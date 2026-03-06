/**
 * ============================================================================
 * delivery-radius.js — Delivery Coverage page controller
 * ----------------------------------------------------------------------------
 * Purpose:
 * - Drives delivery-radius.html
 * - Renders farms + delivery radii on a Leaflet map
 * - Loads saved customer address data
 * - Lets the user show/clear a customer pin
 * - Supports search / visibility toggles / shared overlay
 *
 * Requires:
 * - config.js
 * - utils.js
 * - delivery-shared.js
 * - Leaflet
 * - Turf (optional future support; not required for current logic)
 *
 * Notes:
 * - Page is intentionally public. Guests can view farm coverage.
 * - Customer pin uses saved local address when available.
 * ============================================================================
 */

(function initDeliveryRadiusPage() {
  "use strict";

  const CC = window.CC;
  const Delivery = CC?.delivery;

  if (!CC || !Delivery) {
    console.warn(
      "delivery-radius.js: required globals missing. Make sure config.js, utils.js, and delivery-shared.js load before this file.",
    );
    return;
  }

  /* ==========================================================================
   * DOM
   * ========================================================================== */

  const anonNoticeEl = document.getElementById("anonNotice");

  const addressSelectEl = document.getElementById("addressSelect");
  const useSelectedAddressBtn = document.getElementById("useSelectedAddressBtn");
  const clearCustomerPinBtn = document.getElementById("clearCustomerPinBtn");

  const farmSearchInput = document.getElementById("farmSearchInput");
  const farmVisibilityFilter = document.getElementById("farmVisibilityFilter");
  const showAllFarmsBtn = document.getElementById("showAllFarmsBtn");
  const hideAllFarmsBtn = document.getElementById("hideAllFarmsBtn");
  const resetFarmFiltersBtn = document.getElementById("resetFarmFiltersBtn");

  const showFarmPinsToggle = document.getElementById("showFarmPinsToggle");
  const showFarmRadiusToggle = document.getElementById("showFarmRadiusToggle");
  const showCustomerPinToggle = document.getElementById("showCustomerPinToggle");
  const overallRadiusToggle = document.getElementById("overallRadiusToggle");

  const farmCountBadge = document.getElementById("farmCountBadge");
  const farmToggleList = document.getElementById("farmToggleList");

  const deliveryMapEl = document.getElementById("deliveryMap");

  /* ==========================================================================
   * STATE
   * ========================================================================== */

  let map = null;
  let mapDidAutoFit = false;

  let allFarms = [];
  let selectedCustomerAddress = null;
  let selectedCustomerPoint = null;

  let customerMarker = null;
  let overallCoverageCircle = null;

  // Layer registries so visibility can be toggled without rebuilding the map.
  const farmMarkerById = new Map();
  const farmRadiusById = new Map();

  /* ==========================================================================
   * MAP HELPERS
   * ========================================================================== */

  /**
   * Create the Leaflet map.
   */
  function initMap() {
    if (!deliveryMapEl || !window.L) {
      console.warn("delivery-radius.js: map container or Leaflet missing.");
      return;
    }

    map = L.map(deliveryMapEl, {
      zoomControl: true,
      scrollWheelZoom: true,
    }).setView([39.8283, -98.5795], 4);

    // Free OpenStreetMap tiles.
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
  }

  /**
   * Fit the map to visible content.
   * Only auto-fit aggressively once; later fits are smaller/optional.
   */
  function fitMapToContent() {
    if (!map || !window.L) return;

    const latLngs = [];

    for (const farm of getFilteredFarms()) {
      if (Number.isFinite(Number(farm.lat)) && Number.isFinite(Number(farm.lng))) {
        latLngs.push([Number(farm.lat), Number(farm.lng)]);
      }
    }

    if (selectedCustomerPoint?.lat != null && selectedCustomerPoint?.lng != null) {
      latLngs.push([Number(selectedCustomerPoint.lat), Number(selectedCustomerPoint.lng)]);
    }

    if (!latLngs.length) return;

    const bounds = L.latLngBounds(latLngs);
    map.fitBounds(bounds, { padding: [40, 40] });

    // Prevent giant jump-in on later refreshes.
    if (!mapDidAutoFit) {
      mapDidAutoFit = true;
      if (map.getZoom() > 10) map.setZoom(10);
    }
  }

  /* ==========================================================================
   * ICON HELPERS
   * ========================================================================== */

  /**
   * Farm marker with logo when available, fallback letter tile otherwise.
   * @param {object} farm
   * @returns {L.DivIcon}
   */
  function createFarmIcon(farm) {
    const logo = CC.escapeHtml(String(farm.logoUrl || "").trim());
    const name = String(farm.name || "F");
    const initial = CC.escapeHtml((name[0] || "F").toUpperCase());

    const inner = logo
      ? `<div class="cc-delivery-farm-pin-inner"><img src="${logo}" alt="${CC.escapeHtml(name)} logo" /></div>`
      : `<div class="cc-delivery-farm-pin-inner cc-delivery-farm-pin-fallback">${initial}</div>`;

    return L.divIcon({
      className: "cc-delivery-farm-pin",
      html: inner,
      iconSize: [42, 42],
      iconAnchor: [21, 21],
      popupAnchor: [0, -16],
    });
  }

  /**
   * Customer marker icon.
   * @returns {L.DivIcon}
   */
  function createCustomerIcon() {
    return L.divIcon({
      className: "cc-delivery-customer-pin",
      html: `
        <div class="cc-delivery-customer-pin-inner">
          <i class="bi bi-geo-alt-fill"></i>
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -14],
    });
  }

  /* ==========================================================================
   * FARM FILTERING / VIEW STATE
   * ========================================================================== */

  /**
   * Current filtered list used for sidebar + map rendering.
   * Search + quick filter operate over visibility state.
   *
   * @returns {object[]}
   */
  function getFilteredFarms() {
    const search = String(farmSearchInput?.value || "")
      .trim()
      .toLowerCase();
    const visibilityMode = String(farmVisibilityFilter?.value || "all").trim();

    let list = [...allFarms];

    if (visibilityMode === "visible") {
      list = list.filter((farm) => farm.visible !== false);
    } else if (visibilityMode === "hidden") {
      list = list.filter((farm) => farm.visible === false);
    }

    if (search) {
      list = list.filter((farm) => {
        const haystack = [
          farm.name,
          farm.location,
          String(farm.deliveryRadiusMiles || ""),
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(search);
      });
    }

    // Sort in-range farms first, then by distance, then by name.
    list.sort((a, b) => {
      const aIn = a.inRange ? 0 : 1;
      const bIn = b.inRange ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;

      const aDist = Number.isFinite(Number(a.distanceMiles)) ? Number(a.distanceMiles) : Number.POSITIVE_INFINITY;
      const bDist = Number.isFinite(Number(b.distanceMiles)) ? Number(b.distanceMiles) : Number.POSITIVE_INFINITY;
      if (aDist !== bDist) return aDist - bDist;

      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    return list;
  }

  /**
   * Replace all farm annotations using the current customer point.
   */
  function refreshFarmCoverageState() {
    allFarms = Delivery.annotateFarmsForPoint(allFarms, selectedCustomerPoint);
  }

  /* ==========================================================================
   * FARM SIDEBAR RENDER
   * ========================================================================== */

  /**
   * Small badge block for farm coverage status.
   * @param {object} farm
   * @returns {string}
   */
  function renderRangeBadge(farm) {
    if (!selectedCustomerPoint) {
      return `<span class="badge text-bg-light border">No customer pin</span>`;
    }

    if (farm.inRange) {
      const dist = Number.isFinite(Number(farm.distanceMiles))
        ? `${farm.distanceMiles.toFixed(1)} mi`
        : "In range";
      return `<span class="badge text-bg-success">${CC.escapeHtml(dist)} • In range</span>`;
    }

    if (Number.isFinite(Number(farm.distanceMiles))) {
      return `<span class="badge text-bg-danger">${CC.escapeHtml(farm.distanceMiles.toFixed(1))} mi • Out of range</span>`;
    }

    return `<span class="badge text-bg-secondary">Distance unavailable</span>`;
  }

  /**
   * Render farm toggle list.
   */
  function renderFarmToggleList() {
    if (!farmToggleList) return;

    const farms = getFilteredFarms();

    if (farmCountBadge) {
      farmCountBadge.textContent = `${farms.length} farm${farms.length === 1 ? "" : "s"}`;
    }

    if (!farms.length) {
      farmToggleList.innerHTML = `<div class="small text-muted">No farms match the current filters.</div>`;
      return;
    }

    farmToggleList.innerHTML = farms
      .map((farm) => {
        const farmId = CC.escapeHtml(String(farm.id));
        const farmName = CC.escapeHtml(farm.name);
        const farmLocation = CC.escapeHtml(farm.location || "Location unavailable");
        const radiusLabel = `${Number(farm.deliveryRadiusMiles || 0).toFixed(0)} mi`;
        const checked = farm.visible !== false ? "checked" : "";

        return `
          <div class="cc-delivery-farm-card ${farm.inRange ? "cc-delivery-farm-card--in-range" : ""}">
            <div class="d-flex align-items-start gap-3">
              <div
                class="cc-delivery-farm-swatch"
                style="background:${CC.escapeHtml(farm.color || "#1e5b38")};"
                aria-hidden="true"
              ></div>

              <div class="cc-delivery-farm-logo-wrap">
                ${
                  farm.logoUrl
                    ? `<img class="cc-delivery-farm-logo" src="${CC.escapeHtml(farm.logoUrl)}" alt="${farmName} logo" />`
                    : `<div class="cc-delivery-farm-logo cc-delivery-farm-logo--fallback">${farmName.charAt(0)}</div>`
                }
              </div>

              <div class="flex-grow-1 min-w-0">
                <div class="d-flex align-items-start justify-content-between gap-2">
                  <div>
                    <div class="fw-semibold">${farmName}</div>
                    <div class="small text-muted">${farmLocation}</div>
                    <div class="small text-muted">Radius: ${CC.escapeHtml(radiusLabel)}</div>
                  </div>

                  <div class="form-check form-switch ms-2">
                    <input
                      class="form-check-input js-farm-visible-toggle"
                      type="checkbox"
                      role="switch"
                      data-farm-id="${farmId}"
                      ${checked}
                    />
                  </div>
                </div>

                <div class="mt-2 d-flex flex-wrap gap-2">
                  ${renderRangeBadge(farm)}
                  ${
                    farm.geocodeStatus === "failed"
                      ? `<span class="badge text-bg-warning">Location unresolved</span>`
                      : ``
                  }
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  /* ==========================================================================
   * POPUPS
   * ========================================================================== */

  /**
   * Farm popup HTML.
   * @param {object} farm
   * @returns {string}
   */
  function buildFarmPopupHtml(farm) {
    const distanceText =
      Number.isFinite(Number(farm.distanceMiles))
        ? `${farm.distanceMiles.toFixed(2)} miles from selected customer`
        : "Distance unavailable";

    return `
      <div class="cc-delivery-popup">
        <div class="fw-bold mb-1">${CC.escapeHtml(farm.name)}</div>
        <div class="small text-muted mb-1">${CC.escapeHtml(farm.location || "Location unavailable")}</div>
        <div class="small mb-1">Delivery radius: ${CC.escapeHtml(String(farm.deliveryRadiusMiles))} miles</div>
        ${
          selectedCustomerPoint
            ? `<div class="small ${farm.inRange ? "text-success" : "text-danger"}">${CC.escapeHtml(distanceText)}${farm.inRange ? " • In range" : " • Out of range"}</div>`
            : `<div class="small text-muted">Select a customer address to test coverage.</div>`
        }
      </div>
    `;
  }

  /**
   * Customer popup HTML.
   * @returns {string}
   */
  function buildCustomerPopupHtml() {
    if (!selectedCustomerAddress) return `<div class="small text-muted">No customer selected.</div>`;

    const customerName = CC.escapeHtml(Delivery.getCustomerLabel(selectedCustomerAddress));
    const addressLine = CC.escapeHtml(Delivery.formatAddress(selectedCustomerAddress) || "Saved address");
    const inRangeFarms = allFarms.filter((farm) => farm.inRange).map((farm) => farm.name);

    return `
      <div class="cc-delivery-popup">
        <div class="fw-bold mb-1">${customerName}</div>
        <div class="small text-muted mb-2">${addressLine}</div>
        ${
          inRangeFarms.length
            ? `<div class="small text-success">Inside: ${CC.escapeHtml(inRangeFarms.join(", "))}</div>`
            : `<div class="small text-danger">Not inside any currently loaded farm delivery radius.</div>`
        }
      </div>
    `;
  }

  /* ==========================================================================
   * MAP RENDER
   * ========================================================================== */

  /**
   * Clear only farm layers, not the entire map.
   */
  function clearFarmLayers() {
    for (const marker of farmMarkerById.values()) {
      map?.removeLayer(marker);
    }
    for (const circle of farmRadiusById.values()) {
      map?.removeLayer(circle);
    }
    farmMarkerById.clear();
    farmRadiusById.clear();
  }

  /**
   * Render farm markers + circles from current state/toggles.
   */
  function renderFarmLayers() {
    if (!map || !window.L) return;

    clearFarmLayers();

    const showPins = !!showFarmPinsToggle?.checked;
    const showRadii = !!showFarmRadiusToggle?.checked;

    for (const farm of allFarms) {
      if (farm.visible === false) continue;
      if (!Number.isFinite(Number(farm.lat)) || !Number.isFinite(Number(farm.lng))) continue;

      const latLng = [Number(farm.lat), Number(farm.lng)];

      if (showPins) {
        const marker = L.marker(latLng, {
          icon: createFarmIcon(farm),
          title: farm.name,
        }).bindPopup(buildFarmPopupHtml(farm));

        marker.addTo(map);
        farmMarkerById.set(String(farm.id), marker);
      }

      if (showRadii) {
        const circle = L.circle(latLng, {
          radius: Number(farm.deliveryRadiusMiles || 0) * 1609.34,
          color: farm.color || "#1e5b38",
          weight: 2,
          fillColor: farm.color || "#1e5b38",
          fillOpacity: 0.12,
        }).bindPopup(buildFarmPopupHtml(farm));

        circle.addTo(map);
        farmRadiusById.set(String(farm.id), circle);
      }
    }
  }

  /**
   * Render / rerender selected customer marker.
   */
  function renderCustomerLayer() {
    if (!map || !window.L) return;

    if (customerMarker) {
      map.removeLayer(customerMarker);
      customerMarker = null;
    }

    const shouldShow = !!showCustomerPinToggle?.checked;
    if (!shouldShow) return;
    if (!selectedCustomerPoint?.lat || !selectedCustomerPoint?.lng) return;

    customerMarker = L.marker(
      [Number(selectedCustomerPoint.lat), Number(selectedCustomerPoint.lng)],
      {
        icon: createCustomerIcon(),
        title: "Selected customer address",
      },
    ).bindPopup(buildCustomerPopupHtml());

    customerMarker.addTo(map);
  }

  /**
   * Render the shared overall coverage overlay.
   */
  function renderOverallCoverageLayer() {
    if (!map || !window.L) return;

    if (overallCoverageCircle) {
      map.removeLayer(overallCoverageCircle);
      overallCoverageCircle = null;
    }

    if (!overallRadiusToggle?.checked) return;

    const summary = Delivery.getOverallCoverageSummary(allFarms);
    if (!summary) return;

    overallCoverageCircle = L.circle([summary.lat, summary.lng], {
      radius: Number(summary.radiusMiles) * 1609.34,
      color: "#0d6efd",
      weight: 2,
      dashArray: "8 6",
      fillColor: "#0d6efd",
      fillOpacity: 0.05,
    }).bindPopup(`
      <div class="cc-delivery-popup">
        <div class="fw-bold mb-1">Overall Average Radius</div>
        <div class="small text-muted">
          Approx. center of visible farms with an average radius of ${summary.radiusMiles.toFixed(1)} miles.
        </div>
      </div>
    `);

    overallCoverageCircle.addTo(map);
  }

  /**
   * Full view rerender after state changes.
   */
  function rerenderAll() {
    refreshFarmCoverageState();
    renderFarmToggleList();
    renderFarmLayers();
    renderCustomerLayer();
    renderOverallCoverageLayer();
    fitMapToContent();
  }

  /* ==========================================================================
   * ADDRESS OPTIONS
   * ========================================================================== */

  /**
   * Build the address dropdown options.
   * Right now we support the saved local address cache used elsewhere.
   * This is intentionally structured so additional address sources can be added later.
   */
  function loadAddressOptions() {
    if (!addressSelectEl) return;

    const options = [];
    const localAddress = Delivery.getSavedLocalAddress();

    if (localAddress) {
      options.push({
        id: "local-default",
        label: Delivery.formatAddress(localAddress) || "Saved device address",
        value: localAddress,
      });
    }

    if (!options.length) {
      addressSelectEl.innerHTML = `<option value="">No saved address found</option>`;
      if (anonNoticeEl) {
        anonNoticeEl.classList.remove("d-none");
      }
      return;
    }

    addressSelectEl.innerHTML = `
      <option value="">Select an address</option>
      ${options
        .map(
          (opt, index) =>
            `<option value="${CC.escapeHtml(String(index))}">${CC.escapeHtml(opt.label)}</option>`,
        )
        .join("")}
    `;

    addressSelectEl._ccOptions = options;

    // If logged in or we at least have a local address, the warning can stay but is less urgent.
    if (anonNoticeEl && options.length) {
      anonNoticeEl.classList.toggle("d-none", false);
    }
  }

  /**
   * Resolve the currently selected address option.
   * @returns {object|null}
   */
  function getSelectedAddressOption() {
    const idx = String(addressSelectEl?.value || "");
    const options = addressSelectEl?._ccOptions || [];
    if (idx === "") return null;

    const picked = options[Number(idx)];
    return picked?.value || null;
  }

  /* ==========================================================================
   * DATA LOADING
   * ========================================================================== */

  /**
   * Load farms, resolve coordinates, assign colors, and render.
   */
  async function loadFarms() {
    if (farmToggleList) {
      farmToggleList.innerHTML = `<div class="small text-muted">Loading farms…</div>`;
    }

    let farms = await Delivery.getNormalizedFarms();
    farms = await Delivery.resolveFarmCoordinates(farms);
    farms = Delivery.assignFarmColors(farms);

    allFarms = farms;
    rerenderAll();
  }

  /* ==========================================================================
   * EVENTS
   * ========================================================================== */

  /**
   * Show selected address on map.
   */
  async function handleUseSelectedAddress() {
    const address = getSelectedAddressOption();
    if (!address) return;

    const geocoded = await Delivery.geocodeAddressWithFallback(address);
    if (!geocoded) {
      window.alert(
        "No Address Saved please set a preferred address in the accounts page.",
      );
      return;
    }

    selectedCustomerAddress = address;
    selectedCustomerPoint = {
      lat: Number(geocoded.lat),
      lng: Number(geocoded.lng),
      label: geocoded.label,
      matchedBy: geocoded.matchedBy,
    };

    rerenderAll();

    if (customerMarker) {
      customerMarker.openPopup();
    }
  }

  /**
   * Clear customer pin + coverage status.
   */
  function handleClearCustomerPin() {
    selectedCustomerAddress = null;
    selectedCustomerPoint = null;
    rerenderAll();
  }

  /**
   * Wire all DOM events.
   */
  function wireEvents() {
    useSelectedAddressBtn?.addEventListener("click", handleUseSelectedAddress);
    clearCustomerPinBtn?.addEventListener("click", handleClearCustomerPin);

    farmSearchInput?.addEventListener("input", renderFarmToggleList);
    farmSearchInput?.addEventListener("input", () => {
      renderFarmLayers();
      renderOverallCoverageLayer();
    });

    farmVisibilityFilter?.addEventListener("change", () => {
      renderFarmToggleList();
      renderFarmLayers();
      renderOverallCoverageLayer();
      fitMapToContent();
    });

    showAllFarmsBtn?.addEventListener("click", () => {
      allFarms = allFarms.map((farm) => ({ ...farm, visible: true }));
      rerenderAll();
    });

    hideAllFarmsBtn?.addEventListener("click", () => {
      allFarms = allFarms.map((farm) => ({ ...farm, visible: false }));
      rerenderAll();
    });

    resetFarmFiltersBtn?.addEventListener("click", () => {
      if (farmSearchInput) farmSearchInput.value = "";
      if (farmVisibilityFilter) farmVisibilityFilter.value = "all";
      allFarms = allFarms.map((farm) => ({ ...farm, visible: true }));
      rerenderAll();
    });

    showFarmPinsToggle?.addEventListener("change", renderFarmLayers);
    showFarmRadiusToggle?.addEventListener("change", renderFarmLayers);
    showCustomerPinToggle?.addEventListener("change", renderCustomerLayer);
    overallRadiusToggle?.addEventListener("change", renderOverallCoverageLayer);

    farmToggleList?.addEventListener("change", (event) => {
      const input = event.target?.closest?.(".js-farm-visible-toggle");
      if (!input) return;

      const farmId = String(input.getAttribute("data-farm-id") || "");
      allFarms = allFarms.map((farm) =>
        String(farm.id) === farmId
          ? { ...farm, visible: !!input.checked }
          : farm,
      );

      rerenderAll();
    });
  }

  /* ==========================================================================
   * BOOT
   * ========================================================================== */

  async function boot() {
    try {
      initMap();
      loadAddressOptions();
      wireEvents();
      await loadFarms();
    } catch (err) {
      console.error("delivery-radius.js init failed:", err);
      if (farmToggleList) {
        farmToggleList.innerHTML = `
          <div class="alert alert-danger mb-0">
            Delivery map failed to initialize.
          </div>
        `;
      }
    }
  }

  CC.onReady(boot);
})();