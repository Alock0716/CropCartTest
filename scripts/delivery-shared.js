/**
 * ============================================================================
 * delivery-shared.js — Shared delivery range/location helpers
 * ----------------------------------------------------------------------------
 * Purpose:
 * - Central place for delivery-radius logic reused across:
 *   - delivery-radius.html
 *   - future store/cart/checkout/account favorite badges + range checks
 *
 * Requires:
 * - config.js
 * - utils.js (window.CC)
 *
 * What this file does:
 * - Reads saved customer address data from local storage / auth-connected pages
 * - Fetches farms from the API
 * - Normalizes farm rows into a stable front-end shape
 * - Geocodes farm and customer addresses with fallbacks
 * - Caches geocode results in localStorage
 * - Computes distances / in-range checks
 * - Exposes a shared namespace: window.CC.delivery
 *
 * Notes:
 * - Built to match the project’s existing conventions:
 *   - uses window.CC helpers where possible
 *   - uses config.js API URL
 *   - preserves graceful fallback behavior
 * ============================================================================
 */

(function initDeliveryShared() {
  "use strict";

  const CC = window.CC;
  if (!CC) {
    console.warn(
      "delivery-shared.js: window.CC not found. Make sure utils.js is loaded first.",
    );
    return;
  }

  // Prevent duplicate init if script is included more than once.
  if (CC.delivery && CC.delivery.__ready) return;

  /* ==========================================================================
   * CONSTANTS / LOCAL STORAGE KEYS
   * ========================================================================== */

  // Shared address cache already used by account.js / checkout.js.
  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";

  // Geocode cache for both farm + customer address lookups.
  const GEOCODE_CACHE_KEY = "cc_geocode_cache_v1";

  // Keep key names explicit for readability and future debugging.
  const DEFAULT_RADIUS_MILES = Number(
    CC.getConfigValue?.("DEFAULT_DELIVERY_RADIUS_MILES", 15) || 15,
  );

  /* ==========================================================================
   * BASIC HELPERS
   * ========================================================================== */

  /**
   * Safe JSON read from localStorage.
   * @param {string} key
   * @param {any} fallback
   * @returns {any}
   */
  function getLocalJson(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Safe JSON write to localStorage.
   * @param {string} key
   * @param {any} value
   */
  function setLocalJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage may be blocked/private mode/full; fail silently.
    }
  }

  /**
   * True if a value looks like a usable finite coordinate.
   * @param {any} n
   * @returns {boolean}
   */
  function isFiniteCoord(n) {
    const v = Number(n);
    return Number.isFinite(v);
  }

  /**
   * Normalize any number-ish value.
   * @param {any} n
   * @param {number|null} fallback
   * @returns {number|null}
   */
  function toNumberOr(n, fallback = null) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
  }

  /**
   * Normalize text for stable comparisons / cache keys.
   * @param {any} value
   * @returns {string}
   */
  function norm(value) {
    return String(value || "").trim();
  }

  /**
   * Returns "City, ST" when possible.
   * @param {object} address
   * @returns {string}
   */
  function cityStateLabel(address) {
    const city = norm(address?.city);
    const state = norm(address?.state);
    return [city, state].filter(Boolean).join(", ");
  }

  /**
   * Returns a single-line address string.
   * @param {object} address
   * @returns {string}
   */
  function formatAddress(address) {
    if (!address) return "";
    const line1 = norm(address.address_line1 || address.street_address || "");
    const city = norm(address.city || "");
    const state = norm(address.state || "");
    const zip = norm(address.postal_code || address.zip || "");
    return [line1, city, state, zip].filter(Boolean).join(", ");
  }

  /* ==========================================================================
   * DISTANCE / RANGE HELPERS
   * ========================================================================== */

  /**
   * Haversine distance in miles between two lat/lng points.
   * @param {number} lat1
   * @param {number} lng1
   * @param {number} lat2
   * @param {number} lng2
   * @returns {number}
   */
  function milesBetween(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R_KM = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const km = R_KM * c;
    return km * 0.621371;
  }

  /**
   * Returns whether a customer point falls inside a farm's delivery radius.
   * @param {object} farm
   * @param {{lat:number,lng:number}} point
   * @returns {{inRange:boolean,distanceMiles:number|null}}
   */
  function checkFarmCoverage(farm, point) {
    const farmLat = toNumberOr(farm?.lat);
    const farmLng = toNumberOr(farm?.lng);
    const pointLat = toNumberOr(point?.lat);
    const pointLng = toNumberOr(point?.lng);
    const radius = toNumberOr(farm?.deliveryRadiusMiles, DEFAULT_RADIUS_MILES);

    if (
      farmLat === null ||
      farmLng === null ||
      pointLat === null ||
      pointLng === null ||
      radius === null
    ) {
      return { inRange: false, distanceMiles: null };
    }

    const distanceMiles = milesBetween(farmLat, farmLng, pointLat, pointLng);
    return {
      inRange: distanceMiles <= radius,
      distanceMiles,
    };
  }

  /**
   * Returns farm list annotated with inRange data for a given point.
   * @param {Array<object>} farms
   * @param {{lat:number,lng:number}|null} point
   * @returns {Array<object>}
   */
  function annotateFarmsForPoint(farms, point) {
    return (farms || []).map((farm) => {
      const check = point ? checkFarmCoverage(farm, point) : { inRange: false, distanceMiles: null };
      return {
        ...farm,
        inRange: !!check.inRange,
        distanceMiles: check.distanceMiles,
      };
    });
  }

  /* ==========================================================================
   * ADDRESS HELPERS
   * ========================================================================== */

  /**
   * Read saved address from the local cache used by account.js / checkout.js.
   * @returns {object|null}
   */
  function getSavedLocalAddress() {
    const addr = getLocalJson(LOCAL_ADDRESS_KEY, null);
    return addr && typeof addr === "object" ? addr : null;
  }

  /**
   * Build candidate geocode search strings in priority order.
   * Fallback order follows your planning doc:
   *   1) full address
   *   2) zip
   *   3) city/state
   *
   * @param {object} address
   * @returns {string[]}
   */
  function buildAddressCandidates(address) {
    const full = formatAddress(address);
    const zip = norm(address?.postal_code || address?.zip);
    const cityState = cityStateLabel(address);

    return [full, zip, cityState].filter(Boolean);
  }

  /**
   * Build a display label for a customer pin.
   * @param {object} address
   * @returns {string}
   */
  function getCustomerLabel(address) {
    const fullName =
      [norm(address?.first_name), norm(address?.last_name)]
        .filter(Boolean)
        .join(" ") || "Customer";
    return fullName;
  }

  /* ==========================================================================
   * GEOCODE CACHE
   * ========================================================================== */

  /**
   * Read full geocode cache object.
   * @returns {Record<string, any>}
   */
  function getGeocodeCache() {
    return getLocalJson(GEOCODE_CACHE_KEY, {});
  }

  /**
   * Save a single geocode cache entry.
   * @param {string} query
   * @param {object} payload
   */
  function setGeocodeCache(query, payload) {
    const cache = getGeocodeCache();
    cache[norm(query).toLowerCase()] = {
      ...payload,
      cachedAt: new Date().toISOString(),
    };
    setLocalJson(GEOCODE_CACHE_KEY, cache);
  }

  /**
   * Read a cached geocode entry if present.
   * @param {string} query
   * @returns {object|null}
   */
  function getCachedGeocode(query) {
    const cache = getGeocodeCache();
    return cache[norm(query).toLowerCase()] || null;
  }

  /* ==========================================================================
   * API: FARMS
   * ========================================================================== */

  /**
   * Load public farm rows from the API.
   * Uses the same /farms/ route the rest of the app already uses.
   * @returns {Promise<any[]>}
   */
  async function fetchFarms() {
    try {
      const res = await CC.apiRequest("/farms/", { method: "GET" });
      if (!res.ok) return [];
      return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      console.warn("delivery-shared.js fetchFarms failed:", err);
      return [];
    }
  }

  /**
   * Normalize a farm row from the API into a stable front-end object.
   * This stays defensive because field names may vary.
   *
   * @param {object} farm
   * @returns {object}
   */
  function normalizeFarm(farm) {
    const id = String(farm?.id ?? farm?.farm_id ?? "");
    const name = norm(farm?.farm_name ?? farm?.name ?? "Unnamed Farm");
    const location =
      norm(farm?.farm_location) ||
      norm(farm?.location) ||
      cityStateLabel(farm) ||
      "";
    const locationQuery = location
      ? /usa$/i.test(location)
        ? location
        : `${location}, USA`
      : "";

    const lat = toNumberOr(farm?.lat ?? farm?.latitude, null);
    const lng = toNumberOr(farm?.lng ?? farm?.longitude, null);

    const deliveryRadiusMiles = Number(
      farm?.delivery_radius_miles ??
        farm?.delivery_radius ??
        farm?.radius_miles ??
        DEFAULT_RADIUS_MILES
    ) || DEFAULT_RADIUS_MILES;

    const logoUrl = norm(
      farm?.logo_url ??
        farm?.logo ??
        farm?.image_url ??
        farm?.photo_url ??
        "",
    );

    const description = norm(farm?.description ?? farm?.farm_description ?? "");

    return {
      raw: farm,
      id,
      name,
      description,
      location,
      locationQuery,
      lat,
      lng,
      logoUrl,
      deliveryRadiusMiles,
      color: null,
      visible: true,
      geocodeStatus: lat !== null && lng !== null ? "existing" : "missing",
    };
  }

  /**
   * Fetch + normalize farms in one call.
   * @returns {Promise<object[]>}
   */
  async function getNormalizedFarms() {
    const farms = await fetchFarms();
    return farms.map(normalizeFarm);
  }

  /* ==========================================================================
   * GEOCODING
   * ========================================================================== */

  /**
   * Geocode a free-text query using Nominatim.
   * This is browser-only and does not require a token.
   *
   * @param {string} query
   * @returns {Promise<{lat:number,lng:number,label:string,source:string}|null>}
   */
  async function geocodeQuery(query) {
    const q = norm(query);
    if (!q) return null;

    const cached = getCachedGeocode(q);
    if (cached?.lat != null && cached?.lng != null) {
      return {
        lat: Number(cached.lat),
        lng: Number(cached.lng),
        label: cached.label || q,
        source: "cache",
      };
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;

    const payload = {
      lat: Number(row.lat),
      lng: Number(row.lon),
      label: row.display_name || q,
      source: "nominatim",
    };

    setGeocodeCache(q, payload);
    return payload;
  }

  /**
   * Geocode an address object using the planned fallback order.
   * 1) full address
   * 2) zip
   * 3) city/state
   *
   * @param {object} address
   * @returns {Promise<{lat:number,lng:number,label:string,source:string,matchedBy:string}|null>}
   */
  async function geocodeAddressWithFallback(address) {
    const candidates = buildAddressCandidates(address);

    for (const candidate of candidates) {
      const result = await geocodeQuery(candidate);
      if (result?.lat != null && result?.lng != null) {
        return {
          ...result,
          matchedBy: candidate,
        };
      }
    }

    return null;
  }

  /**
   * Ensure a farm has coordinates.
   * If coordinates are already present, keep them.
   * Otherwise geocode from farm location text.
   *
   * @param {object} farm
   * @returns {Promise<object>}
   */
  async function ensureFarmCoordinates(farm) {
    if (isFiniteCoord(farm?.lat) && isFiniteCoord(farm?.lng)) {
      return {
        ...farm,
        geocodeStatus: farm.geocodeStatus || "existing",
      };
    }

    const result = await geocodeQuery(
      farm?.locationQuery || farm?.location || farm?.name || "",
    );

    if (!result) {
      return {
        ...farm,
        lat: null,
        lng: null,
        geocodeStatus: "failed",
      };
    }

    return {
      ...farm,
      lat: Number(result.lat),
      lng: Number(result.lng),
      geocodeStatus: result.source === "cache" ? "cache" : "geocoded",
    };
  }

  /**
   * Resolve all farm coordinates.
   * @param {object[]} farms
   * @returns {Promise<object[]>}
   */
  async function resolveFarmCoordinates(farms) {
    const results = [];
    for (const farm of farms || []) {
      results.push(await ensureFarmCoordinates(farm));
    }
    return results;
  }

  /* ==========================================================================
   * COLOR HELPERS
   * ========================================================================== */

  /**
   * Stable palette for farm circles / legends.
   * @param {number} index
   * @returns {string}
   */
  function pickFarmColor(index) {
    const palette = [
      "#1e5b38",
      "#2f7a4d",
      "#7c5c2e",
      "#9a4d2e",
      "#3c6e71",
      "#6a4c93",
      "#5e8c31",
      "#355070",
      "#bc6c25",
      "#2a9d8f",
    ];
    return palette[index % palette.length];
  }

  /**
   * Apply stable colors to each farm.
   * @param {object[]} farms
   * @returns {object[]}
   */
  function assignFarmColors(farms) {
    return (farms || []).map((farm, index) => ({
      ...farm,
      color: farm.color || pickFarmColor(index),
    }));
  }

  /* ==========================================================================
   * OVERALL / AVERAGE RADIUS HELPERS
   * ========================================================================== */

  /**
   * Get average center/radius summary for visible farms.
   * Useful for the shared overlay circle.
   *
   * @param {object[]} farms
   * @returns {{lat:number,lng:number,radiusMiles:number}|null}
   */
  function getOverallCoverageSummary(farms) {
    const usable = (farms || []).filter(
      (f) => f?.visible !== false && isFiniteCoord(f.lat) && isFiniteCoord(f.lng),
    );

    if (!usable.length) return null;

    const avgLat =
      usable.reduce((sum, f) => sum + Number(f.lat), 0) / usable.length;
    const avgLng =
      usable.reduce((sum, f) => sum + Number(f.lng), 0) / usable.length;
    const avgRadius =
      usable.reduce(
        (sum, f) => sum + Number(f.deliveryRadiusMiles || DEFAULT_RADIUS_MILES),
        0,
      ) / usable.length;

    return {
      lat: avgLat,
      lng: avgLng,
      radiusMiles: avgRadius,
    };
  }

  /* ==========================================================================
   * EXPOSE SHARED NAMESPACE
   * ========================================================================== */

  CC.delivery = {
    __ready: true,

    LOCAL_ADDRESS_KEY,
    GEOCODE_CACHE_KEY,
    DEFAULT_RADIUS_MILES,

    getSavedLocalAddress,
    buildAddressCandidates,
    formatAddress,
    getCustomerLabel,

    fetchFarms,
    normalizeFarm,
    getNormalizedFarms,
    ensureFarmCoordinates,
    resolveFarmCoordinates,

    geocodeQuery,
    geocodeAddressWithFallback,

    milesBetween,
    checkFarmCoverage,
    annotateFarmsForPoint,

    pickFarmColor,
    assignFarmColors,
    getOverallCoverageSummary,
  };
})();