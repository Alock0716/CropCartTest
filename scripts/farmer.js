/**
 * ============================================================================
 * farmer.js — Farmer Portal logic (FULL REPLACEMENT)
 * ----------------------------------------------------------------------------
 * What this version does (per your request):
 * - Uses your provided AUTH HELPERS block (provider first, customer fallback)
 * - Adds a provider-guard so farmer-only endpoints don't accidentally use cc_auth
 * - Implements Stripe Connect button behavior using ONLY the status fields:
 *    { connected, stripe_account_id, charges_enabled, payouts_enabled, details_submitted }
 *   -> and the "format" you requested:
 *      handleStripeConnection() decides which action to take.
 *
 * Assumptions (same as your project):
 * - CFG.API_URL exists (ex: https://.../api)
 * - ROOT_BASE is API_URL without trailing /api
 * - Farmer endpoints live under /farmer/*
 * - Stripe status endpoint exists at /farmer/stripe/account (trailing slash maybe)
 * - Stripe onboarding/dashboard link endpoints may exist on backend:
 *     POST /farmer/stripe/account/onboarding  -> { url }
 *     POST /farmer/stripe/account/dashboard   -> { url }
 *   If those are missing, but CFG.STRIPE_API_URL exists, we fall back to helper server.
 * ============================================================================
 */

