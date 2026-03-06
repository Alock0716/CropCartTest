/**
 * ============================================================================
 * farmer.js — Farmer Portal logic (FULL REPLACEMENT)
 * ----------------------------------------------------------------------------
 * Updated for NEW API route structure + Stripe Connect flow changes:
 *
 * Stripe rules (per your request):
 * - NO onboarding initiated from the farmer portal
 * - Portal only:
 *   1) Checks Stripe status:    GET  /farmer/stripe/account/
 *   2) Opens Express dashboard: GET  /farmer/stripe/dashboard/
 *   3) Optionally reads callbacks (public):
 *        GET /farmer/stripe/return/
 *        GET /farmer/stripe/refresh/
 *
 * Notes:
 * - This file assumes window.__CROPCART_CONFIG__.API_URL is set (ex: https://.../api)
 * - ROOT_BASE is derived by removing trailing "/api" from API_URL
 * - IDs and page structure should match your existing farmer.html
 * ============================================================================
 */

(function FarmerPortal() {
  "use strict";

  // ==========================================================================
  // CONFIG / BASE URLS
  // ==========================================================================

  /**
   * Global config injected by config.js
   * @type {{ API_URL?: string }}
   */
  const CFG = window.__CROPCART_CONFIG__ || {};

  /**
   * API base (often ends in /api)
   * Example: https://d1xxxx.cloudfront.net/api
   * @type {string}
   */
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, "");

  /**
   * Root base (strip trailing /api)
   * Example: https://d1xxxx.cloudfront.net
   * @type {string}
   */
  const ROOT_BASE = API_BASE.replace(/\/api$/i, "");

  // ==========================================================================
  // DOM (IDs must match farmer.html)
  // ==========================================================================

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

  // Header title
  const farmerPortalTitle = document.getElementById("farmerPortalTitle");

  // Stripe
  const connectStripeBtn = document.getElementById("connectStripeBtn");

  // Optional Stripe status box (safe if missing)
  const stripeStatusBox = document.getElementById("stripeStatusBox");

  // Edit Product Modal elements
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

  const editModal = editProductModalEl ? new bootstrap.Modal(editProductModalEl) : null;

  // ==========================================================================
  // STATE
  // ==========================================================================

  /** @type {Array<object>} */
  let inventory = [];

  /** @type {Array<object>} */
  let orders = [];

  /**
   * Stripe account status snapshot from GET /farmer/stripe/account/
   * @type {null | {
   *   connected: boolean,
   *   stripe_account_id: string | null,
   *   charges_enabled: boolean,
   *   payouts_enabled: boolean,
   *   details_submitted: boolean
   * }}
   */
  let stripeState = null;

  // ==========================================================================
  // UI HELPERS
  // ==========================================================================

  /**
   * Sets main page status text.
   * @param {string} msg - Status message to show
   * @param {"muted"|"success"|"warning"|"danger"} kind - Bootstrap-ish text class suffix
   */
  function setStatus(msg, kind = "muted") {
    if (!pageStatus) return;
    pageStatus.textContent = msg || "";
    pageStatus.className = `small text-${kind}`;
  }

  /**
   * Sets edit modal status text.
   * @param {string} msg - Status message to show
   * @param {"muted"|"success"|"warning"|"danger"} kind - Bootstrap-ish text class suffix
   */
  function setEditStatus(msg, kind = "muted") {
    if (!epStatus) return;
    epStatus.textContent = msg || "";
    epStatus.className = `small text-${kind}`;
  }

  /**
   * Sets Stripe status text area if it exists.
   * @param {string} msg - Stripe status message
   * @param {"muted"|"success"|"warning"|"danger"} kind - Bootstrap-ish text class suffix
   */
  function setStripeStatus(msg, kind = "muted") {
    if (!stripeStatusBox) return;
    stripeStatusBox.textContent = msg || "";
    stripeStatusBox.className = `small text-${kind} mb-3`;
  }

  /**
   * Escapes HTML for safe rendering inside .innerHTML
   * @param {string} str - Raw string
   * @returns {string} HTML-escaped string
   */
  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /**
   * Finds a product from in-memory inventory list.
   * Supports both id and product_id shapes.
   * @param {string|number} productId - Product identifier
   * @returns {object|null}
   */
  function findProductById(productId) {
    return inventory.find((p) => String(p.id ?? p.product_id) === String(productId)) || null;
  }

  // ==========================================================================
  // AUTH HELPERS (provider token first, customer fallback)
  // ==========================================================================

  /**
   * Reads provider auth from storage if it exists.
   * Uses cc_farmer_auth first because /farmer/* endpoints usually require provider.
   * @returns {{access?: string} | null}
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
   * auth.js typically stores "cc_auth" and token field is "access".
   * @returns {{access?: string} | null}
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
   * Picks the best access token available.
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
   * Builds Authorization headers if a token exists.
   * @param {Record<string,string>} extra - Extra headers to merge in
   * @returns {Record<string,string>}
   */
  function authHeaders(extra = {}) {
    const token = getBestAccessToken();
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
  }

  /**
   * Reads response as JSON if possible, otherwise returns raw text.
   * @param {Response} res - Fetch response
   * @returns {Promise<{ok:boolean,status:number,data:any,raw:string}>}
   */
  async function readJsonOrText(res) {
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text), raw: text };
    } catch {
      return { ok: res.ok, status: res.status, data: null, raw: text };
    }
  }

  // ==========================================================================
  // PROVIDER GUARDS
  // ==========================================================================

  /**
   * True if provider auth exists and contains an access token.
   * @returns {boolean}
   */
  function hasProviderToken() {
    const provider = getProviderAuth();
    return Boolean(provider?.access);
  }

  /**
   * Prevent calling farmer-only routes without provider token.
   * @param {string} actionLabel - Short label used in error message
   * @returns {boolean}
   */
  function requireProviderAuth(actionLabel = "This action") {
    if (hasProviderToken()) return true;

    setStatus(
      `${actionLabel} requires a Farmer/Provider login. Your provider token (cc_farmer_auth) is missing or expired.`,
      "danger",
    );
    return false;
  }

  // ==========================================================================
  // RENDER — INVENTORY + ORDERS
  // ==========================================================================

  /**
   * Renders inventory table from current `inventory` state.
   */
  function renderInventory() {
    if (!inventoryBody) return;

    const q = String(invSearch?.value || "").trim().toLowerCase();

    const list = inventory.filter((p) => {
      const name = String(p?.name ?? "").toLowerCase();
      return !q || name.includes(q);
    });

    inventoryBody.innerHTML = "";

    if (!list.length) {
      inventoryBody.innerHTML = `<tr><td colspan="5" class="text-muted small py-4">No inventory found.</td></tr>`;
      return;
    }

    for (const p of list) {
      const id = p?.id ?? p?.product_id ?? "";
      const name = escapeHtml(p?.name ?? "Unnamed");
      const category = escapeHtml(p?.category_display ?? p?.category ?? "—");
      const priceNum = Number(p?.price ?? 0);
      const stockNum = Number(p?.stock ?? p?.quantity ?? 0);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="fw-semibold">${name}</td>
        <td>${category}</td>
        <td>$${Number.isFinite(priceNum) ? priceNum.toFixed(2) : "0.00"}</td>
        <td>${Number.isFinite(stockNum) ? stockNum : 0}</td>
        <td class="text-end">
          <div class="btn-group btn-group-sm">
            <button type="button" class="btn btn-outline-primary" data-edit="${escapeHtml(String(id))}">Edit</button>
            <button type="button" class="btn btn-outline-danger" data-del="${escapeHtml(String(id))}">Delete</button>
          </div>
        </td>
      `;
      inventoryBody.appendChild(tr);
    }
  }

  /**
   * Renders farmer orders table from current `orders` state.
   */
  function renderOrders() {
    if (!farmerOrdersBody) return;

    farmerOrdersBody.innerHTML = "";

    if (!orders.length) {
      farmerOrdersBody.innerHTML = `<tr><td colspan="4" class="text-muted small py-4">No incoming orders right now.</td></tr>`;
      return;
    }

    for (const o of orders) {
      const orderId = o?.id ?? o?.order_id ?? "";
      const status = o?.status_display ?? o?.status ?? "—";
      const customer = o?.user ? `User ${o.user}` : "Customer";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="fw-semibold">#${escapeHtml(String(orderId))}</td>
        <td>${escapeHtml(String(customer))}</td>
        <td><span class="badge text-bg-light border">${escapeHtml(String(status))}</span></td>
        <td class="text-end">
          <button type="button" class="btn btn-sm btn-outline-cc" data-confirm="${escapeHtml(String(orderId))}">
            Confirm
          </button>
        </td>
      `;
      farmerOrdersBody.appendChild(tr);
    }
  }

  // ==========================================================================
  // MODAL — EDIT PRODUCT
  // ==========================================================================

  /**
   * Opens edit modal and pre-fills fields from local `inventory`.
   * @param {string|number} productId - Product identifier
   */
  function openEditProductModal(productId) {
    if (!editModal) return;

    const p = findProductById(productId);
    if (!p) {
      setStatus("Could not find that product in inventory.", "danger");
      return;
    }

    const idValue = p.id ?? p.product_id;
    const nameValue = p.name ?? "";
    const descValue = p.description ?? "";
    const categoryValue = p.category ?? "other";
    const priceValue = p.price ?? "";
    const stockValue = p.stock ?? 0;
    const isActiveValue = typeof p.is_active === "boolean" ? p.is_active : true;

    epId.value = String(idValue);
    epName.value = String(nameValue);
    epDescription.value = String(descValue);
    epCategory.value = String(categoryValue);
    epPrice.value = String(priceValue);
    epStock.value = String(stockValue);
    epIsActive.checked = !!isActiveValue;

    // File inputs can’t be set programmatically
    epPhoto.value = "";

    if (epCurrentPhoto) {
      const photoUrl = p.photo_url || "";
      epCurrentPhoto.textContent = photoUrl ? "Current photo: set" : "Current photo: none";
    }

    setEditStatus("");
    editModal.show();
  }

  /**
   * Submits edit product form.
   * Uses multipart/form-data when a file is present.
   */
  async function submitEditProduct() {
    if (!requireProviderAuth("Saving product changes")) return;

    const productId = String(epId.value || "").trim();
    if (!productId) return;

    setEditStatus("Saving…", "muted");
    if (epSaveBtn) epSaveBtn.disabled = true;

    try {
      const fd = new FormData();

      fd.append("name", String(epName.value || "").trim());
      fd.append("description", String(epDescription.value || "").trim());
      fd.append("category", String(epCategory.value || "other"));
      fd.append("price", String(epPrice.value || "0"));
      fd.append("stock", String(epStock.value || "0"));
      fd.append("is_active", epIsActive.checked ? "true" : "false");

      const file = epPhoto.files?.[0];
      if (file) fd.append("photo", file);

      const res = await fetch(`${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/`, {
        method: "PUT",
        headers: authHeaders({ Accept: "application/json" }), // Do NOT set Content-Type for FormData
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

      editModal.hide();
      setStatus("", "success");
    } finally {
      if (epSaveBtn) epSaveBtn.disabled = false;
    }
  }

  // ==========================================================================
  // STRIPE CONNECT — STATUS + DASHBOARD
  // ==========================================================================

  /**
   * Fetch Stripe account status from:
   *   GET /farmer/stripe/account/
   *
   * Returns a status object like:
   * {
   *   connected: true|false,
   *   stripe_account_id: string|null,
   *   charges_enabled: boolean,
   *   payouts_enabled: boolean,
   *   details_submitted: boolean
   * }
   *
   * @returns {Promise<object>}
   */
  async function fetchStripeAccountStatus() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      const msg =
        parsed.data?.error ||
        parsed.data?.detail ||
        `Stripe account status failed (HTTP ${parsed.status})`;
      throw new Error(msg);
    }

    return parsed.data || {};
  }

  /**
   * Generate a short-lived Stripe Express dashboard login link:
   *   GET /farmer/stripe/dashboard/
   *
   * Response:
   * { url: "https://connect.stripe.com/express/.../login/..." }
   *
   * @returns {Promise<string>} dashboard login URL
   */
  async function fetchStripeDashboardLink() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/dashboard/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      const msg =
        parsed.data?.error ||
        parsed.data?.detail ||
        `Stripe dashboard link failed (HTTP ${parsed.status})`;
      throw new Error(msg);
    }

    const url = parsed.data?.url ? String(parsed.data.url) : "";
    if (!url) throw new Error("Stripe dashboard endpoint did not return a url.");

    return url;
  }

  /**
   * Updates the Stripe button label and the optional Stripe status box.
   * This is the only Stripe UI logic you need in the portal now.
   */
  async function refreshStripeUi() {
    if (!connectStripeBtn) return;

    // Default “safe” UI before the request finishes
    connectStripeBtn.disabled = true;
    connectStripeBtn.textContent = "Checking Stripe status…";
    setStripeStatus("Checking Stripe connection…", "muted");

    try {
      if (!requireProviderAuth("Checking Stripe status")) {
        // If they aren’t logged in as provider, don’t spam the endpoint
        connectStripeBtn.disabled = true;
        connectStripeBtn.textContent = "Open Stripe Dashboard";
        setStripeStatus("Log in as a Farmer/Provider to view payout settings.", "warning");
        return;
      }

      stripeState = await fetchStripeAccountStatus();

      const connected = Boolean(stripeState?.connected);
      const acctId = stripeState?.stripe_account_id ? String(stripeState.stripe_account_id) : "";
      const detailsSubmitted = Boolean(stripeState?.details_submitted);
      const chargesEnabled = Boolean(stripeState?.charges_enabled);
      const payoutsEnabled = Boolean(stripeState?.payouts_enabled);

      // If onboarding was truly done already, this should be “good”.
      // Still, we handle edge states cleanly for debugging / partial setups.
      if (!connected) {
        connectStripeBtn.disabled = true;
        connectStripeBtn.textContent = "Open Stripe Dashboard";
        setStripeStatus(
          "Stripe is not connected to this farm yet. Onboarding is handled by the emailed link, so check your email or contact support.",
          "warning",
        );
        return;
      }

      // Connected but still missing onboarding requirements
      if (!detailsSubmitted || !payoutsEnabled) {
        connectStripeBtn.disabled = true;
        connectStripeBtn.textContent = "Open Stripe Dashboard";
        setStripeStatus(
          `Stripe is linked${acctId ? ` (${acctId})` : ""}, but setup isn’t fully complete yet (details/payouts not enabled). ` +
            "Onboarding is handled by the emailed link — finish that flow, then refresh this page.",
          "warning",
        );
        return;
      }

      // Fully enabled (the happy path)
      connectStripeBtn.disabled = false;
      connectStripeBtn.textContent = "Open Stripe Dashboard";
      setStripeStatus(
        `Stripe connected${acctId ? ` (${acctId})` : ""}. Use the dashboard for payouts and earnings statements.`,
        "success",
      );

      // Optional: keep a small “mode” value in case you want it later
      connectStripeBtn.dataset.mode = "dashboard";
    } catch (err) {
      console.warn("Stripe UI refresh failed:", err);

      connectStripeBtn.disabled = true;
      connectStripeBtn.textContent = "Open Stripe Dashboard";
      setStripeStatus(
        "Could not load Stripe status. Make sure you’re logged in as a provider and try again.",
        "danger",
      );
    }
  }

  /**
   * Optional callback handler.
   *
   * If you ever redirect farmers back onto farmer.html (instead of a backend JSON page),
   * you can add:
   *   farmer.html?stripe=return
   * or
   *   farmer.html?stripe=refresh
   *
   * Then this will call:
   *   GET /farmer/stripe/return/   -> { status: "onboarding_complete", ... }
   *   GET /farmer/stripe/refresh/ -> { status: "link_expired", message: ... }
   *
   * And it will show that message in the Stripe status box/page status.
   */
  async function handleStripeCallbackHints() {
    const params = new URLSearchParams(window.location.search);
    const mode = String(params.get("stripe") || "").toLowerCase();

    if (!mode) return;
    if (mode !== "return" && mode !== "refresh") return;

    const endpoint = mode === "return" ? "/farmer/stripe/return/" : "/farmer/stripe/refresh/";

    try {
      const res = await fetch(`${ROOT_BASE}${endpoint}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) return;

      const status = parsed.data?.status ? String(parsed.data.status) : "";
      const message = parsed.data?.message ? String(parsed.data.message) : "";

      if (mode === "return") {
        setStripeStatus("Stripe onboarding completed. Refreshing account status…", "success");
        setStatus("Stripe onboarding completed. Refreshing account status…", "success");
      } else {
        setStripeStatus(message || "Stripe onboarding link expired. Request a new one.", "warning");
        setStatus(message || "Stripe onboarding link expired. Request a new one.", "warning");
      }

      // Refresh portal state after callback
      await refreshStripeUi();
    } catch (err) {
      console.warn("handleStripeCallbackHints failed:", err);
    }
  }

  /**
   * Click handler for “Open Stripe Dashboard”
   * - Generates a fresh dashboard login link
   * - Opens it in a new tab
   */
  async function openStripeDashboard() {
    if (!connectStripeBtn) return;
    if (!requireProviderAuth("Opening Stripe dashboard")) return;

    try {
      connectStripeBtn.disabled = true;
      setStatus("Opening Stripe dashboard…", "muted");

      const url = await fetchStripeDashboardLink();

      // Open in a new tab so your portal page remains available
      window.open(url, "_blank", "noopener,noreferrer");

      setStatus("", "success");
    } catch (err) {
      setStatus(err?.message || String(err), "danger");
    } finally {
      connectStripeBtn.disabled = false;

      // The state on Stripe can change between clicks, so keep it fresh
      await refreshStripeUi();
    }
  }

  // ==========================================================================
  // API CALLS — INVENTORY / FARM / ORDERS
  // ==========================================================================

  async function loadInventory() {
    if (!requireProviderAuth("Loading inventory")) {
      inventory = [];
      renderInventory();
      return;
    }

    setStatus("Loading inventory…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/inventory/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Inventory error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Inventory failed (HTTP ${parsed.status})`, "danger");
      inventory = [];
      renderInventory();
      return;
    }

    inventory = Array.isArray(parsed.data) ? parsed.data : parsed.data?.results || [];
    renderInventory();
    setStatus("", "success");
  }

  /**
   * Loads farms list and tries to find the owned farm to set the page title.
   * This endpoint might work for both auth types depending on your backend.
   */
  async function loadFarmProfile() {
    try {
      const res = await fetch(`${ROOT_BASE}/farms/`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
        credentials: "include",
      });

      const parsed = await readJsonOrText(res);

      if (!parsed.ok || !Array.isArray(parsed.data)) {
        console.log("Farms fetch failed:", parsed.status, parsed.data ?? parsed.raw);
        return;
      }

      const ownedFarm = parsed.data.find((f) => f.is_owner === true);
      if (!ownedFarm) return;

      const farmName = String(ownedFarm.name || "").trim();
      if (!farmName) return;

      if (farmerPortalTitle) farmerPortalTitle.textContent = `${farmName}'s Farmer Portal`;
      document.title = `${farmName} | Farmer Portal`;
    } catch (err) {
      console.warn("loadFarmProfile failed:", err);
    }
  }

  async function loadOrders() {
    if (!requireProviderAuth("Loading orders")) {
      orders = [];
      renderOrders();
      return;
    }

    setStatus("Loading orders…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Orders error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Orders failed (HTTP ${parsed.status})`, "danger");
      orders = [];
      renderOrders();
      return;
    }

    orders = Array.isArray(parsed.data) ? parsed.data : parsed.data?.results || [];
    renderOrders();
    setStatus("", "success");
  }

  async function createProductFromForm() {
    if (!requireProviderAuth("Adding a product")) return;

    setStatus("Adding product…", "muted");
    if (addProductBtn) addProductBtn.disabled = true;

    try {
      const name = String(document.getElementById("pName")?.value || "").trim();
      const price = String(document.getElementById("pPrice")?.value || "").trim();
      const stock = String(document.getElementById("pQty")?.value || "").trim();
      const category = String(document.getElementById("pCategory")?.value || "").trim();
      const imageEl = document.getElementById("pImage");

      if (!name || !price || !stock || !category) {
        setStatus("Please fill out name, price, stock, and category.", "danger");
        return;
      }

      const fd = new FormData();
      fd.append("name", name);
      fd.append("price", price);
      fd.append("stock", stock);
      fd.append("category", category);

      const file = imageEl?.files?.[0];
      if (file) fd.append("photo", file);

      const res = await fetch(`${ROOT_BASE}/farmer/products/`, {
        method: "POST",
        headers: authHeaders(), // FormData sets Content-Type automatically
        body: fd,
        credentials: "include",
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) {
        console.log("Create product error:", parsed.status, parsed.data ?? parsed.raw);
        setStatus(`Add product failed (HTTP ${parsed.status})`, "danger");
        return;
      }

      addProductForm?.reset();
      setStatus("", "success");
      await loadInventory();
    } finally {
      if (addProductBtn) addProductBtn.disabled = false;
    }
  }

  async function deleteProduct(productId) {
    if (!requireProviderAuth("Deleting a product")) return;

    setStatus("Deleting product…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/delete/`, {
      method: "DELETE",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      console.log("Delete product error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Delete failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("", "success");
    await loadInventory();
  }

  async function confirmOrder(orderId) {
    if (!requireProviderAuth("Confirming an order")) return;

    setStatus("Confirming…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/${encodeURIComponent(orderId)}/confirm/`, {
      method: "PUT",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) {
      console.log("Confirm order error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Confirm failed (HTTP ${parsed.status})`, "danger");
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

    // Stripe dashboard button (no onboarding from portal)
    connectStripeBtn?.addEventListener("click", openStripeDashboard);

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

    await loadFarmProfile();
    await loadInventory();
    await loadOrders();

    // Optional: if you bounce back to farmer.html?stripe=return|refresh
    await handleStripeCallbackHints();

    // Always refresh Stripe UI state for the portal button
    await refreshStripeUi();
  });
})();