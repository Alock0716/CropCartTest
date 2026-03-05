/**
 * ============================================================================
 * farmer.js — Farmer Portal (FULL REPLACEMENT)
 * ----------------------------------------------------------------------------
 * Stripe behavior (per your requirement):
 * - NO use of /farmer/stripe/onboarding/
 * - Uses only:
 *    - GET  /farmer/stripe/account/    -> status (connected, payouts_enabled, etc.)
 *    - POST /farmer/stripe/account     -> returns link { url, stripe_account_id }
 *    - GET  /farmer/stripe/refresh/    -> returns {status,message} (ex link_expired)
 *    - GET  /farmer/stripe/return/     -> returns {status,stripe_account_id}
 *
 * What the Stripe button does:
 * - Always opens a Stripe link (new tab) from POST /farmer/stripe/account
 * - If the link is expired, it refreshes by calling POST /account again
 *
 * NOTE:
 * - Farmer endpoints are rooted at /farmer/* (NOT /api/farmer/*)
 * - Auth token may be stored in cc_farmer_auth OR cc_auth
 * ============================================================================
 */

(function FarmerPortal() {
  "use strict";

  // ==========================================================================
  // CONFIG / BASE URLS
  // ==========================================================================

  const CFG = window.__CROPCART_CONFIG__ || {};
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, ""); // ex: https://host/api
  const ROOT_BASE = API_BASE ? API_BASE.replace(/\/api$/i, "") : ""; // ex: https://host

  // ==========================================================================
  // DOM
  // ==========================================================================

  // Global status line (optional)
  const pageStatus = document.getElementById("pageStatus");

  // Inventory
  const inventoryBody = document.getElementById("inventoryBody");
  const refreshInventoryBtn = document.getElementById("refreshInventoryBtn");
  const invSearch = document.getElementById("invSearch");

  // Orders
  const farmerOrdersBody = document.getElementById("farmerOrdersBody");
  const refreshFarmerOrdersBtn = document.getElementById("refreshFarmerOrdersBtn");

  // Add product
  const addProductForm = document.getElementById("addProductForm");
  const addProductBtn = document.getElementById("addProductBtn");

  // Stripe UI (optional but expected on farmer.html)
  const stripeStatusBox = document.getElementById("stripeStatusBox");
  const connectStripeBtn = document.getElementById("connectStripeBtn");

  // Sales UI (optional)
  const refreshSalesBtn = document.getElementById("refreshSalesBtn");
  const applySalesRangeBtn = document.getElementById("applySalesRangeBtn");
  const salesFrom = document.getElementById("salesFrom");
  const salesTo = document.getElementById("salesTo");
  const salesStatus = document.getElementById("salesStatus");
  const salesSummary = document.getElementById("salesSummary");
  const salesTableBody = document.getElementById("salesTableBody");
  const salesRaw = document.getElementById("salesRaw");

  // Edit Product Modal (optional if your page includes it)
  const editProductModalEl = document.getElementById("editProductModal");
  const editProductForm = document.getElementById("editProductForm");

  const epId = document.getElementById("epId");
  const epName = document.getElementById("epName");
  const epDescription = document.getElementById("epDescription");
  const epCategory = document.getElementById("epCategory");
  const epPrice = document.getElementById("epPrice");
  const epStock = document.getElementById("epStock");
  const epIsActive = document.getElementById("epIsActive");
  const epPhoto = document.getElementById("epPhoto");

  const epStatus = document.getElementById("epStatus");
  const epSaveBtn = document.getElementById("epSaveBtn");
  const epCurrentPhoto = document.getElementById("epCurrentPhoto");

  const editModal =
    editProductModalEl && window.bootstrap?.Modal
      ? new bootstrap.Modal(editProductModalEl)
      : null;

  // ==========================================================================
  // STATE
  // ==========================================================================

  let inventory = [];
  let orders = [];

  // Cached Stripe status so UI can decide label/behavior quickly
  let stripeStatusCache = null;

  // ==========================================================================
  // UI HELPERS
  // ==========================================================================

  function setStatus(msg, kind = "muted") {
    if (!pageStatus) return;
    pageStatus.textContent = msg || "";
    pageStatus.className = `small text-${kind}`;
  }

  function setStripeStatus(msg, kind = "muted") {
    if (!stripeStatusBox) return;
    stripeStatusBox.textContent = msg || "";
    stripeStatusBox.className = `small text-${kind} mb-3`;
  }

  function setEditStatus(msg, kind = "muted") {
    if (!epStatus) return;
    epStatus.textContent = msg || "";
    epStatus.className = `small text-${kind}`;
  }

  function setSalesStatus(msg, kind = "muted") {
    if (!salesStatus) return;
    salesStatus.textContent = msg || "—";
    salesStatus.className = `small text-${kind} mb-2`;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showProvider401Help() {
    setStatus(
      "401 Unauthorized. Farmer Portal requires a provider/farmer session. " +
        "Log in with your farmer account (and ensure it’s approved).",
      "danger",
    );
  }

  // ==========================================================================
  // AUTH / FETCH HELPERS
  // ==========================================================================

  function safeJsonParse(v) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  function getProviderAuth() {
    return (
      safeJsonParse(sessionStorage.getItem("cc_farmer_auth")) ||
      safeJsonParse(localStorage.getItem("cc_farmer_auth"))
    );
  }

  function getCustomerAuth() {
    if (typeof getAuth === "function") return getAuth();
    return (
      safeJsonParse(sessionStorage.getItem("cc_auth")) ||
      safeJsonParse(localStorage.getItem("cc_auth"))
    );
  }

  function getBestAccessToken() {
    const provider = getProviderAuth();
    if (provider?.access) return String(provider.access);

    const customer = getCustomerAuth();
    if (customer?.access) return String(customer.access);

    return "";
  }

  function authHeaders(extra = {}) {
    const token = getBestAccessToken();
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
  }

  async function readJsonOrText(res) {
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
      raw: text,
      headers: res.headers,
    };
  }

  // ==========================================================================
  // STRIPE — NEW FLOW (ACCOUNT / REFRESH / RETURN)
  // ==========================================================================

  /**
   * GET /farmer/stripe/account/
   * Returns:
   * { connected, stripe_account_id, charges_enabled, payouts_enabled, details_submitted }
   */
  async function fetchStripeAccountStatus() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account/`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      throw new Error(parsed.data?.error || parsed.raw || `Stripe status failed (HTTP ${parsed.status})`);
    }

    const d = parsed.data || {};
    return {
      connected: Boolean(d.connected),
      stripe_account_id: d.stripe_account_id || null,
      charges_enabled: Boolean(d.charges_enabled),
      payouts_enabled: Boolean(d.payouts_enabled),
      details_submitted: Boolean(d.details_submitted),
      raw: d,
    };
  }

  /**
   * POST /farmer/stripe/account
   * Returns:
   * { url, stripe_account_id }
   *
   * You want this route to be the source of the "connection page link" and
   * also the link we open for payouts/earnings statements.
   */
  async function fetchStripeConnectionLink() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders({
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({}), // API accepts empty payload based on your probe
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      throw new Error(parsed.data?.error || parsed.raw || `Stripe link fetch failed (HTTP ${parsed.status})`);
    }

    const d = parsed.data || {};
    return {
      url: d.url || "",
      stripe_account_id: d.stripe_account_id || null,
      raw: d,
    };
  }

  /**
   * GET /farmer/stripe/refresh/
   * Returns:
   * { status: "link_expired", message: "..." } (example)
   *
   * We'll call this when we fail to open or when status indicates a stale link.
   */
  async function fetchStripeRefreshStatus() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/refresh/`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      throw new Error(parsed.data?.error || parsed.raw || `Stripe refresh failed (HTTP ${parsed.status})`);
    }

    return parsed.data || {};
  }

  /**
   * GET /farmer/stripe/return/
   * Returns:
   * { status: "onboarding_complete", stripe_account_id }
   *
   * Useful after coming back from Stripe. If the user isn't redirected to
   * farmer.html, this still won't fire; but it’s harmless and nice for status.
   */
  async function fetchStripeReturnStatus() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/return/`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      throw new Error(parsed.data?.error || parsed.raw || `Stripe return check failed (HTTP ${parsed.status})`);
    }

    return parsed.data || {};
  }

  function renderStripeStatusUI(statusObj) {
    stripeStatusCache = statusObj;

    if (!stripeStatusBox || !connectStripeBtn) return;

    const {
      connected,
      stripe_account_id,
      charges_enabled,
      payouts_enabled,
      details_submitted,
    } = statusObj || {};

    // Determine "ready" state
    const fullyReady = Boolean(connected && charges_enabled && payouts_enabled && details_submitted);

    if (fullyReady) {
      setStripeStatus(
        `Stripe connected ✅ (acct: ${stripe_account_id || "—"})`,
        "success",
      );
      connectStripeBtn.textContent = "Open Stripe payouts & earnings";
      connectStripeBtn.dataset.mode = "open_dashboard";
      return;
    }

    // Not fully ready
    const bits = [
      connected ? "connected" : "not connected",
      charges_enabled ? "charges enabled" : "charges not enabled",
      payouts_enabled ? "payouts enabled" : "payouts not enabled",
      details_submitted ? "details submitted" : "details not submitted",
    ].join(" • ");

    setStripeStatus(
      `Stripe setup incomplete ⚠ (${bits})`,
      "warning",
    );
    connectStripeBtn.textContent = "Finish Stripe setup";
    connectStripeBtn.dataset.mode = "open_setup";
  }

  async function refreshStripePanel({ showSpinner = true } = {}) {
    if (!connectStripeBtn) return;

    if (showSpinner) {
      connectStripeBtn.disabled = true;
      setStripeStatus("Checking Stripe status…", "muted");
    }

    try {
      const s = await fetchStripeAccountStatus();
      renderStripeStatusUI(s);
    } catch (err) {
      setStripeStatus(err?.message || String(err), "danger");
      if (connectStripeBtn) {
        connectStripeBtn.textContent = "Retry Stripe status";
        connectStripeBtn.dataset.mode = "retry";
      }
    } finally {
      if (showSpinner && connectStripeBtn) connectStripeBtn.disabled = false;
    }
  }

  /**
   * Called when user presses the Stripe button.
   * Requirement:
   * - get connection page link via /farmer/stripe/account
   * - open Stripe for payouts/earnings in a new tab
   */
  async function handleStripeButtonClick() {
    if (!connectStripeBtn) return;

    connectStripeBtn.disabled = true;

    try {
      // Quick refresh check: if backend says link expired, we’ll just fetch a fresh link.
      // (We don't have a persistent link in UI; we always ask server for it.)
      let refreshInfo = null;
      try {
        refreshInfo = await fetchStripeRefreshStatus();
      } catch {
        // Refresh route might not always be meaningful; ignore failures
        refreshInfo = null;
      }

      if (refreshInfo?.status === "link_expired") {
        setStripeStatus(refreshInfo.message || "Stripe link expired. Getting a new link…", "warning");
      } else {
        setStripeStatus("Getting Stripe link…", "muted");
      }

      const link = await fetchStripeConnectionLink();

      if (!link.url) {
        throw new Error("Stripe did not return a URL. (Missing 'url' field)");
      }

      // Open in new tab (payouts / earnings statements / account)
      window.open(link.url, "_blank", "noopener,noreferrer");

      // After opening, refresh status so UI is accurate if they completed something quickly
      // (Also check /return/ as a lightweight signal)
      try {
        const ret = await fetchStripeReturnStatus();
        if (ret?.status === "onboarding_complete") {
          setStripeStatus("Stripe onboarding complete ✅ Updating status…", "success");
        }
      } catch {
        // ignore
      }

      await refreshStripePanel({ showSpinner: false });
    } catch (err) {
      setStripeStatus(err?.message || String(err), "danger");
    } finally {
      connectStripeBtn.disabled = false;
    }
  }

  // ==========================================================================
  // SALES REPORT — GET /farmer/sales/
  // ==========================================================================

  function clearSalesUI() {
    if (salesSummary) salesSummary.innerHTML = "";
    if (salesTableBody) salesTableBody.innerHTML = "";
    if (salesRaw) salesRaw.textContent = "";
  }

  function renderSalesReport(data) {
    clearSalesUI();

    if (salesRaw) salesRaw.textContent = JSON.stringify(data, null, 2);

    const summary = data?.summary || {};
    const period = data?.period || {};
    const farm = data?.farm || {};
    const daily = Array.isArray(data?.daily_breakdown) ? data.daily_breakdown : [];
    const top = Array.isArray(data?.top_products) ? data.top_products : [];

    // Summary chips
    if (salesSummary) {
      const chips = [];

      if (farm?.name || farm?.farm_name) {
        chips.push(["Farm", farm.name || farm.farm_name]);
      }
      if (period?.start || period?.from) {
        chips.push(["From", period.start || period.from]);
      }
      if (period?.end || period?.to) {
        chips.push(["To", period.end || period.to]);
      }

      // Common summary fields (best effort)
      if (summary?.orders !== undefined) chips.push(["Orders", summary.orders]);
      if (summary?.items !== undefined) chips.push(["Items", summary.items]);
      if (summary?.revenue !== undefined) chips.push(["Revenue", summary.revenue]);
      if (summary?.total !== undefined) chips.push(["Total", summary.total]);

      salesSummary.innerHTML = `
        <div class="d-flex flex-wrap gap-2">
          ${chips
            .map(([k, v]) => `<span class="badge text-bg-light border">${escapeHtml(k)}: ${escapeHtml(v)}</span>`)
            .join("")}
        </div>
        ${
          top.length
            ? `<div class="small text-muted mt-2">Top products returned: ${top.length}</div>`
            : ""
        }
      `;
    }

    // Daily breakdown table
    if (salesTableBody) {
      if (!daily.length) {
        salesTableBody.innerHTML = `
          <tr>
            <td colspan="4" class="text-muted small">No daily breakdown data for this period.</td>
          </tr>
        `;
      } else {
        salesTableBody.innerHTML = daily
          .map((r) => {
            const date = escapeHtml(r.date ?? r.day ?? "—");
            const orders = escapeHtml(r.orders ?? r.order_count ?? "—");
            const items = escapeHtml(r.items ?? r.item_count ?? "—");
            const total = escapeHtml(r.total ?? r.revenue ?? "—");

            return `
              <tr>
                <td>${date}</td>
                <td>${orders}</td>
                <td>${items}</td>
                <td>${total}</td>
              </tr>
            `;
          })
          .join("");
      }
    }
  }

  async function loadSalesReport({ from = "", to = "" } = {}) {
    if (!refreshSalesBtn && !salesStatus && !salesRaw) return; // no sales UI present

    setSalesStatus("Loading sales report…", "muted");

    // Your API currently works without params; we only add them if UI provides values.
    // If the backend ignores them, that’s fine.
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    const url = `${ROOT_BASE}/farmer/sales/${params.toString() ? `?${params.toString()}` : ""}`;

    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      if (parsed.status === 401) showProvider401Help();
      setSalesStatus(`Sales report failed (HTTP ${parsed.status})`, "danger");
      if (salesRaw) salesRaw.textContent = parsed.raw || "";
      return;
    }

    setSalesStatus("Sales report loaded.", "success");
    renderSalesReport(parsed.data || {});
  }

  // ==========================================================================
  // INVENTORY / ORDERS / PRODUCT CRUD
  // ==========================================================================

  async function loadInventory() {
    if (!inventoryBody) return;

    setStatus("Loading inventory…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/inventory/`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Inventory failed (HTTP ${parsed.status})`, "danger");

      inventory = [];
      renderInventory();
      return;
    }

    inventory = Array.isArray(parsed.data) ? parsed.data : parsed.data?.results || [];
    setStatus("", "success");
    renderInventory();
  }

  function renderInventory() {
    if (!inventoryBody) return;

    const q = String(invSearch?.value || "").trim().toLowerCase();
    const filtered = !q
      ? inventory
      : inventory.filter((p) => {
          const name = String(p.name || "").toLowerCase();
          const cat = String(p.category || "").toLowerCase();
          return name.includes(q) || cat.includes(q);
        });

    if (!filtered.length) {
      inventoryBody.innerHTML = `
        <tr>
          <td colspan="5" class="text-muted small">No inventory items found.</td>
        </tr>
      `;
      return;
    }

    inventoryBody.innerHTML = filtered
      .map((p) => {
        const id = p.id ?? p.product_id ?? "";
        const name = escapeHtml(p.name ?? "—");
        const category = escapeHtml(p.category ?? "—");
        const price = escapeHtml(p.price ?? "—");
        const stock = escapeHtml(p.stock ?? p.quantity ?? "—");

        return `
          <tr>
            <td class="fw-semibold">${name}</td>
            <td>${category}</td>
            <td>${price}</td>
            <td>${stock}</td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary me-2" data-edit="${escapeHtml(id)}">
                Edit
              </button>
              <button class="btn btn-sm btn-outline-danger" data-del="${escapeHtml(id)}">
                Delete
              </button>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function loadOrders() {
    if (!farmerOrdersBody) return;

    setStatus("Loading orders…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Orders failed (HTTP ${parsed.status})`, "danger");

      orders = [];
      renderOrders();
      return;
    }

    orders = Array.isArray(parsed.data) ? parsed.data : parsed.data?.results || [];
    setStatus("", "success");
    renderOrders();
  }

  function renderOrders() {
    if (!farmerOrdersBody) return;

    if (!orders.length) {
      farmerOrdersBody.innerHTML = `
        <tr>
          <td colspan="4" class="text-muted small">No incoming orders.</td>
        </tr>
      `;
      return;
    }

    farmerOrdersBody.innerHTML = orders
      .map((o) => {
        const orderId = escapeHtml(o.id ?? o.order_id ?? "—");
        const customer = escapeHtml(o.customer ?? o.customer_name ?? o.email ?? "—");
        const status = escapeHtml(o.status ?? "—");

        const canConfirm =
          String(status).toLowerCase().includes("paid") ||
          String(status).toLowerCase().includes("pending");

        return `
          <tr>
            <td class="fw-semibold">#${orderId}</td>
            <td>${customer}</td>
            <td>${status}</td>
            <td class="text-end">
              ${
                canConfirm
                  ? `<button class="btn btn-sm btn-outline-cc" data-confirm="${orderId}">Confirm</button>`
                  : `<span class="text-muted small">—</span>`
              }
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function confirmOrder(orderId) {
    setStatus("Confirming…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/${encodeURIComponent(orderId)}/confirm/`, {
      method: "PUT",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Confirm failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("", "success");
    await loadOrders();
  }

  async function createProductFromForm() {
    if (!addProductBtn || !addProductForm) return;

    setStatus("Creating product…", "muted");
    addProductBtn.disabled = true;

    try {
      const pName = document.getElementById("pName")?.value || "";
      const pPrice = document.getElementById("pPrice")?.value || "";
      const pQty = document.getElementById("pQty")?.value || "";
      const pCategory = document.getElementById("pCategory")?.value || "";
      const pImage = document.getElementById("pImage");

      const fd = new FormData();
      fd.append("name", pName);
      fd.append("price", pPrice);
      fd.append("stock", pQty);
      fd.append("category", pCategory);

      const file = pImage?.files?.[0];
      if (file) fd.append("photo", file);

      const res = await fetch(`${ROOT_BASE}/farmer/products/`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders({ Accept: "application/json" }), // don't set Content-Type for FormData
        body: fd,
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) {
        if (parsed.status === 401) showProvider401Help();
        else setStatus(`Create failed (HTTP ${parsed.status})`, "danger");
        return;
      }

      setStatus("Product created ✅", "success");
      addProductForm.reset();
      await loadInventory();
    } finally {
      addProductBtn.disabled = false;
    }
  }

  function findProductById(productId) {
    return inventory.find((p) => String(p.id ?? p.product_id) === String(productId)) || null;
  }

  function openEditProductModal(productId) {
    if (!editModal) return;

    const p = findProductById(productId);
    if (!p) return;

    if (epId) epId.value = String(p.id ?? p.product_id ?? "");
    if (epName) epName.value = String(p.name ?? "");
    if (epDescription) epDescription.value = String(p.description ?? "");
    if (epCategory) epCategory.value = String(p.category ?? "");
    if (epPrice) epPrice.value = String(p.price ?? "");
    if (epStock) epStock.value = String(p.stock ?? p.quantity ?? "");
    if (epIsActive) epIsActive.checked = Boolean(p.is_active ?? p.active ?? true);

    if (epCurrentPhoto) {
      const url = p.photo_url || p.image_url || "";
      epCurrentPhoto.textContent = url ? `Current: ${url}` : "No current photo.";
    }

    setEditStatus("", "muted");
    editModal.show();
  }

  async function submitEditProduct() {
    if (!editProductForm || !epSaveBtn) return;

    const productId = epId?.value || "";
    if (!productId) return;

    setEditStatus("Saving…", "muted");
    epSaveBtn.disabled = true;

    try {
      const fd = new FormData();
      fd.append("name", epName?.value || "");
      fd.append("description", epDescription?.value || "");
      fd.append("category", epCategory?.value || "");
      fd.append("price", epPrice?.value || "");
      fd.append("stock", epStock?.value || "");
      fd.append("is_active", epIsActive?.checked ? "true" : "false");

      const file = epPhoto?.files?.[0];
      if (file) fd.append("photo", file);

      const res = await fetch(`${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/`, {
        method: "PUT",
        credentials: "include",
        headers: authHeaders({ Accept: "application/json" }),
        body: fd,
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) {
        setEditStatus(`Save failed (HTTP ${parsed.status})`, "danger");
        return;
      }

      setEditStatus("Saved ✅", "success");
      await loadInventory();
      editModal.hide();
    } finally {
      epSaveBtn.disabled = false;
    }
  }

  async function deleteProduct(productId) {
    setStatus("Deleting…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Delete failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("", "success");
    await loadInventory();
  }

  // ==========================================================================
  // EVENTS
  // ==========================================================================

  function wireEvents() {
    invSearch?.addEventListener("input", renderInventory);
    refreshInventoryBtn?.addEventListener("click", loadInventory);

    refreshFarmerOrdersBtn?.addEventListener("click", loadOrders);

    addProductForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      createProductFromForm();
    });

    inventoryBody?.addEventListener("click", (e) => {
      const editBtn = e.target?.closest?.("[data-edit]");
      const delBtn = e.target?.closest?.("[data-del]");

      const editId = editBtn?.getAttribute?.("data-edit");
      const delId = delBtn?.getAttribute?.("data-del");

      if (editId) openEditProductModal(editId);
      if (delId) deleteProduct(delId);
    });

    farmerOrdersBody?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-confirm]");
      const id = btn?.getAttribute?.("data-confirm");
      if (id) confirmOrder(id);
    });

    editProductForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitEditProduct();
    });

    // Stripe button: opens Stripe dashboard/setup link from POST /account
    connectStripeBtn?.addEventListener("click", handleStripeButtonClick);

    // Sales
    refreshSalesBtn?.addEventListener("click", () => loadSalesReport());
    applySalesRangeBtn?.addEventListener("click", () => {
      const from = salesFrom?.value || "";
      const to = salesTo?.value || "";
      loadSalesReport({ from, to });
    });
  }

  // ==========================================================================
  // INIT
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", async () => {
    wireEvents();

    // Core portal data
    await loadInventory();
    await loadOrders();

    // Stripe status panel (no redirect)
    await refreshStripePanel({ showSpinner: true });

    // Sales report (if UI exists)
    await loadSalesReport();

    // Optional: if the user came back from Stripe in THIS tab,
    // we can check return status and refresh Stripe panel.
    // This is harmless even if they didn’t come from Stripe.
    try {
      const ret = await fetchStripeReturnStatus();
      if (ret?.status === "onboarding_complete") {
        setStripeStatus("Stripe onboarding complete ✅", "success");
        await refreshStripePanel({ showSpinner: false });
      }
    } catch {
      // ignore
    }
  });
})();