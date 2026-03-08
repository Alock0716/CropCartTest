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

    if (!String(rawCustomer.preferred_delivery_address || "").trim()) {
      missing.push("preferred_delivery_address");
    }
    if (!isFiniteCoord(rawCustomer.lat)) missing.push("lat");
    if (!isFiniteCoord(rawCustomer.lng)) missing.push("lng");

    return {
      ok: missing.length === 0,
      missing,
      customer: {
        preferred_delivery_address: String(
          rawCustomer.preferred_delivery_address || "",
        ).trim(),
        lat: Number(rawCustomer.lat),
        lng: Number(rawCustomer.lng),
      },
    };
  }

  function validateFarm(rawFarm, index = 0) {
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
    if (!String(rawFarm.name || "").trim()) missing.push("name");
    if (!String(rawFarm.farm_location || "").trim()) missing.push("farm_location");
    if (!isFiniteCoord(rawFarm.lat)) missing.push("lat");
    if (!isFiniteCoord(rawFarm.lng)) missing.push("lng");
    if (!String(rawFarm.logo_url || "").trim()) missing.push("logo_url");

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
      name: String(rawFarm.name).trim(),
      farm_location: String(rawFarm.farm_location).trim(),
      lat: Number(rawFarm.lat),
      lng: Number(rawFarm.lng),
      logo_url: String(rawFarm.logo_url).trim(),
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