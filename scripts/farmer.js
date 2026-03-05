/**
 * ============================================================================
 * farmer.js — Farmer Portal logic (FULL REPLACEMENT)
 * ----------------------------------------------------------------------------
 * This version does exactly what you asked:
 * - Fixes token detection (uses cc_auth in sessionStorage/localStorage)
 * - Treats provider users stored in cc_auth as valid provider auth
 * - Uses the CORRECT Stripe status endpoint you discovered:
 *     GET /farmer/stripe/account/   (works)
 * - Stripe button: "skip the onboarding logic" and just LINK OUT:
 *     click -> try a small set of link endpoints -> open returned {url}
 *
 * IMPORTANT:
 * - You cannot safely build a Stripe Connect URL in the browser.
 * - One of the "link endpoints" MUST exist server-side and return { url }.
 * - We DO NOT POST to /farmer/stripe/account (that was 500 for you).
 *
 * NOTE ON "Unexpected token export":
 * - That error is from some OTHER JS file being loaded as non-module.
 * - This farmer.js is plain script (no export/import) so it won't cause that.
 * ============================================================================
 */

(function FarmerPortal() {
  "use strict";

  // ==========================================================================
  // CONFIG / BASE URLS
  // ==========================================================================

  const CFG = window.__CROPCART_CONFIG__ || {};

  /**
   * Base API URL (usually ends in /api) set in config.js
   * Example: https://d1nnhq1iqs57tb.cloudfront.net/api
   */
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, "");

  /**
   * Root base URL (strip trailing /api)
   * Example: https://d1nnhq1iqs57tb.cloudfront.net
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
  // AUTH HELPERS (robust + matches your actual storage)
  // ==========================================================================

  /**
   * Reads JSON from storage safely.
   * @param {Storage} store
   * @param {string} key
   * @returns {any|null}
   */
  function readStoreJson(store, key) {
    try {
      const raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * Provider auth may be stored as:
   * - cc_farmer_auth (dedicated)
   * - OR cc_auth where user.role === "provider" (your current reality)
   */
  function getProviderAuth() {
    // Dedicated farmer auth first
    const farmer =
      readStoreJson(sessionStorage, "cc_farmer_auth") ||
      readStoreJson(localStorage, "cc_farmer_auth");

    if (farmer?.access) return farmer;

    // Fallback to cc_auth (only if provider role)
    const auth =
      (window.CC?.auth?.getAuth ? window.CC.auth.getAuth() : null) ||
      readStoreJson(sessionStorage, "cc_auth") ||
      readStoreJson(localStorage, "cc_auth");

    if (auth?.access && auth?.user?.role === "provider") return auth;

    return null;
  }

  /**
   * "Customer auth" is just cc_auth, regardless of role.
   * We still read it, because your site uses cc_auth everywhere.
   */
  function getCustomerAuth() {
    return (
      (window.CC?.auth?.getAuth ? window.CC.auth.getAuth() : null) ||
      readStoreJson(sessionStorage, "cc_auth") ||
      readStoreJson(localStorage, "cc_auth")
    );
  }

  /**
   * Picks best access token:
   * - provider token preferred
   * - otherwise cc_auth token
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

  /**
   * Farmer-only routes should require provider role
   */
  function requireProviderAuth(actionLabel = "This action") {
    const provider = getProviderAuth();
    if (provider?.access) return true;

    setStatus(
      `${actionLabel} requires a Provider login. ` +
        `You're logged out or not recognized as a provider.`,
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

    epId.value = String(idValue);
    epName.value = String(p.name ?? "");
    epDescription.value = String(p.description ?? "");
    epCategory.value = String(p.category ?? "other");
    epPrice.value = String(p.price ?? "");
    epStock.value = String(p.stock ?? 0);
    epIsActive.checked =
      typeof p.is_active === "boolean" ? p.is_active : true;

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
        console.log(
          "Update product failed:",
          parsed.status,
          parsed.data ?? parsed.raw,
        );
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
  // STRIPE — STATUS (GET) + LINK-OUT (no onboarding logic)
  // ==========================================================================

  /**
   * You verified this exists:
   *   GET /farmer/stripe/account/
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

        // If 404, try the next variant
        if (res.status === 404) continue;

        const parsed = await readJsonOrText(res);
        if (!parsed.ok) {
          throw new Error(
            parsed.data?.detail ||
              parsed.data?.error ||
              `Stripe status failed (HTTP ${parsed.status})`,
          );
        }

        return parsed.data || {};
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("Stripe status endpoint not found.");
  }

  /**
   * Link-out URL generator:
   * We try a SMALL list of likely endpoints that should return { url }.
   * You told me: "no onboarding, just skip to the link out".
   *
   * If none of these exist, you need to confirm the backend route name.
   */
  async function getStripeLinkOutUrl() {
    // Keep this list tight; add the REAL one once you confirm it.
    const candidates = [
      // Common patterns for creating an account link / portal link
      `${ROOT_BASE}/farmer/stripe/link/`,
      `${ROOT_BASE}/farmer/stripe/link`,
      `${ROOT_BASE}/farmer/stripe/connect/`,
      `${ROOT_BASE}/farmer/stripe/connect`,
      `${ROOT_BASE}/farmer/stripe/portal/`,
      `${ROOT_BASE}/farmer/stripe/portal`,
      `${ROOT_BASE}/farmer/stripe/dashboard/`,
      `${ROOT_BASE}/farmer/stripe/dashboard`,
      `${ROOT_BASE}/farmer/stripe/account/link/`,
      `${ROOT_BASE}/farmer/stripe/account/link`,
      `${ROOT_BASE}/farmer/stripe/account/dashboard/`,
      `${ROOT_BASE}/farmer/stripe/account/dashboard`,
    ];

    let lastErr = null;

    for (const url of candidates) {
      try {
        // POST first (fresh link)
        let res = await fetch(url, {
          method: "POST",
          headers: authHeaders({ Accept: "application/json" }),
        });

        if (res.status !== 404) {
          const parsed = await readJsonOrText(res);
          if (parsed.ok && parsed.data?.url) return String(parsed.data.url);
        }

        // Then GET (some APIs just return an existing link)
        res = await fetch(url, {
          method: "GET",
          headers: authHeaders({ Accept: "application/json" }),
        });

        if (res.status !== 404) {
          const parsed = await readJsonOrText(res);
          if (parsed.ok && parsed.data?.url) return String(parsed.data.url);
        }
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("No Stripe link-out endpoint returned {url}.");
  }

  /**
   * Stripe button: always link out (no branching).
   * We still fetch status on load to show a helpful message, but it won't block linking.
   */
  async function linkOutToStripe() {
    if (!requireProviderAuth("Stripe access")) return;

    // Try to link out even if status is weird; status is informational only.
    const url = await getStripeLinkOutUrl();

    // New tab is safer for external portals
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function refreshStripeUi() {
    if (!connectStripeBtn) return;

    connectStripeBtn.disabled = false;
    connectStripeBtn.textContent = "Open Stripe";

    try {
      const s = await fetchStripeAccountState();

      const connected = Boolean(s?.connected);
      const acctId = s?.stripe_account_id ? String(s.stripe_account_id) : "";
      const details = Boolean(s?.details_submitted);
      const charges = Boolean(s?.charges_enabled);
      const payouts = Boolean(s?.payouts_enabled);

      if (!connected) {
        setStripeStatus("Stripe not connected yet (server reports not connected).", "warning");
        return;
      }

      if (!details || !charges || !payouts) {
        setStripeStatus(
          `Stripe connected${acctId ? ` (${acctId})` : ""}, but setup isn't fully enabled yet.`,
          "warning",
        );
        return;
      }

      setStripeStatus(
        `Stripe fully enabled${acctId ? ` (${acctId})` : ""}.`,
        "success",
      );
    } catch (e) {
      // Don’t block the button; just show a note.
      setStripeStatus("Stripe status unavailable (still can try Open Stripe).", "danger");
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

      if (farmerPortalTitle) {
        farmerPortalTitle.textContent = `${farmName}'s Farmer Portal`;
      }
      document.title = `${farmName} | Farmer Portal`;
    } catch (e) {
      // non-blocking
    }
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
        console.log(
          "Create product error:",
          parsed.status,
          parsed.data ?? parsed.raw,
        );
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
      console.log(
        "Delete product error:",
        parsed.status,
        parsed.data ?? parsed.raw,
      );
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
      console.log(
        "Confirm order error:",
        parsed.status,
        parsed.data ?? parsed.raw,
      );
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
      if (id) confirmOrder(id);
    });

    connectStripeBtn?.addEventListener("click", async () => {
      if (!connectStripeBtn) return;

      try {
        connectStripeBtn.disabled = true;
        setStatus("Opening Stripe…", "muted");

        await linkOutToStripe();

        setStatus("", "success");
      } catch (err) {
        console.error("Stripe link-out failed:", err);
        setStatus(err?.message || "Unable to open Stripe.", "danger");
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

    // Non-blocking page loads
    await loadFarmProfile();
    await loadInventory();
    await loadOrders();

    // Stripe UI refresh (does not block Open Stripe button)
    await refreshStripeUi();
  });
})();