/**
 * ============================================================================
 * store.js — Store page logic (index.html)
 * ----------------------------------------------------------------------------
 * Requires:
 * - config.js
 * - utils.js (window.CC)
 * - auth.js (optional; navbar rendering is handled elsewhere)
 *
 * What this file does:
 * - Loads product list from the API
 * - Supports search, category filter, sorting
 * - Supports farm filter + location filter
 * - Renders product cards into #products
 * - Loads and caches favorite farms (API-backed)
 * - Uses event delegation:
 *    - Open modal from image / add button
 *    - Add-to-cart from modal
 *    - Favorite toggle from product card
 *    - Daily picks -> filter by farm
 *
 * Image behavior:
 * - If product.photo_url exists, we render it as <img>
 * - If missing OR fails to load, we fall back to the initial letter tile
 *
 * IMPORTANT:
 * - This regen is ORGANIZATION + COMMENTS only.
 * - No functional logic changes.
 * - No inline styles were introduced; one existing inline style in error <pre>
 *   was replaced with a CSS class (cc-prewrap).
 * ============================================================================
 */

(function initStorePage() {
  "use strict";

  const CC = window.CC;
  if (!CC) {
    console.warn(
      "store.js: window.CC not found. Make sure utils.js is loaded before store.js",
    );
    return;
  }

  /* ==========================================================================
   * DOM ELEMENTS (IDs come from index.html)
   * ========================================================================== */

  const pageStatusEl = document.getElementById("pageStatus"); // optional
  const productsHostEl = document.getElementById("products");

  // Filters / controls
  const searchEl = document.getElementById("productSearch");
  const categoryEl = document.getElementById("productCategory");
  const sortEl = document.getElementById("productSort");
  const farmEl = document.getElementById("productFarm");
  const locationEl = document.getElementById("productLocation");

  // Favorites sidebar host (Today's picks)
  const favoriteFarmsHostEl = document.getElementById("favoriteFarmsHost");

  /* ==========================================================================
   * STATE
   * ========================================================================== */

  // Farm lookup cache (built from GET /api/farms/)
  // Key: normalized farm name (lowercased + trimmed)
  let farmByNameMap = new Map();

  // Holds the full products list loaded from the API
  let allProducts = [];

  // -------------------------
  // Favorites (API-backed)
  // -------------------------

  // Keyed by farm_id (number)
  let favoriteFarmIdSet = new Set();

  // For daily picks list (nice display names)
  let favoriteFarmNames = [];

  // Farm lookup maps built from GET /api/farms/
  let farmByIdMap = new Map(); // id -> farmRow
  let farmIdByNameMap = new Map(); // normalized farm name -> id

  /* ==========================================================================
   * FILTER + SORT HELPERS
   * ========================================================================== */

  /**
   * Returns the selected sort value, normalized.
   * This keeps compatibility if UI labels ever change slightly.
   */
  function getSortValue() {
    const raw = String(sortEl?.value || "Recommended").trim();
    return raw.replace(/^Sorted by:\s*/i, "");
  }

  /**
   * Apply an initial farm filter using:
   * 1) URL param: ?farm=...
   * 2) sessionStorage fallback: cc_store_prefarm
   *
   * This solves cases where hosting/routing strips query params on redirect.
   */
  function applyInitialFarmFilterFromUrl() {
    if (!farmEl) return;

    const params = new URLSearchParams(window.location.search);

    // 1) Prefer querystring
    let farmParamRaw = String(params.get("farm") || "").trim();

    // 2) Fallback to sessionStorage
    if (!farmParamRaw) {
      farmParamRaw = String(sessionStorage.getItem("cc_store_prefarm") || "").trim();
    }

    if (!farmParamRaw) return;

    // Clear the fallback so it doesn't "stick" forever
    sessionStorage.removeItem("cc_store_prefarm");

    const wantKey = normalizeFarmKey(farmParamRaw);

    const match = Array.from(farmEl.options || []).find(
      (opt) => normalizeFarmKey(opt.value) === wantKey,
    );

    if (match) {
      farmEl.value = match.value;

      // Trigger render in the same way a user changing the dropdown would
      farmEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  /**
   * Sort comparator for product lists
   */
  function compareProducts(a, b, sortValue) {
    const priceA = Number(a.price ?? 0);
    const priceB = Number(b.price ?? 0);
    const stockA = Number(a.stock ?? a.quantity ?? 0);
    const stockB = Number(b.stock ?? b.quantity ?? 0);

    switch (sortValue) {
      case "Price: Low → High":
        return priceA - priceB;
      case "Price: High → Low":
        return priceB - priceA;
      case "Stock: High → Low":
        return stockB - stockA;
      case "Farm: A→Z":
        return String(a.farm_name ?? "").localeCompare(
          String(b.farm_name ?? ""),
        );
      case "Farm: Z→A":
        return String(b.farm_name ?? "").localeCompare(
          String(a.farm_name ?? ""),
        );
      case "Farm Location: A-Z": {
        //This can be easily changed to Location sort close to far if need/wanted
        const locA = String(a.farm_location ?? "").trim();
        const locB = String(b.farm_location ?? "").trim();
        return locA.localeCompare(locB);
      }
      case "Recommended":
      default:
        // simple stable-ish default: alphabetical by name
        return String(a.name ?? "").localeCompare(String(b.name ?? ""));
    }
  }

  /* ==========================================================================
   * FAVORITES — NORMALIZATION HELPERS
   * ========================================================================== */

  /**
   * Normalize favorites list into an array of farm_id numbers.
   * Supports:
   *  - [1,2,3]
   *  - [{farm_id:1}, {farm:{id:2}}, {id:3}]
   */
  function normalizeFavoriteFarmIds(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => {
        if (typeof x === "number") return x;
        const id = x?.farm_id ?? x?.farm?.id ?? x?.farm?.farm_id ?? x?.id;
        return Number(id);
      })
      .filter((n) => Number.isFinite(n));
  }

  /**
   * Normalize favorites list into displayable farm names for the daily picks list.
   * Uses API-provided farm_name when available, otherwise looks up by id.
   */
  function normalizeFavoriteFarmNamesFromApi(list) {
    if (!Array.isArray(list)) return [];
    const names = [];

    for (const item of list) {
      if (typeof item === "string") {
        const s = item.trim();
        if (s) names.push(s);
        continue;
      }

      const apiName = String(
        item?.farm_name ?? item?.farm?.farm_name ?? item?.farm?.name ?? "",
      ).trim();
      if (apiName) {
        names.push(apiName);
        continue;
      }

      const id = Number(item?.farm_id ?? item?.farm?.id ?? item?.id);
      if (Number.isFinite(id)) {
        const farmRow = farmByIdMap.get(id);
        const fallbackName = String(
          farmRow?.farm_name ?? farmRow?.name ?? "",
        ).trim();
        if (fallbackName) names.push(fallbackName);
      }
    }

    return names;
  }

  /* ==========================================================================
   * FAVORITES — API CALLS
   * ========================================================================== */

  /**
   * GET /api/favorites/  [name='list_favorites']
   */
  async function apiListFavorites() {
    if (!CC.auth.isLoggedIn()) return [];

    const res = await CC.apiRequest("/favorites/", { method: "GET" });

    // Not logged in / expired session -> treat as none
    if (res.status === 401) return [];

    if (!res.ok) {
      console.warn("Favorites list failed:", res.status, res.raw);
      return [];
    }

    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * POST /api/favorites/add/  [name='add_favorite']
   */
  async function apiAddFavorite(farmId) {
    return CC.apiRequest("/favorites/add/", {
      method: "POST",
      json: { farm_id: Number(farmId) },
    });
  }

  /**
   * DELETE /api/favorites/<farm_id>/  [name='remove_favorite']
   * (Fallback to POST if backend disallows DELETE)
   */
  async function apiRemoveFavorite(farmId) {
    const id = Number(farmId);

    let res = await CC.apiRequest(`/favorites/${id}/`, { method: "DELETE" });

    if (res.status === 405) {
      res = await CC.apiRequest(`/favorites/${id}/`, { method: "POST" });
    }

    return res;
  }

  /**
   * Load favorites and cache them in favoriteFarmIdSet + favoriteFarmNames.
   */
  async function loadFavorites() {
    const list = await apiListFavorites();

    favoriteFarmIdSet = new Set(normalizeFavoriteFarmIds(list));
    favoriteFarmNames = normalizeFavoriteFarmNamesFromApi(list);

    renderDailyPicksFavorites();
    render(); // re-render so star icons reflect cached favorites
  }

  /**
   * Render favorite farms into the "Today’s picks" side card.
   * - Click name -> filters by farm
   * - Click star -> removes from favorites
   */
  function renderDailyPicksFavorites() {
    if (!favoriteFarmsHostEl) return;

    if (!CC.auth.isLoggedIn()) {
      favoriteFarmsHostEl.innerHTML = `<div class="text-muted small">Sign in and favorite some farms to see them listed here.</div>`;
      return;
    }

    const names = [...new Set(favoriteFarmNames)].sort((a, b) =>
      a.localeCompare(b),
    );

    if (!names.length) {
      favoriteFarmsHostEl.innerHTML = `<div class="text-muted small">No favorites yet — star a farm on a product card.</div>`;
      return;
    }

    favoriteFarmsHostEl.innerHTML = names
      .map((name) => {
        const farmKey = normalizeFarmKey(name);
        const farmId = farmIdByNameMap.get(farmKey);
        const canRemove = Number.isFinite(Number(farmId));

        return `
          <div class="d-flex align-items-center justify-content-between">
            <button
              type="button"
              class="cc-mini text-start col-sm-12 col-6"
              data-farm-filter="${CC.escapeHtml(name)}"
              title="Filter products to ${CC.escapeHtml(name)}"
            >
                <div>
                  <div class="cc-mini-title">${CC.escapeHtml(name)}</div>
                  <div class="cc-muted">Click to filter products</div>
                </div>
                ${
                  canRemove
                    ? `
                      <button
                        class="favorite-farm-btn-2 active"
                        type="button"
                        data-farm-id="${CC.escapeHtml(String(farmId))}"
                        data-farm-name="${CC.escapeHtml(name)}"
                        aria-label="Remove farm from favorites"
                        title="Remove from favorites"
                      >
                        <i class="bi bi-star-fill"></i>
                    `
                    : ``
                }
              </div>
            </button>
          </div>
        `;
      })
      .join("");
  }

  /* ==========================================================================
   * FARM LOOKUP HELPERS
   * ========================================================================== */

  /**
   * Build a Map of farms keyed by farm id.
   * @param {Array<object>} farms
   * @returns {Map<number, object>}
   */
  function buildFarmByIdMap(farms) {
    const map = new Map();
    (farms || []).forEach((f) => {
      const id = Number(f?.id ?? f?.farm_id);
      if (!Number.isFinite(id)) return;
      map.set(id, f);
    });
    return map;
  }

  /**
   * Build a Map of normalized farm name -> farm id.
   * @param {Array<object>} farms
   * @returns {Map<string, number>}
   */
  function buildFarmIdByNameMap(farms) {
    const map = new Map();
    (farms || []).forEach((f) => {
      const key = normalizeFarmKey(f?.farm_name ?? f?.name);
      const id = Number(f?.id ?? f?.farm_id);
      if (!key || !Number.isFinite(id)) return;
      map.set(key, id);
    });
    return map;
  }

  /**
   * Attempt to pull a human-friendly farm/product location from common API shapes.
   * We keep it defensive so it won't break if fields don't exist.
   *
   * @param {any} p Product row from /products/
   * @returns {string} Best guess location label ("" if unknown)
   */
  function getProductLocationLabel(p) {
    // Common guesses (use whatever the API actually sends back)
    const candidates = [
      p?.farm_location,
      p?.location,
      p?.farm?.location,
      p?.farm?.farm_location,
      p?.farm_city && p?.farm_state ? `${p.farm_city}, ${p.farm_state}` : "",
      p?.city && p?.state ? `${p.city}, ${p.state}` : "",
    ];

    const picked =
      candidates.map((v) => String(v || "").trim()).find(Boolean) || "";
    return picked;
  }

  /**
   * Build the Location <select> options based on loaded products.
   * Keeps the first option as "All locations".
   *
   * @param {any[]} products
   */
  function populateLocationOptions(products) {
    if (!locationEl) return;

    const unique = new Set();
    for (const p of products || []) {
      const label = getProductLocationLabel(p);
      if (label) unique.add(label);
    }

    const values = Array.from(unique).sort((a, b) => a.localeCompare(b));

    // Preserve current selection if possible
    const current = String(locationEl.value || "All");

    locationEl.innerHTML = `
      <option value="All">All locations</option>
      ${values.map((v) => `<option value="${CC.escapeHtml(v)}">${CC.escapeHtml(v)}</option>`).join("")}
    `;

    // Restore selection if still valid
    const stillExists = values.includes(current);
    locationEl.value = stillExists ? current : "All";
  }

  /**
   * Normalize a farm name so lookups are stable.
   *
   * @param {string} nameRaw - incoming farm name from product or farm record
   * @returns {string} normalized key
   */
  function normalizeFarmKey(nameRaw) {
    return String(nameRaw || "")
      .trim()
      .toLowerCase();
  }

  /**
   * Fetch farms from the API.
   *
   * Why: product rows do not contain location, so we pull the associated farm
   * and join it client-side.
   *
   * Expected route: GET /api/farms/
   *
   * @returns {Promise<Array<object>>} list of farm rows (or empty array)
   */
  async function getFarms() {
    try {
      const parsed = await CC.apiRequest("/farms/", { method: "GET" });
      if (!parsed.ok) return [];
      return Array.isArray(parsed.data) ? parsed.data : [];
    } catch (err) {
      console.warn("getFarms() failed:", err);
      return [];
    }
  }

  /**
   * Build a Map of farms keyed by normalized farm name.
   *
   * @param {Array<object>} farms - farm records from the API
   * @returns {Map<string, object>}
   */
  function buildFarmByNameMap(farms) {
    const map = new Map();
    (farms || []).forEach((f) => {
      const key = normalizeFarmKey(f?.farm_name ?? f?.name);
      if (!key) return;
      map.set(key, f);
    });
    return map;
  }

  /**
   * Enrich products with farm fields we need for UI (like farm_location and farm_id).
   *
   * @param {Array<object>} products - raw products from GET /api/products/
   * @param {Map<string, object>} farmMap - map of farm records by normalized name
   * @returns {Array<object>} products with farm_location + farm_id attached when possible
   */
  function attachFarmDataToProducts(products, farmMap) {
    return (products || []).map((p) => {
      const farmKey = normalizeFarmKey(p?.farm_name);
      const farmRow = farmKey ? farmMap.get(farmKey) : null;

      const farmIdValue = Number(
        p?.farm_id ??
          p?.farm?.id ??
          p?.farm?.farm_id ??
          farmRow?.id ??
          farmRow?.farm_id,
      );

      return {
        ...p,

        // Join-derived farm id (used for favorites API)
        farm_id: Number.isFinite(farmIdValue) ? farmIdValue : null,

        // Join-derived location for display/sorting
        farm_location:
          p?.farm_location ?? farmRow?.farm_location ?? farmRow?.location ?? "",
      };
    });
  }

  /**
   * Normalize a farm name so comparisons are consistent.
   * @param {string} s
   * @returns {string}
   */
  function normalizeFarmName(s) {
    return String(s || "").trim();
  }

  /**
   * Extract unique farms from products and return them sorted A-Z.
   * @param {Array<object>} products
   * @returns {string[]}
   */
  function getUniqueFarmNames(products) {
    const set = new Set();

    (products || []).forEach((p) => {
      const farm = normalizeFarmName(p?.farm_name);
      if (farm) set.add(farm);
    });

    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Populate the farm filter dropdown without breaking the current selection.
   * @param {Array<object>} products
   */
  function populateFarmFilter(products) {
    if (!farmEl) return;

    const prev = String(farmEl.value || "all");
    const farms = getUniqueFarmNames(products);

    farmEl.innerHTML = `
      <option value="all">All Farms</option>
      ${farms.map((f) => `<option value="${CC.escapeHtml(f)}">${CC.escapeHtml(f)}</option>`).join("")}
    `;

    // Restore selection if still present; otherwise default back to "all"
    const stillExists = farms.some((f) => f === prev);
    farmEl.value = stillExists ? prev : "all";
  }

  /* ==========================================================================
   * RENDER HELPERS
   * ========================================================================== */

  function renderEmptyState(query, category) {
    const msg = query
      ? `No matches for “${CC.escapeHtml(query)}”.`
      : category !== "All"
        ? `No products in “${CC.escapeHtml(category)}”.`
        : "No products found.";

    return `
      <div class="alert alert-warning mb-0">
        <div class="fw-bold">${msg}</div>
        <div class="small mt-1">Try clearing filters or changing the sort.</div>
      </div>
    `;
  }

  /**
   * Render a single product card.
   * IMPORTANT: This version supports product.photo_url
   */
  function renderCard(product) {
    // Core fields
    const id = product.id ?? product.product_id ?? "";
    const nameRaw = String(product.name ?? "—").trim();
    const name = CC.escapeHtml(nameRaw);

    const category = CC.escapeHtml(
      String(product.category_display ?? product.category ?? "Other").trim(),
    );

    const farmRaw = String(product.farm_name ?? "Local Farm").trim();
    const farm = CC.escapeHtml(farmRaw);

    const farmLocationRaw = String(product.farm_location ?? "").trim();
    const farmLocation = CC.escapeHtml(farmLocationRaw);

    const price = CC.formatMoney(product.price);
    const stock = product.stock ?? product.quantity ?? null;

    // Image handling
    // API field name assumed: photo_url (null/empty allowed)
    const photoUrlRaw = String(product.photo_url ?? "").trim();
    const hasPhoto = photoUrlRaw.length > 0;

    // Fallback initial
    const initial = (nameRaw[0] || "P").toUpperCase();

    // Favorites UI (farm_id required)
    const farmId = Number(product?.farm_id);
    const canFavorite = Number.isFinite(farmId);
    const isFavorited = canFavorite && favoriteFarmIdSet.has(farmId);
    const isActive = isFavorited ? "active" : "";
    const starIconClass = isFavorited ? "bi-star-fill" : "bi-star";

    const stockPill =
      stock == null
        ? `<span class="badge rounded-pill text-bg-light cc-badge">Stock: —</span>`
        : `<span class="badge rounded-pill text-bg-light cc-badge">Stock: ${CC.escapeHtml(
            String(stock),
          )}</span>`;

    /**
     * If image fails to load, we:
     * 1) hide/remove the <img>
     * 2) add fallback class so the initial tile is centered
     *
     * NOTE: Because cards are injected dynamically, we use inline onerror
     * here for a super-reliable fallback without extra listeners.
     */
    const imageBlockHtml = `
      <div class="cc-product-img ${hasPhoto ? "" : "cc-product-img--fallback"}" aria-hidden="true">
        ${
          hasPhoto
            ? `
              <img
                class="img-fluid cc-product-photo"
                src="${CC.escapeHtml(photoUrlRaw)}"
                data-full-src="${CC.escapeHtml(photoUrlRaw)}"
                alt="${name}"
                loading="lazy"
                onload="this.parentElement.classList.remove('cc-product-img--fallback'); this.parentElement.querySelector('.cc-product-initial')?.classList.add('d-none');"
                onerror="this.remove(); this.parentElement.classList.add('cc-product-img--fallback'); this.parentElement.querySelector('.cc-product-initial')?.classList.remove('d-none');"
              />
            `
            : ``
        }
        <span class="cc-product-initial ${hasPhoto ? "d-none" : ""}">${CC.escapeHtml(initial)}</span>
      </div>
    `;

    const fallbackHtml = `
      <span class="cc-product-initial">${CC.escapeHtml(initial)}</span>
    `;

    return `
      <div class="col-12 col-lg-4 justify-content-between">
        <div class="cc-product-card position-relative">

          <div
            class="open-image"
            data-open-product="${CC.escapeHtml(String(id))}"
            title="Click to view details"
          >
            ${imageBlockHtml}
            <div class="card-img-overlay">
              <span class="m-1 badge rounded-pill cc-badge bg-opacity-10">
                ${category}
              </span>
            </div>
          </div>
          
          <div class="p-1 cover">
            <div class="d-flex align-items-start justify-content-center gap-2">
              <div class="fw-bold position-relative align-top py-2">${name}</div>
            </div>

            <div class="d-flex justify-content-between m-1">
              <div class=" m-2">
                <div class="position-relative ">Provided by: ${farm}</div>
                <div class="position-relative ">${farmLocationRaw ? `<p>Location: ${farmLocation}</p>` : ""}</div>
              </div>

              <div class="py-2">
                <p>Price: ${price} ${stockPill}</p>
              </div>
            </div>
            <div class="d-flex position-relative justify-content-between m-1">
              <button
                class="m-1 p-2 btn cc-btn"
                data-open-product="${CC.escapeHtml(String(id))}"
                type="button"
              >
                Add to cart
              </button>

              <div class="cc-product-meta ${isActive} m-1 p-2">
                ${
                  canFavorite
                    ? `
                        <button
                          class="favorite-farm-btn ${isActive}"
                          type="button"
                          data-farm-id="${CC.escapeHtml(String(farmId))}"
                          data-farm-name="${CC.escapeHtml(farmRaw)}"
                          aria-label="${isFavorited ? "Remove farm from favorites" : "Add farm to favorites"}"
                          title="${isFavorited ? "Remove this farm from your favorites" : "Add this farm to your favorites"}"
                        >
                          <i class="bi ${starIconClass}"></i>
                        </button>
                      `
                    : ``
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderCards(list) {
    return `
      <div class="row">
        ${list.map(renderCard).join("")}
      </div>
    `;
  }

  /**
   * Re-render the product list based on search/category/sort/farm/location.
   */
  function render() {
    if (!productsHostEl) return;

    const q = String(searchEl?.value || "")
      .trim()
      .toLowerCase();
    const category = String(categoryEl?.value || "All").trim();
    const sortValue = getSortValue();

    const farmSelectedRaw = String(farmEl?.value || "all").trim();
    const farmSelected = farmSelectedRaw.toLowerCase();
    const selectedLocation = String(locationEl?.value || "All").trim();

    // Start with full list
    let list = [...allProducts];

    // Farm filter
    if (farmSelected && farmSelected !== "all") {
      list = list.filter(
        (p) =>
          String(p.farm_name ?? "")
            .trim()
            .toLowerCase() === farmSelected,
      );
    }

    // Search filter
    if (q) {
      list = list.filter((p) => {
        const name = String(p.name ?? "").toLowerCase();
        const desc = String(p.description ?? "").toLowerCase();
        const farm = String(p.farm_name ?? "").toLowerCase();
        const cat = String(
          p.category_display ?? p.category ?? "",
        ).toLowerCase();
        return (
          name.includes(q) ||
          desc.includes(q) ||
          farm.includes(q) ||
          cat.includes(q)
        );
      });
    }

    // Category filter
    if (category && category !== "All") {
      list = list.filter((p) => {
        const apiCat = String(p.category_display ?? p.category ?? "").trim();
        return apiCat.toLowerCase() === category.toLowerCase();
      });
    }

    // Location filter
    if (selectedLocation && selectedLocation !== "All") {
      const want = selectedLocation.toLowerCase();
      list = list.filter((p) => {
        const loc = getProductLocationLabel(p).toLowerCase();
        return loc === want;
      });
    }

    // Sort
    list.sort((a, b) => compareProducts(a, b, sortValue));

    productsHostEl.innerHTML = `
      <div class="cc-products-head">
        <small class="text-muted">Showing <b>${list.length}</b> of ${allProducts.length}</small>
        <small class="text-muted">Sorted by: ${CC.escapeHtml(sortValue)}</small>
      </div>
      ${list.length ? renderCards(list) : renderEmptyState(q, category)}
    `;
  }

  /* ==========================================================================
   * API LOADERS
   * ========================================================================== */

  async function loadProducts() {
    if (!productsHostEl) return;
    CC.setStatus(pageStatusEl, "Loading products…", "muted");

    productsHostEl.innerHTML = `
      <div class="d-flex align-items-center justify-content-between py-2">
        <div class="text-muted small">Fetching from API…</div>
        <div class="spinner-border spinner-border-sm" role="status" aria-label="Loading"></div>
      </div>
    `;

    try {
      const parsed = await CC.apiRequest("/products/", { method: "GET" });

      if (!parsed.ok) throw new Error(parsed.raw || `HTTP ${parsed.status}`);
      if (!Array.isArray(parsed.data))
        throw new Error("API did not return an array of products.");

      // 1) Load products
      const productsRaw = parsed.data;

      // 2) Load farms (needed for location) and build lookup map
      const farms = await getFarms();
      farmByNameMap = buildFarmByNameMap(farms);

      // 3) Favorite Mapping
      farmByIdMap = buildFarmByIdMap(farms);
      farmIdByNameMap = buildFarmIdByNameMap(farms);

      // 4) Attach farm_location onto each product for display + sorting
      allProducts = attachFarmDataToProducts(productsRaw, farmByNameMap);

      populateFarmFilter(allProducts);
      applyInitialFarmFilterFromUrl();
      populateLocationOptions(allProducts);

      CC.setStatus(
        pageStatusEl,
        `Loaded ${allProducts.length} products`,
        "success",
      );
      render();
      await loadFavorites();
    } catch (err) {
      CC.setStatus(pageStatusEl, "Failed to load products", "danger");
      productsHostEl.innerHTML = `
        <div class="alert alert-danger mb-0">
          <div class="fw-bold">Error loading products</div>
          <div class="small mt-1">Check API availability and CORS.</div>
          <hr/>
          <pre class="small mb-0 cc-prewrap">${CC.escapeHtml(err?.message || String(err))}</pre>
        </div>
      `;
    }
  }

  /* ==========================================================================
   * CART ACTIONS
   * ========================================================================== */

  async function handleAddToCart(product, qtyToAdd = 1) {
    const qty = Math.max(1, Math.floor(Number(qtyToAdd) || 1));

    // Logged out -> cache snapshot + qty
    if (!CC.auth.isLoggedIn()) {
      CC.cartCache.addGuestItem(product, qty);
      CC.setStatus(
        pageStatusEl,
        `Saved ${qty} to cart (sign in to checkout).`,
        "info",
      );
      return;
    }

    // Logged in -> server cart
    const productId = Number(product?.id);
    const parsed = await CC.apiRequest("/cart/add/", {
      method: "POST",
      json: { product_id: productId, quantity: qty },
    });

    if (!parsed.ok) {
      CC.setStatus(
        pageStatusEl,
        parsed.data?.error || `Add to cart failed (HTTP ${parsed.status}).`,
        "danger",
      );
      return;
    }

    CC.setStatus(pageStatusEl, `Added ${qty} to your cart ✓`, "success");
  }

  /* ==========================================================================
   * BOOT + EVENT WIRING
   * ========================================================================== */

  CC.onReady(async () => {
    // Filter controls
    if (searchEl) searchEl.addEventListener("input", render);
    if (categoryEl) categoryEl.addEventListener("change", render);
    if (sortEl) sortEl.addEventListener("change", render);
    if (farmEl) farmEl.addEventListener("change", render);
    if (locationEl) locationEl.addEventListener("change", render);

    // ----- Product modal helpers -----
    const productModalEl = document.getElementById("productModal");
    const productModal = productModalEl
      ? new bootstrap.Modal(productModalEl)
      : null;

    function findProductById(productIdRaw) {
      const pid = String(productIdRaw || "").trim();
      if (!pid) return null;
      return (
        allProducts.find((p) => String(p.id ?? p.product_id ?? "") === pid) ||
        null
      );
    }

    function openProductModalFor(product) {
      if (!productModalEl || !productModal || !product) return;

      // Store current product id on the modal element
      productModalEl.dataset.productId = String(
        product.id ?? product.product_id ?? "",
      );

      // Pull fields defensively (API can vary)
      const nameRaw = String(product.name ?? "Product").trim();
      const farmRaw = String(product.farm_name ?? "Local Farm").trim();
      const locationRaw = String(product.farm_location ?? "").trim();
      const categoryRaw = String(
        product.category_display ?? product.category ?? "Other",
      ).trim();
      const descRaw = String(product.description ?? "").trim();
      const stockRaw = product.stock ?? product.quantity ?? null;

      // Fill header
      document.getElementById("productModalTitle").textContent = nameRaw;
      document.getElementById("productModalSubtitle").textContent = farmRaw;

      // Fill badges + fields
      document.getElementById("productModalCategory").textContent =
        categoryRaw || "Other";
      document.getElementById("productModalFarm").textContent =
        farmRaw || "Local Farm";
      document.getElementById("productModalLocation").textContent = locationRaw
        ? locationRaw
        : "";
      document.getElementById("productModalDesc").textContent = descRaw || "—";
      document.getElementById("productModalPrice").textContent = CC.formatMoney(
        product.price,
      );

      const stockEl = document.getElementById("productModalStock");
      stockEl.textContent =
        stockRaw == null ? "Stock: —" : `Stock: ${stockRaw}`;

      // Image / fallback
      const imgEl = document.getElementById("productModalImg");
      const fallbackEl = document.getElementById("productModalImgFallback");
      const initialEl = document.getElementById("productModalInitial");

      const photoUrl = String(product.photo_url ?? "").trim();
      const initial = (nameRaw[0] || "P").toUpperCase();

      initialEl.textContent = initial;

      if (photoUrl) {
        imgEl.src = photoUrl;
        imgEl.classList.remove("d-none");
        fallbackEl.classList.add("d-none");
      } else {
        imgEl.src = "";
        imgEl.classList.add("d-none");
        fallbackEl.classList.remove("d-none");
      }

      // Qty defaults + limits
      const qtyEl = document.getElementById("productModalQty");
      const qtyHelpEl = document.getElementById("productModalQtyHelp");
      const statusEl = document.getElementById("productModalStatus");

      qtyEl.value = "1";
      qtyEl.min = "1";

      const maxStock = Number(stockRaw);
      if (Number.isFinite(maxStock) && maxStock > 0) {
        qtyEl.max = String(Math.floor(maxStock));
        qtyHelpEl.textContent = `Max: ${Math.floor(maxStock)}`;
      } else {
        qtyEl.removeAttribute("max");
        qtyHelpEl.textContent = "";
      }

      statusEl.textContent = "";

      productModal.show();
    }

    // ----- Click handling (image OR button opens modal, modal button adds) -----
    document.addEventListener("click", (e) => {
      // 1) Open modal
      const openHit = e.target.closest?.("[data-open-product]");
      if (openHit) {
        const pid = openHit.getAttribute("data-open-product");
        const product = findProductById(pid);
        if (product) openProductModalFor(product);
        return;
      }

      // 2) Add from modal
      const modalAddBtn = e.target.closest?.("#productModalAddBtn");
      if (modalAddBtn) {
        if (!productModalEl) return;

        const pid = productModalEl.dataset.productId;
        const product = findProductById(pid);
        if (!product) return;

        const qtyEl = document.getElementById("productModalQty");
        const qtyRaw = Number(qtyEl?.value);

        // Clamp to min/max
        let qty = Math.max(1, Math.floor(qtyRaw || 1));
        const maxAttr = qtyEl?.getAttribute("max");
        const max = maxAttr ? Number(maxAttr) : null;
        if (Number.isFinite(max) && max > 0)
          qty = Math.min(qty, Math.floor(max));

        handleAddToCart(product, qty).catch((err) => {
          console.error(err);
          document.getElementById("productModalStatus").textContent =
            `Add failed: ${err.message}`;
        });

        productModal.hide();
      }
    });

    // click handler for dynamic content
    document.addEventListener("click", async (e) => {
      const addBtn = e.target.closest?.("[data-add]");
      if (addBtn) {
        const productId = addBtn.getAttribute("data-add");
        if (!productId) return;

        // find product from allProducts
        const product = allProducts.find(
          (p) => String(p.id) === String(productId),
        );

        if (product) {
          handleAddToCart(product);
        }

        return;
      }

      // Daily picks -> filter by farm
      const farmPickBtn = e.target.closest?.("[data-farm-filter]");
      if (farmPickBtn) {
        const farmName = String(
          farmPickBtn.getAttribute("data-farm-filter") || "",
        ).trim();
        if (farmName && farmEl) {
          farmEl.value = farmName;
          render();
        }
        return;
      }

      // Favorite toggle (API-backed)
      const favBtn = e.target.closest?.(".favorite-farm-btn");
      if (favBtn) {
        if (!CC.auth.isLoggedIn()) {
          CC.setStatus(
            pageStatusEl,
            "Please sign in to favorite farms.",
            "info",
          );
          return;
        }

        const farmId = Number(favBtn.dataset.farmId);
        const farmName = String(favBtn.dataset.farmName || "").trim();

        if (!Number.isFinite(farmId)) {
          CC.setStatus(
            pageStatusEl,
            "This farm can't be favorited yet (missing farm_id).",
            "warning",
          );
          return;
        }

        const isCurrentlyFavorited = favoriteFarmIdSet.has(farmId);

        // Optimistic UI
        favBtn.classList.toggle("active", !isCurrentlyFavorited);
        const icon = favBtn.querySelector("i");
        if (icon) {
          icon.classList.toggle("bi-star-fill", !isCurrentlyFavorited);
          icon.classList.toggle("bi-star", isCurrentlyFavorited);
        }

        try {
          const res = isCurrentlyFavorited
            ? await apiRemoveFavorite(farmId)
            : await apiAddFavorite(farmId);

          if (res.status === 401) {
            CC.auth.clearAuth();
            window.location.href = "login.html";
            return;
          }

          if (!res.ok) {
            throw new Error(
              res.data?.error ||
                res.data?.detail ||
                res.raw ||
                `HTTP ${res.status}`,
            );
          }

          // Commit local cache
          if (isCurrentlyFavorited) {
            favoriteFarmIdSet.delete(farmId);
            favoriteFarmNames = favoriteFarmNames.filter(
              (n) => normalizeFarmKey(n) !== normalizeFarmKey(farmName),
            );
            CC.setStatus(
              pageStatusEl,
              `Removed from favorites: ${farmName || "Farm"}`,
              "success",
            );
          } else {
            favoriteFarmIdSet.add(farmId);
            if (farmName) favoriteFarmNames.push(farmName);
            CC.setStatus(
              pageStatusEl,
              `Added to favorites: ${farmName || "Farm"}`,
              "success",
            );
          }

          renderDailyPicksFavorites();
        } catch (err) {
          // Rollback optimistic UI
          favBtn.classList.toggle("active", isCurrentlyFavorited);
          if (icon) {
            icon.classList.toggle("bi-star-fill", isCurrentlyFavorited);
            icon.classList.toggle("bi-star", !isCurrentlyFavorited);
          }
          CC.setStatus(pageStatusEl, err?.message || String(err), "danger");
        }

        return;
      }
    });

    await loadProducts();
  });
})();