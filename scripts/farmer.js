/**
 * ============================================================================
 * farmer.js — Farmer Portal logic
 * ----------------------------------------------------------------------------
 * IMPORTANT:
 * - Farmer routes are rooted at /farmer/* (NOT /api/farmer/*)
 * - Provider auth may be stored separately as "cc_farmer_auth"
 *
 * Stripe changes (per updated API routes):
 * - Uses server routes:
 *    - farmer/stripe/account          (create account)
 *    - farmer/stripe/account/         (status)
 *    - farmer/stripe/onboarding/      (request onboarding link/email)
 *    - farmer/stripe/return/          (Stripe redirect target - backend only)
 *    - farmer/stripe/refresh/         (Stripe refresh target - backend only)
 * - Onboarding is NOT performed from the portal (no redirect to Stripe here).
 *
 * Sales changes:
 * - Uses farmer/sales/ for farmer sales reporting.
 * ============================================================================
 */

(function FarmerPortal() {
  "use strict";

  // ==========================================================================
  // CONFIG / BASE URLS
  // ==========================================================================

  /**
   * window.__CROPCART_CONFIG__ is populated by config.js
   * API_URL is expected to be something like:
   *   http(s)://<host>/api
   *
   * Farmer endpoints live at:
   *   http(s)://<host>/farmer/...
   */
  const CFG = window.__CROPCART_CONFIG__ || {};

  // API base (usually ends with /api)
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, "");

  // Root base (strip trailing /api)
  const ROOT_BASE = API_BASE.replace(/\/api$/i, "");

  // ==========================================================================
  // DOM (IDs must match farmer.html)
  // ==========================================================================

  // Global status line
  const pageStatus = document.getElementById("pageStatus");

  // Inventory table
  const inventoryBody = document.getElementById("inventoryBody");
  const refreshInventoryBtn = document.getElementById("refreshInventoryBtn");
  const invSearch = document.getElementById("invSearch");

  // Orders table
  const farmerOrdersBody = document.getElementById("farmerOrdersBody");
  const refreshFarmerOrdersBtn = document.getElementById("refreshFarmerOrdersBtn");

  // Add product form
  const addProductForm = document.getElementById("addProductForm");
  const addProductBtn = document.getElementById("addProductBtn");

  // Header title
  const farmerPortalTitle = document.getElementById("farmerPortalTitle");

  // Stripe payout setup
  const stripeStatusBox = document.getElementById("stripeStatusBox");
  const connectStripeBtn = document.getElementById("connectStripeBtn");

  // Sales report
  const refreshSalesBtn = document.getElementById("refreshSalesBtn");
  const applySalesRangeBtn = document.getElementById("applySalesRangeBtn");
  const salesFrom = document.getElementById("salesFrom");
  const salesTo = document.getElementById("salesTo");
  const salesStatus = document.getElementById("salesStatus");
  const salesSummary = document.getElementById("salesSummary");
  const salesTableBody = document.getElementById("salesTableBody");
  const salesRaw = document.getElementById("salesRaw");

  // --- Edit Product Modal elements
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

  // Bootstrap modal instance (created once)
  const editModal = editProductModalEl ? new bootstrap.Modal(editProductModalEl) : null;

  // ==========================================================================
  // STATE
  // ==========================================================================

  let inventory = [];
  let orders = [];

  // ==========================================================================
  // UI HELPERS
  // ==========================================================================

  /**
   * Updates the global page status line.
   * @param {string} msg - Message to display
   * @param {"muted"|"success"|"danger"|"warning"|"info"} kind - Bootstrap text color suffix
   */
  function setStatus(msg, kind = "muted") {
    if (!pageStatus) return;
    pageStatus.textContent = msg || "";
    pageStatus.className = `small text-${kind}`;
  }

  /**
   * Updates the edit modal status line.
   * @param {string} msg - Message to display
   * @param {"muted"|"success"|"danger"|"warning"|"info"} kind - Bootstrap text color suffix
   */
  function setEditStatus(msg, kind = "muted") {
    if (!epStatus) return;
    epStatus.textContent = msg || "";
    epStatus.className = `small text-${kind}`;
  }

  function setStripeStatus(msg, kind = "muted") {
    if (!stripeStatusBox) return;
    stripeStatusBox.textContent = msg || "";
    stripeStatusBox.className = `small text-${kind} mb-3`;
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

  function findProductById(productId) {
    return inventory.find((p) => String(p.id ?? p.product_id) === String(productId)) || null;
  }

  /**
   * Farmer endpoints generally require an approved provider account.
   * This message is intentionally explicit so it’s obvious what to do.
   */
  function showProvider401Help() {
    setStatus(
      "401 Unauthorized. Farmer Portal requires an APPROVED provider account. " +
        "If you registered as a provider, wait for admin approval, or log in with your provider credentials.",
      "danger",
    );
  }

  // ==========================================================================
  // AUTH HELPERS
  // ==========================================================================

  /**
   * Reads provider auth from storage if it exists.
   * We use this FIRST because farmer endpoints likely require provider credentials.
   * Expected shape contains `access` for bearer token.
   */
  function getProviderAuth() {
    try {
      const s = sessionStorage.getItem("cc_farmer_auth");
      const l = localStorage.getItem("cc_farmer_auth");
      return JSON.parse(s || l || "null");
    } catch {
      return null;
    }
  }

  /**
   * Reads customer auth from your existing auth.js storage.
   * auth.js stores "cc_auth" and the token field is "access".
   */
  function getCustomerAuth() {
    if (typeof getAuth === "function") return getAuth();
    try {
      const s = sessionStorage.getItem("cc_auth");
      const l = localStorage.getItem("cc_auth");
      return JSON.parse(s || l || "null");
    } catch {
      return null;
    }
  }

  /**
   * Picks the best access token available:
   * - provider token first
   * - customer token fallback
   * @returns {string}
   */
  function getBestAccessToken() {
    const provider = getProviderAuth();
    if (provider?.access) return String(provider.access);

    const customer = getCustomerAuth();
    if (customer?.access) return String(customer.access);

    return "";
  }

  /**
   * Builds headers with Authorization when available.
   * @param {Record<string,string>} extra - additional headers
   */
  function authHeaders(extra = {}) {
    const token = getBestAccessToken();
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
  }

  /**
   * Safely parses a fetch response as JSON (fallback to raw text).
   * Keeps debugging predictable even when API returns HTML or plain text.
   */
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
    };
  }

  // ==========================================================================
  // STRIPE (NEW ROUTES) — NO PORTAL ONBOARDING
  // ==========================================================================

  /**
   * GET farmer/stripe/account/
   * Used to show “connected” vs “needs setup”.
   */
  async function fetchStripeAccountStatus() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      // If they don't have an account yet, some APIs return 404.
      // We treat that as "not created" rather than a hard error.
      if (parsed.status === 404) return { exists: false };
      throw new Error(parsed.data?.error || parsed.raw || `Stripe status failed (HTTP ${parsed.status})`);
    }

    // We keep this flexible because API response shapes can differ.
    // Normalize a couple common patterns into a single object.
    const d = parsed.data || {};
    return {
      exists: true,
      raw: d,
      // Try a few likely fields. If your API uses different names, we still show raw.
      connected: Boolean(d.connected ?? d.is_connected ?? d.payouts_enabled ?? d.charges_enabled),
      onboardingComplete: Boolean(d.onboarding_complete ?? d.details_submitted ?? d.detailsSubmitted),
      accountId: d.account_id ?? d.stripe_account_id ?? d.id ?? null,
    };
  }

  /**
   * POST farmer/stripe/account
   * Creates a Stripe account record/server-side object for this farmer.
   * This should NOT redirect the user.
   */
  async function createStripeAccount() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account`, {
      method: "POST",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      throw new Error(
        parsed.data?.error || parsed.raw || `Create Stripe account failed (HTTP ${parsed.status})`,
      );
    }
    return parsed.data || {};
  }

  /**
   * GET farmer/stripe/onboarding/
   * Portal use: request a new onboarding email/link (no redirect here).
   */
  async function requestStripeOnboardingLink() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/onboarding/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      throw new Error(
        parsed.data?.error || parsed.raw || `Request onboarding failed (HTTP ${parsed.status})`,
      );
    }

    // Some APIs might return { url: "..." } even if you email it too.
    // We DO NOT automatically redirect.
    return parsed.data || {};
  }

  /**
   * Re-renders the Stripe box/button based on server status.
   * This keeps portal behavior aligned with "email-based onboarding".
   */
  async function refreshStripePayoutUi() {
    if (!connectStripeBtn) return;

    setStripeStatus("Checking Stripe connection…", "muted");
    connectStripeBtn.disabled = true;

    try {
      const status = await fetchStripeAccountStatus();

      // No Stripe record yet
      if (!status.exists) {
        setStripeStatus(
          "No Stripe account found for this farm yet. If you just registered, it may take a moment — " +
            "otherwise you can request the setup email.",
          "warning",
        );

        connectStripeBtn.dataset.mode = "create_then_email";
        connectStripeBtn.textContent = "Send Stripe setup email";
        connectStripeBtn.disabled = false;
        return;
      }

      // We have a Stripe record
      // If it looks fully connected
      if (status.connected || status.onboardingComplete) {
        setStripeStatus("Stripe is connected ✅ Payouts should be enabled.", "success");

        connectStripeBtn.dataset.mode = "refresh";
        connectStripeBtn.textContent = "Refresh Stripe status";
        connectStripeBtn.disabled = false;
        return;
      }

      // Exists but not completed
      setStripeStatus(
        "Stripe setup is not complete yet. Use the emailed onboarding link to finish setup.",
        "warning",
      );

      connectStripeBtn.dataset.mode = "email";
      connectStripeBtn.textContent = "Resend Stripe setup email";
      connectStripeBtn.disabled = false;
    } catch (err) {
      setStripeStatus(err?.message || String(err), "danger");
      connectStripeBtn.dataset.mode = "refresh";
      connectStripeBtn.textContent = "Retry Stripe status";
      connectStripeBtn.disabled = false;
    }
  }

  // ==========================================================================
  // SALES REPORT (NEW ROUTE)
  // ==========================================================================

  function clearSalesUi() {
    if (salesSummary) salesSummary.innerHTML = "";
    if (salesTableBody) salesTableBody.innerHTML = "";
    if (salesRaw) salesRaw.textContent = "";
  }

  /**
   * Best-effort renderer for farmer/sales/ responses.
   * We support:
   * - arrays of rows
   * - { rows: [...] }
   * - { results: [...] }
   * - anything else -> raw JSON in <pre>
   */
  function renderSalesReport(data) {
    clearSalesUi();

    const pretty = JSON.stringify(data, null, 2);
    if (salesRaw) salesRaw.textContent = pretty;

    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.rows)
        ? data.rows
        : Array.isArray(data?.results)
          ? data.results
          : Array.isArray(data?.sales)
            ? data.sales
            : null;

    // Summary (best-effort)
    const totals =
      data?.totals ||
      data?.summary ||
      (typeof data?.total === "number" ? { total: data.total } : null);

    if (salesSummary) {
      if (totals && typeof totals === "object") {
        const chips = Object.entries(totals)
          .map(([k, v]) => {
            const label = escapeHtml(k);
            const val = escapeHtml(v);
            return `<span class="badge text-bg-light border me-2 mb-2">${label}: ${val}</span>`;
          })
          .join("");
        salesSummary.innerHTML = `<div class="d-flex flex-wrap">${chips}</div>`;
      } else {
        salesSummary.innerHTML = "";
      }
    }

    if (!rows) return;

    if (salesTableBody) {
      salesTableBody.innerHTML = rows
        .map((r) => {
          const date = escapeHtml(r.date ?? r.day ?? r.created_at ?? "—");
          const ordersCount = escapeHtml(r.orders ?? r.order_count ?? r.count ?? "—");
          const itemsCount = escapeHtml(r.items ?? r.item_count ?? "—");
          const total = escapeHtml(r.total ?? r.revenue ?? r.amount ?? "—");

          return `
            <tr>
              <td>${date}</td>
              <td>${ordersCount}</td>
              <td>${itemsCount}</td>
              <td>${total}</td>
            </tr>
          `;
        })
        .join("");
    }
  }

  /**
   * GET farmer/sales/
   * If your API supports date range filtering, we pass query params:
   *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
   */
  async function loadSalesReport({ from = "", to = "" } = {}) {
    setSalesStatus("Loading sales report…", "muted");

    // Build query string only when values exist
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    const qs = params.toString();
    const url = `${ROOT_BASE}/farmer/sales/${qs ? `?${qs}` : ""}`;

    const res = await fetch(url, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Sales report error:", parsed.status, parsed.data ?? parsed.raw);

      if (parsed.status === 401) showProvider401Help();
      setSalesStatus(`Sales report failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setSalesStatus("Sales report loaded.", "success");
    renderSalesReport(parsed.data ?? parsed.raw);
  }

  // ==========================================================================
  // API CALLS — INVENTORY / FARM / ORDERS
  // ==========================================================================

  async function loadInventory() {
    setStatus("Loading inventory…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/inventory/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Inventory error:", parsed.status, parsed.data ?? parsed.raw);

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
    setStatus("Loading orders…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Orders error:", parsed.status, parsed.data ?? parsed.raw);

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

        const canConfirm = String(status).toLowerCase().includes("paid") || String(status).toLowerCase().includes("pending");

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


  // ==========================================================================
  // PRODUCT CRUD
  // ==========================================================================

  async function createProductFromForm() {
    if (!addProductBtn) return;

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
        headers: authHeaders({ Accept: "application/json" }), // DON'T set Content-Type with FormData
        body: fd,
      });

      const parsed = await readJsonOrText(res);

      if (!parsed.ok) {
        console.log("Create product error:", parsed.status, parsed.data ?? parsed.raw);
        if (parsed.status === 401) showProvider401Help();
        else setStatus(`Create failed (HTTP ${parsed.status})`, "danger");
        return;
      }

      setStatus("Product created ✅", "success");

      // Reload inventory table
      await loadInventory();

      // Reset form (only after successful create)
      addProductForm?.reset?.();
    } finally {
      addProductBtn.disabled = false;
    }
  }

  function openEditProductModal(productId) {
    const p = findProductById(productId);
    if (!p) return;

    // Fill modal inputs
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
    editModal?.show();
  }

  async function submitEditProduct() {
    if (!epSaveBtn) return;

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
        headers: authHeaders({ Accept: "application/json" }), // DON'T set Content-Type with FormData
        body: fd,
      });

      const parsed = await readJsonOrText(res);

      if (!parsed.ok) {
        console.log("Update product failed:", parsed.status, parsed.data ?? parsed.raw);
        setEditStatus(`Save failed (HTTP ${parsed.status})`, "danger");
        return;
      }

      setEditStatus("Saved ✅", "success");

      await loadInventory();

      editModal?.hide?.();
      setStatus("", "success");
    } finally {
      epSaveBtn.disabled = false;
    }
  }

  async function deleteProduct(productId) {
    setStatus("Deleting…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/`, {
      method: "DELETE",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Delete product error:", parsed.status, parsed.data ?? parsed.raw);
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Delete failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("", "success");
    await loadInventory();
  }

  async function confirmOrder(orderId) {
    setStatus("Confirming…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/${encodeURIComponent(orderId)}/confirm/`, {
      method: "PUT",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      console.log("Confirm order error:", parsed.status, parsed.data ?? parsed.raw);
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Confirm failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("", "success");
    await loadOrders();
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
      if (!id) return;
      confirmOrder(id);
    });

    // Stripe button:
    // - DOES NOT redirect to Stripe
    // - can create the Stripe account record if needed
    // - can request onboarding email/link
    connectStripeBtn?.addEventListener("click", async () => {
      if (!connectStripeBtn) return;

      const mode = connectStripeBtn.dataset.mode || "refresh";

      connectStripeBtn.disabled = true;

      try {
        if (mode === "create_then_email") {
          setStripeStatus("Creating Stripe account…", "muted");
          await createStripeAccount();

          setStripeStatus("Requesting Stripe setup email…", "muted");
          await requestStripeOnboardingLink();

          setStripeStatus(
            "Stripe setup email requested. Check your inbox (and spam) for the onboarding link.",
            "success",
          );

          await refreshStripePayoutUi();
          return;
        }

        if (mode === "email") {
          setStripeStatus("Requesting Stripe setup email…", "muted");
          await requestStripeOnboardingLink();

          setStripeStatus(
            "Stripe setup email requested. Use the emailed onboarding link to finish setup.",
            "success",
          );

          await refreshStripePayoutUi();
          return;
        }

        // mode === "refresh" (default)
        await refreshStripePayoutUi();
      } catch (err) {
        setStripeStatus(err?.message || String(err), "danger");
      } finally {
        connectStripeBtn.disabled = false;
      }
    });

    // Sales
    refreshSalesBtn?.addEventListener("click", () => loadSalesReport());
    applySalesRangeBtn?.addEventListener("click", () => {
      const from = salesFrom?.value || "";
      const to = salesTo?.value || "";
      loadSalesReport({ from, to });
    });

    // Edit modal submit
    editProductForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitEditProduct();
    });
  }

  // ==========================================================================
  // INIT
  // ==========================================================================

  document.addEventListener("DOMContentLoaded", async () => {
    wireEvents();

    await loadInventory();
    await loadOrders();

    // Stripe + Sales are independent from inventory/orders, so failures there shouldn't brick the page.
    await refreshStripePayoutUi();
    await loadSalesReport();
  });
})();