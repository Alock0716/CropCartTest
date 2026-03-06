/**
 * cart.js — Cart page logic (real DB/API)
 *
 * Uses:
 * - GET    /api/cart/
 * - POST   /api/cart/add/           (not used on cart page, but part of system)
 * - PATCH  /api/cart/update/<id>/
 * - DELETE /api/cart/remove/<id>/
 *
 * Requires:
 * - config.js + utils.js (window.CC)
 * - auth.js (for navbar rendering)
 * - page.js (for data-auth="in/out" toggling)
 */

(function initCartPage() {
  "use strict";

  const CC = window.CC;

  // ===========================================================================
  // DOM ELEMENTS
  // ===========================================================================

  const tableBodyEl = document.getElementById("cartTableBody");
  const subtotalEl = document.getElementById("cartSubtotal");
  const totalEl = document.getElementById("cartTotal");
  const statusEl = document.getElementById("pageStatus");

  const clearBtn = document.getElementById("clearCartBtn");
  const goCheckoutBtn = document.getElementById("goCheckoutBtn");

  // ===========================================================================
  // STATE
  // ===========================================================================

  // Example shape (from API docs):
  // { id, user, items: [{ id, product: { id, name, price }, quantity, subtotal }], total }
  let cart = null;

  //for location checks
  let normalizedFarms = [];
  let savedCustomerPoint = null;
  /* Product lookup cache (id → product) */
  let productLookup = {};
  let annotatedCartRows = [];

  // ===========================================================================
  // AUTH / ERROR HANDLING
  // ===========================================================================

  /**
   * If the token exists but the API says 401, clear auth and refresh
   * so the page flips back to logged-out view cleanly.
   */
  function handleUnauthorized() {
    CC.auth.clearAuth();
    window.location.reload();
  }

  // ===========================================================================
  // API
  // ===========================================================================

    /**
   * Fetch all products and build a lookup table
   * product_id → product
   */
  async function loadProductLookup() {
    try {
      const res = await fetch(`${CC.API_BASE}/api/products/`);
      const data = await res.json();

      const list = data?.data || data || [];

      productLookup = {};

      for (const p of list) {
        productLookup[String(p.id)] = p;
      }

    } catch (err) {
      console.error("Failed loading product lookup", err);
      productLookup = {};
    }
  }

  /**
   * Load the current user's cart from the backend.
   */
  async function fetchCart() {
    CC.setStatus(statusEl, "Loading your cart…", "muted");

    const res = await CC.apiRequest("/cart/", { method: "GET" });
    if (res.status === 401) return handleUnauthorized();

    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    cart = res.data;
    return cart;
  }

  // ===========================================================================
  // LOCAL HELPERS (kept as in source)
  // ===========================================================================

  function formatMoney(n) {
    const v = Number(n) || 0;
    return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

    function getDeliveryApi() {
    return CC?.delivery && CC.delivery.__sharedReady ? CC.delivery : null;
  }

  function getSavedCustomerPoint() {
    const delivery = getDeliveryApi();
    if (!delivery) return null;

    const saved = delivery.getSavedAddress?.();
    if (!saved) return null;

    return delivery.toPoint?.(saved.lat, saved.lng) || null;
  }

  async function loadDeliveryContext() {
    const delivery = getDeliveryApi();
    if (!delivery) {
      normalizedFarms = [];
      savedCustomerPoint = null;
      return;
    }

    normalizedFarms = await delivery.fetchNormalizedFarms();
    savedCustomerPoint = getSavedCustomerPoint();
  }

  function annotateCartProduct(product) {
    const delivery = getDeliveryApi();
    if (!delivery) {
      return {
        product,
        farm: null,
        inRange: null,
        distanceMiles: null,
      };
    }

    return delivery.annotateProductDelivery(
      product || {},
      savedCustomerPoint,
      delivery.buildFarmNameMap(normalizedFarms),
    );
  }

  function renderDeliveryBadge(row) {
    const delivery = getDeliveryApi();
    if (!delivery) {
      return `<span class="badge cc-delivery-badge text-bg-secondary">Range Unknown</span>`;
    }

    const label = delivery.getDeliveryStatusLabel(row?.inRange ?? null);
    const klass = delivery.getDeliveryStatusClass(row?.inRange ?? null);

    return `<span class="badge cc-delivery-badge ${CC.escapeHtml(klass)}">${CC.escapeHtml(label)}</span>`;
  }

  function renderDistanceNote(row) {
    const miles = row?.distanceMiles;
    if (!Number.isFinite(miles)) {
      return `<span class="cc-distance-note">Distance unavailable</span>`;
    }

    return `<span class="cc-distance-note">${CC.escapeHtml(miles.toFixed(1))} mi away</span>`;
  }

    function buildAnnotatedCartRows() {
    const delivery = getDeliveryApi();
    const items = Array.isArray(cart?.items) ? cart.items : [];

    if (!delivery) return [];

    const farmMap = delivery.buildFarmNameMap(normalizedFarms);

    return items.map((item) => {
      const rawProduct = item.product || {};
      const fullProduct =
        productLookup[String(rawProduct.id)] ||
        productLookup[String(item.product_id)] ||
        rawProduct;

      const annotated = delivery.annotateProductDelivery(
        fullProduct,
        savedCustomerPoint,
        farmMap,
      );

      return {
        item,
        product: fullProduct,
        ...annotated,
      };
    });
  }

  function getCheckoutBlockMessage(rows) {
    const delivery = getDeliveryApi();
    if (!delivery) {
      return "Delivery range could not be verified right now. Please try again.";
    }

    if (!savedCustomerPoint) {
      return "Please save or select a delivery address before checking out.";
    }

    const outRows = delivery.getOutOfRangeRows(rows);
    if (!outRows.length) return "";

    const names = outRows
      .map((row) => row?.product?.name || row?.item?.product?.name || "Item")
      .slice(0, 3);

    const extra =
      outRows.length > 3 ? ` and ${outRows.length - 3} more` : "";

    return `Some items are outside this address's delivery range: ${names.join(", ")}${extra}.`;
  }

  function canProceedToCheckout() {
    const delivery = getDeliveryApi();
    if (!delivery) return false;

    annotatedCartRows = buildAnnotatedCartRows();
    return delivery.areAllRowsDeliverable(annotatedCartRows);
  }

  // ===========================================================================
  // GUEST CART RENDER (pre-login cart)
  // ===========================================================================

  function renderGuestCart() {
    const items = CC.cartCache.listGuestItems();
    const subtotal = CC.cartCache.guestSubtotal();

    // You already have a container / table area in cart.html — use whatever you’re using for normal cart
    const cartHost =
      document.querySelector("#cartHost") ||
      document.querySelector("[data-cart-host]");
    if (!cartHost) return;

    if (!items.length) {
      cartHost.innerHTML = `
        <div class="alert alert-light border">
          <div class="fw-semibold">Your cart is empty.</div>
          <div class="text-muted">Add something from the store — it’ll stay here until you sign in.</div>
        </div>
      `;
      return;
    }

    const rowsHtml = items
      .map(({ qty, product }) => {
        const imgHtml = product.photo_url
          ? `<img src="${product.photo_url}" alt="${product.name}" class="rounded border cc-guest-thumb">`
          : `<div class="rounded border bg-light d-flex align-items-center justify-content-center cc-guest-thumb-fallback">🛒</div>`;

        const unit = product.unit ? ` / ${product.unit}` : "";
        const lineTotal = (Number(product.price) || 0) * (Number(qty) || 0);

        return `
        <div class="d-flex gap-3 align-items-center py-3 border-bottom" data-guest-row="${product.id}">
          ${imgHtml}

          <div class="flex-grow-1">
            <div class="fw-semibold">${product.name || "Item"}</div>
            <div class="text-muted small">
              ${product.farm_name ? `${product.farm_name} • ` : ""}${formatMoney(product.price)}${unit}
            </div>
          </div>

          <div class="d-flex align-items-center gap-2">
            <button class="btn btn-sm btn-outline-secondary" data-guest-dec="${product.id}">−</button>
            <input class="form-control form-control-sm text-center cc-guest-qty-input"
                  value="${qty}" inputmode="numeric" data-guest-qty="${product.id}">
            <button class="btn btn-sm btn-outline-secondary" data-guest-inc="${product.id}">+</button>
          </div>

          <div class="text-end cc-guest-line-total">
            <div class="fw-semibold">${formatMoney(lineTotal)}</div>
            <button class="btn btn-sm btn-link text-danger p-0" data-guest-remove="${item.id}">Remove</button>
          </div>
        </div>
      `;
      })
      .join("");

    cartHost.innerHTML = `
      <div class="alert alert-info border">
        <div class="fw-semibold">Guest cart</div>
        <div class="small">Sign in to sync this cart to your account and checkout.</div>
      </div>

      <div class="bg-white border rounded-4 p-3">
        ${rowsHtml}

        <div class="d-flex justify-content-between align-items-center pt-3">
          <div class="text-muted">Subtotal</div>
          <div class="fw-bold fs-5">${formatMoney(subtotal)}</div>
        </div>

        <div class="d-flex gap-2 pt-3">
          <a class="btn btn-cc" href="login.html">Sign in to checkout</a>
          <a class="btn btn-outline-cc" href="index.html">Keep shopping</a>
        </div>
      </div>
    `;

    // Wire controls
    cartHost.querySelectorAll("[data-guest-inc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-guest-inc");
        const cart = CC.cartCache.getGuestCart();
        const current = cart.items?.[String(id)]?.qty || 0;
        CC.cartCache.setGuestItemQty(id, current + 1);
        renderGuestCart();
      });
    });

    cartHost.querySelectorAll("[data-guest-dec]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-guest-dec");
        const cart = CC.cartCache.getGuestCart();
        const current = cart.items?.[String(id)]?.qty || 0;
        CC.cartCache.setGuestItemQty(id, current - 1);
        renderGuestCart();
      });
    });

    cartHost.querySelectorAll("[data-guest-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-guest-remove");
        CC.cartCache.removeGuestItem(id);
        renderGuestCart();
      });
    });

    cartHost.querySelectorAll("[data-guest-qty]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const id = inp.getAttribute("data-guest-qty");
        CC.cartCache.setGuestItemQty(id, inp.value);
        renderGuestCart();
      });
    });
  }

  // ===========================================================================
  // CART MUTATIONS (API)
  // ===========================================================================

  /**
   * Update a cart item quantity on the backend.
   * @param {number} itemId - cart item id
   * @param {number} newQty - new quantity (must be >= 1)
   */
  async function updateItemQty(itemId, newQty) {
    const safeQty = Math.max(1, Number(newQty) || 1);

    const res = await CC.apiRequest(`/cart/update/${itemId}/`, {
      method: "PATCH",
      json: { quantity: safeQty },
    });

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    // After update, re-fetch cart so totals stay authoritative from DB
    await refresh();
  }

  /**
   * Remove an item from cart on the backend.
   * @param {number} itemId - cart item id
   */
  async function removeItem(itemId) {
    const res = await CC.apiRequest(`/cart/remove/${itemId}/`, {
      method: "DELETE",
    });

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    await refresh();
  }

  /**
   * Remove an item from cart on the backend WITHOUT re-fetching.
   * This is used for "Clear Cart" to avoid N refresh calls.
   * @param {number} itemId - cart item id
   */
  async function removeItemNoRefresh(itemId) {
    const res = await CC.apiRequest(`/cart/remove/${itemId}/`, {
      method: "DELETE",
    });

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }
  }

  /**
   * Clears the authenticated cart by deleting each cart item.
   * The API currently exposes remove-by-item-id (no bulk clear endpoint),
   * so we perform deletes and then refresh once at the end.
   */
  async function clearAuthCart() {
    const items = Array.isArray(cart?.items) ? cart.items : [];

    if (!items.length) {
      CC.setStatus(statusEl, "Your cart is already empty.", "muted");
      return;
    }

    // UX: prevent double clicks while clearing
    if (clearBtn) clearBtn.disabled = true;
    CC.setStatus(statusEl, "Clearing your cart…", "muted");

    try {
      // Run sequentially to keep server load predictable and errors easier to attribute.
      for (const it of items) {
        await removeItemNoRefresh(Number(it.id));
      }

      await refresh();
      CC.setStatus(statusEl, "", "success");
    } finally {
      if (clearBtn) clearBtn.disabled = false;
    }
  }

  // ===========================================================================
  // RENDER (AUTH CART)
  // ===========================================================================

  function renderCart() {
    if (!tableBodyEl || !subtotalEl || !totalEl) return;

    const items = Array.isArray(cart?.items) ? cart.items : [];

    if (!items.length) {
      tableBodyEl.innerHTML = `
        <tr>
          <td colspan="5" class="text-center text-muted py-4">
            Your cart is empty.
          </td>
        </tr>
      `;
      subtotalEl.textContent = formatMoney(0);
      totalEl.textContent = formatMoney(0);
      CC.setStatus(statusEl, "", "muted");
      return;
    }

    tableBodyEl.innerHTML = items
      .map((item) => {
        const raw = item.product || {};
        const fullProduct =
          productLookup[String(raw.id)] ||
          productLookup[String(item.product_id)] ||
          raw;

        const name = fullProduct.name || "Item";
        const price = Number(fullProduct.price) || 0;
        const qty = Number(item.quantity) || 1;
        const line = Number(item.subtotal) || price * qty;

        const deliveryRow = CC.delivery.annotateProductDelivery(
          fullProduct,
          savedCustomerPoint,
          CC.delivery.buildFarmNameMap(normalizedFarms)
        );
        const farmName = fullProduct.farm_name;
        const farmLocation = fullProduct.farm_location;

        return `
          <tr>
            <td class="px-3">
              <div class="cc-cart-item-meta">
                <div class="fw-semibold">${CC.escapeHtml(name)}</div>
                <div class="cc-cart-item-subline">
                  ${CC.escapeHtml(farmName)}
                  ${farmLocation ? ` • ${CC.escapeHtml(farmLocation)}` : ""}
                </div>
                <div class="cc-cart-item-badges">
                  ${renderDeliveryBadge(deliveryRow)}
                  ${renderDistanceNote(deliveryRow)}
                </div>
              </div>
            </td>

            <td>${formatMoney(price)}</td>

            <td>
              <input
                class="form-control form-control-sm"
                type="number"
                min="1"
                step="1"
                value="${qty}"
                data-qty-input="${item.id}"
              />
            </td>

            <td>${formatMoney(line)}</td>

            <td class="text-end px-3">
              <button
                class="btn btn-sm btn-outline-danger"
                type="button"
                data-remove-btn="${item.id}"
              >
                Remove
              </button>
            </td>
          </tr>
        `;
      })
      .join("");
    
    // Totals from API
    subtotalEl.textContent = formatMoney(cart?.total_price || 0);
    totalEl.textContent = formatMoney(cart?.total_price || 0);

    // Wire qty inputs
    tableBodyEl.querySelectorAll("[data-qty-input]").forEach((inp) => {
      inp.addEventListener("change", async () => {
        const id = Number(inp.getAttribute("data-qty-input"));
        try {
          await updateItemQty(id, inp.value);
        } catch (err) {
          CC.setStatus(statusEl, err.message || "Update failed.", "danger");
        }
      });
    });

    // Wire remove buttons
    tableBodyEl.querySelectorAll("[data-remove-btn]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-remove-btn"));
        try {
          await removeItem(id);
        } catch (err) {
          CC.setStatus(statusEl, err.message || "Remove failed.", "danger");
        }
      });
    });

    CC.setStatus(statusEl, "", "muted");
  }

  // ===========================================================================
  // REFRESH / BOOT
  // ===========================================================================
  async function refresh() {
    await Promise.all([
      fetchCart(),
      loadProductLookup(),
      loadDeliveryContext(),
    ]);

    annotatedCartRows = buildAnnotatedCartRows();
    renderCart();
  }

  function wireActions() {
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
          // Guest cart clear
          if (!CC.auth.isLoggedIn()) {
            CC.cartCache.clearGuestCart();
            try {
              renderGuestCart();
            } catch {
              // ignore
            }
            CC.setStatus(statusEl, "", "success");
            return;
          }

          // Auth cart clear
          await clearAuthCart();
        } catch (err) {
          CC.setStatus(
            statusEl,
            err.message || "Unable to clear cart.",
            "danger",
          );
        }
      });
    }

    if (goCheckoutBtn) {
      goCheckoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();

        try {
          if (!CC.auth.isLoggedIn()) {
            window.location.href = "login.html";
            return;
          }

          await Promise.all([
            loadProductLookup(),
            loadDeliveryContext(),
            fetchCart(),
          ]);

          annotatedCartRows = buildAnnotatedCartRows();

          if (!canProceedToCheckout()) {
            CC.setStatus(
              statusEl,
              getCheckoutBlockMessage(annotatedCartRows),
              "danger",
            );
            return;
          }

          CC.setStatus(statusEl, "", "success");
          window.location.href = "checkout.html";
        } catch (err) {
          CC.setStatus(
            statusEl,
            err?.message || "Unable to validate delivery range.",
            "danger",
          );
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Guest cart (only renders if your HTML provides a cartHost)
    try {
      renderGuestCart();
    } catch {
      // Keep silent like source behavior (do not break cart page)
    }

    // Auth cart
    if (CC.auth.isLoggedIn()) {
      try {
        wireActions();
        await refresh();
      } catch (err) {
        CC.setStatus(statusEl, err.message || "Unable to load cart.", "danger");
      }
    }
  });
})();
