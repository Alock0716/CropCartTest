/**
 * ============================================================================
 * delivery-radius.js — Delivery Coverage page controller
 * ----------------------------------------------------------------------------
 * Requires:
 * - config.js
 * - utils.js
 * - delivery-shared.js
 * - Leaflet
 * - Turf.js
 *
 * Purpose:
 * - Initialize the Delivery Coverage page map
 * - Load farms from GET /farms/
 * - Use farm.location / farm_location strings for geocoding
 * - Render farm pins and radius circles
 * - Keep farms visible at all zoom levels
 * - Populate saved/cached customer address dropdown
 * - Render selected customer pin and coverage result
 * - Support farm searching, visibility filters, and layer toggles
 *
 * Geocoding:
 * - Uses free Nominatim instead of Mapbox
 * - No API key required
 * - Includes a small delay between farm requests for polite public usage
 * ============================================================================
 */

(function initDeliveryRadiusPage() {
  "use strict";

  const CC = window.CC;
  const delivery = CC?.delivery;

  if (!CC) {
    console.warn("delivery-radius.js: window.CC not found.");
    return;
  }

  if (!delivery || !delivery.__sharedReady) {
    console.warn("delivery-radius.js: delivery-shared.js must load before this file.");
    return;
  }

  if (typeof window.L === "undefined") {
    console.warn("delivery-radius.js: Leaflet is required.");
    return;
  }

  // ==========================================================================
  // CONFIG
  // ==========================================================================

  const DEFAULT_MAP_CENTER = [39.8283, -98.5795];
  const DEFAULT_MAP_ZOOM = 4;

  /**
   * Delay between geocode calls to the public Nominatim service.
   * 1000 ms is the safe/polite choice.
   */
  const NOMINATIM_DELAY_MS = 1000;

  /**
   * Cache geocode results for the lifetime of the page session.
   */
  const geocodeCache = new Map();

  // ==========================================================================
  // DOM
  // ==========================================================================

  const pageStatusEl = document.getElementById("pageStatus");
  const anonNoticeEl = document.getElementById("anonNotice");

  const addressSelectEl = document.getElementById("addressSelect");
  const useSelectedAddressBtn = document.getElementById("useSelectedAddressBtn");
  const clearCustomerPinBtn = document.getElementById("clearCustomerPinBtn");
  const selectedAddressSummaryEl = document.getElementById("selectedAddressSummary");

  const farmSearchInputEl = document.getElementById("farmSearchInput");
  const farmVisibilityFilterEl = document.getElementById("farmVisibilityFilter");
  const showAllFarmsBtn = document.getElementById("showAllFarmsBtn");
  const hideAllFarmsBtn = document.getElementById("hideAllFarmsBtn");
  const resetFarmFiltersBtn = document.getElementById("resetFarmFiltersBtn");
  const farmToggleListEl = document.getElementById("farmToggleList");
  const farmCountBadgeEl = document.getElementById("farmCountBadge");

  const showFarmPinsToggleEl = document.getElementById("showFarmPinsToggle");
  const showFarmRadiusToggleEl = document.getElementById("showFarmRadiusToggle");
  const showCustomerPinToggleEl = document.getElementById("showCustomerPinToggle");
  const overallRadiusToggleEl = document.getElementById("overallRadiusToggle");

  const deliveryMapEl = document.getElementById("deliveryMap");

  if (!deliveryMapEl) {
    console.warn("delivery-radius.js: #deliveryMap not found.");
    return;
  }

  // ==========================================================================
  // STATE
  // ==========================================================================

  let map = null;

  let farmPinLayer = null;
  let farmRadiusLayer = null;
  let customerPinLayer = null;
  let overallRadiusLayer = null;

  let allFarms = [];
  let availableAddresses = [];

  let selectedAddress = null;
  let selectedCustomerPoint = null;
  let customerMarker = null;
  let overallRadiusCircle = null;

  // ==========================================================================
  // UI HELPERS
  // ==========================================================================

  function esc(value) {
    return typeof CC.escapeHtml === "function"
      ? CC.escapeHtml(String(value ?? ""))
      : String(value ?? "");
  }

  function setPageStatus(message, tone = "muted") {
    if (!pageStatusEl) return;

    const toneMap = {
      muted: "text-muted",
      success: "text-success",
      danger: "text-danger",
      warning: "text-warning",
    };

    pageStatusEl.className = `small ${toneMap[tone] || "text-muted"}`;
    pageStatusEl.textContent = String(message || "");
  }

  function formatMiles(miles) {
    return Number.isFinite(Number(miles)) ? `${Number(miles).toFixed(1)} mi` : "—";
  }

  function milesToMeters(miles) {
    return Number(miles || 0) * 1609.344;
  }

  function isLikelySignedIn() {
    try {
      if (CC.auth && typeof CC.auth.isLoggedIn === "function") {
        return !!CC.auth.isLoggedIn();
      }
      if (typeof CC.getToken === "function") {
        return !!CC.getToken();
      }
    } catch {
      // ignore
    }
    return false;
  }

  function refreshGuestNotice() {
    if (!anonNoticeEl) return;

    const signedIn = isLikelySignedIn();
    const hasAddresses = availableAddresses.length > 0;

    if (signedIn || hasAddresses) {
      anonNoticeEl.classList.add("d-none");
    } else {
      anonNoticeEl.classList.remove("d-none");
    }
  }

  // ==========================================================================
  // POINT SAFETY HELPERS
  // ==========================================================================

  /**
   * Convert any point-like object into a Leaflet-safe [lat, lng] tuple.
   *
   * @param {object|null} pointLike
   * @returns {[number, number] | null}
   */
  function toLeafletLatLng(pointLike) {
    if (!delivery.hasValidPoint(pointLike)) return null;

    const lat = Number(pointLike.lat);
    const lng = Number(pointLike.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return [lat, lng];
  }

  /**
   * @param {object|null} pointLike
   * @returns {boolean}
   */
  function canRenderPoint(pointLike) {
    return Array.isArray(toLeafletLatLng(pointLike));
  }

  /**
   * Small async delay helper used between public geocoder calls.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  // ==========================================================================
  // MAP
  // ==========================================================================

  function initMap() {
    map = L.map(deliveryMapEl, {
      center: DEFAULT_MAP_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    farmPinLayer = L.layerGroup().addTo(map);
    farmRadiusLayer = L.layerGroup().addTo(map);
    customerPinLayer = L.layerGroup().addTo(map);
    overallRadiusLayer = L.layerGroup().addTo(map);
  }

  function getFarmMarkerRadiusForZoom() {
    if (!map) return 7;

    const z = Number(map.getZoom() || DEFAULT_MAP_ZOOM);

    if (z <= 4) return 11;
    if (z <= 6) return 10;
    if (z <= 8) return 9;
    if (z <= 10) return 8;
    return 7;
  }

  function fitMapToVisibleContent() {
    if (!map) return;

    const bounds = L.latLngBounds([]);
    let hasAnyPoint = false;
    let pointCount = 0;

    for (const farm of allFarms) {
      if (farm.visible === false) continue;

      const latLng = toLeafletLatLng(farm);
      if (!latLng) continue;

      bounds.extend(latLng);
      hasAnyPoint = true;
      pointCount += 1;
    }

    if (showCustomerPinToggleEl?.checked ?? true) {
      const customerLatLng = toLeafletLatLng(selectedCustomerPoint);
      if (customerLatLng) {
        bounds.extend(customerLatLng);
        hasAnyPoint = true;
        pointCount += 1;
      }
    }

    if (!hasAnyPoint) return;

    if (pointCount === 1) {
      map.setView(bounds.getCenter(), 8);
      return;
    }

    map.fitBounds(bounds.pad(0.2), {
      maxZoom: 8,
      animate: true,
    });
  }

  // ==========================================================================
  // FREE GEOCODING (NOMINATIM)
  // ==========================================================================

  /**
   * Geocode a place string using Nominatim.
   * No token required.
   *
   * @param {string} query
   * @returns {Promise<{lat:number,lng:number}|null>}
   */
  async function geocodePlace(query) {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) return null;

    if (geocodeCache.has(cleanQuery)) {
      return geocodeCache.get(cleanQuery);
    }

    const url =
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q: cleanQuery,
        format: "json",
        limit: "1",
        countrycodes: "us",
      });

    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      if (!Array.isArray(data) || !data.length) {
        console.warn("No geocode result:", cleanQuery, data);
        geocodeCache.set(cleanQuery, null);
        return null;
      }

      const result = data[0];
      const point = delivery.toPoint(Number(result.lat), Number(result.lon));

      console.log("Geocode success:", {
        query: cleanQuery,
        display_name: result.display_name,
        point,
      });

      geocodeCache.set(cleanQuery, point || null);
      return point || null;
    } catch (err) {
      console.warn("Nominatim geocode failed:", cleanQuery, err);
      geocodeCache.set(cleanQuery, null);
      return null;
    }
  }

  async function ensureFarmCoordinates(farm) {
    if (delivery.hasValidPoint(farm)) {
      return {
        ...farm,
        lat: Number(farm.lat),
        lng: Number(farm.lng),
        geocodeStatus: "existing",
      };
    }

    const query = delivery.buildFarmLocationQuery(farm);

    if (!query) {
      console.warn("No geocode query available for farm:", farm);
      return {
        ...farm,
        geocodeStatus: "missing-query",
      };
    }

    const point = await geocodePlace(query);

    if (!point) {
      console.warn(`Geocode failed for farm "${farm.name}" using query "${query}"`);
      return {
        ...farm,
        lat: null,
        lng: null,
        geocodeStatus: "failed",
      };
    }

    return {
      ...farm,
      lat: point.lat,
      lng: point.lng,
      geocodeStatus: "ok",
    };
  }

  async function geocodeAddress(address) {
    const query = delivery.formatAddressForGeocode(address);
    return geocodePlace(query);
  }

  // ==========================================================================
  // FARM LAYER RENDERING
  // ==========================================================================

  function getFarmColorByIndex(index) {
    const palette = [
      "#5aa469",
      "#4f86c6",
      "#e07a5f",
      "#9d4edd",
      "#f4a261",
      "#2a9d8f",
      "#c1121f",
      "#6c757d",
    ];

    return palette[index % palette.length];
  }

  function buildFarmPopupHtml(farm) {
    const locationText =
      delivery.toCleanString(farm.location) ||
      [farm.city, farm.state, farm.zip].filter(Boolean).join(", ");

    let customerHtml = "";

    if (delivery.hasValidPoint(selectedCustomerPoint) && delivery.hasValidPoint(farm)) {
      const inRange = delivery.isPointInFarmRange(selectedCustomerPoint, farm);
      const distanceMiles = delivery.distanceMiles(selectedCustomerPoint, farm);
      const statusLabel = delivery.getDeliveryStatusLabel(inRange);
      const statusClass = inRange ? "text-success" : "text-danger";

      customerHtml = `
        <hr class="my-2" />
        <div class="small">
          <div class="fw-semibold">Selected Address Check</div>
          <div class="${statusClass} fw-semibold">${esc(statusLabel)}</div>
          <div>Distance: ${esc(formatMiles(distanceMiles))}</div>
        </div>
      `;
    }

    return `
      <div class="small">
        <div class="fw-semibold mb-1">${esc(farm.name)}</div>
        <div>${esc(locationText || "Location unavailable")}</div>
        <div>Radius: ${esc(formatMiles(farm.radiusMiles))}</div>
        ${customerHtml}
      </div>
    `;
  }

  function renderFarmLayers(farm) {
    if (farm.marker && farmPinLayer?.hasLayer(farm.marker)) {
      farmPinLayer.removeLayer(farm.marker);
    }

    if (farm.circle && farmRadiusLayer?.hasLayer(farm.circle)) {
      farmRadiusLayer.removeLayer(farm.circle);
    }

    const latLng = toLeafletLatLng(farm);
    if (!latLng) {
      return {
        ...farm,
        marker: null,
        circle: null,
      };
    }

    const marker = L.circleMarker(latLng, {
      radius: getFarmMarkerRadiusForZoom(),
      color: "#1f2937",
      weight: 2,
      fillColor: farm.color,
      fillOpacity: 1,
      pane: "markerPane",
    }).bindPopup(buildFarmPopupHtml(farm));

    const circle = L.circle(latLng, {
      radius: milesToMeters(farm.radiusMiles),
      color: farm.color,
      weight: 2,
      opacity: 0.95,
      fillColor: farm.color,
      fillOpacity: 0.16,
    });

    if (farm.visible !== false) {
      if (showFarmPinsToggleEl?.checked ?? true) marker.addTo(farmPinLayer);
      if (showFarmRadiusToggleEl?.checked ?? true) circle.addTo(farmRadiusLayer);
    }

    return {
      ...farm,
      marker,
      circle,
    };
  }

  function refreshFarmLayers() {
    if (!farmPinLayer || !farmRadiusLayer) return;

    farmPinLayer.clearLayers();
    farmRadiusLayer.clearLayers();

    allFarms = allFarms.map((farm) => renderFarmLayers(farm));
  }

  // ==========================================================================
  // OVERALL RADIUS
  // ==========================================================================

  function refreshOverallRadius() {
    if (!overallRadiusLayer) return;

    overallRadiusLayer.clearLayers();
    overallRadiusCircle = null;

    if (!(overallRadiusToggleEl?.checked ?? true)) return;

    const visibleFarms = allFarms.filter(
      (farm) => farm.visible !== false && delivery.hasValidPoint(farm)
    );

    // Avoid misleading overlays when there are too few mapped farms.
    if (visibleFarms.length < 2) return;

    const overall = delivery.getOverallCoverageCircle(visibleFarms);
    const latLng = toLeafletLatLng(overall);

    if (!overall || !latLng) return;

    overallRadiusCircle = L.circle(latLng, {
      radius: milesToMeters(overall.radiusMiles),
      color: "#212529",
      weight: 2,
      dashArray: "8 6",
      opacity: 0.85,
      fillColor: "#6c757d",
      fillOpacity: 0.08,
    }).bindPopup(`
      <div class="small">
        <div class="fw-semibold mb-1">Overall Coverage Estimate</div>
        <div>Average radius: ${esc(formatMiles(overall.radiusMiles))}</div>
        <div class="text-muted">Heuristic overlay only — not an exact merged service area.</div>
      </div>
    `);

    overallRadiusCircle.addTo(overallRadiusLayer);
  }

  // ==========================================================================
  // CUSTOMER ADDRESS
  // ==========================================================================

  function populateAddressDropdown() {
    if (!addressSelectEl) return;

    availableAddresses = delivery.getAvailableAddresses();

    addressSelectEl.innerHTML = [
      `<option value="">Select an address</option>`,
      ...availableAddresses.map((address, index) => {
        const option = delivery.toAddressOption(address, index);
        return `<option value="${esc(option.value)}">${esc(option.label)}</option>`;
      }),
    ].join("");

    refreshGuestNotice();
  }

  function getSelectedAddressFromDropdown() {
    const idx = Number(addressSelectEl?.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= availableAddresses.length) {
      return null;
    }
    return availableAddresses[idx] || null;
  }

  function refreshSelectedAddressSummary() {
    if (!selectedAddressSummaryEl) return;

    if (!selectedAddress) {
      selectedAddressSummaryEl.textContent = "No address selected yet.";
      return;
    }

    selectedAddressSummaryEl.textContent =
      delivery.formatAddressLine(selectedAddress) || "Address details unavailable.";
  }

  function buildCustomerPopupHtml() {
    const addressText = delivery.formatAddressLine(selectedAddress);
    const visibleFarms = allFarms.filter((farm) => farm.visible !== false);
    const coverage = delivery.hasValidPoint(selectedCustomerPoint)
      ? delivery.getCoverageForPoint(selectedCustomerPoint, visibleFarms)
      : null;

    const inRange = coverage?.inRange ?? null;
    const statusLabel = delivery.getDeliveryStatusLabel(inRange);
    const statusClass =
      inRange === true
        ? "text-success"
        : inRange === false
          ? "text-danger"
          : "text-secondary";

    const nearestFarmName = coverage?.nearestFarm?.name || "—";
    const nearestDistance = formatMiles(coverage?.nearestDistanceMiles ?? null);

    return `
      <div class="small">
        <div class="fw-semibold mb-1">Selected Customer Address</div>
        <div>${esc(addressText || "Unknown address")}</div>
        <hr class="my-2" />
        <div class="${statusClass} fw-semibold">${esc(statusLabel)}</div>
        <div>Nearest visible farm: ${esc(nearestFarmName)}</div>
        <div>Distance: ${esc(nearestDistance)}</div>
      </div>
    `;
  }

  function refreshCustomerMarker() {
    if (!customerPinLayer) return;

    customerPinLayer.clearLayers();
    customerMarker = null;

    if (!(showCustomerPinToggleEl?.checked ?? true)) return;

    const latLng = toLeafletLatLng(selectedCustomerPoint);
    if (!latLng) return;

    customerMarker = L.circleMarker(latLng, {
      radius: 8,
      color: "#0d6efd",
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
      pane: "markerPane",
    }).bindPopup(buildCustomerPopupHtml());

    customerMarker.addTo(customerPinLayer);
  }

  function clearCustomerPin() {
    selectedCustomerPoint = null;
    selectedAddress = null;

    if (addressSelectEl) addressSelectEl.value = "";
    refreshSelectedAddressSummary();
    refreshCustomerMarker();
    refreshFarmLayers();
    refreshOverallRadius();
    fitMapToVisibleContent();
    setPageStatus("Customer pin cleared.", "muted");
  }

  async function showSelectedAddressOnMap() {
    selectedAddress = getSelectedAddressFromDropdown();
    refreshSelectedAddressSummary();

    if (!selectedAddress) {
      setPageStatus("Select an address first.", "warning");
      refreshCustomerMarker();
      return;
    }

    setPageStatus("Locating selected address…", "muted");

    const point = await geocodeAddress(selectedAddress);
    if (!point) {
      selectedCustomerPoint = null;
      refreshCustomerMarker();
      setPageStatus(
        "Could not geocode the selected address.",
        "danger"
      );
      return;
    }

    selectedCustomerPoint = point;
    delivery.setSavedAddress(selectedAddress);

    refreshCustomerMarker();
    refreshFarmLayers();
    refreshOverallRadius();
    fitMapToVisibleContent();

    setPageStatus("Customer address loaded onto the map.", "success");
  }

  // ==========================================================================
  // FARM LIST UI
  // ==========================================================================

  function getFilteredFarmListForSidebar() {
    const query = farmSearchInputEl?.value || "";
    const visibilityMode = farmVisibilityFilterEl?.value || "all";

    const searched = delivery.filterFarmsBySearch(allFarms, query);
    return delivery.filterFarmsByVisibility(searched, visibilityMode);
  }

  function renderFarmToggleList() {
    if (!farmToggleListEl) return;

    const filteredRows = getFilteredFarmListForSidebar();

    if (farmCountBadgeEl) {
      farmCountBadgeEl.textContent = `${allFarms.length} farm${allFarms.length === 1 ? "" : "s"}`;
    }

    if (!filteredRows.length) {
      farmToggleListEl.innerHTML = `<div class="small text-muted">No farms match the current filters.</div>`;
      return;
    }

    farmToggleListEl.innerHTML = filteredRows
      .map((farm) => {
        const checked = farm.visible !== false ? "checked" : "";
        const locationText =
          delivery.toCleanString(farm.location) ||
          [farm.city, farm.state].filter(Boolean).join(", ");

        const hasCoords = delivery.hasValidPoint(farm);
        const coordText = hasCoords ? "Mapped" : "Needs geocode";

        return `
          <label class="border rounded-3 p-3 d-flex align-items-start gap-3">
            <input
              class="form-check-input mt-1 cc-farm-visibility-toggle"
              type="checkbox"
              data-farm-id="${esc(farm.id)}"
              ${checked}
            />
            <span class="flex-grow-1">
              <span class="d-flex align-items-center justify-content-between gap-2">
                <span class="fw-semibold">${esc(farm.name)}</span>
                <span
                  style="display:inline-block;width:14px;height:14px;border-radius:999px;background:${esc(farm.color)};"
                  aria-hidden="true"
                ></span>
              </span>
              <span class="d-block small text-muted mt-1">
                ${esc(locationText || "Location unavailable")}
              </span>
              <span class="d-block small text-muted">
                Radius: ${esc(formatMiles(farm.radiusMiles))} • ${esc(coordText)}
              </span>
            </span>
          </label>
        `;
      })
      .join("");
  }

  function setFarmVisibility(farmId, visible) {
    allFarms = allFarms.map((farm) =>
      String(farm.id) === String(farmId) ? { ...farm, visible: !!visible } : farm
    );

    renderFarmToggleList();
    refreshFarmLayers();
    refreshCustomerMarker();
    refreshOverallRadius();
  }

  function setAllFarmsVisibility(visible) {
    allFarms = allFarms.map((farm) => ({
      ...farm,
      visible: !!visible,
    }));

    renderFarmToggleList();
    refreshFarmLayers();
    refreshCustomerMarker();
    refreshOverallRadius();
    fitMapToVisibleContent();
  }

  function resetFarmFilters() {
    if (farmSearchInputEl) farmSearchInputEl.value = "";
    if (farmVisibilityFilterEl) farmVisibilityFilterEl.value = "all";

    allFarms = allFarms.map((farm) => ({
      ...farm,
      visible: true,
    }));

    renderFarmToggleList();
    refreshFarmLayers();
    refreshCustomerMarker();
    refreshOverallRadius();
    fitMapToVisibleContent();
  }

  // ==========================================================================
  // DATA LOAD
  // ==========================================================================

  async function loadFarms() {
    setPageStatus("Loading farms…", "muted");

    const normalizedFarms = await delivery.fetchNormalizedFarms();

    if (!normalizedFarms.length) {
      allFarms = [];
      renderFarmToggleList();
      refreshFarmLayers();
      refreshOverallRadius();
      setPageStatus("No farms were returned from the API.", "warning");
      return;
    }

    const enriched = [];

    for (let i = 0; i < normalizedFarms.length; i += 1) {
      const baseFarm = normalizedFarms[i];

      let farm = {
        ...baseFarm,
        color: getFarmColorByIndex(i),
        visible: true,
        marker: null,
        circle: null,
        geocodeStatus: "pending",
      };

      farm = await ensureFarmCoordinates(farm);

      console.log("Farm mapping result:", {
        id: farm.id,
        name: farm.name,
        location: farm.location,
        locationQuery: farm.locationQuery,
        lat: farm.lat,
        lng: farm.lng,
        geocodeStatus: farm.geocodeStatus,
      });

      enriched.push(farm);

      // Be polite to the public geocoder service.
      if (i < normalizedFarms.length - 1) {
        await wait(NOMINATIM_DELAY_MS);
      }
    }

    allFarms = enriched;
    renderFarmToggleList();
    refreshFarmLayers();
    refreshOverallRadius();
    fitMapToVisibleContent();

    const mappedCount = allFarms.filter((farm) => canRenderPoint(farm)).length;
    setPageStatus(
      `Loaded ${allFarms.length} farm${allFarms.length === 1 ? "" : "s"} (${mappedCount} mapped).`,
      "success"
    );
  }

  // ==========================================================================
  // EVENTS
  // ==========================================================================

  function bindEvents() {
    useSelectedAddressBtn?.addEventListener("click", async () => {
      await showSelectedAddressOnMap();
    });

    addressSelectEl?.addEventListener("change", () => {
      selectedAddress = getSelectedAddressFromDropdown();
      refreshSelectedAddressSummary();
    });

    clearCustomerPinBtn?.addEventListener("click", () => {
      clearCustomerPin();
    });

    farmSearchInputEl?.addEventListener("input", () => {
      renderFarmToggleList();
    });

    farmVisibilityFilterEl?.addEventListener("change", () => {
      renderFarmToggleList();
    });

    showAllFarmsBtn?.addEventListener("click", () => {
      setAllFarmsVisibility(true);
    });

    hideAllFarmsBtn?.addEventListener("click", () => {
      setAllFarmsVisibility(false);
    });

    resetFarmFiltersBtn?.addEventListener("click", () => {
      resetFarmFilters();
    });

    farmToggleListEl?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains("cc-farm-visibility-toggle")) return;

      const farmId = target.getAttribute("data-farm-id");
      if (!farmId) return;

      setFarmVisibility(farmId, target.checked);
    });

    showFarmPinsToggleEl?.addEventListener("change", () => {
      refreshFarmLayers();
    });

    showFarmRadiusToggleEl?.addEventListener("change", () => {
      refreshFarmLayers();
    });

    showCustomerPinToggleEl?.addEventListener("change", () => {
      refreshCustomerMarker();
    });

    overallRadiusToggleEl?.addEventListener("change", () => {
      refreshOverallRadius();
    });

    map?.on("zoomend", () => {
      refreshFarmLayers();
      refreshCustomerMarker();
    });
  }

  // ==========================================================================
  // INIT
  // ==========================================================================

  async function init() {
    initMap();
    bindEvents();
    populateAddressDropdown();
    refreshSelectedAddressSummary();
    refreshGuestNotice();

    await loadFarms();

    if (addressSelectEl && availableAddresses.length > 0) {
      addressSelectEl.value = "0";
      selectedAddress = getSelectedAddressFromDropdown();
      refreshSelectedAddressSummary();
    }
  }

  init().catch((err) => {
    console.error("delivery-radius.js init failed:", err);
    setPageStatus("Delivery coverage page failed to initialize.", "danger");
  });
})();