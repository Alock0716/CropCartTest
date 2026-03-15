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
  const cartDeliveryWarningEl = document.getElementById("cartDeliveryWarning");

  //Global Helper Variables
  const delivery = CC?.delivery || null;
  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";
  const TEMP_CHECKOUT_ADDRESS_KEY = "cc_checkout_address_geo_v1";


  // ===========================================================================
  // STATE
  // ===========================================================================

  // Example shape (from API docs):
  // { id, user, items: [{ id, product: { id, name, price }, quantity, subtotal }], total }
  let cart = null;

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
  
  function getJson(storage, key, fallback = null) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function normalizeAddressValue(v) {
    return String(v || "")
      .trim()
      .replace(/\s+/g, " ")
      .toUpperCase();
  }

  function sameAddress(a, b) {
    if (!a || !b) return false;

    return (
      normalizeAddressValue(a.address_line1 || a.street_address) ===
        normalizeAddressValue(b.address_line1 || b.street_address) &&
      normalizeAddressValue(a.city) === normalizeAddressValue(b.city) &&
      normalizeAddressValue(a.state) === normalizeAddressValue(b.state) &&
      normalizeAddressValue(a.postal_code || a.zip) ===
        normalizeAddressValue(b.postal_code || b.zip)
    );
  }

  function getAddressFromAuth(auth) {
    const user =
      auth?.user || auth?.data?.user || auth?.account || auth?.profile || null;

    if (!user || typeof user !== "object") return null;

    const lat = Number(user.lat);
    const lng = Number(user.lng);

    const addr = {
      address_line1: String(
        user.address_line1 || user.street_address || ""
      ).trim(),
      city: String(user.city || "").trim(),
      state: String(user.state || "").trim(),
      postal_code: String(user.postal_code || user.zip || "").trim(),
      country: String(user.country || "US").trim(),
      preferred_delivery_address: String(
        user.preferred_delivery_address || user.preferredDeliveryAddress || ""
      ).trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    };

    const hasAddressText =
      addr.address_line1 && addr.city && addr.state && addr.postal_code;
    const hasPreferred = !!addr.preferred_delivery_address;
    const hasCoords = Number.isFinite(addr.lat) && Number.isFinite(addr.lng);

    return hasAddressText || hasPreferred || hasCoords ? addr : null;
  }

  function getBestCartAddress() {
    const authAddr = getAddressFromAuth(CC.auth.getAuth?.() || null);
    const localAddr = getJson(localStorage, LOCAL_ADDRESS_KEY, null);
    const tempCheckoutAddr = getJson(sessionStorage, TEMP_CHECKOUT_ADDRESS_KEY, null);

    if (
      authAddr &&
      Number.isFinite(Number(authAddr.lat)) &&
      Number.isFinite(Number(authAddr.lng))
    ) {
      return { source: "account", address: authAddr };
    }

    if (
      localAddr &&
      Number.isFinite(Number(localAddr.lat)) &&
      Number.isFinite(Number(localAddr.lng))
    ) {
      return { source: "device", address: localAddr };
    }

    if (
      tempCheckoutAddr &&
      Number.isFinite(Number(tempCheckoutAddr.lat)) &&
      Number.isFinite(Number(tempCheckoutAddr.lng))
    ) {
      return { source: "checkout", address: tempCheckoutAddr };
    }

    if (authAddr) return { source: "account", address: authAddr };
    if (localAddr) return { source: "device", address: localAddr };
    if (tempCheckoutAddr) return { source: "checkout", address: tempCheckoutAddr };

    return { source: null, address: null };
  }

  function setCartDeliveryWarning(text, kind = "muted") {
    if (!cartDeliveryWarningEl) return;

    cartDeliveryWarningEl.textContent = text || "";
    cartDeliveryWarningEl.className =
      "small mb-3 " +
      (kind === "danger"
        ? "text-danger"
        : kind === "success"
          ? "text-success"
          : kind === "warning"
            ? "text-warning"
            : "text-muted");
  }

  function refreshCartDeliveryWarning() {
    if (!cartDeliveryWarningEl) return;

    const items = Array.isArray(cart?.items) ? cart.items : [];
    if (!items.length) {
      setCartDeliveryWarning("");
      return;
    }

    if (!delivery) {
      setCartDeliveryWarning(
        "Delivery status preview is unavailable right now.",
        "warning"
      );
      return;
    }

    const hqCheck = delivery.validateHq(delivery.getDeliveryConfig());
    if (!hqCheck?.ok) {
      setCartDeliveryWarning(
        "Delivery status preview is unavailable because HQ settings are missing.",
        "warning"
      );
      return;
    }

    const { source, address } = getBestCartAddress();

    if (!address) {
      setCartDeliveryWarning(
        "No saved delivery address found yet. You can still continue and enter or change your address during checkout.",
        "warning"
      );
      return;
    }

    const customerCheck = delivery.validateCustomer(address);

    if (!customerCheck?.ok) {
      setCartDeliveryWarning(
        "A delivery address exists, but coordinates are not available yet. You can still continue and verify the address during checkout.",
        "warning"
      );
      return;
    }

    const distanceMiles = delivery.milesBetween(
      hqCheck.hq.lat,
      hqCheck.hq.lng,
      customerCheck.customer.lat,
      customerCheck.customer.lng
    );

    const inRange = distanceMiles <= hqCheck.hq.deliveryRange;

    const sourceLabel =
      source === "account"
        ? "saved account address"
        : source === "device"
          ? "saved device address"
          : source === "checkout"
            ? "most recent checkout address"
            : "saved address";

    if (inRange) {
      setCartDeliveryWarning(
        `Estimated deliverable based on your ${sourceLabel}. Current distance from HQ: ${distanceMiles.toFixed(2)} miles. You can still change the address during checkout.`,
        "success"
      );
      return;
    }

    setCartDeliveryWarning(
      `Warning: your ${sourceLabel} is currently outside the delivery radius (${distanceMiles.toFixed(2)} miles from HQ). You can still continue to checkout and change the address there.`,
      "danger"
    );
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
      refreshCartDeliveryWarning();
      CC.setStatus(statusEl, "", "muted");
      return;
    }

    tableBodyEl.innerHTML = items
      .map((item) => {
        const name = item.product_name || "Item";
        const price = Number(item.product_price) || 0;
        const qty = Number(item.quantity) || 1;
        const line = Number(item.subtotal) || price * qty;

        return `
          <tr>
            <td class="px-3">
              <div class="fw-semibold">${name}</div>
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

    refreshCartDeliveryWarning();
    CC.setStatus(statusEl, "", "muted");
  }

  // ===========================================================================
  // REFRESH / BOOT
  // ===========================================================================

  async function refresh() {
    await fetchCart();
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
      goCheckoutBtn.addEventListener("click", () => {
        window.location.href = "checkout.html";
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
