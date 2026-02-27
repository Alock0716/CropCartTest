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

  // ----- DOM elements used on this page -----
  const tableBodyEl = document.getElementById("cartTableBody");
  const subtotalEl = document.getElementById("cartSubtotal");
  const totalEl = document.getElementById("cartTotal");
  const statusEl = document.getElementById("pageStatus");

  const clearBtn = document.getElementById("clearCartBtn");
  const goCheckoutBtn = document.getElementById("goCheckoutBtn");

  // ----- State: the cart returned by API -----
  // Example shape (from API docs):
  // { id, user, items: [{ id, product: { id, name, price }, quantity, subtotal }], total }
  let cart = null;

  /**
   * If the token exists but the API says 401, we clear auth and refresh
   * so the page flips back to logged-out view cleanly.
   */
  function handleUnauthorized() {
    CC.auth.clearAuth();
    window.location.reload();
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

  function formatMoney(n) {
    const v = Number(n) || 0;
    return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

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
          ? `<img src="${product.photo_url}" alt="${product.name}" class="rounded border" style="width:56px;height:56px;object-fit:cover;">`
          : `<div class="rounded border bg-light d-flex align-items-center justify-content-center" style="width:56px;height:56px;">🛒</div>`;

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
            <input class="form-control form-control-sm text-center" style="width:70px"
                  value="${qty}" inputmode="numeric" data-guest-qty="${product.id}">
            <button class="btn btn-sm btn-outline-secondary" data-guest-inc="${product.id}">+</button>
          </div>

          <div class="text-end" style="width:110px">
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
   *
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
   * Clears the cart by deleting each item (API doesn't provide a bulk clear endpoint).
   */
  async function clearCart() {
    if (!cart?.items?.length) return;

    CC.setStatus(statusEl, "Clearing cart…", "muted");

    // Delete sequentially to keep server load and errors simple to reason about
    for (const item of cart.items) {
      const res = await CC.apiRequest(`/cart/remove/${item.id}/`, {
        method: "DELETE",
      });
      if (res.status === 401) return handleUnauthorized();
      if (!res.ok) {
        throw new Error(
          res.data?.error ||
            res.data?.detail ||
            res.raw ||
            `HTTP ${res.status}`,
        );
      }
    }

    await refresh();
  }

  /**
   * Render cart rows + totals.
   */
  function render() {
    if (!tableBodyEl || !subtotalEl || !totalEl) return;

    const items = cart?.items || [];

    tableBodyEl.innerHTML = "";

    if (!items.length) {
      tableBodyEl.innerHTML = `
        <tr>
          <td class="px-3 py-4 text-muted" colspan="5">Your cart is empty.</td>
        </tr>
      `;

      subtotalEl.textContent = CC.formatMoney(0);
      totalEl.textContent = CC.formatMoney(0);

      if (goCheckoutBtn) goCheckoutBtn.classList.add("disabled");
      CC.setStatus(statusEl, "Your cart is empty.", "muted");
      return;
    }

    if (goCheckoutBtn) goCheckoutBtn.classList.remove("disabled");

    let total = 0;

    for (const item of items) {
      const itemId = item.id;
      const name = CC.escapeHtml(item.product_name || "Item");
      const unitPrice = item.product_price ?? 0;
      const qty = Number(item.quantity || 1);
      const lineTotal = item.subtotal ?? Number(unitPrice) * qty;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="px-3 fw-semibold">${name}</td>
        <td>${CC.formatMoney(unitPrice)}</td>
        <td>
          <div class="input-group input-group-sm">
            <button class="btn btn-outline-secondary" data-dec="${itemId}" type="button">-</button>
            <input class="form-control text-center" value="${qty}" inputmode="numeric" data-qty="${itemId}">
            <button class="btn btn-outline-secondary" data-inc="${itemId}" type="button">+</button>
          </div>
        </td>
        <td class="fw-semibold">${CC.formatMoney(lineTotal)}</td>
        <td class="text-end px-3">
          <button class="btn btn-sm btn-outline-danger" data-rm="${itemId}" type="button">Remove</button>
        </td>
      `;
      tableBodyEl.appendChild(tr);
      total += parseFloat(lineTotal);
    }

    // The API returns total as a string. We treat it as authoritative.

    subtotalEl.textContent = CC.formatMoney(total);
    totalEl.textContent = CC.formatMoney(total);

    CC.setStatus(statusEl, "Cart loaded.", "success");
  }

  /**
   * Full refresh: fetch cart from API then render.
   */
  async function refresh() {
    await fetchCart();
    render();
  }

  /**
   * Wire all click/change handlers.
   */
  function wireEvents() {
    // +/-/remove buttons
    tableBodyEl?.addEventListener("click", async (e) => {
      const target = e.target;
      const inc = target?.getAttribute?.("data-inc");
      const dec = target?.getAttribute?.("data-dec");
      const rm = target?.getAttribute?.("data-rm");

      try {
        if (inc) {
          const row = cart?.items?.find((x) => String(x.id) === String(inc));
          const next = (Number(row?.quantity) || 1) + 1;
          CC.setStatus(statusEl, "Updating quantity…", "muted");
          await updateItemQty(Number(inc), next);
        }

        if (dec) {
          const row = cart?.items?.find((x) => String(x.id) === String(dec));
          const next = Math.max(1, (Number(row?.quantity) || 1) - 1);
          CC.setStatus(statusEl, "Updating quantity…", "muted");
          await updateItemQty(Number(dec), next);
        }

        if (rm) {
          CC.setStatus(statusEl, "Removing item…", "muted");
          await removeItem(Number(rm));
        }
      } catch (err) {
        CC.setStatus(statusEl, err?.message || String(err), "danger");
      }
    });

    // Manual quantity typing (Enter or blur)
    tableBodyEl?.addEventListener("change", async (e) => {
      const input = e.target;
      if (!input?.matches?.("[data-qty]")) return;

      const itemId = Number(input.getAttribute("data-qty"));
      const newQty = Number(String(input.value || "").trim());

      try {
        CC.setStatus(statusEl, "Updating quantity…", "muted");
        await updateItemQty(itemId, newQty);
      } catch (err) {
        CC.setStatus(statusEl, err?.message || String(err), "danger");
      }
    });

    clearBtn?.addEventListener("click", async () => {
      try {
        await clearCart();
      } catch (err) {
        CC.setStatus(statusEl, err?.message || String(err), "danger");
      }
    });
  }

  CC.onReady(async () => {
    // Only run if user is logged in; otherwise the page shows logged-out panel.
    if (!CC.auth.isLoggedIn()) {
      renderGuestCart();
      return;
    }

    wireEvents();

    try {
      await refresh();
    } catch (err) {
      CC.setStatus(statusEl, err?.message || String(err), "danger");
    }
  });
})();
