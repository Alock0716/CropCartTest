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
      CUSTOMER_PATH: "auth/profile/", // update this once the finalized API route is ready

      ENABLE_DELIVERY_TEST_DEFAULTS: Boolean(cfg.ENABLE_DELIVERY_TEST_DEFAULTS),
      TEST_FARM_LAT: Number(cfg.TEST_FARM_LAT),
      TEST_FARM_LONG: Number(cfg.TEST_FARM_LONG),
      TEST_CUSTOMER_LAT: Number(cfg.TEST_CUSTOMER_LAT),
      TEST_CUSTOMER_LONG: Number(cfg.TEST_CUSTOMER_LONG),
      TEST_DELIVERY_ADDRESS: String(cfg.TEST_DELIVERY_ADDRESS),
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
      console.error(
        "delivery-radius: customer object missing. Expected CC.auth.getAuth().user"
      );
      return { ok: false, missing: ["user object"], customer: null };
    }

    let preferredDeliveryAddress = String(
      rawCustomer.preferred_delivery_address || ""
    ).trim();

    let lat = Number(rawCustomer.lat);
    let lng = Number(rawCustomer.lng);

    const hasLat = isFiniteCoord(lat);
    const hasLng = isFiniteCoord(lng);

    

    if ((!hasLat || !hasLng || !preferredDeliveryAddress) && config.ENABLE_DELIVERY_TEST_DEFAULTS) {
      lat = config.TEST_CUSTOMER_LAT;
      lng = config.TEST_CUSTOMER_LONG;
      preferredDeliveryAddress = config.TEST_DELIVERY_ADDRESS;

      console.warn(
        "delivery-radius: customer lat/lng missing. Using TEST_CUSTOMER coordinates from config.",
        rawCustomer
      );
    } else {
      if (!hasLat) missing.push("lat");
      if (!hasLng) missing.push("lng");
      if (!preferredDeliveryAddress) missing.push("preferred_delivery_address");
    }
    
    
    
    return {
      ok: missing.length === 0,
      missing,
      customer: {
        id: rawCustomer.id,
        username: rawCustomer.username,
        preferred_delivery_address: preferredDeliveryAddress,
        lat,
        lng
      }
    };
  }

  function validateFarm(rawFarm, index = 0) {
    const config = getDeliveryConfig();
    const missing = [];

    if (!rawFarm || typeof rawFarm !== "object") {
      console.error(
        `delivery-radius: farm index ${index} invalid. Expected farm object.`,
        rawFarm
      );
      return null;
    }

    const name = String(rawFarm.name || "").trim();
    const location = String(rawFarm.farm_location || "").trim();
    const logo = String(rawFarm.logo_url || "").trim();

    if (!name) missing.push("name");
    if (!location) missing.push("farm_location");
    if (!logo) missing.push("logo_url");

    let lat = Number(rawFarm.lat);
    let lng = Number(rawFarm.lng);

    const hasLat = isFiniteCoord(lat);
    const hasLng = isFiniteCoord(lng);

    if ((!hasLat || !hasLng) && config.ENABLE_DELIVERY_TEST_DEFAULTS) {
      lat = config.TEST_FARM_LAT;
      lng = config.TEST_FARM_LONG;

      console.warn(
        `delivery-radius: farm "${name}" missing lat/lng. Using TEST_FARM coordinates.`,
        rawFarm
      );
    } else {
      if (!hasLat) missing.push("lat");
      if (!hasLng) missing.push("lng");
    }

    if (missing.length) {
      missing.forEach(field => {
        console.error(
          `delivery-radius: farm "${name}" missing field "${field}".`,
          rawFarm
        );
      });
      return null;
    }

    return {
      id: rawFarm.id,
      name,
      farm_location: location,
      lat,
      lng,
      logo_url: logo
    };
  }

    /**
   * Read the currently logged-in user's delivery data from auth.
   *
   * Expected future auth shape:
   * {
   *   access,
   *   refresh,
   *   user: {
   *     id,
   *     username,
   *     email,
   *     role,
   *     preferred_delivery_address,
   *     lat,
   *     lng
   *   }
   * }
   *
   * @returns {object|null}
   */
  function getCustomerFromAuth() {
    const auth = CC.auth?.getAuth?.();
    const user = auth?.user;

    if (!user || typeof user !== "object") {
      console.error(
        "delivery-radius: auth user data missing. Expected CC.auth.getAuth().user to exist.",
        auth,
      );
      return null;
    }

    return {
      id: user.id,
      username: String(user.username || "").trim(),
      email: String(user.email || "").trim(),
      role: String(user.role || "").trim(),
      preferred_delivery_address: String(
        user.preferred_delivery_address || "",
      ).trim(),
      lat: Number(user.lat),
      lng: Number(user.lng),
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
    getCustomerFromAuth,
  };
})();