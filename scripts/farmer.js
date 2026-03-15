/**
 * ============================================================================
 * farmer.js — Farmer Portal logic (FULL REPLACEMENT)
 * ----------------------------------------------------------------------------
 * Fixes the issue you’re hitting:
 * - You ALREADY have provider auth stored in `cc_auth` (user.role === "provider").
 * - Your old farmer.js was blocking /farmer/* calls unless `cc_farmer_auth` existed.
 * - This version uses ONLY `cc_auth` + role checks (no separate provider token).
 *
 * Stripe (new routes):
 * - GET  /farmer/stripe/account/        -> status { connected, payouts_enabled, ... }
 * - POST /farmer/stripe/account         -> returns connection/setup link { url, stripe_account_id }
 * - GET  /farmer/stripe/dashboard/      -> returns dashboard link { url }   (for payouts/statements)
 * - GET  /farmer/stripe/return/         -> status info after onboarding return
 * - GET  /farmer/stripe/refresh/        -> link expired message
 *
 * Notes:
 * - Farmer routes are rooted at /farmer/* (NOT /api/farmer/*)
 * - This file assumes config.js provides window.__CROPCART_CONFIG__.API_URL ending in /api
 * ============================================================================
 */

(function FarmerPortal() {
  "use strict";

  // ============================================================================
  // CONFIG / BASE URLS
  // ============================================================================

  const CFG = window.__CROPCART_CONFIG__ || {};

  /**
   * API_BASE: usually ".../api"
   * Example: https://d1nnhq1iqs57tb.cloudfront.net/api
   */
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, "");

  /**
   * ROOT_BASE: strip trailing "/api"
   * Example: https://d1nnhq1iqs57tb.cloudfront.net
   */
  const ROOT_BASE = API_BASE.replace(/\/api\/?$/i, "");

  if (!ROOT_BASE) {
    // If config isn’t loaded correctly, fail loudly so it’s obvious what’s wrong.
    console.error(
      "Farmer Portal config error: ROOT_BASE is empty. Check config.js API_URL.",
      { API_BASE, CFG },
    );
  }

  // ============================================================================
  // DOM (IDs must match farmer.html)
  // ============================================================================

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

  // Header
  const farmerPortalTitle = document.getElementById("farmerPortalTitle");
  const farmLogoInput = document.getElementById("farmLogoInput");
  const farmLogoImg = document.getElementById("farmLogoImg");
  const farmLogoPlaceholder = document.getElementById("farmLogoPlaceholder");
  const farmLogoStatus = document.getElementById("farmLogoStatus");

  // Stripe
  const connectStripeBtn = document.getElementById("connectStripeBtn");
  const stripeStatusBox = document.getElementById("stripeStatusBox"); // optional (safe if missing)

  // Edit Product Modal
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

  // Bootstrap modal instance (optional)
  const editModal =
    editProductModalEl && window.bootstrap?.Modal
      ? new bootstrap.Modal(editProductModalEl)
      : null;

  // ============================================================================
  // STATE
  // ============================================================================

  let inventory = [];
  let ownedFarm = null;
  let orders = [];

  /**
   * Cached Stripe status so we can render button text consistently.
   * @type {null | {connected:boolean,stripe_account_id?:string,charges_enabled?:boolean,payouts_enabled?:boolean,details_submitted?:boolean}}
   */
  let stripeAccountStatus = null;

  // ============================================================================
  // UI HELPERS
  // ============================================================================

  function setStatus(msg, kind = "muted") {
    if (!pageStatus) return;
    pageStatus.textContent = msg || "";
    pageStatus.className = `small text-${kind}`;
  }

  function setStripeStatus(msg, kind = "muted") {
    if (!stripeStatusBox) return;
    stripeStatusBox.textContent = msg || "";
    stripeStatusBox.className = `small text-${kind}`;
  }

  function setEditStatus(msg, kind = "muted") {
    if (!epStatus) return;
    epStatus.textContent = msg || "";
    epStatus.className = `small text-${kind}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `$${n.toFixed(2)}`;
  }

  function showProviderHelp(msg) {
    setStatus(msg, "danger");
  }

  function setFarmLogoStatus(msg, kind = "muted") {
    if (!farmLogoStatus) return;
    farmLogoStatus.textContent = msg || "";
    farmLogoStatus.className = `small text-${kind}`;
  }

  function renderFarmLogo(logoUrl) {
    const url = String(logoUrl || "").trim();

    if (!farmLogoImg || !farmLogoPlaceholder) return;

    if (url) {
      farmLogoImg.src = url;
      farmLogoImg.classList.remove("d-none");
      farmLogoPlaceholder.classList.add("d-none");
      setFarmLogoStatus("Click the logo to replace it.", "muted");
      return;
    }

    farmLogoImg.removeAttribute("src");
    farmLogoImg.classList.add("d-none");
    farmLogoPlaceholder.classList.remove("d-none");
    setFarmLogoStatus("Click the box to upload your farm logo.", "muted");
  }

  // ============================================================================
  // AUTH HELPERS (USE cc_auth ONLY)
  // ============================================================================

  function safeJsonParse(raw) {
    try {
      return JSON.parse(raw || "null");
    } catch {
      return null;
    }
  }

  /**
   * Reads cc_auth from sessionStorage/localStorage OR via utils.js getAuth()
   * (utils.js defines getAuth() + authHeader()).
   */
  function getAuthObj() {
    if (typeof getAuth === "function") return getAuth();
    return (
      safeJsonParse(sessionStorage.getItem("cc_auth")) ||
      safeJsonParse(localStorage.getItem("cc_auth"))
    );
  }

  function getAccessToken() {
    const auth = getAuthObj();
    return String(auth?.access || "");
  }

  function getUserRole() {
    const auth = getAuthObj();
    return String(auth?.user?.role || "");
  }

  function requireProviderRole(actionLabel = "This action") {
    const token = getAccessToken();
    if (!token) {
      showProviderHelp(`${actionLabel} requires login. Please log in again.`);
      return false;
    }

    const role = getUserRole();
    if (role !== "provider") {
      showProviderHelp(
        `${actionLabel} requires a provider account. Your current role is "${role || "unknown"}".`,
      );
      return false;
    }

    return true;
  }

  function authHeaders(extra = {}) {
    const token = getAccessToken();
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
  }

  async function readJsonOrText(res) {
    const raw = await res.text();
    try {
      return { ok: res.ok, status: res.status, data: raw ? JSON.parse(raw) : null, raw };
    } catch {
      return { ok: res.ok, status: res.status, data: null, raw };
    }
  }

  // ============================================================================
  // RENDER — INVENTORY
  // ============================================================================

  function renderInventory() {
    if (!inventoryBody) return;

    const q = String(invSearch?.value || "").trim().toLowerCase();
    const list = inventory.filter((p) => {
      const name = String(p?.name ?? "").toLowerCase();
      return !q || name.includes(q);
    });

    inventoryBody.innerHTML = "";

    if (!list.length) {
      inventoryBody.innerHTML =
        `<tr><td colspan="5" class="text-muted small py-4">No inventory found.</td></tr>`;
      return;
    }

    for (const p of list) {
      const id = p?.id ?? p?.product_id ?? "";
      const name = escapeHtml(p?.name ?? "Unnamed");
      const category = escapeHtml(p?.category_display ?? p?.category ?? "—");
      const price = toMoney(p?.price ?? p?.unit_price);
      const stock = escapeHtml(p?.stock ?? p?.quantity ?? "—");

      inventoryBody.insertAdjacentHTML(
        "beforeend",
        `
          <tr>
            <td class="small">${name}</td>
            <td class="small">${category}</td>
            <td class="small">${price}</td>
            <td class="small">${stock}</td>
            <td class="small text-end">
              <button class="btn btn-sm btn-outline-primary" data-action="edit" data-id="${escapeHtml(id)}">Edit</button>
              <button class="btn btn-sm btn-outline-danger ms-1" data-action="delete" data-id="${escapeHtml(id)}">Delete</button>
            </td>
          </tr>
        `,
      );
    }
  }

  function findProductById(productId) {
    return (
      inventory.find((p) => String(p?.id ?? p?.product_id) === String(productId)) || null
    );
  }

  // ============================================================================
  // RENDER — ORDERS
  // ============================================================================

  function renderOrders() {
    if (!farmerOrdersBody) return;

    farmerOrdersBody.innerHTML = "";

    if (!orders.length) {
      farmerOrdersBody.innerHTML =
        `<tr><td colspan="4" class="text-muted small py-4">No orders found.</td></tr>`;
      return;
    }

    for (const o of orders) {
      const id = o?.id ?? o?.order_id ?? "";
      const customer = o?.user ?? "—";
      const status = escapeHtml(o?.status_display ?? o?.status ?? "—");

      const myFarmConfirmation = Array.isArray(o?.farm_confirmations)
        ? o.farm_confirmations.find((fc) => fc && fc.is_confirmed === true)
        : null;

      const isConfirmed = Boolean(myFarmConfirmation);

      farmerOrdersBody.insertAdjacentHTML(
        "beforeend",
        `
          <tr>
            <td class="small">#${escapeHtml(id)}</td>
            <td class="small">${escapeHtml(customer)}</td>
            <td class="small">
              ${status}
              ${isConfirmed ? '<div class="text-success small">Confirmed by your farm</div>' : ""}
            </td>
            <td class="small text-end">
              <button
                class="btn btn-sm ${isConfirmed ? "btn-outline-secondary" : "btn-outline-success"}"
                data-action="confirmOrder"
                data-id="${escapeHtml(id)}"
                ${isConfirmed ? "disabled" : ""}
              >
                ${isConfirmed ? "Confirmed" : "Confirm"}
              </button>
            </td>
          </tr>
        `,
      );
    }
  }

  // ============================================================================
  // API CALLS — FARM / INVENTORY / ORDERS / PRODUCTS
  // ============================================================================

  async function loadFarmProfileTitle() {
    try {
      const res = await fetch(`${ROOT_BASE}/farms/`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
        credentials: "include",
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok || !Array.isArray(parsed.data)) return;

      ownedFarm = parsed.data.find((f) => f?.is_owner === true) || null;
      if (!ownedFarm) return;

      const name = String(ownedFarm?.name || "").trim();
      const logoUrl = String(ownedFarm?.logo_url || "").trim();

      if (name) {
        if (farmerPortalTitle) farmerPortalTitle.textContent = `${name}'s Farmer Portal`;
        document.title = `${name} | Farmer Portal`;
      }

      renderFarmLogo(logoUrl);
    } catch {
      // silent: not critical
    }
  }

  async function uploadFarmLogo(file) {
    if (!requireProviderRole("Uploading a farm logo")) return;
    if (!file) return;

    setFarmLogoStatus("Uploading logo…", "muted");

    // optimistic preview
    const localUrl = URL.createObjectURL(file);
    renderFarmLogo(localUrl);

    try {
      const fd = new FormData();

      /**
       * NOTE:
       * The current API docs do NOT document a farm logo field.
       * This frontend attempts a multipart farm update using field name "logo".
       * If the backend uses a different field name, this request will need to match it.
       */
      fd.append("logo", file);

      const res = await fetch(`${ROOT_BASE}/farmer/farm/`, {
        method: "PUT",
        headers: authHeaders({ Accept: "application/json" }),
        credentials: "include",
        body: fd,
      });

      const parsed = await readJsonOrText(res);

      if (!parsed.ok) {
        console.log("Farm logo upload error:", parsed.status, parsed.data ?? parsed.raw);

        setFarmLogoStatus(
          parsed.data?.error ||
            parsed.data?.detail ||
            parsed.raw ||
            `Logo upload failed (HTTP ${parsed.status})`,
          "danger",
        );

        // fall back to server data if we have it
        renderFarmLogo(ownedFarm?.logo_url || "");
        return;
      }

      // refresh farm info after successful save
      await loadFarmProfileTitle();
      setFarmLogoStatus("Farm logo updated.", "success");
    } catch (err) {
      console.error("Farm logo upload failed:", err);
      setFarmLogoStatus(
        "Logo upload could not be completed. The backend may not support farm logo uploads yet.",
        "danger",
      );
      renderFarmLogo(ownedFarm?.logo_url || "");
    } finally {
      URL.revokeObjectURL(localUrl);
      if (farmLogoInput) farmLogoInput.value = "";
    }
  }

  async function loadInventory() {
    if (!requireProviderRole("Loading inventory")) {
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

  async function loadOrders() {
    if (!requireProviderRole("Loading orders")) {
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

  async function createProduct(payload) {
    if (!requireProviderRole("Creating a product")) return;

    setStatus("Creating product…", "muted");
    if (addProductBtn) addProductBtn.disabled = true;

    try {
      const fd = new FormData();

      fd.append("name", String(payload.name || "").trim());
      fd.append("description", String(payload.description || "").trim());
      fd.append("category", String(payload.category || "").trim());
      fd.append("price", String(payload.price || "").trim());
      fd.append("stock", String(payload.stock || "").trim());

      if (payload.photo instanceof File) {
        fd.append("photo", payload.photo);
      }

      const res = await fetch(`${ROOT_BASE}/farmer/products/`, {
        method: "POST",
        headers: authHeaders({ Accept: "application/json" }),
        credentials: "include",
        body: fd,
      });

      const parsed = await readJsonOrText(res);

      if (!parsed.ok) {
        console.log("Create product error:", parsed.status, parsed.data ?? parsed.raw);

        const msg =
          parsed.data?.error ||
          parsed.data?.detail ||
          parsed.raw ||
          `Create product failed (HTTP ${parsed.status})`;

        setStatus(msg, "danger");
        return;
      }

      setStatus("Product created.", "success");
      addProductForm?.reset();
      await loadInventory();
    } catch (err) {
      console.error("Create product fetch failed:", err);
      setStatus("Product creation failed before the response could be read.", "danger");
    } finally {
      if (addProductBtn) addProductBtn.disabled = false;
    }
  }

  async function updateProduct(productId, payload) {
    if (!requireProviderRole("Updating a product")) return;

    setEditStatus("Saving changes…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
      credentials: "include",
      body: JSON.stringify(payload),
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Update product error:", parsed.status, parsed.data ?? parsed.raw);
      setEditStatus(`Save failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setEditStatus("Saved.", "success");
    if (editModal) editModal.hide();
    await loadInventory();
  }

  async function deleteProduct(productId) {
    if (!requireProviderRole("Deleting a product")) return;

    const ok = window.confirm("Delete this product? This cannot be undone.");
    if (!ok) return;

    setStatus("Deleting product…", "muted");

    const res = await fetch(
      `${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/delete/`,
      {
        method: "DELETE",
        headers: authHeaders({ Accept: "application/json" }),
        credentials: "include",
      },
    );

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Delete product error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Delete failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("Deleted.", "success");
    await loadInventory();
  }

  async function confirmOrder(orderId) {
    if (!requireProviderRole("Confirming an order")) return;

    setStatus("Confirming order…", "muted");

    const res = await fetch(`${ROOT_BASE}/farmer/orders/${encodeURIComponent(orderId)}/confirm/`, {
      method: "PUT",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Confirm order error:", parsed.status, parsed.data ?? parsed.raw);

      const msg =
        parsed.data?.error ||
        parsed.data?.detail ||
        parsed.raw ||
        `Confirm failed (HTTP ${parsed.status})`;

      setStatus(msg, "danger");
      return;
    }

    const msg =
      parsed.data?.message ||
      (parsed.data?.all_farms_confirmed
        ? "Order confirmed. All farms have confirmed."
        : "Order confirmed for your farm.");

    setStatus(msg, "success");
    await loadOrders();
  }

  // ============================================================================
  // STRIPE — STATUS + LINKS (new API)
  // ============================================================================

  async function fetchStripeAccountStatus() {
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) throw new Error(`Stripe status failed (HTTP ${parsed.status})`);

    return parsed.data;
  }

  async function fetchStripeDashboardLink() {
    // Expected: { url: "https://..." }
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/dashboard/`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      credentials: "include",
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) throw new Error(`Stripe dashboard link failed (HTTP ${parsed.status})`);

    const url = parsed.data?.url;
    if (!url) throw new Error("Stripe dashboard endpoint did not return {url}.");
    return String(url);
  }

  async function fetchStripeConnectionLink() {
    // POST /farmer/stripe/account  -> { url, stripe_account_id }
    const res = await fetch(`${ROOT_BASE}/farmer/stripe/account`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
      credentials: "include",
      body: JSON.stringify({}), // backend can ignore; safe default
    });

    const parsed = await readJsonOrText(res);
    if (!parsed.ok) throw new Error(`Stripe connection link failed (HTTP ${parsed.status})`);

    const url = parsed.data?.url;
    if (!url) throw new Error("Stripe account create endpoint did not return {url}.");
    return String(url);
  }

  async function refreshStripeUi() {
    if (!connectStripeBtn) return;

    try {
      if (!requireProviderRole("Checking Stripe status")) return;

      stripeAccountStatus = await fetchStripeAccountStatus();

      const connected = Boolean(stripeAccountStatus?.connected);
      const payoutsEnabled = Boolean(stripeAccountStatus?.payouts_enabled);
      const detailsSubmitted = Boolean(stripeAccountStatus?.details_submitted);

      if (connected && payoutsEnabled && detailsSubmitted) {
        connectStripeBtn.textContent = "Open Stripe payout dashboard";
        connectStripeBtn.dataset.mode = "dashboard";
        setStripeStatus("Stripe connected. Payouts enabled.", "success");
        return;
      }

      if (connected) {
        connectStripeBtn.textContent = "Open Stripe (finish setup)";
        connectStripeBtn.dataset.mode = "connect";
        setStripeStatus("Stripe connected, but setup may be incomplete.", "warning");
        return;
      }

      connectStripeBtn.textContent = "Get Stripe connection link";
      connectStripeBtn.dataset.mode = "connect";
      setStripeStatus("Stripe not connected yet.", "muted");
    } catch (err) {
      console.warn("refreshStripeUi failed:", err);
      connectStripeBtn.textContent = "Stripe status unavailable";
      setStripeStatus("Could not load Stripe status.", "danger");
    }
  }

  async function handleStripeButtonClick() {
    if (!connectStripeBtn) return;
    if (!requireProviderRole("Opening Stripe")) return;

    connectStripeBtn.disabled = true;

    try {
      await refreshStripeUi();

      const mode = String(connectStripeBtn.dataset.mode || "");
      if (mode === "dashboard") {
        setStatus("Opening Stripe dashboard…", "muted");
        const url = await fetchStripeDashboardLink();
        window.open(url, "_blank", "noopener,noreferrer");
        setStatus("", "success");
        return;
      }

      // Not fully connected or not connected:
      // This returns a link the provider can use to connect/finish setup.
      setStatus("Getting Stripe connection link…", "muted");
      const url = await fetchStripeConnectionLink();
      window.open(url, "_blank", "noopener,noreferrer");
      setStatus("Opened Stripe connection link.", "success");
    } catch (err) {
      setStatus(err?.message || String(err), "danger");
    } finally {
      connectStripeBtn.disabled = false;
      await refreshStripeUi();
    }
  }

  async function handleStripeCallbackHints() {
    // Optional: if you redirect back to farmer.html?stripe=return or ?stripe=refresh
    const params = new URLSearchParams(window.location.search);
    const mode = String(params.get("stripe") || "").toLowerCase();
    if (!mode || (mode !== "return" && mode !== "refresh")) return;

    const endpoint = mode === "return" ? "/farmer/stripe/return/" : "/farmer/stripe/refresh/";

    try {
      const res = await fetch(`${ROOT_BASE}${endpoint}`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
        credentials: "include",
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) return;

      const status = String(parsed.data?.status || "");
      const message = String(parsed.data?.message || "");

      if (mode === "return") {
        setStripeStatus(status ? `Stripe: ${status}` : "Stripe return received.", "success");
        setStatus("Stripe return received. Refreshing…", "success");
      } else {
        setStripeStatus(message || "Stripe link expired. Request a new link.", "warning");
        setStatus(message || "Stripe link expired. Request a new link.", "warning");
      }

      await refreshStripeUi();
    } catch (err) {
      console.warn("handleStripeCallbackHints failed:", err);
    }
  }

  // ============================================================================
  // EVENTS
  // ============================================================================

  function wireEvents() {
    // Inventory refresh
    refreshInventoryBtn?.addEventListener("click", loadInventory);
    invSearch?.addEventListener("input", renderInventory);

    // Orders refresh
    refreshFarmerOrdersBtn?.addEventListener("click", loadOrders);

    // Inventory table actions (edit/delete)
    inventoryBody?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-action]");
      if (!btn) return;

      const action = String(btn.dataset.action || "");
      const id = String(btn.dataset.id || "");

      if (!id) return;

      if (action === "delete") {
        deleteProduct(id);
        return;
      }

      if (action === "edit") {
        const p = findProductById(id);
        if (!p) return;

        // Populate modal form
        if (epId) epId.value = String(p?.id ?? p?.product_id ?? "");
        if (epName) epName.value = String(p?.name ?? "");
        if (epDescription) epDescription.value = String(p?.description ?? "");
        if (epCategory) epCategory.value = String(p?.category ?? "");
        if (epPrice) epPrice.value = String(p?.price ?? "");
        if (epStock) epStock.value = String(p?.stock ?? p?.quantity ?? "");
        if (epIsActive) epIsActive.checked = Boolean(p?.is_active ?? p?.active ?? true);

        if (epCurrentPhoto) {
          const url = String(p?.photo_url ?? "");
          epCurrentPhoto.textContent = url ? `Current: ${url}` : "Current: —";
        }

        setEditStatus("", "muted");
        editModal?.show();
      }
    });

    // Edit modal save
    editProductForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireProviderRole("Saving product changes")) return;

      const id = epId?.value;
      if (!id) {
        setEditStatus("Missing product id.", "danger");
        return;
      }

      // Build PATCH payload (only send fields we have)
      const payload = {
        name: epName?.value ?? "",
        description: epDescription?.value ?? "",
        category: epCategory?.value ?? "",
        price: Number(epPrice?.value ?? 0),
        stock: Number(epStock?.value ?? 0),
        is_active: Boolean(epIsActive?.checked),
      };

      // Photo: if you support URL upload vs file upload, adjust here.
      // If your backend expects multipart for images, keep photo handling separate.
      const photoVal = String(epPhoto?.value || "").trim();
      if (photoVal) payload.photo_url = photoVal;

      await updateProduct(id, payload);
    });

    // Add product form
    addProductForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!requireProviderRole("Creating a product")) return;

      const form = new FormData(addProductForm);

      const payload = {
        name: String(form.get("name") || "").trim(),
        description: String(form.get("description") || "").trim(),
        category: String(form.get("category") || "").trim(),
        price: String(form.get("price") || "").trim(),
        stock: String(form.get("stock") || "").trim(),
        photo: form.get("photo"),
      };

      if (!payload.name) {
        setStatus("Product name is required.", "danger");
        return;
      }

      if (!payload.category) {
        setStatus("Category is required.", "danger");
        return;
      }

      if (!payload.price || Number(payload.price) < 0) {
        setStatus("Please enter a valid price.", "danger");
        return;
      }

      if (!payload.stock || Number(payload.stock) < 1) {
        setStatus("Stock must be at least 1.", "danger");
        return;
      }

      await createProduct(payload);
    });

    // Stripe button
    connectStripeBtn?.addEventListener("click", handleStripeButtonClick);

    // Orders table actions
    farmerOrdersBody?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-action]");
      if (!btn) return;

      const action = String(btn.dataset.action || "");
      const id = String(btn.dataset.id || "");

      if (!id) return;

      if (action === "confirmOrder") {
        confirmOrder(id);
      }
    });

    //Upload Logo
    farmLogoInput?.addEventListener("change", async (e) => {
      const file = e.target?.files?.[0];
      if (!file) return;

      await uploadFarmLogo(file);
    });
  }

  // ============================================================================
  // INIT
  // ============================================================================

  async function init() {
    wireEvents();

    // Don’t block rendering; just show helpful messages
    const role = getUserRole();
    if (role !== "provider") {
      showProviderHelp(
        `You are logged in, but your role is "${role || "unknown"}". Farmer Portal requires role "provider".`,
      );
      return;
    }

    await loadFarmProfileTitle();
    await handleStripeCallbackHints();

    // Load portal data
    await Promise.allSettled([loadInventory(), loadOrders(), refreshStripeUi()]);
  }

  // Kick off
  init().catch((err) => {
    console.error("FarmerPortal init failed:", err);
    setStatus("Farmer portal failed to initialize. Check console for details.", "danger");
  });
})();