/**
 * farmer.js — Farmer Portal logic
 *
 * IMPORTANT:
 * - Farmer routes are rooted at /farmer/* (NOT /api/farmer/*)
 * - Provider auth may be stored separately as "cc_farmer_auth"
 *
 * This file:
 * - Uses provider token if present
 * - Falls back to customer token
 * - Gives a clear 401 message guiding provider approval/login
 */

(function FarmerPortal() {
  "use strict";

  // -----------------------------
  // BASE URLS
  // -----------------------------
  const CFG = window.__CROPCART_CONFIG__ || {};
  const API_BASE = String(CFG.API_URL || "").replace(/\/+$/, ""); // e.g. http://3.142.227.162/api
  const ROOT_BASE = API_BASE.replace(/\/api$/i, ""); // e.g. http://3.142.227.162
  const API_STRIPE = String(CFG.STRIPE_API_URL || "");

  // -----------------------------
  // DOM
  // -----------------------------
  const pageStatus = document.getElementById("pageStatus");
  const inventoryBody = document.getElementById("inventoryBody");
  const farmerOrdersBody = document.getElementById("farmerOrdersBody");

  const refreshInventoryBtn = document.getElementById("refreshInventoryBtn");
  const refreshFarmerOrdersBtn = document.getElementById(
    "refreshFarmerOrdersBtn",
  );
  const invSearch = document.getElementById("invSearch");

  const addProductForm = document.getElementById("addProductForm");
  const addProductBtn = document.getElementById("addProductBtn");

  const farmerPortalTitle = document.getElementById("farmerPortalTitle");

  // --- DOM Edit Product Modal elements
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

  // bootstrap modal instance (created once)
  const editModal = editProductModalEl
    ? new bootstrap.Modal(editProductModalEl)
    : null;

  // -----------------------------
  // STATE
  // -----------------------------
  let inventory = [];
  let orders = [];

  // --- Stripe payout setup elements
  const connectStripeBtn = document.getElementById("connectStripeBtn");

  // Caches the exact username used for Stripe mapping so return/refresh works reliably
  const STRIPE_USERNAME_KEY = "cc_stripe_provider_username";

  /**
   * Try to find a username we can use as a stable key for mapping
   * to a Stripe account in stripe_accounts.json.
   */
  function getBestUsernameForStripe() {
    // 1) Prefer cached username from last onboarding attempt
    const cached = localStorage.getItem(STRIPE_USERNAME_KEY);
    if (cached) return cached;

    // 2) Fall back to auth objects
    const provider = getProviderAuth();
    const customer = getCustomerAuth();

    const username =
      provider?.user?.username ||
      provider?.username ||
      provider?.user?.email ||
      customer?.user?.username ||
      customer?.username ||
      customer?.user?.email ||
      "";

    if (username) localStorage.setItem(STRIPE_USERNAME_KEY, username);
    return username;
  }
  // -----------------------------
  // UI HELPERS
  // -----------------------------

  function setEditStatus(msg, kind = "muted") {
    if (!epStatus) return;
    epStatus.textContent = msg || "";
    epStatus.className = `small text-${kind}`;
  }

  function findProductById(productId) {
    return (
      inventory.find(
        (p) => String(p.id ?? p.product_id) === String(productId),
      ) || null
    );
  }

  function setStatus(msg, kind = "muted") {
    if (!pageStatus) return;
    pageStatus.textContent = msg || "";
    pageStatus.className = `small text-${kind}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // -----------------------------
  // AUTH HELPERS
  // -----------------------------
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
   * auth.js stores "cc_auth" and the token field is "access".【turn4:5†auth.js†L44-L56】
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

  function showProvider401Help() {
    // Provider registration requires approval per API docs【turn4:9†API_DOCUMENTATION.md†L45-L100】
    setStatus(
      "401 Unauthorized. Farmer Portal requires an APPROVED provider account. " +
        "If you registered as a provider, wait for admin approval, or log in with your provider credentials.",
      "danger",
    );
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  function openEditProductModal(productId) {
    if (!editModal) return;

    const p = findProductById(productId);
    if (!p) {
      setStatus("Could not find that product in inventory.", "danger");
      return;
    }

    // Normalize common API shapes
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

    // file inputs can’t be programmatically set (browser security)
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
          <button 
            type="button"
            class="btn btn-outline-primary"
            data-edit="${escapeHtml(String(id))}">
            Edit
          </button>
          <button class="btn btn-sm btn-outline-danger" type="button" data-del="${escapeHtml(String(id))}">
            Delete
          </button>
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
          <button class="btn btn-sm btn-outline-cc" type="button" data-confirm="${escapeHtml(String(orderId))}">
            Confirm
          </button>
        </td>
      `;
      farmerOrdersBody.appendChild(tr);
    }
  }

  // -----------------------------
  // API CALLS
  // -----------------------------

  /**
   * Ask our local stripe helper server for the farmer’s connect status.
   * Used to show “connected” vs “needs setup”.
   */
  async function fetchStripeConnectStatus() {
    const url = `${API_STRIPE}status`;
    const res = await fetch(url, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }

    if (!res.ok)
      throw new Error(data?.error || `Stripe status failed (${res.status})`);
    return data;
  }

  /**
   * Starts Stripe Connect onboarding for the farmer:
   * - server returns an onboarding URL
   * - we redirect them to Stripe
   */
  async function startStripeConnectOnboarding(providerUsername) {
    const res = await fetch(`${API_STRIPE}start`, {
      method: "POST",
      headers: authHeaders({ Accept: "application/json" }),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }

    if (!res.ok)
      throw new Error(
        data?.error || `Stripe Connect start failed (${res.status})`,
      );
    if (!data?.url)
      throw new Error("Stripe Connect server did not return a url.");

    localStorage.setItem(STRIPE_USERNAME_KEY, providerUsername);
    window.location.href = data.url;
  }

  /**
   * Optional: open Stripe Express dashboard after they’re connected.
   */
  async function openStripeExpressDashboard(providerUsername) {
    const res = await fetch(`${API_STRIPE}dashboard`, {
      method: "GET",
      headers: authHeaders({ Accept: "application/json" }),
      //body: JSON.stringify({ providerUsername }),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }

    if (!res.ok)
      throw new Error(data?.error || `Stripe dashboard failed (${res.status})`);
    if (!data?.url)
      throw new Error("Stripe Connect server did not return a dashboard url.");

    window.open(data.url, "_blank", "noopener,noreferrer");
  }

  async function submitEditProduct() {
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
          headers: authHeaders({ Accept: "application/json" }), // DON'T set Content-Type with FormData
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

      // Refresh inventory to show updates (stock/price/photo_url etc.)
      await loadInventory();

      // Close modal
      editModal.hide();
      setStatus("Product updated.", "success");
    } finally {
      if (epSaveBtn) epSaveBtn.disabled = false;
    }
  }

  async function refreshStripePayoutUi() {
    if (!connectStripeBtn) return;

    const providerUsername = getBestUsernameForStripe();
    if (!providerUsername) {
      connectStripeBtn.textContent = "Connect Stripe";
      connectStripeBtn.disabled = false;
      return;
    }

    try {
      const status = await fetchStripeConnectStatus(providerUsername);

      if (status?.connected) {
        connectStripeBtn.textContent = "Open Stripe payout dashboard";
        connectStripeBtn.disabled = false;

        // If connected, make the button open the dashboard instead of onboarding
        connectStripeBtn.dataset.mode = "dashboard";
        connectStripeBtn.textContent = "Open Stripe payout dashboard";

        setStatus("✅ Stripe is connected for payouts.", "success");
        return;
      }

      // Not connected yet
      connectStripeBtn.dataset.mode = "onboarding";
      connectStripeBtn.textContent = "Connect Stripe";

      // restore normal click behavior (onboarding)
      connectStripeBtn.onclick = null;
    } catch (err) {
      // If the local stripe server isn’t running, don’t brick the page
      connectStripeBtn.textContent = "Connect Stripe";
      setStatus("danger");
    }
  }

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

    inventory = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data?.results || [];
    renderInventory();
    setStatus("Inventory loaded", "success");
  }

  /**
   * Loads all farms and finds the one owned by the current user.
   * Then updates the page header to:
   * "[Farm Name]'s Farmer Portal"
   *
   * Assumes /farms/ returns an array of farm objects.
   * Looks for a property like:
   *   owner === true
   */
  async function loadFarmProfile() {
    try {
      const res = await fetch(`${ROOT_BASE}/farms/`, {
        method: "GET",
        headers: authHeaders({ Accept: "application/json" }),
      });

      const parsed = await readJsonOrText(res);

      if (!parsed.ok || !Array.isArray(parsed.data)) {
        console.log(
          "Farms fetch failed:",
          parsed.status,
          parsed.data ?? parsed.raw,
        );
        return;
      }

      // Adjust this line if your property name differs
      const ownedFarm = parsed.data.find((f) => f.is_owner === true);

      if (!ownedFarm) {
        console.warn("No owned farm found in farms list.");
        return;
      }

      const farmName = String(ownedFarm.name || "").trim();
      if (!farmName) return;

      if (farmerPortalTitle) {
        farmerPortalTitle.textContent = `${farmName}'s Farmer Portal`;
      }

      document.title = `${farmName} | Farmer Portal`;
    } catch (err) {
      console.warn("loadOwnedFarmFromFarmsList failed:", err);
    }
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

    orders = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data?.results || [];
    renderOrders();
    setStatus("Orders loaded", "success");
  }

  async function createProductFromForm() {
    setStatus("Adding product…", "muted");
    if (addProductBtn) addProductBtn.disabled = true;

    try {
      const name = String(document.getElementById("pName")?.value || "").trim();
      const price = String(
        document.getElementById("pPrice")?.value || "",
      ).trim();
      const stock = String(document.getElementById("pQty")?.value || "").trim();
      const category = String(
        document.getElementById("pCategory")?.value || "",
      ).trim();
      const imageEl = document.getElementById("pImage");

      if (!name || !price || !stock || !category) {
        setStatus(
          "Please fill out name, price, stock, and category.",
          "danger",
        );
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
        headers: authHeaders(), // FormData sets content-type automatically
        body: fd,
      });

      const parsed = await readJsonOrText(res);
      if (!parsed.ok) {
        console.log(
          "Create product error:",
          parsed.status,
          parsed.data ?? parsed.raw,
        );
        if (parsed.status === 401) showProvider401Help();
        else setStatus(`Add product failed (HTTP ${parsed.status})`, "danger");
        return;
      }

      addProductForm?.reset();
      setStatus("Product added", "success");
      await loadInventory();
    } finally {
      if (addProductBtn) addProductBtn.disabled = false;
    }
  }

  async function deleteProduct(productId) {
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
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Delete failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("Product deleted", "success");
    await loadInventory();
  }

  async function confirmOrder(orderId) {
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
      if (parsed.status === 401) showProvider401Help();
      else setStatus(`Confirm failed (HTTP ${parsed.status})`, "danger");
      return;
    }

    setStatus("Confirmed", "success");
    await loadOrders();
  }

  // -----------------------------
  // EVENTS
  // -----------------------------
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
      if (delId) {
        // your existing delete logic
        deleteProduct(delId);
      }
    });

    farmerOrdersBody?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-confirm]");
      const id = btn?.getAttribute?.("data-confirm");
      if (!id) return;
      confirmOrder(id);
    });

    connectStripeBtn?.addEventListener("click", async () => {
      try {
        const providerUsername = getBestUsernameForStripe();
        if (!providerUsername) {
          setStatus(
            "Could not determine your username for Stripe setup. Log in as a provider first.",
            "danger",
          );
          return;
        }

        const mode = connectStripeBtn.dataset.mode || "onboarding";

        if (mode === "dashboard") {
          setStatus("Opening Stripe dashboard…", "muted");
          await openStripeExpressDashboard(providerUsername);
          setStatus("Stripe dashboard opened.", "success");
          return;
        }

        // default onboarding
        setStatus("Starting Stripe Connect…", "muted");
        connectStripeBtn.disabled = true;
        await startStripeConnectOnboarding(providerUsername);
      } catch (err) {
        setStatus(err?.message || String(err), "danger");
      } finally {
        if (connectStripeBtn) connectStripeBtn.disabled = false;
      }
    });
  }

  // -----------------------------
  // INIT
  // -----------------------------

  document.addEventListener("DOMContentLoaded", async () => {
    wireEvents();

    await loadFarmProfile();
    await loadInventory();
    await loadOrders();

    await refreshStripePayoutUi();

    editProductForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitEditProduct();
    });
  });
})();
