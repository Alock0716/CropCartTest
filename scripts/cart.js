/**
 * cart.js — Cart page logic (real DB/API)
 *
 * Fixes included:
 * - Loads product lookup through CC.apiRequest instead of CC.API_BASE
 * - Reads saved address from cc_saved_address_v1 and geocodes it when lat/lng are missing
 * - Waits for product lookup + delivery context before rendering the authenticated cart
 * - Blocks checkout when address is missing or items are out of range
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

  let cart = null;

  // Delivery / enrichment state
  let normalizedFarms = [];
  let savedCustomerPoint = null;
  let productLookup = {};
  let annotatedCartRows = [];

  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";

  // ===========================================================================
  // AUTH / ERROR HANDLING
  // ===========================================================================

  function handleUnauthorized() {
    CC.auth.clearAuth();
    window.location.reload();
  }

  // ===========================================================================
  // API
  // ===========================================================================

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

  async function loadProductLookup() {
    const res = await CC.apiRequest("/products/", { method: "GET" });

    if (!res.ok) {
      console.warn("Product lookup failed:", res.status, res.raw);
      productLookup = {};
      return;
    }

    const rows = Array.isArray(res.data?.data)
      ? res.data.data
      : Array.isArray(res.data)
        ? res.data
        : [];

    productLookup = {};
    for (const product of rows) {
      const key = String(product?.id ?? product?.product_id ?? "").trim();
      if (!key) continue;
      productLookup[key] = product;
    }
  }

  // ===========================================================================
  // LOCAL HELPERS
  // ===========================================================================

  function formatMoney(n) {
    const v = Number(n) || 0;
    return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  function getLocalAddress() {
    try {
      const raw = localStorage.getItem(LOCAL_ADDRESS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setLocalAddress(addr) {
    try {
      localStorage.setItem(LOCAL_ADDRESS_KEY, JSON.stringify(addr));
    } catch {
      // ignore storage issues
    }
  }

  function getDeliveryApi() {
    return window.CC?.delivery && window.CC.delivery.__sharedReady
      ? window.CC.delivery
      : null;
  }

  async function geocodeAddressWithFallback(address) {
    const delivery = getDeliveryApi();
    if (!delivery || !address) return null;

    const fullQuery = delivery.formatAddressForGeocode(address);
    const zipQuery = delivery.formatZipForGeocode(address);

    async function geocode(query) {
      if (!query) return null;

      const url =
        "https://nominatim.openstreetmap.org/search?" +
        new URLSearchParams({
          q: query,
          format: "json",
          limit: "1",
          countrycodes: "us",
        });

      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!res.ok) return null;

        const data = await res.json();
        if (!Array.isArray(data) || !data.length) return null;

        return delivery.toPoint(Number(data[0].lat), Number(data[0].lon));
      } catch {
        return null;
      }
    }

    return (await geocode(fullQuery)) || (await geocode(zipQuery)) || null;
  }

  async function getSavedCustomerPoint() {
    const delivery = getDeliveryApi();
    if (!delivery) return null;

    const saved = delivery.getSavedAddress();
    if (!saved) return null;

    if (delivery.hasValidPoint(saved)) {
      return delivery.toPoint(saved.lat, saved.lng);
    }

    const point = await geocodeAddressWithFallback(saved);
    if (!point) return null;

    delivery.setSavedAddress({
      ...saved,
      lat: point.lat,
      lng: point.lng,
      geocode_source: "page_geocode",
      updatedAt: new Date().toISOString(),
    });

    return point;
  }

  async function loadDeliveryContext() {
    const delivery = getDeliveryApi();
    if (!delivery) {
      normalizedFarms = [];
      savedCustomerPoint = null;
      return;
    }

    try {
      normalizedFarms = await delivery.fetchNormalizedFarms();
    } catch (err) {
      console.warn("Failed loading normalized farms:", err);
      normalizedFarms = [];
    }

    savedCustomerPoint = await getSavedCustomerPoint();
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
      return "Please save a delivery address on the Account page before checking out.";
    }

    const outRows = delivery.getOutOfRangeRows(rows);
    if (!outRows.length) return "";

    const names = outRows
      .map((row) => row?.product?.name || row?.item?.product?.name || "Item")
      .slice(0, 3);

    const extra = outRows.length > 3 ? ` and ${outRows.length - 3} more` : "";

    return `Some items are outside this address's delivery range: ${names.join(", ")}${extra}.`;
  }

  function canProceedToCheckout() {
    const delivery = getDeliveryApi();
    if (!delivery) return false;

    annotatedCartRows = buildAnnotatedCartRows();
    return delivery.areAllRowsDeliverable(annotatedCartRows);
  }

  // ===========================================================================
  // GUEST CART RENDER
  // ===========================================================================

  function renderGuestCart() {
    const items = CC.cartCache.listGuestItems();
    const subtotal = CC.cartCache.guestSubtotal();

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
              <button class="btn btn-sm btn-link text-danger p-0" data-guest-remove="${product.id}">Remove</button>
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

    cartHost.querySelectorAll("[data-guest-inc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-guest-inc");
        const guestCart = CC.cartCache.getGuestCart();
        const current = guestCart.items?.[String(id)]?.qty || 0;
        CC.cartCache.setGuestItemQty(id, current + 1);
        renderGuestCart();
      });
    });

    cartHost.querySelectorAll("[data-guest-dec]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-guest-dec");
        const guestCart = CC.cartCache.getGuestCart();
        const current = guestCart.items?.[String(id)]?.qty || 0;
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
  // CART MUTATIONS
  // ===========================================================================

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

    await refresh();
  }

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

  async function clearAuthCart() {
    const items = Array.isArray(cart?.items) ? cart.items : [];

    if (!items.length) {
      CC.setStatus(statusEl, "Your cart is already empty.", "muted");
      return;
    }

    if (clearBtn) clearBtn.disabled = true;
    CC.setStatus(statusEl, "Clearing your cart…", "muted");

    try {
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
  // RENDER
  // ===========================================================================

  function renderCart() {
    if (!tableBodyEl || !subtotalEl || !totalEl) return;

    const items = Array.isArray(cart?.items) ? cart.items : [];
    const delivery = getDeliveryApi();

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

    annotatedCartRows = buildAnnotatedCartRows();

    tableBodyEl.innerHTML = items
      .map((item) => {
        const p = item.product || {};
        const name = p.name || "Item";
        const price = Number(p.price) || 0;
        const qty = Number(item.quantity) || 1;
        const line = Number(item.subtotal) || price * qty;
        
        let deliveryRow = null;
        if (delivery) {
          deliveryRow =
            annotatedCartRows.find((row) => String(row.item?.id) === String(item.id)) ||
            delivery.annotateProductDelivery(
              fullProduct,
              savedCustomerPoint,
              delivery.buildFarmNameMap(normalizedFarms),
            );
        }

        const farmName = String(
          fullProduct?.farm_name ??
          fullProduct?.farm?.farm_name ??
          fullProduct?.farm?.name ??
          raw?.farm_name ??
          ""
        ).trim();

        const farmLocation = String(
          fullProduct?.farm_location ??
          fullProduct?.farm?.location ??
          raw?.farm_location ??
          ""
        ).trim();

        return `
          <tr>
            <td class="px-3">
              <div class="cc-cart-item-meta">
                <div class="fw-semibold">${CC.escapeHtml(name)}</div>
                ${
                  farmName || farmLocation
                    ? `
                  <div class="cc-cart-item-subline">
                    ${CC.escapeHtml(farmName)}
                    ${farmLocation ? ` • ${CC.escapeHtml(farmLocation)}` : ""}
                  </div>
                `
                    : ""
                }
                ${
                  delivery
                    ? `
                  <div class="cc-cart-item-badges">
                    ${renderDeliveryBadge(deliveryRow)}
                    ${renderDistanceNote(deliveryRow)}
                  </div>
                `
                    : ""
                }
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

    subtotalEl.textContent = formatMoney(cart?.total_price || cart?.total || 0);
    totalEl.textContent = formatMoney(cart?.total_price || cart?.total || 0);

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
    await Promise.all([loadProductLookup(), loadDeliveryContext()]);
    await fetchCart();
    renderCart();
  }

  function wireActions() {
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
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
      goCheckoutBtn.addEventListener("click", (e) => {
        e.preventDefault();

        const delivery = getDeliveryApi();

        if (!delivery) {
          CC.setStatus(
            statusEl,
            "Delivery checks are unavailable right now.",
            "danger",
          );
          return;
        }

        if (!savedCustomerPoint) {
          CC.setStatus(
            statusEl,
            "Please save a delivery address on your Account page before checking out.",
            "danger",
          );
          return;
        }

        annotatedCartRows = buildAnnotatedCartRows();

        if (!delivery.areAllRowsDeliverable(annotatedCartRows)) {
          CC.setStatus(
            statusEl,
            getCheckoutBlockMessage(annotatedCartRows),
            "danger",
          );
          return;
        }

        window.location.href = "checkout.html";
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      renderGuestCart();
    } catch {
      // silent
    }

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