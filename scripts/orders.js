/**
 * orders.js — Customer orders page (orders.html)
 *
 * What this file is
 * - Controller for orders.html.
 * - Loads the signed-in customer’s order history.
 * - Adds: favorite orders (local), search, filter, sort, and "import to cart" reorders.
 *
 * API routes used (per API_DOCUMENTATION.md)
 * - GET  /api/orders/history/   (preferred) -> { summary, orders }
 * - GET  /api/orders/           (fallback)  -> [orders]
 * - POST /api/cart/add/         (reorder)   -> add product to cart
 *
 * Requires:
 * - config.js
 * - utils.js (window.CC helpers)
 * - auth.js / page.js (auth + navbar)
 */
(function initOrdersPage() {
  "use strict";

  const CC = window.CC;
  if (!CC) {
    console.warn(
      "orders.js: window.CC not found. Make sure utils.js is loaded before orders.js",
    );
    return;
  }

  // -------------------------
  // DOM (IDs come from orders.html)
  // -------------------------
  const pageStatusEl = document.getElementById("pageStatus");
  const refreshBtn = document.getElementById("refreshOrdersBtn");

  const statusFilterEl = document.getElementById("orderStatusFilter");
  const searchEl = document.getElementById("orderSearch");
  const sortEl = document.getElementById("orderSort");
  const favoritesOnlyEl = document.getElementById("favoriteOnly");

  const summaryWrapEl = document.getElementById("ordersSummary");
  const summaryTotalOrdersEl = document.getElementById("sumTotalOrders");
  const summaryTotalSpentEl = document.getElementById("sumTotalSpent");
  const summaryAvgOrderEl = document.getElementById("sumAvgOrder");

  const tbodyEl = document.getElementById("ordersTableBody");

  // -------------------------
  // State
  // -------------------------
  /** @type {any[]} */
  let allOrders = [];

  const FAVORITES_KEY = "cc_favorite_orders";
  let favoriteIds = new Set();

  // -------------------------
  // Helpers
  // -------------------------

  /** Clear auth + send user to login page */
  function handleUnauthorized() {
    CC.auth.clearAuth();
    window.location.href = "login.html";
  }

  /** Safe number parse for amounts like "16.17" */
  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Parse ISO string -> readable local date/time */
  function formatDateTime(isoString) {
    if (!isoString) return "—";
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return CC.escapeHtml(String(isoString));

    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  /** Map API status -> Bootstrap badge color */
  function statusBadge(statusRaw, displayRaw) {
    const status = String(statusRaw || "")
      .trim()
      .toLowerCase();
    const map = {
      payment_pending: "warning",
      received: "info",
      packed: "primary",
      out_for_delivery: "primary",
      delivered: "success",
      cancelled: "secondary",
    };

    const kind = map[status] || "dark";
    const label = displayRaw
      ? String(displayRaw)
      : status
        ? status.replaceAll("_", " ")
        : "—";

    return `<span class="badge rounded-pill text-bg-${kind}">${CC.escapeHtml(label)}</span>`;
  }

  /** Load favorites from localStorage */
  function loadFavorites() {
    try {
      const raw = window.localStorage.getItem(FAVORITES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        favoriteIds = new Set(parsed.map((x) => String(x)));
      }
    } catch {
      favoriteIds = new Set();
    }
  }

  // Save favorites to localStorage
  function saveFavorites() {
    try {
      window.localStorage.setItem(
        FAVORITES_KEY,
        JSON.stringify([...favoriteIds]),
      );
    } catch {
      // ignore (private mode, storage blocked, etc.)
    }
  }

  // Favorite toggle. Returns the new state.
  function toggleFavorite(orderId) {
    const id = String(orderId);
    if (favoriteIds.has(id)) {
      favoriteIds.delete(id);
      saveFavorites();
      return false;
    }

    favoriteIds.add(id);
    saveFavorites();
    return true;
  }

  function isFavorited(orderId) {
    return favoriteIds.has(String(orderId));
  }

  //Render line items into a compact list (expanded details panel)
  function renderItems(items) {
    if (!Array.isArray(items) || !items.length) {
      return `<div class="text-muted small">No items found for this order.</div>`;
    }

    const rows = items
      .map((it) => {
        const name = CC.escapeHtml(it.product_name ?? "Item");
        const farm = CC.escapeHtml(it.farm_name ?? "—");
        const qty = Number(it.quantity ?? 0);
        const unit = CC.formatMoney(it.unit_price ?? 0);
        const line = CC.formatMoney(it.line_total ?? 0);

        return `
          <div class="d-flex justify-content-between align-items-start gap-3 py-1 border-bottom">
            <div class="flex-grow-1">
              <div class="fw-semibold">${name}</div>
              <div class="text-muted small">Farm: ${farm} • Qty: ${qty} • Unit: ${unit}</div>
            </div>
            <div class="text-nowrap fw-semibold">${line}</div>
          </div>
        `;
      })
      .join("");

    return `<div class="cc-card p-2">${rows}</div>`;
  }

  // Render per-farm confirmations if present
  function renderFarmConfirmations(farmConfirmations, allConfirmed) {
    if (!Array.isArray(farmConfirmations) || !farmConfirmations.length)
      return "";

    const pills = farmConfirmations
      .map((fc) => {
        const name = CC.escapeHtml(fc.farm_name ?? "Farm");
        const ok = !!fc.is_confirmed;
        const when = ok ? formatDateTime(fc.confirmed_at) : "pending";
        const kind = ok ? "success" : "warning";

        return `
          <span class="badge rounded-pill text-bg-${kind} me-1 mb-1">
            ${name}: ${CC.escapeHtml(when)}
          </span>
        `;
      })
      .join("");

    const headline = allConfirmed
      ? `<div class="text-success small mb-1"><i class="bi bi-check2-circle"></i> All farms confirmed</div>`
      : `<div class="text-warning small mb-1"><i class="bi bi-hourglass-split"></i> Awaiting farm confirmation</div>`;

    return `
      <div class="mt-2 d-flex align-content-center">
        ${headline}
        <div>${pills}</div>
      </div>
    `;
  }

  /** Builds the details row HTML (expanded view) */
  function renderDetailsRow(order) {
    const ship = order?.shipping_address;
    const shippingBlock = ship
      ? `
        <div class="small text-muted">
          <div class="fw-semibold text-dark mb-1">Shipping</div>
          <div>${CC.escapeHtml([ship.line1, ship.line2].filter(Boolean).join(" "))}</div>
          <div>${CC.escapeHtml([ship.city, ship.state, ship.zip].filter(Boolean).join(", "))}</div>
        </div>
      `
      : "";

    const farmBlock = renderFarmConfirmations(
      order?.farm_confirmations,
      order?.all_farms_confirmed,
    );

    return `
      <tr class="cc-order-details-row">
        <td colspan="5">
          <div class="p-2 p-md-3">
            <div class="row g-3">
              <div class="col-12 col-lg-7">
                <div class="d-flex fw-semibold mb-2 justify-content-center">Items</div>
                ${renderItems(order?.items)}
                ${farmBlock}
              </div>

              <div class="col-12 col-lg-5 cc-order-details-card">
                <div class="d-flex fw-semibold mb-2 justify-content-center">Cost</div>
                <div class="cc-card p-3 h-100">
                  <div class="d-flex justify-content-between">
                    <span class="text-muted">Subtotal</span>
                    <span>${CC.formatMoney(order?.subtotal_amount ?? 0)}</span>
                  </div>
                  <div class="d-flex justify-content-between">
                    <span class="text-muted">Tax</span>
                    <span>${CC.formatMoney(order?.tax_amount ?? 0)}</span>
                  </div>
                  <hr class="my-2">
                  <div class="d-flex justify-content-between fw-bold">
                    <span>Total</span>
                    <span>${CC.formatMoney(order?.total_amount ?? 0)}</span>
                  </div>
                  ${shippingBlock ? `<hr class="my-2">` : ""}
                  ${shippingBlock}
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    `;
  }

  /** Close any expanded details rows */
  function collapseAllDetails() {
    CC.qsa(".cc-order-details-row").forEach((tr) => tr.remove());
    CC.qsa("[data-action='toggle-details'][aria-expanded='true']").forEach(
      (btn) => {
        btn.setAttribute("aria-expanded", "false");
        btn.innerHTML = 'More Information <i class="bi bi-chevron-down"></i>';
      },
    );
  }

  /**
   * Final list shown in the table.
   * Combines filter + favorites toggle + search + sort.
   */
  function getViewOrders() {
    let list = [...allOrders];

    // 1) Status filter
    const selectedStatus = String(statusFilterEl?.value || "all")
      .trim()
      .toLowerCase();
    if (selectedStatus && selectedStatus !== "all") {
      list = list.filter(
        (o) => String(o.status || "").toLowerCase() === selectedStatus,
      );
    }

    // 2) Favorites only
    if (favoritesOnlyEl?.checked) {
      list = list.filter((o) => isFavorited(o.id));
    }

    // 3) Search (order id, status label, item names, farm names)
    const q = String(searchEl?.value || "")
      .trim()
      .toLowerCase();
    if (q) {
      list = list.filter((o) => {
        const idText = String(o.id ?? "").toLowerCase();
        const statusText = String(
          o.status_display ?? o.status ?? "",
        ).toLowerCase();
        const items = Array.isArray(o.items) ? o.items : [];
        const itemText = items
          .map((it) => `${it.product_name ?? ""} ${it.farm_name ?? ""}`)
          .join(" ")
          .toLowerCase();

        return (
          idText.includes(q) ||
          `#${idText}`.includes(q) ||
          statusText.includes(q) ||
          itemText.includes(q)
        );
      });
    }

    // 4) Sort
    const sortValue = String(sortEl?.value || "newest")
      .trim()
      .toLowerCase();
    const statusSortOrder = {
      payment_pending: 1,
      received: 2,
      packed: 3,
      out_for_delivery: 4,
      delivered: 5,
      cancelled: 6,
    };

    list.sort((a, b) => {
      const aCreated = new Date(a.created_at || 0).getTime();
      const bCreated = new Date(b.created_at || 0).getTime();

      if (sortValue === "oldest") return aCreated - bCreated;
      if (sortValue === "total_desc")
        return toNumber(b.total_amount) - toNumber(a.total_amount);
      if (sortValue === "total_asc")
        return toNumber(a.total_amount) - toNumber(b.total_amount);
      if (sortValue === "status") {
        const as = statusSortOrder[String(a.status || "").toLowerCase()] ?? 999;
        const bs = statusSortOrder[String(b.status || "").toLowerCase()] ?? 999;
        if (as !== bs) return as - bs;
        return bCreated - aCreated; // newest first within the same status
      }

      // default newest first
      return bCreated - aCreated;
    });

    return list;
  }

  /** Render the orders table body */
  function renderOrdersTable(orders) {
    if (!tbodyEl) return;

    if (!Array.isArray(orders) || !orders.length) {
      tbodyEl.innerHTML = `
        <tr>
          <td colspan="5">
            <div class="alert alert-light border mb-0">
              No matching orders.
              <a href="index.html" class="alert-link">Shop the store</a>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbodyEl.innerHTML = orders
      .map((o) => {
        const id = String(o.id ?? "");
        const createdAt = formatDateTime(o.created_at);
        const total = CC.formatMoney(o.total_amount ?? 0);
        const status = statusBadge(o.status, o.status_display);
        const fav = isFavorited(id);
        const starIcon = fav ? "bi-star-fill" : "bi-star";
        const favTitle = fav ? "Remove from favorites" : "Add to favorites";

        return `
          <tr>
            <td class="px-3 text-nowrap">#${CC.escapeHtml(id)}</td>
            <td>${status}</td>
            <td class="text-nowrap fw-semibold">${total}</td>
            <td class="text-nowrap">${CC.escapeHtml(createdAt)}</td>
            <td class="text-end px-3">
              <div class="d-inline-flex align-items-center gap-2">
                <button
                  class="btn btn cc-btn"
                  type="button"
                  data-action="reorder"
                  data-order-id="${CC.escapeHtml(id)}"
                  title="Add these items to your cart"
                >
                  Reorder
                </button>

                <button
                  class="btn cc-btn-outline"
                  type="button"
                  data-action="toggle-details"
                  data-order-id="${CC.escapeHtml(id)}"
                  aria-expanded="false"
                  title="View order details"
                >
                 More Information <i class="bi bi-chevron-down"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  /** Render optional summary card if markup exists */
  function renderSummary(summary) {
    if (!summaryWrapEl) return;

    const totalOrders = summary?.total_orders ?? summary?.totalOrders ?? null;
    const totalSpent = summary?.total_spent ?? summary?.totalSpent ?? null;
    const avg =
      summary?.average_order_value ?? summary?.averageOrderValue ?? null;

    if (totalOrders === null && totalSpent === null && avg === null) {
      summaryWrapEl.classList.add("d-none");
      return;
    }

    summaryWrapEl.classList.remove("d-none");

    if (summaryTotalOrdersEl)
      summaryTotalOrdersEl.textContent = totalOrders ?? "—";
    if (summaryTotalSpentEl)
      summaryTotalSpentEl.textContent = CC.formatMoney(totalSpent ?? "—");
    if (summaryAvgOrderEl)
      summaryAvgOrderEl.textContent = CC.formatMoney(avg ?? "—");
  }

  /** Rerender using current UI controls (no refetch) */
  function renderFromState() {
    collapseAllDetails();
    const view = getViewOrders();
    renderOrdersTable(view);
    CC.setStatus(
      pageStatusEl,
      `Showing ${view.length} order${view.length === 1 ? "" : "s"}.`,
      "success",
    );
  }

  // -------------------------
  // API
  // -------------------------

  /**
   * Fetch orders.
   * Primary: /orders/history/ (includes summary)
   * Fallback: /orders/ (older list endpoint)
   */
  async function fetchOrders() {
    const status = String(statusFilterEl?.value || "all").trim();
    const query =
      status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";

    let res = await CC.apiRequest(`/orders/history/${query}`, {
      method: "GET",
    });
    if (res.status === 401) return handleUnauthorized();

    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await CC.apiRequest(`/orders/${query}`, { method: "GET" });
      if (res.status === 401) return handleUnauthorized();
    }

    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    if (Array.isArray(res.data)) {
      return { summary: null, orders: res.data };
    }

    return {
      summary: res.data?.summary || null,
      orders: Array.isArray(res.data?.orders) ? res.data.orders : [],
    };
  }

  /**
   * Import (reorder) — adds a past order’s items back into the current cart.
   * Uses POST /api/cart/add/ for each product.
   */
  async function importOrderToCart(order) {
    const orderId = String(order?.id ?? "").trim();
    const items = Array.isArray(order?.items) ? order.items : [];

    if (!orderId || !items.length) {
      CC.setStatus(
        pageStatusEl,
        "This order has no items to import.",
        "warning",
      );
      return;
    }

    CC.setStatus(
      pageStatusEl,
      `Importing order #${orderId} into your cart…`,
      "muted",
    );

    const failures = [];

    for (const it of items) {
      const productId = Number(it.product_id);
      const qty = Number(it.quantity ?? 0);

      if (
        !Number.isFinite(productId) ||
        productId <= 0 ||
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        failures.push({
          name: String(it.product_name ?? "Item"),
          reason: "Invalid product/quantity",
        });
        continue;
      }

      const res = await CC.apiRequest("/cart/add/", {
        method: "POST",
        json: {
          product_id: productId,
          quantity: qty,
        },
      });

      if (res.status === 401) return handleUnauthorized();

      if (!res.ok) {
        failures.push({
          name: String(it.product_name ?? `Product ${productId}`),
          reason: String(
            res.data?.error ||
              res.data?.detail ||
              res.raw ||
              `HTTP ${res.status}`,
          ),
        });
      }
    }

    if (!failures.length) {
      CC.setStatus(
        pageStatusEl,
        `Imported order #${orderId} into your cart.`,
        "success",
      );
      window.location.href = "cart.html?imported=1";
      return;
    }

    const failureText = failures
      .slice(0, 3)
      .map((f) => `${f.name}: ${f.reason}`)
      .join("; ");

    const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : "";

    CC.setStatus(
      pageStatusEl,
      `Error adding to cart. ${failureText}${more}. Added any remaining items that are available and in stock to your cart.`,
      "danger",
    );
  }

  // -------------------------
  // Events + page flow
  // -------------------------

  async function refresh() {
    CC.setStatus(pageStatusEl, "Loading orders…", "muted");
    collapseAllDetails();

    const { summary, orders } = await fetchOrders();

    allOrders = Array.isArray(orders) ? orders : [];
    renderSummary(summary);

    const view = getViewOrders();
    renderOrdersTable(view);

    CC.setStatus(pageStatusEl, ``, "success");
  }

  function wireEvents() {
    refreshBtn?.addEventListener("click", () => {
      refresh().catch((err) => {
        console.error(err);
        CC.setStatus(
          pageStatusEl,
          `Failed to load orders: ${err.message}`,
          "danger",
        );
      });
    });

    // Search/sort/favorites toggle are client-side.
    searchEl?.addEventListener("input", () => renderFromState());
    sortEl?.addEventListener("change", () => renderFromState());
    favoritesOnlyEl?.addEventListener("change", () => renderFromState());

    // Status filter refetches (keeps summary accurate)
    statusFilterEl?.addEventListener("change", () => {
      refresh().catch((err) => {
        console.error(err);
        CC.setStatus(
          pageStatusEl,
          `Failed to load orders: ${err.message}`,
          "danger",
        );
      });
    });

    // Row action buttons (event delegation)
    tbodyEl?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-action]");
      if (!btn) return;

      const action = String(btn.getAttribute("data-action") || "").trim();
      const id = String(btn.getAttribute("data-order-id") || "").trim();
      if (!id) return;

      // Favorite toggle
      if (action === "favorite") {
        toggleFavorite(id);
        renderFromState();
        return;
      }

      const order = allOrders.find((o) => String(o.id) === id);
      if (!order) return;

      if (action === "reorder") {
        importOrderToCart(order).catch((err) => {
          console.error(err);
          CC.setStatus(pageStatusEl, `Import failed: ${err.message}`, "danger");
        });
        return;
      }

      if (action === "toggle-details") {
        const expanded = btn.getAttribute("aria-expanded") === "true";

        collapseAllDetails();
        if (expanded) return;

        const tr = btn.closest("tr");
        if (!tr) return;

        tr.insertAdjacentHTML("afterend", renderDetailsRow(order));
        btn.setAttribute("aria-expanded", "true");
        btn.innerHTML = 'More Information <i class="bi bi-chevron-up"></i>';
      }
    });
  }

  // -------------------------
  // Boot
  // -------------------------

  CC.onReady(() => {
    loadFavorites();
    wireEvents();

    const url = new URL(window.location.href);
    if (url.searchParams.get("success") === "1") {
      CC.setStatus(
        pageStatusEl,
        "Payment successful — your order is now in your history.",
        "success",
      );
      url.searchParams.delete("success");
      window.history.replaceState({}, "", url.toString());
    }

    refresh().catch((err) => {
      console.error(err);
      CC.setStatus(
        pageStatusEl,
        `Failed to load orders: ${err.message}`,
        "danger",
      );
    });
  });
})();
