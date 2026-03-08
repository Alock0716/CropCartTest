(function initDeliveryShared() {
  "use strict";

  const CC = window.CC;
  if (!CC) {
    console.warn(
      "delivery-shared.js: window.CC not found. Make sure utils.js is loaded first.",
    );
    return;
  }

  function getDeliveryConfig() {
    const cfg = window.__CROPCART_CONFIG__ || {};

    return {
      DELIVERY_RANGE: Number(cfg.DELIVERY_RANGE),
      HQ_ADDRESS: String(cfg.HQ_ADDRESS || "").trim(),
      HQ_LAT: Number(cfg.HQ_LAT),
      HQ_LONG: Number(cfg.HQ_LONG),
      HQ_ICON_URL: "./Images/CClogo1.png",
      FARMS_PATH: "/farms/",
      CUSTOMER_PATH: "auth/profile/delivery-address/", // update this once the finalized API route is ready

      ENABLE_DELIVERY_TEST_DEFAULTS: Boolean(cfg.ENABLE_DELIVERY_TEST_DEFAULTS),
      TEST_FARM_LAT: Number(cfg.TEST_FARM_LAT),
      TEST_FARM_LONG: Number(cfg.TEST_FARM_LONG),
      TEST_CUSTOMER_LAT: Number(cfg.TEST_CUSTOMER_LAT),
      TEST_CUSTOMER_LONG: Number(cfg.TEST_CUSTOMER_LONG),
    };
  }

  function isFiniteCoord(value) {
    return Number.isFinite(Number(value));
  }

  function escape(input) {
    return CC.escapeHtml(String(input ?? ""));
  }

  function milesBetween(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadiusMiles = 3958.7613;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusMiles * c;
  }

  function milesToMeters(miles) {
    return Number(miles) * 1609.344;
  }

  function buildImageIcon(url, size = 42, className = "") {
    return L.divIcon({
      className: `cc-map-pin-wrap ${className}`.trim(),
      html: `
        <div class="cc-map-pin" style="width:${size}px;height:${size}px;">
          <img src="${escape(url)}" alt="" width="${size}" height="${size}" />
        </div>
      `,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -8],
    });
  }

  function validateHq(config) {
    const missing = [];

    if (!config.HQ_ADDRESS) missing.push("HQ_ADDRESS");
    if (!isFiniteCoord(config.HQ_LAT)) missing.push("HQ_LAT");
    if (!isFiniteCoord(config.HQ_LONG)) missing.push("HQ_LONG");
    if (!Number.isFinite(config.DELIVERY_RANGE)) missing.push("DELIVERY_RANGE");

    return {
      ok: missing.length === 0,
      missing,
      hq: {
        address: config.HQ_ADDRESS,
        lat: config.HQ_LAT,
        lng: config.HQ_LONG,
        deliveryRange: config.DELIVERY_RANGE,
      },
    };
  }

  function validateCustomer(rawCustomer) {
    const config = getDeliveryConfig();
    const missing = [];

    if (!rawCustomer || typeof rawCustomer !== "object") {
      return {
        ok: false,
        missing: [
          "customer object",
          "preferred_delivery_address",
          "lat",
          "lng",
        ],
        customer: null,
      };
    }

    const preferredDeliveryAddress = String(
      rawCustomer.preferred_delivery_address || "",
    ).trim();

    const hasLat = isFiniteCoord(rawCustomer.lat);
    const hasLng = isFiniteCoord(rawCustomer.lng);

    let lat = Number(rawCustomer.lat);
    let lng = Number(rawCustomer.lng);

    if (!preferredDeliveryAddress) {
      missing.push("preferred_delivery_address");
    }

    if ((!hasLat || !hasLng) && config.ENABLE_DELIVERY_TEST_DEFAULTS) {
      lat = config.TEST_CUSTOMER_LAT;
      lng = config.TEST_CUSTOMER_LONG;

      console.warn(
        'delivery-radius: customer lat/lng missing. Using test default coordinates from config. Expected customer.lat and customer.lng.',
        rawCustomer,
      );
    } else {
      if (!hasLat) missing.push("lat");
      if (!hasLng) missing.push("lng");
    }

    return {
      ok: missing.length === 0,
      missing,
      customer: {
        preferred_delivery_address: preferredDeliveryAddress,
        lat,
        lng,
      },
    };
  }

  function validateFarm(rawFarm, index = 0) {
    const config = getDeliveryConfig();
    const missing = [];

    if (!rawFarm || typeof rawFarm !== "object") {
      console.error(
        `delivery-radius: farm at index ${index} is missing. Expected an object with id, name, farm_location, lat, lng, logo_url.`,
      );
      return null;
    }

    if (rawFarm.id === undefined || rawFarm.id === null || rawFarm.id === "") {
      missing.push("id");
    }

    const name = String(rawFarm.name || "").trim();
    const farmLocation = String(rawFarm.farm_location || "").trim();
    const logoUrl = String(rawFarm.logo_url || "").trim();

    if (!name) missing.push("name");
    if (!farmLocation) missing.push("farm_location");
    if (!logoUrl) missing.push("logo_url");

    const hasLat = isFiniteCoord(rawFarm.lat);
    const hasLng = isFiniteCoord(rawFarm.lng);

    let lat = Number(rawFarm.lat);
    let lng = Number(rawFarm.lng);

    if ((!hasLat || !hasLng) && config.ENABLE_DELIVERY_TEST_DEFAULTS) {
      lat = config.TEST_FARM_LAT;
      lng = config.TEST_FARM_LONG;

      console.warn(
        `delivery-radius: farm "${name || `[index ${index}]`}" is missing lat/lng. Using test default farm coordinates from config. Expected farm.lat and farm.lng.`,
        rawFarm,
      );
    } else {
      if (!hasLat) missing.push("lat");
      if (!hasLng) missing.push("lng");
    }

    if (missing.length) {
      missing.forEach((fieldName) => {
        console.error(
          `delivery-radius: farm data missing "${fieldName}". Expected farm.${fieldName} to exist. Skipping farm record:`,
          rawFarm,
        );
      });
      return null;
    }

    return {
      id: rawFarm.id,
      name,
      farm_location: farmLocation,
      lat,
      lng,
      logo_url: logoUrl,
      delivery_radius: Number(rawFarm.delivery_radius),
    };
  }

  function farmPopupHtml(farm) {
    return `
      <div class="cc-map-popup">
        <div class="fw-semibold mb-1">${escape(farm.name)}</div>
        <div>${escape(farm.farm_location)}</div>
      </div>
    `;
  }

  window.CC = window.CC || {};
  window.CC.delivery = {
    getDeliveryConfig,
    validateHq,
    validateCustomer,
    validateFarm,
    milesBetween,
    milesToMeters,
    buildImageIcon,
    farmPopupHtml,
  };
})();