(function FarmerPortal() {
  "use strict";

  // ==========================================================================
  // CONFIG / BASE URLS
  // ==========================================================================

  const CFG = window.__CROPCART_CONFIG__ || {};

  // API base (usually ends with /api)
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, "");

  // Root base (strip trailing /api)
  const ROOT_BASE = API_BASE.replace(/\/api$/i, "");

  // Optional helper Stripe server (old flow)
  const API_STRIPE = String(CFG.STRIPE_API_URL || "").replace(/\/+$/, "");

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
  const refreshFarmerOrdersBtn = document.getElementById(
    "refreshFarmerOrdersBtn",
  );

  // Add product
  const addProductForm = document.getElementById("addProductForm");
  const addProductBtn = document.getElementById("addProductBtn");

  // Header title
  const farmerPortalTitle = document.getElementById("farmerPortalTitle");

  // Stripe payout setup
  const connectStripeBtn = document.getElementById("connectStripeBtn");
  const stripeStatusBox = document.getElementById("stripeStatusBox"); // optional

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

  const editModal = editProductModalEl
    ? new bootstrap.Modal(editProductModalEl)
    : null;

  // ==========================================================================
  // STATE
  // ==========================================================================

  let inventory = [];
  let orders = [];

  // ==========================================================================
  // UI HELPERS
  // ==========================================================================

  function setStatus(msg, kind = "muted") {
    if (!pageStatus) return;
    pageStatus.textContent = msg || "";
    pageStatus.className = `small text-${kind}`;
  }

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

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function findProductById(productId) {
    return (
      inventory.find(
        (p) => String(p.id ?? p.product_id) === String(productId),
      ) || null
    );
  }

  // ==========================================================================
  // AUTH HELPERS (EXACT BLOCK YOU PROVIDED)
  // ==========================================================================

  /**
   * Reads provider auth from storage if it exists.
   * We use this FIRST because farmer endpoints likely require provider credentials.
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
    if (typeof getAuth === "function") return getAuth(); // uses cc_auth internally
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
   */
  function getBestAccessToken() {
    const provider = getProviderAuth();
    if (provider?.access) return String(provider.access);

    const customer = getCustomerAuth();
    if (customer?.access) return String(customer.access);

    return "";
  }

  function authHeaders(extra = {}) {
    const token = getBestAccessToken();
    return token
      ? { ...extra, Authorization: `Bearer ${token}` }
      : { ...extra };
  }

  async function readJsonOrText(res) {
    const text = await res.text();
    try {
      return {
        ok: res.ok,
        status: res.status,
        data: JSON.parse(text),
        raw: text,
      };
    } catch {
      return { ok: res.ok, status: res.status, data: null, raw: text };
    }
  }

  // ==========================================================================
  // PROVIDER GUARDS (so /farmer/* doesn't use cc_auth fallback)
  // ==========================================================================

  function hasProviderToken() {
    const provider = getProviderAuth();
    return Boolean(provider?.access);
  }

  function requireProviderAuth(actionLabel = "This action") {
    if (hasProviderToken()) return true;

    setStatus(
      `${actionLabel} requires a Farmer/Provider login. ` +
        `Your provider token (cc_farmer_auth) is missing or expired.`,
      "danger",
    );

    return false;
  }

  // ==========================================================================
  // RENDER — INVENTORY + ORDERS
  // ==========================================================================

  function renderInventory() {
    if (!inventoryBody) return;

    const q = String(invSearch?.value || "")
      .trim()
      .toLowerCase();

    const list = inventory.filter((p) => {
      const name = String(p?.name ?? "").toLowerCase();
      return !q || name.includes(q);
    });

    inventoryBody.innerHTML = "";

    if (!list.length) {
      inventoryBody.innerHTML = `
        <tr><td colspan="5" class="text-muted small py-4">No inventory found.</td></tr>
      `;
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

  function renderOrders() {
    if (!farmerOrdersBody) return;

    farmerOrdersBody.innerHTML = "";

    if (!orders.length) {
      farmerOrdersBody.innerHTML = `
        <tr><td colspan="4" class="text-muted small py-4">No incoming orders right now.</td></tr>
      `;
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

    epPhoto.value = "";

    if (epCurrentPhoto) {
      const photoUrl = p.photo_url || "";
      epCurrentPhoto.textContent = photoUrl
        ? "Current photo: set"
        : "Current photo: none";
    }

    setEditStatus("");
    editModal.show();
  }

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

      const res = await fetch(
        `${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/`,
        {
          method: "PUT",
          headers: authHeaders({ Accept: "application/json" }),
          body: fd,
        },
      );

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
  // STRIPE CONNECT — STATUS + ACTIONS (YOUR REQUESTED FORMAT)
  // ==========================================================================

  /**
   * Fetch stripe status.
   * Tries trailing slash first (common backend requirement).
   */
  async function fetchStripeAccountState() {
    const urls = [
      `${ROOT_BASE}/farmer/stripe/account/`,
      `${ROOT_BASE}/farmer/stripe/account`,
    ];

    let lastErr = null;

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: authHeaders({ Accept: "application/json" }),
        });

        if (res.status === 404) continue;

        const parsed = await readJsonOrText(res);
        if (!parsed.ok) {
          throw new Error(
            parsed.data?.error ||
              `Stripe account status failed (HTTP ${parsed.status})`,
          );
        }

        return parsed.data || {};
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error("Stripe account status endpoint not found.");
  }

  /**
   * Prefer backend onboarding endpoint:
   *   POST /farmer/stripe/account/onboarding -> { url }
   * Fallback to helper server if configured.
   */
  async function startStripeOnboarding() {
    // Backend attempt
    {
      const res = await fetch(`${ROOT_BASE}/farmer/stripe/account`, {
        method: "POST",
        headers: authHeaders({ Accept: "application/json" }),
      });

      const parsed = await readJsonOrText(res);
      if (parsed.ok && parsed.data?.url) {
        window.location.href = String(parsed.data.url);
        return;
      }
    }

    // Helper fallback
    if (API_STRIPE) {
      const res = await fetch(`${API_STRIPE}/stripe/account/`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) {
        throw new Error(
          parsed.data?.error ||
            `Stripe Connect start failed (HTTP ${parsed.status})`,
        );
      }
      if (!parsed.data?.url) throw new Error("No onboarding URL returned.");
      window.location.href = String(parsed.data.url);
      return;
    }

    throw new Error("No onboarding endpoint available.");
  }

  /**
   * Prefer backend dashboard endpoint:
   *   POST /farmer/stripe/account/dashboard -> { url }
   * Fallback to helper server if configured.
   */
  async function openStripeDashboard() {
    // Backend attempt
    {
      const res = await fetch(`${ROOT_BASE}/farmer/stripe/account/dashboard`, {
        method: "POST",
        headers: authHeaders({ Accept: "application/json" }),
      });

      const parsed = await readJsonOrText(res);
      if (parsed.ok && parsed.data?.url) {
        window.open(String(parsed.data.url), "_blank", "noopener,noreferrer");
        return;
      }
    }

    // Helper fallback
    if (API_STRIPE) {
      const res = await fetch(`${API_STRIPE}/stripe/account`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) {
        throw new Error(
          parsed.data?.error ||
            `Stripe dashboard failed (HTTP ${parsed.status})`,
        );
      }
      if (!parsed.data?.url) throw new Error("No dashboard URL returned.");
      window.open(String(parsed.data.url), "_blank", "noopener,noreferrer");
      return;
    }

    throw new Error("No dashboard endpoint available.");
  }

  /**
   * YOUR REQUESTED DECIDER:
   * Uses ONLY the stripe status fields to decide what to do.
   */
  async function handleStripeConnection() {
    const status = await fetchStripeAccountState();

    // Keep button/status text in sync (optional)
    updateStripeUiFromState(status);

    // If not connected, start onboarding
    if (!status.connected) {
      await startStripeOnboarding();
      return;
    }

    // Connected but onboarding not finished
    if (status.connected && !status.details_submitted) {
      await startStripeOnboarding();
      return;
    }

    // Details submitted but not fully enabled
    if (
      status.details_submitted &&
      (!status.charges_enabled || !status.payouts_enabled)
    ) {
      await startStripeOnboarding();
      return;
    }

    // Fully enabled
    if (status.charges_enabled && status.payouts_enabled) {
      await openStripeDashboard();
      return;
    }

    // Catch-all fallback (safe)
    await startStripeOnboarding();
  }

  /**
   * Optional UI helper: updates Stripe status box + button label based on state.
   * Uses ONLY: connected/details_submitted/charges_enabled/payouts_enabled/account_id
   */
  function updateStripeUiFromState(status) {
    if (!connectStripeBtn) return;

    const connected = Boolean(status?.connected);
    const acctId = status?.stripe_account_id ? String(status.stripe_account_id) : "";
    const details = Boolean(status?.details_submitted);
    const charges = Boolean(status?.charges_enabled);
    const payouts = Boolean(status?.payouts_enabled);

    // Default
    connectStripeBtn.disabled = false;

    if (!connected) {
      connectStripeBtn.textContent = "Connect Stripe";
      setStripeStatus("Stripe not connected yet.", "muted");
      return;
    }

    if (!details) {
      connectStripeBtn.textContent = "Finish Stripe Setup";
      setStripeStatus(
        `Stripe connected${acctId ? ` (${acctId})` : ""}, but onboarding is not finished.`,
        "warning",
      );
      return;
    }

    if (!charges || !payouts) {
      connectStripeBtn.textContent = "Review Stripe Requirements";
      setStripeStatus(
        `Stripe setup submitted${acctId ? ` (${acctId})` : ""}. Waiting for charges/payouts to be enabled.`,
        "warning",
      );
      return;
    }

    connectStripeBtn.textContent = "Open Stripe Dashboard";
    setStripeStatus(
      `Stripe fully enabled${acctId ? ` (${acctId})` : ""}.`,
      "success",
    );
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
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Inventory error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Inventory failed (HTTP ${parsed.status})`, "danger");

      inventory = [];
      renderInventory();
      return;
    }

    inventory = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data?.results || [];

    renderInventory();
    setStatus("", "success");
  }

  async function loadFarmProfile() {
    try {
      const res = await fetch(`${ROOT_BASE}/farms/`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok || !Array.isArray(parsed.data)) return;

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
    });

    const parsed = await readJsonOrText(res);

    if (!parsed.ok) {
      console.log("Orders error:", parsed.status, parsed.data ?? parsed.raw);
      setStatus(`Orders failed (HTTP ${parsed.status})`, "danger");

      orders = [];
      renderOrders();
      return;
    }

    orders = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data?.results || [];

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
        headers: authHeaders(),
        body: fd,
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

    const res = await fetch(
      `${ROOT_BASE}/farmer/products/${encodeURIComponent(productId)}/delete/`,
      {
        method: "DELETE",
        headers: authHeaders({ Accept: "application/json" }),
      },
    );

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

    const res = await fetch(
      `${ROOT_BASE}/farmer/orders/${encodeURIComponent(orderId)}/confirm/`,
      {
        method: "PUT",
        headers: authHeaders({ Accept: "application/json" }),
      },
    );

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

    connectStripeBtn?.addEventListener("click", async () => {
      if (!connectStripeBtn) return;

      try {
        connectStripeBtn.disabled = true;
        setStatus("Opening Stripe setup…", "muted");

        await handleStripeConnection();

        setStatus("", "success");
      } catch (err) {
        console.error("Stripe connection failed:", err);
        setStatus(err?.message || "Unable to open Stripe connection portal.", "danger");
      } finally {
        connectStripeBtn.disabled = false;
      }
    });

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

    // Stripe: update the UI on load
    try {
      const s = await fetchStripeAccountState();
      updateStripeUiFromState(s);
    } catch {
      // don't block the page if stripe status fails
      setStripeStatus("Stripe status unavailable.", "danger");
    }
  });
})();