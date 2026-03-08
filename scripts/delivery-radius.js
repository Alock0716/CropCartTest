(function initDeliveryRadiusPage() {
  "use strict";

  const CC = window.CC;
  const delivery = CC?.delivery;

  if (!CC || !delivery) {
    console.warn(
      "delivery-radius.js: required helpers missing. Make sure config.js, utils.js, and delivery-shared.js are loaded first.",
    );
    return;
  }

  const statusEl = document.getElementById("deliveryPageStatus");
  const mapEl = document.getElementById("deliveryMap");

  const hqAddressTextEl = document.getElementById("hqAddressText");
  const customerAddressTextEl = document.getElementById("customerAddressText");
  const deliveryRangeTextEl = document.getElementById("deliveryRangeText");

  const toggleHqMarkerEl = document.getElementById("toggleHqMarker");
  const toggleHqRadiusEl = document.getElementById("toggleHqRadius");
  const toggleCustomerMarkerEl = document.getElementById("toggleCustomerMarker");
  const toggleFarmMarkersEl = document.getElementById("toggleFarmMarkers");

  let map = null;

  const layers = {
    hqMarker: null,
    hqRadius: null,
    customerMarker: null,
    farmMarkers: L.layerGroup(),
  };

  function setPageStatus(message, kind = "muted") {
    CC.setStatus(statusEl, message, kind);
  }

  async function apiGetFarms() {
    return CC.apiRequest(CC.delivery.getDeliveryConfig().FARMS_PATH, {
      method: "GET",
    });
  }

  function initMap(hq, customer, farms) {
    const centerLat = customer?.lat ?? hq.lat;
    const centerLng = customer?.lng ?? hq.lng;

    map = L.map(mapEl, {
      zoomControl: true,
      scrollWheelZoom: true,
    }).setView([centerLat, centerLng], 10);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    renderHq(hq);
    renderCustomer(customer, hq);
    renderFarms(farms);

    fitBoundsToData(hq, customer, farms);
    bindLayerToggles();
  }

  function renderHq(hq) {
    const hqIcon = delivery.buildImageIcon("./Images/CClogo1.png", 46, "cc-map-pin--hq");

    layers.hqMarker = L.marker([hq.lat, hq.lng], { icon: hqIcon }).bindPopup(`
      <div class="cc-map-popup">
        <div class="fw-semibold mb-1">CropCart HQ</div>
        <div><strong>Delivery Radius:</strong> ${CC.escapeHtml(String(hq.deliveryRange))} miles</div>
        <div>${CC.escapeHtml(hq.address)}</div>
      </div>
    `);

    layers.hqRadius = L.circle([hq.lat, hq.lng], {
      radius: delivery.milesToMeters(hq.deliveryRange),
      color: "#1e5b38",
      weight: 2,
      opacity: 0.9,
      fillColor: "#2f7a4d",
      fillOpacity: 0.12,
    });

    if (toggleHqMarkerEl?.checked) layers.hqMarker.addTo(map);
    if (toggleHqRadiusEl?.checked) layers.hqRadius.addTo(map);
  }

  function renderCustomer(customer, hq) {
    if (!customer) return;

    const distanceFromHq = delivery.milesBetween(
      hq.lat,
      hq.lng,
      customer.lat,
      customer.lng,
    );

    const isInRange = distanceFromHq <= hq.deliveryRange;

    layers.customerMarker = L.marker([customer.lat, customer.lng], {
      icon: L.divIcon({
        className: "cc-customer-pin-wrap",
        html: `
          <div class="cc-customer-pin">
            <i class="bi bi-geo-alt-fill"></i>
          </div>
        `,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -10],
      }),
    }).bindPopup(`
      <div class="cc-map-popup">
        <div class="fw-semibold mb-1">${CC.escapeHtml(customer.username || "Customer")}</div>
        <div>${CC.escapeHtml(customer.preferred_delivery_address)}</div>
        <div><strong>In Range:</strong> ${isInRange ? "Yes" : "No"}</div>
        <div><strong>Distance From HQ:</strong> ${distanceFromHq.toFixed(2)} miles</div>
      </div>
    `);

    if (toggleCustomerMarkerEl?.checked) {
      layers.customerMarker.addTo(map);
    }
  }

  function renderFarms(farms) {
    layers.farmMarkers.clearLayers();

    farms.forEach((farm) => {
      const icon = delivery.buildImageIcon(farm.logo_url, 42, "cc-map-pin--farm");

      const marker = L.marker([farm.lat, farm.lng], { icon }).bindPopup(
        delivery.farmPopupHtml(farm),
      );

      layers.farmMarkers.addLayer(marker);
    });

    if (toggleFarmMarkersEl?.checked) {
      layers.farmMarkers.addTo(map);
    }
  }

  function fitBoundsToData(hq, customer, farms) {
    const points = [[hq.lat, hq.lng]];

    if (customer) points.push([customer.lat, customer.lng]);

    farms.forEach((farm) => {
      points.push([farm.lat, farm.lng]);
    });

    if (points.length === 1) {
      map.setView(points[0], 11);
      return;
    }

    map.fitBounds(points, { padding: [30, 30] });
  }

  function bindLayerToggles() {
    toggleHqMarkerEl?.addEventListener("change", () => {
      if (!layers.hqMarker) return;
      if (toggleHqMarkerEl.checked) layers.hqMarker.addTo(map);
      else map.removeLayer(layers.hqMarker);
    });

    toggleHqRadiusEl?.addEventListener("change", () => {
      if (!layers.hqRadius) return;
      if (toggleHqRadiusEl.checked) layers.hqRadius.addTo(map);
      else map.removeLayer(layers.hqRadius);
    });

    toggleCustomerMarkerEl?.addEventListener("change", () => {
      if (!layers.customerMarker) return;
      if (toggleCustomerMarkerEl.checked) layers.customerMarker.addTo(map);
      else map.removeLayer(layers.customerMarker);
    });

    toggleFarmMarkersEl?.addEventListener("change", () => {
      if (toggleFarmMarkersEl.checked) layers.farmMarkers.addTo(map);
      else map.removeLayer(layers.farmMarkers);
    });
  }

  async function init() {
    const config = delivery.getDeliveryConfig();
    const hqCheck = delivery.validateHq(config);

    hqAddressTextEl.textContent = config.HQ_ADDRESS || "—";
    deliveryRangeTextEl.textContent = Number.isFinite(config.DELIVERY_RANGE)
      ? `${config.DELIVERY_RANGE} miles`
      : "—";

    if (!hqCheck.ok) {
      const message = `Missing HQ config: ${hqCheck.missing.join(", ")}`;
      console.error(
        "delivery-radius: HQ configuration invalid. Expected HQ_ADDRESS, HQ_LAT, HQ_LONG, and DELIVERY_RANGE in config.js.",
      );
      setPageStatus(message, "danger");
      customerAddressTextEl.textContent = "Unable to load until HQ config is fixed.";
      return;
    }

        setPageStatus("Loading farms and customer location…", "muted");

    const farmsRes = await apiGetFarms();

    if (!farmsRes.ok) {
      console.error(
        "delivery-radius: failed to load farms. Expected GET /farms/ to return an array of farm records.",
        farmsRes,
      );
    }

    const rawFarms = Array.isArray(farmsRes.data) ? farmsRes.data : [];
    const validatedFarms = rawFarms
      .map((farm, index) => delivery.validateFarm(farm, index))
      .filter(Boolean);

    const customerRecord = delivery.getCustomerFromAuth();
    const customerCheck = delivery.validateCustomer(customerRecord);

    if (!customerCheck.ok) {
      const message = `Missing customer data: ${customerCheck.missing.join(", ")}`;
      console.error(
        "delivery-radius: customer data invalid. Expected preferred_delivery_address, lat, and long on the customer record.",
        customerRecord,
      );
      setPageStatus(message, "danger");
      customerAddressTextEl.textContent = "Customer delivery data is missing.";
      return;
    }

    customerAddressTextEl.textContent =
      customerCheck.customer.preferred_delivery_address;

    initMap(hqCheck.hq, customerCheck.customer, validatedFarms);

    setPageStatus(
      `Loaded ${validatedFarms.length} farm marker${validatedFarms.length === 1 ? "" : "s"}.`,
      "success",
    );
  }

  CC.onReady(init);
})();