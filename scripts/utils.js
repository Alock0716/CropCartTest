/**
 * ============================================================================
 * utils.js — CropCart shared front-end helpers (SOURCE-BASED REGEN)
 * ----------------------------------------------------------------------------
 * IMPORTANT:
 * - Logic/behavior preserved from project source file.
 * - Changes are ORGANIZATION + COMMENTS only.
 *
 * Purpose:
 * - Centralized helpers: config, DOM shortcuts, formatting, auth, API fetch,
 *   and Guest Cart caching (pre-login cart).
 *
 * Usage order (in HTML):
 *   1) config.js
 *   2) utils.js
 *   3) auth.js / page.js / other page scripts
 *
 * Global:
 * - Exposes window.CC (CropCart namespace)
 * ============================================================================
 */

(function initCropCartUtils() {
  "use strict";

  // Prevent redefining CC if this file is loaded more than once.
  if (window.CC && window.CC.__ready) return;

  /* ==========================================================================
   * CONFIG HELPERS
   * ========================================================================== */

  /**
   * Read the global config object (defined in config.js).
   * @returns {object}
   */
  function getConfig() {
    return window.__CROPCART_CONFIG__ || {};
  }

  /**
   * Safely read a config key with fallback.
   * @param {string} key
   * @param {any} [fallback=null]
   * @returns {any}
   */
  function getConfigValue(key, fallback = null) {
    const cfg = getConfig();
    const val = cfg ? cfg[key] : undefined;
    return val === undefined || val === null ? fallback : val;
  }

  /**
   * Normalize a base URL (remove trailing slashes).
   * @param {string} url
   * @returns {string}
   */
  function normalizeBaseUrl(url) {
    return String(url || "")
      .trim()
      .replace(/\/+$/, "");
  }

  /**
   * Returns the API base URL (example: "http://3.142.227.162/api").
   * Supports older keys and creates a consistent source of truth.
   * @returns {string}
   */
  function apiBaseUrl() {
    // Preferred key in your config.js
    const fromConfig = getConfigValue("API_URL", "");
    if (fromConfig) return normalizeBaseUrl(fromConfig);

    // Backwards compatibility if you ever set API_BASE_URL separately
    const legacy = window.API_BASE_URL || window.API_URL || "";
    return normalizeBaseUrl(legacy);
  }

  /**
   * Build a full API URL from a path.
   *
   * NOTE: This preserves your existing special-case behavior for "/farms/".
   *
   * @example buildApiUrl("/products/") -> "http://.../api/products/"
   * @param {string} path
   * @returns {string}
   */
  function buildApiUrl(path) {
    let base = "";
    if (path != "/farms/") {
      base = apiBaseUrl();
    } else {
      base = String(getConfigValue("API_URL", "")).replace(/\/api$/i, "");
    }
    const cleanPath = String(path || "").trim();
    if (!base) return cleanPath; // allows relative if base missing

    if (!cleanPath) return base;
    if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://"))
      return cleanPath;

    return `${base}${cleanPath.startsWith("/") ? "" : "/"}${cleanPath}`;
  }

  /* ==========================================================================
   * DOM HELPERS
   * ========================================================================== */

  /**
   * Run a function once DOM is ready.
   * @param {Function} fn
   */
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  /**
   * Query selector helpers (kept because other project files may rely on them).
   * @param {string} sel
   * @param {ParentNode} [root=document]
   */
  function qs(sel, root = document) {
    return root.querySelector(sel);
  }
  /**
   * Query selector all helper.
   * @param {string} sel
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement[]}
   */
  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  /* ==========================================================================
   * TEXT / FORMATTING HELPERS
   * ========================================================================== */

  /**
   * Escape HTML for safe insertion into innerHTML.
   * @param {any} input
   * @returns {string}
   */
  function escapeHtml(input) {
    return String(input)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /**
   * Format a number as USD (default). If input is invalid, returns "—".
   * @param {any} value
   * @param {string} [currency="USD"]
   * @returns {string}
   */
  function formatMoney(value, currency = "USD") {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    if (!Number.isFinite(num)) return escapeHtml(String(value));
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(num);
    } catch {
      return `$${num.toFixed(2)}`;
    }
  }

  /**
   * Set a status message with a simple styling convention.
   * NOTE: This keeps your existing class reset behavior.
   *
   * @param {HTMLElement|null} el
   * @param {string} message
   * @param {"muted"|"success"|"danger"|"warning"|"info"} [kind="muted"]
   */
  function setStatus(el, message, kind = "muted") {
    if (!el) return;
    el.textContent = message || "";
    el.className = `small mb-3 text-${kind}`;
  }

  /**
   * Format DRF-style field errors (or similar) into a single readable line.
   * @param {any} obj
   * @returns {string}
   */
  function formatFieldErrors(obj) {
    if (!obj || typeof obj !== "object") return "";
    const parts = [];
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) parts.push(`${key}: ${value.join(" ")}`);
      else if (typeof value === "string") parts.push(`${key}: ${value}`);
    }
    return parts.join(" • ");
  }

  /* ==========================================================================
   * NETWORK HELPERS
   * ========================================================================== */

  /**
   * Read a fetch() response as text + attempt JSON parsing.
   * @param {Response} res
   * @returns {Promise<{ok:boolean,status:number,data:any,raw:string}>}
   */
  async function readResponse(res) {
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, raw };
  }

  /**
   * Fetch wrapper:
   * - Builds full URL via buildApiUrl()
   * - Adds Accept header + auth header
   * - Allows `options.json` shorthand for JSON requests
   *
   * @param {string} urlOrPath
   * @param {object} options
   * @returns {Promise<Response>}
   */
  async function apiFetch(urlOrPath, options = {}) {
    const url = buildApiUrl(urlOrPath);
    const init = { ...options };

    if (Object.prototype.hasOwnProperty.call(init, "json")) {
      init.body = JSON.stringify(init.json);
      delete init.json;
    }

    const headers = {
      Accept: "application/json",
      ...authHeader(),
      ...(init.headers || {}),
    };

    if (
      init.body &&
      typeof init.body === "string" &&
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] = "application/json";
    }

    init.headers = headers;
    return fetch(url, init);
  }

  /**
   * Request wrapper:
   * - Calls apiFetch and returns parsed response object.
   * @param {string} urlOrPath
   * @param {object} options
   * @returns {Promise<{ok:boolean,status:number,data:any,raw:string}>}
   */
  async function apiRequest(urlOrPath, options = {}) {
    const res = await apiFetch(urlOrPath, options);
    return readResponse(res);
  }

  /* ==========================================================================
   * AUTH HELPERS
   * ========================================================================== */

  const AUTH_KEY = "cc_auth";
  const FARMER_AUTH_KEY = "cc_farmer_auth";
  const RETURN_TO_KEY = "cc_returnTo";

  /**
   * Read auth object from sessionStorage (preferred) or localStorage.
   * @returns {object|null}
   */
  function getAuth() {
    const sessionRaw = sessionStorage.getItem(AUTH_KEY);
    const localRaw = localStorage.getItem(AUTH_KEY);
    try {
      return JSON.parse(sessionRaw || localRaw || "null");
    } catch {
      return null;
    }
  }

  /**
   * Save auth tokens and user in either sessionStorage or localStorage.
   * Preserves original access/refresh storage design.
   *
   * @param {object} data
   * @param {boolean} remember
   */
  function saveAuth(data, remember) {
    const access = data?.access || null;
    const refresh = data?.refresh || null;
    if (!access) return;

    const payload = {
      access,
      refresh,
      user: data?.user || null,
      savedAt: new Date().toISOString(),
    };

    const store = remember ? localStorage : sessionStorage;
    store.setItem(AUTH_KEY, JSON.stringify(payload));
  }

  /**
   * Clear auth storage.
   */
  function clearAuth() {
    sessionStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_KEY);
  }

  /**
   * True if access token exists.
   * @returns {boolean}
   */
  function isLoggedIn() {
    return !!getAuth()?.access;
  }

  /**
   * Return Authorization header map (Bearer token), or empty map.
   * @returns {object}
   */
  function authHeader() {
    const access = getAuth()?.access;
    if (!access) return {};
    return { Authorization: `Bearer ${access}` };
  }

  /**
   * Clear auth and redirect.
   * @param {string} [redirectTo="index.html"]
   */
  function logout(redirectTo = "index.html") {
    clearAuth();
    sessionStorage.removeItem(RETURN_TO_KEY);
    window.location.href = redirectTo;
  }

  /**
   * Save filename of current page for redirect after login.
   */
  function saveReturnToCurrentPage() {
    const filename = window.location.pathname.split("/").pop() || "index.html";
    sessionStorage.setItem(RETURN_TO_KEY, filename);
  }

  /**
   * Read and clear return-to value.
   * @param {string} [fallback="index.html"]
   * @returns {string}
   */
  function consumeReturnTo(fallback = "index.html") {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    return v || fallback;
  }

  /* ==========================================================================
   * GUEST CART CACHE (PRE-LOGIN CART)
   * ========================================================================== */

  const GUEST_CART_KEY = "cc_guest_cart";

  /**
   * Safely parse JSON from storage.
   * @param {string} raw
   * @param {any} fallback
   * @returns {any}
   */
  function safeJsonParse(raw, fallback) {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  /**
   * Minimal product snapshot for guest cart display.
   * Keep it small (localStorage is limited).
   *
   * @param {object} rawProduct
   * @returns {{id:number,name:string,price:number,unit:string,photo_url:string,farm_name:string}}
   */
  function toGuestProductSnapshot(rawProduct) {
    const p = rawProduct || {};
    return {
      id: Number(p.id ?? p.product_id ?? 0),
      name: String(p.name ?? p.product_name ?? "").trim(),
      price: Number(p.price ?? p.unit_price ?? 0),
      unit: String(p.unit ?? p.unit_name ?? "").trim(),
      photo_url: String(p.photo_url ?? "").trim(),
      farm_name: String(p.farm_name ?? p.farm ?? "").trim(),
    };
  }

  /**
   * Read guest cart and normalize structure.
   * @returns {{items: Record<string,{qty:number,product:any}>, updatedAt: string|null}}
   */
  function getGuestCart() {
    const raw = localStorage.getItem(GUEST_CART_KEY);
    const data = safeJsonParse(raw || "null", null);

    const items =
      data?.items && typeof data.items === "object" ? data.items : {};
    const normalized = {};

    for (const [k, v] of Object.entries(items)) {
      const productId = String(k).trim();
      if (!productId) continue;

      const qty = Math.max(0, Math.floor(Number(v?.qty) || 0));
      if (qty <= 0) continue;

      const product = toGuestProductSnapshot(v?.product || {});
      if (!product.id) product.id = Number(productId);

      normalized[productId] = { qty, product };
    }

    return {
      items: normalized,
      updatedAt: data?.updatedAt || null,
    };
  }

  /**
   * Persist guest cart back to localStorage and emit event.
   * @param {object} cart
   */
  function setGuestCart(cart) {
    const payload = {
      items: cart?.items && typeof cart.items === "object" ? cart.items : {},
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(GUEST_CART_KEY, JSON.stringify(payload));
    document.dispatchEvent(
      new CustomEvent("cc:cart-changed", { detail: { source: "guest" } }),
    );
  }

  /**
   * Clear guest cart entirely and emit event.
   */
  function clearGuestCart() {
    localStorage.removeItem(GUEST_CART_KEY);
    document.dispatchEvent(
      new CustomEvent("cc:cart-changed", { detail: { source: "guest" } }),
    );
  }

  /**
   * Add item to guest cart.
   * - If item exists: increments qty
   * - Refreshes cached snapshot
   *
   * @param {object} rawProduct
   * @param {number} [qtyToAdd=1]
   */
  function addGuestItem(rawProduct, qtyToAdd = 1) {
    const snap = toGuestProductSnapshot(rawProduct);
    const id = String(snap.id || "").trim();
    if (!id) return;

    const qty = Math.max(1, Math.floor(Number(qtyToAdd) || 1));
    const cart = getGuestCart();

    const current = cart.items[id]?.qty ? Number(cart.items[id].qty) : 0;
    cart.items[id] = {
      qty: current + qty,
      product: snap,
    };

    setGuestCart(cart);
  }

  /**
   * Set exact quantity for a guest cart item (0 removes).
   * @param {string|number} productId
   * @param {number} nextQty
   */
  function setGuestItemQty(productId, nextQty) {
    const id = String(productId || "").trim();
    if (!id) return;

    const qty = Math.max(0, Math.floor(Number(nextQty) || 0));
    const cart = getGuestCart();

    if (qty <= 0) {
      delete cart.items[id];
    } else if (cart.items[id]) {
      cart.items[id].qty = qty;
    }

    setGuestCart(cart);
  }

  /**
   * Remove a guest item entirely.
   * @param {string|number} productId
   */
  function removeGuestItem(productId) {
    setGuestItemQty(productId, 0);
  }

  /**
   * Get guest cart entries as an array for rendering.
   * @returns {{qty:number,product:any}[]}
   */
  function listGuestItems() {
    const cart = getGuestCart();
    return Object.values(cart.items).map((x) => ({
      qty: Number(x.qty) || 0,
      product: x.product || {},
    }));
  }

  /**
   * Calculate guest cart subtotal (price * qty).
   * @returns {number}
   */
  function guestSubtotal() {
    const items = listGuestItems();
    return items.reduce((sum, row) => {
      const price = Number(row.product?.price) || 0;
      const qty = Number(row.qty) || 0;
      return sum + price * qty;
    }, 0);
  }

  /**
   * Sync guest cart into authenticated DB cart.
   * Uses POST /api/cart/add/ per item, then clears cache.
   *
   * @returns {Promise<{synced:number,attempted:number,unauthorized?:boolean}>}
   */
  async function syncGuestCartToServer() {
    if (!isLoggedIn()) return { synced: 0, attempted: 0 };

    const entries = listGuestItems();
    if (!entries.length) return { synced: 0, attempted: 0 };

    let synced = 0;

    for (const row of entries) {
      const productId = Number(row.product?.id);
      const quantity = Math.max(1, Math.floor(Number(row.qty) || 1));
      if (!Number.isFinite(productId) || productId <= 0) continue;

      const res = await apiRequest("/cart/add/", {
        method: "POST",
        json: { product_id: productId, quantity },
      });

      if (res.status === 401)
        return { synced, attempted: entries.length, unauthorized: true };
      if (res.ok) synced += 1;
    }

    clearGuestCart();
    return { synced, attempted: entries.length };
  }

  /* ==========================================================================
   * PUBLIC NAMESPACE
   * ========================================================================== */

  window.CC = {
    __ready: true,

    // Guest Cart Caching
    cartCache: {
      GUEST_CART_KEY,
      getGuestCart,
      setGuestCart,
      clearGuestCart,
      addGuestItem,
      setGuestItemQty,
      removeGuestItem,
      listGuestItems,
      guestSubtotal,
      syncGuestCartToServer,
    },

    // Config
    getConfig,
    getConfigValue,
    apiBaseUrl,
    buildApiUrl,

    // DOM
    onReady,
    qs,
    qsa,

    // Text/formatting
    escapeHtml,
    formatMoney,
    setStatus,
    formatFieldErrors,

    // Network
    readResponse,
    apiFetch,
    apiRequest,

    // Auth
    auth: {
      AUTH_KEY,
      FARMER_AUTH_KEY,
      RETURN_TO_KEY,
      getAuth,
      saveAuth,
      clearAuth,
      isLoggedIn,
      authHeader,
      logout,
      saveReturnToCurrentPage,
      consumeReturnTo,
    },
  };
})();