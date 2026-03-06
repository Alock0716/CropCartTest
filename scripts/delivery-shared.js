/**
 * ============================================================================
 * delivery-shared.js — Shared delivery / range helpers for CropCart
 * ----------------------------------------------------------------------------
 * Purpose:
 * - Centralize delivery coverage helpers used by multiple pages.
 * - Keep delivery/range logic out of utils.js so it can be reused safely.
 * - Expose a CC.delivery namespace for:
 *   - farm normalization
 *   - address handling
 *   - geospatial distance/range checks
 *   - delivery annotations for products/cart rows
 *
 * Notes:
 * - Current farm API shape is centered on a combined location string
 *   like "City, ST", so that is treated as the primary farm geocode source.
 * - Current address cache key is shared with checkout/account.
 * - This file does not render UI and does not initialize any map instance.
 * ============================================================================
 */

(function initDeliverySharedHelpers() {
  "use strict";

  window.CC = window.CC || {};
  if (window.CC.delivery && window.CC.delivery.__sharedReady) return;

  const CC = window.CC;
  const delivery = {};

  // ==========================================================================
  // STORAGE KEYS
  // ==========================================================================

  /**
   * Existing single saved/default address cache used by checkout/account flows.
   */
  const SAVED_ADDRESS_KEY = "cc_saved_address_v1";

  /**
   * Optional local list used for the delivery coverage page dropdown.
   * This is a frontend convenience cache until a dedicated address endpoint exists.
   */
  const SAVED_ADDRESSES_KEY = "cc_saved_addresses_v1";

  // ==========================================================================
  // CONFIG HELPERS
  // ==========================================================================

  /**
   * Safely read the global CropCart config object.
   *
   * @returns {object}
   */
  function getAppConfig() {
    return window.CC_CONFIG || window.__CROPCART_CONFIG__ || {};
  }

  /**
   * Read the delivery config block safely.
   *
   * @returns {object}
   */
  function getDeliveryConfig() {
    return getAppConfig().delivery || {};
  }

  /**
   * Read one delivery config value with fallback.
   *
   * @param {string} key
   * @param {any} fallback
   * @returns {any}
   */
  function getDeliveryConfigValue(key, fallback = null) {
    const cfg = getDeliveryConfig();
    const value = cfg ? cfg[key] : undefined;
    return value === undefined || value === null ? fallback : value;
  }

  /**
   * Resolve the default radius in miles used when a farm does not yet have
   * a DB-backed delivery radius field.
   *
   * @returns {number}
   */
  function getDefaultRadiusMiles() {
    const cfgVal = Number(getDeliveryConfigValue("defaultFarmRadiusMiles", 15));
    if (Number.isFinite(cfgVal) && cfgVal > 0) return cfgVal;
    return 15;
  }

  /**
   * @returns {"cache"|"api"}
   */
  function getCustomerSourceMode() {
    return String(getDeliveryConfigValue("customerSource", "cache")).toLowerCase();
  }

  /**
   * @returns {"hardcoded"|"api"}
   */
  function getFarmSourceMode() {
    return String(getDeliveryConfigValue("farmSource", "hardcoded")).toLowerCase();
  }

  // ==========================================================================
  // BASIC HELPERS
  // ==========================================================================

  /**
   * Trim any incoming value into a safe string.
   *
   * @param {any} value
   * @returns {string}
   */
  function toCleanString(value) {
    return String(value == null ? "" : value).trim();
  }

  /**
   * Convert a value to a number if valid; otherwise use fallback.
   *
   * @param {any} value
   * @param {number|null} fallback
   * @returns {number|null}
   */
  function toNumber(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * Lowercase + trim for stable searching/matching.
   *
   * @param {any} value
   * @returns {string}
   */
  function normalizeSearchText(value) {
    return toCleanString(value).toLowerCase();
  }

  // ==========================================================================
  // ADDRESS HELPERS
  // ==========================================================================

  /**
   * Build a human-readable single-line address label.
   *
   * @param {object|null} address
   * @returns {string}
   */
  function formatAddressLine(address) {
    if (!address || typeof address !== "object") return "";

    const line1 = toCleanString(address.address_line1 || address.address || address.street_address);
    const line2 = toCleanString(address.address_line2);
    const city = toCleanString(address.city);
    const state = toCleanString(address.state);
    const zip = toCleanString(address.zip || address.postal_code);

    const street = [line1, line2].filter(Boolean).join(", ");
    const locality = [city, state, zip].filter(Boolean).join(" ");

    return [street, locality].filter(Boolean).join(", ");
  }

  /**
   * Address string intended for geocoding.
   *
   * @param {object|null} address
   * @returns {string}
   */
  function formatAddressForGeocode(address) {
    return formatAddressLine(address);
  }

  /**
   * Read the current saved/default address.
   *
   * @returns {object|null}
   */
  function getSavedAddress() {
    try {
      const raw = localStorage.getItem(SAVED_ADDRESS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * Save the current saved/default address.
   *
   * @param {object} address
   * @returns {boolean}
   */
  function setSavedAddress(address) {
    try {
      localStorage.setItem(SAVED_ADDRESS_KEY, JSON.stringify(address || {}));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read any locally cached address list.
   *
   * @returns {Array<object>}
   */
  function getSavedAddressList() {
    try {
      const raw = localStorage.getItem(SAVED_ADDRESSES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Merge the active saved address with any cached address list and dedupe.
   *
   * @returns {Array<object>}
   */
  function getAvailableAddresses() {
    const single = getSavedAddress();
    const list = getSavedAddressList();

    const merged = [];
    const seen = new Set();

    function addAddress(addr) {
      const label = formatAddressLine(addr);
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(addr);
    }

    if (single) addAddress(single);
    (list || []).forEach(addAddress);

    return merged;
  }

  /**
   * Convert one address object into a dropdown-friendly option.
   *
   * @param {object} address
   * @param {number} index
   * @returns {{value:string,label:string,address:object}}
   */
  function toAddressOption(address, index = 0) {
    const label = formatAddressLine(address) || `Address ${index + 1}`;
    return {
      value: String(index),
      label,
      address,
    };
  }

  // ==========================================================================
  // FARM HELPERS
  // ==========================================================================

  /**
   * Build a stable farm display name.
   *
   * @param {object} farm
   * @returns {string}
   */
  function getFarmDisplayName(farm) {
    return (
      toCleanString(farm?.name) ||
      toCleanString(farm?.farm_name) ||
      toCleanString(farm?.title) ||
      "Farm"
    );
  }

  /**
   * Resolve a stable farm id.
   *
   * @param {object} farm
   * @returns {string}
   */
  function getFarmId(farm) {
    return String(farm?.farm_id ?? farm?.id ?? getFarmDisplayName(farm));
  }

  /**
   * Read or default a farm radius in miles.
   *
   * @param {object} farm
   * @returns {number}
   */
  function getFarmRadiusMiles(farm) {
    const direct =
      toNumber(farm?.delivery_radius_miles) ??
      toNumber(farm?.radius_miles) ??
      toNumber(farm?.radius);

    if (Number.isFinite(direct) && direct > 0) return direct;
    return getDefaultRadiusMiles();
  }

  /**
   * Build the best geocoding query for a farm.
   * The current backend primarily stores location as one combined string,
   * so that is the main source of truth.
   *
   * @param {object} farm
   * @returns {string}
   */
  function buildFarmLocationQuery(farm) {
    const directLocation =
      toCleanString(farm?.location) ||
      toCleanString(farm?.farm_location) ||
      toCleanString(farm?.raw?.location) ||
      toCleanString(farm?.raw?.farm_location);

    if (!directLocation) return "";

    // Add a country hint to reduce ambiguous geocoding.
    if (/,\s*usa$/i.test(directLocation)) return directLocation;
    return `${directLocation}, USA`;
  }

  /**
   * Normalize one farm row into a consistent shared shape.
   *
   * @param {object} farm
   * @returns {object}
   */
  function normalizeFarm(farm) {
    const id = getFarmId(farm);
    const name = getFarmDisplayName(farm);

    const lat =
      toNumber(farm?.lat) ??
      toNumber(farm?.latitude) ??
      toNumber(farm?.farm_lat);

    const lng =
      toNumber(farm?.lng) ??
      toNumber(farm?.longitude) ??
      toNumber(farm?.farm_lng);

    const location =
      toCleanString(farm?.location) ||
      toCleanString(farm?.farm_location) ||
      toCleanString(farm?.raw?.location) ||
      toCleanString(farm?.raw?.farm_location);

    let city =
      toCleanString(farm?.city) ||
      toCleanString(farm?.farm_city);

    let state =
      toCleanString(farm?.state) ||
      toCleanString(farm?.farm_state);

    const zip =
      toCleanString(farm?.zip) ||
      toCleanString(farm?.postal_code) ||
      toCleanString(farm?.farm_zip);

    if (location && (!city || !state) && location.includes(",")) {
      const parts = location.split(",").map((part) => toCleanString(part));
      if (!city) city = parts[0] || "";
      if (!state) state = parts[1] || "";
    }

    const normalized = {
      id,
      name,
      location,
      city,
      state,
      zip,
      radiusMiles: getFarmRadiusMiles(farm),
      lat,
      lng,
      logoUrl: toCleanString(farm?.logo_url || farm?.farm_logo_url || ""),
      raw: farm,
    };

    return {
      ...normalized,
      locationQuery: buildFarmLocationQuery({ ...normalized, raw: farm }),
    };
  }

  /**
   * Normalize a farm list.
   *
   * @param {Array<any>} farms
   * @returns {Array<object>}
   */
  function normalizeFarmList(farms) {
    return Array.isArray(farms) ? farms.map(normalizeFarm) : [];
  }

  /**
   * Filter farms by search term.
   *
   * @param {Array<object>} farms
   * @param {string} query
   * @returns {Array<object>}
   */
  function filterFarmsBySearch(farms, query) {
    const q = normalizeSearchText(query);
    if (!q) return Array.isArray(farms) ? [...farms] : [];

    return (Array.isArray(farms) ? farms : []).filter((farm) => {
      const haystack = [
        farm?.name,
        farm?.location,
        farm?.city,
        farm?.state,
        farm?.zip,
      ]
        .map(normalizeSearchText)
        .join(" ");

      return haystack.includes(q);
    });
  }

  /**
   * Filter farms by visible flag.
   *
   * @param {Array<object>} farms
   * @param {"all"|"visible"|"hidden"} mode
   * @returns {Array<object>}
   */
  function filterFarmsByVisibility(farms, mode) {
    const safeMode = String(mode || "all").toLowerCase();
    const rows = Array.isArray(farms) ? farms : [];

    if (safeMode === "visible") {
      return rows.filter((farm) => farm?.visible !== false);
    }

    if (safeMode === "hidden") {
      return rows.filter((farm) => farm?.visible === false);
    }

    return [...rows];
  }

  // ==========================================================================
  // GEO HELPERS
  // ==========================================================================

  /**
   * Determine whether a point-like object has valid numeric coordinates.
   *
   * @param {object|null} point
   * @returns {boolean}
   */
    function hasValidPoint(point) {
        if (!point || typeof point !== "object") return false;

        const rawLat = point.lat;
        const rawLng = point.lng;

        // Reject null / undefined / empty-string before numeric conversion.
        if (rawLat === null || rawLat === undefined || rawLat === "") return false;
        if (rawLng === null || rawLng === undefined || rawLng === "") return false;

        const lat = Number(rawLat);
        const lng = Number(rawLng);

        return Number.isFinite(lat) && Number.isFinite(lng);
    }   

  /**
   * Normalize raw lat/lng values into a point object.
   *
   * @param {number} lat
   * @param {number} lng
   * @returns {{lat:number,lng:number}|null}
   */
    function toPoint(lat, lng) {
    if (lat === null || lat === undefined || lat === "") return null;
    if (lng === null || lng === undefined || lng === "") return null;

    const safeLat = toNumber(lat);
    const safeLng = toNumber(lng);

    if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) return null;

    return { lat: safeLat, lng: safeLng };
    }

  /**
   * Convert a point object into a Turf point.
   *
   * @param {{lat:number,lng:number}} point
   * @returns {object}
   */
  function toTurfPoint(point) {
    return turf.point([Number(point.lng), Number(point.lat)]);
  }

  /**
   * Calculate distance in miles between two points.
   *
   * @param {{lat:number,lng:number}} fromPoint
   * @param {{lat:number,lng:number}} toPointValue
   * @returns {number|null}
   */
  function distanceMiles(fromPoint, toPointValue) {
    if (!hasValidPoint(fromPoint) || !hasValidPoint(toPointValue)) return null;
    if (typeof turf === "undefined") return null;

    return turf.distance(toTurfPoint(fromPoint), toTurfPoint(toPointValue), {
      units: "miles",
    });
  }

  /**
   * Check whether a point is inside a farm's radius.
   *
   * @param {{lat:number,lng:number}} customerPoint
   * @param {{lat:number,lng:number,radiusMiles:number}} farm
   * @returns {boolean}
   */
  function isPointInFarmRange(customerPoint, farm) {
    if (!hasValidPoint(customerPoint)) return false;
    if (!hasValidPoint(farm)) return false;

    const miles = distanceMiles(customerPoint, farm);
    if (!Number.isFinite(miles)) return false;

    return miles <= Number(farm.radiusMiles || 0);
  }

  /**
   * Find the nearest farm to a point.
   *
   * @param {{lat:number,lng:number}} customerPoint
   * @param {Array<object>} farms
   * @returns {{farm: object|null, distanceMiles: number|null}}
   */
  function getNearestFarm(customerPoint, farms) {
    if (!hasValidPoint(customerPoint)) {
      return { farm: null, distanceMiles: null };
    }

    let nearestFarm = null;
    let nearestDistance = null;

    for (const farm of Array.isArray(farms) ? farms : []) {
      if (!hasValidPoint(farm)) continue;

      const miles = distanceMiles(customerPoint, farm);
      if (!Number.isFinite(miles)) continue;

      if (nearestDistance === null || miles < nearestDistance) {
        nearestFarm = farm;
        nearestDistance = miles;
      }
    }

    return {
      farm: nearestFarm,
      distanceMiles: nearestDistance,
    };
  }

  /**
   * Return a simple coverage summary for one customer point across farms.
   *
   * @param {{lat:number,lng:number}} customerPoint
   * @param {Array<object>} farms
   * @returns {{
   *   inRange: boolean,
   *   nearestFarm: object|null,
   *   nearestDistanceMiles: number|null,
   *   matchingFarms: Array<object>
   * }}
   */
  function getCoverageForPoint(customerPoint, farms) {
    const farmRows = Array.isArray(farms) ? farms : [];
    const matchingFarms = farmRows.filter((farm) =>
      isPointInFarmRange(customerPoint, farm)
    );
    const nearest = getNearestFarm(customerPoint, farmRows);

    return {
      inRange: matchingFarms.length > 0,
      nearestFarm: nearest.farm,
      nearestDistanceMiles: nearest.distanceMiles,
      matchingFarms,
    };
  }

  /**
   * Compute the heuristic overall radius overlay:
   * - center = average farm coords
   * - radius = average farm radius
   *
   * @param {Array<object>} farms
   * @returns {{lat:number,lng:number,radiusMiles:number}|null}
   */
  function getOverallCoverageCircle(farms) {
    const rows = (Array.isArray(farms) ? farms : []).filter(hasValidPoint);
    if (!rows.length) return null;

    let totalLat = 0;
    let totalLng = 0;
    let totalRadius = 0;

    for (const farm of rows) {
      totalLat += Number(farm.lat);
      totalLng += Number(farm.lng);
      totalRadius += Number(farm.radiusMiles || 0);
    }

    return {
      lat: totalLat / rows.length,
      lng: totalLng / rows.length,
      radiusMiles: totalRadius / rows.length,
    };
  }

  // ==========================================================================
  // PRODUCT / CART HELPERS
  // ==========================================================================

  /**
   * Resolve a farm name from a product row.
   *
   * @param {object} product
   * @returns {string}
   */
  function getProductFarmName(product) {
    return (
      toCleanString(product?.farm_name) ||
      toCleanString(product?.farm?.name) ||
      toCleanString(product?.farmName)
    );
  }

  /**
   * Build a map of normalized farm names to farm objects.
   *
   * @param {Array<object>} farms
   * @returns {Map<string, object>}
   */
  function buildFarmNameMap(farms) {
    const map = new Map();

    for (const farm of Array.isArray(farms) ? farms : []) {
      const key = normalizeSearchText(farm?.name);
      if (!key) continue;
      map.set(key, farm);
    }

    return map;
  }

  /**
   * Annotate one product with delivery metadata.
   *
   * @param {object} product
   * @param {{lat:number,lng:number}|null} customerPoint
   * @param {Map<string, object>} farmMap
   * @returns {{product:object,farm:object|null,inRange:boolean|null,distanceMiles:number|null}}
   */
  function annotateProductDelivery(product, customerPoint, farmMap) {
    const farmNameKey = normalizeSearchText(getProductFarmName(product));
    const farm = farmMap.get(farmNameKey) || null;

    if (!farm || !hasValidPoint(customerPoint)) {
      return {
        product,
        farm,
        inRange: null,
        distanceMiles: null,
      };
    }

    const miles = distanceMiles(customerPoint, farm);

    return {
      product,
      farm,
      inRange: Number.isFinite(miles) ? miles <= Number(farm.radiusMiles || 0) : null,
      distanceMiles: miles,
    };
  }

  /**
   * Annotate a product list with delivery metadata.
   *
   * @param {Array<object>} products
   * @param {{lat:number,lng:number}|null} customerPoint
   * @param {Array<object>} farms
   * @returns {Array<object>}
   */
  function annotateProductListDelivery(products, customerPoint, farms) {
    const farmMap = buildFarmNameMap(farms);

    return (Array.isArray(products) ? products : []).map((product) =>
      annotateProductDelivery(product, customerPoint, farmMap)
    );
  }

  /**
   * Filter annotated rows by range mode.
   *
   * @param {Array<object>} rows
   * @param {"all"|"in"|"out"} mode
   * @returns {Array<object>}
   */
  function filterAnnotatedRowsByRange(rows, mode) {
    const safeMode = String(mode || "all").toLowerCase();
    const list = Array.isArray(rows) ? rows : [];

    if (safeMode === "in") return list.filter((row) => row?.inRange === true);
    if (safeMode === "out") return list.filter((row) => row?.inRange === false);

    return [...list];
  }

  /**
   * Sort annotated rows by distance.
   *
   * @param {Array<object>} rows
   * @param {"asc"|"desc"} direction
   * @returns {Array<object>}
   */
  function sortAnnotatedRowsByDistance(rows, direction = "asc") {
    const dir = String(direction || "asc").toLowerCase();

    return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
      const aValue = Number.isFinite(a?.distanceMiles) ? a.distanceMiles : Infinity;
      const bValue = Number.isFinite(b?.distanceMiles) ? b.distanceMiles : Infinity;

      return dir === "desc" ? bValue - aValue : aValue - bValue;
    });
  }

  /**
   * Check whether all rows are deliverable.
   *
   * @param {Array<object>} rows
   * @returns {boolean}
   */
  function areAllRowsDeliverable(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return false;
    return list.every((row) => row?.inRange === true);
  }

  /**
   * Get only rows that are confirmed out of range.
   *
   * @param {Array<object>} rows
   * @returns {Array<object>}
   */
  function getOutOfRangeRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter((row) => row?.inRange === false);
  }

  // ==========================================================================
  // UI STATUS HELPERS
  // ==========================================================================

  /**
   * Friendly label for one delivery state.
   *
   * @param {boolean|null} inRange
   * @returns {string}
   */
  function getDeliveryStatusLabel(inRange) {
    if (inRange === true) return "In Range";
    if (inRange === false) return "Out of Range";
    return "Range Unknown";
  }

  /**
   * Suggested Bootstrap badge class for one delivery state.
   *
   * @param {boolean|null} inRange
   * @returns {string}
   */
  function getDeliveryStatusClass(inRange) {
    if (inRange === true) return "text-bg-success";
    if (inRange === false) return "text-bg-danger";
    return "text-bg-secondary";
  }

  // ==========================================================================
  // DATA ACCESS
  // ==========================================================================

  /**
   * Load farms from the shared farms endpoint and normalize them.
   *
   * @returns {Promise<Array<object>>}
   */
  async function fetchNormalizedFarms() {
    if (!CC.apiRequest) return [];

    try {
      const response = await CC.apiRequest("/farms/", { method: "GET" });
      const rows = Array.isArray(response?.data) ? response.data : [];
      return normalizeFarmList(rows);
    } catch (err) {
      console.warn("fetchNormalizedFarms() failed:", err);
      return [];
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  delivery.__sharedReady = true;

  delivery.getAppConfig = getAppConfig;
  delivery.getDeliveryConfig = getDeliveryConfig;
  delivery.getDeliveryConfigValue = getDeliveryConfigValue;
  delivery.getDefaultRadiusMiles = getDefaultRadiusMiles;
  delivery.getCustomerSourceMode = getCustomerSourceMode;
  delivery.getFarmSourceMode = getFarmSourceMode;

  delivery.toCleanString = toCleanString;
  delivery.toNumber = toNumber;
  delivery.normalizeSearchText = normalizeSearchText;

  delivery.formatAddressLine = formatAddressLine;
  delivery.formatAddressForGeocode = formatAddressForGeocode;
  delivery.getSavedAddress = getSavedAddress;
  delivery.setSavedAddress = setSavedAddress;
  delivery.getSavedAddressList = getSavedAddressList;
  delivery.getAvailableAddresses = getAvailableAddresses;
  delivery.toAddressOption = toAddressOption;

  delivery.getFarmDisplayName = getFarmDisplayName;
  delivery.getFarmId = getFarmId;
  delivery.getFarmRadiusMiles = getFarmRadiusMiles;
  delivery.buildFarmLocationQuery = buildFarmLocationQuery;
  delivery.normalizeFarm = normalizeFarm;
  delivery.normalizeFarmList = normalizeFarmList;
  delivery.filterFarmsBySearch = filterFarmsBySearch;
  delivery.filterFarmsByVisibility = filterFarmsByVisibility;

  delivery.hasValidPoint = hasValidPoint;
  delivery.toPoint = toPoint;
  delivery.distanceMiles = distanceMiles;
  delivery.isPointInFarmRange = isPointInFarmRange;
  delivery.getNearestFarm = getNearestFarm;
  delivery.getCoverageForPoint = getCoverageForPoint;
  delivery.getOverallCoverageCircle = getOverallCoverageCircle;

  delivery.getProductFarmName = getProductFarmName;
  delivery.buildFarmNameMap = buildFarmNameMap;
  delivery.annotateProductDelivery = annotateProductDelivery;
  delivery.annotateProductListDelivery = annotateProductListDelivery;
  delivery.filterAnnotatedRowsByRange = filterAnnotatedRowsByRange;
  delivery.sortAnnotatedRowsByDistance = sortAnnotatedRowsByDistance;
  delivery.areAllRowsDeliverable = areAllRowsDeliverable;
  delivery.getOutOfRangeRows = getOutOfRangeRows;

  delivery.getDeliveryStatusLabel = getDeliveryStatusLabel;
  delivery.getDeliveryStatusClass = getDeliveryStatusClass;

  delivery.fetchNormalizedFarms = fetchNormalizedFarms;

  CC.delivery = delivery;
})();