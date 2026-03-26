/**
 * ============================================================================
 * account.js — Account page behavior (API integrated where possible)
 * ----------------------------------------------------------------------------
 * What it does:
 * - Shows user info from CC.auth (username/email) + optional first/last
 * - Finds a “default delivery address” from:
 *    1) localStorage override (cc_saved_address_v1)
 *    2) newest order (GET /api/orders/) since the API stores address on orders
 * - Shows favorites (tries GET /favorites/ — fails gracefully if API differs)
 * - Shows provider-owned farm if detectable from GET /farms/
 * - Password “change” is done via reset email (POST /api/auth/password-reset/)
 * - Delete account button exists, but endpoint may not be supported (fails gracefully)
 *
 * NOTE:
 * - Logic preserved from project source.
 * - Inline styles in injected HTML were replaced with CSS classes (no behavior change).
 * ============================================================================
 */

(function initAccountPage() {
  "use strict";

  const CC = window.CC;

  const ROOT_BASE = String(String(CC.API_URL).replace(/\/api$/i, ""));

  // ===========================================================================
  // DOM
  // ===========================================================================

  const pageStatusEl = document.getElementById("pageStatus");

  // Profile
  const profileForm = document.getElementById("accountProfileForm");
  const accUsernameEl = document.getElementById("accUsername");
  const accEmailEl = document.getElementById("accEmail");
  const accFirstEl = document.getElementById("accFirst");
  const accLastEl = document.getElementById("accLast");
  const saveProfileBtn = document.getElementById("saveProfileBtn");
  const resetProfileBtn = document.getElementById("resetProfileBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  // Change Email
  const changeEmailForm = document.getElementById("changeEmailForm");
  const openChangeEmailBtn = document.getElementById("openChangeEmailBtn");
  const newEmailEl = document.getElementById("newEmail");
  const confirmPasswordEl = document.getElementById("confirmPassword");
  const changeEmailStatusEl = document.getElementById("changeEmailStatus");
  const saveEmailBtn = document.getElementById("saveEmailBtn");

  // Address
  const addressSummaryEl = document.getElementById("addressSummary");
  const addressForm = document.getElementById("addressForm");
  const addressModalStatusEl = document.getElementById("addressModalStatus");
  const addrLine1El = document.getElementById("addrLine1");
  const addrCityEl = document.getElementById("addrCity");
  const addrStateEl = document.getElementById("addrState");
  const addrZipEl = document.getElementById("addrZip");
  const deliveryAddressBadgeEl = document.getElementById(
    "deliveryAddressBadge",
  );
  const deliveryAddressBadgeNoteEl = document.getElementById(
    "deliveryAddressBadgeNote",
  );

  // Favorites
  const refreshFavoritesBtn = document.getElementById("refreshFavoritesBtn");
  const favoritesListEl = document.getElementById("favoritesList");
  const favoritesNoteEl = document.getElementById("favoritesNote");

  // Provider
  const providerBoxEl = document.getElementById("providerBox");
  const stripeBoxEl = document.getElementById("stripeBox");
  const providerSectionEl = document.getElementById("providerSection");
  const accountFarmerNavItemEl = document.getElementById(
    "accountFarmerNavItem",
  );

  // Security
  const passwordResetForm = document.getElementById("passwordResetForm");
  const resetEmailEl = document.getElementById("resetEmail");
  const sendResetBtn = document.getElementById("sendResetBtn");
  const securityStatusEl = document.getElementById("securityStatus");

  // Danger
  const deleteAccountBtn = document.getElementById("deleteAccountBtn");
  const dangerStatusEl = document.getElementById("dangerStatus");

  // ===========================================================================
  // Local keys
  // ===========================================================================

  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";

  // ===========================================================================
  // Helpers
  // ===========================================================================
  /**
   * Check whether the signed-in account has the provider role.
   *
   * Uses the auth payload already cached by login/auth.js.
   * This matches the same role gate already used by page.js for farmer.html.
   *
   * @returns {boolean}
   */
  function isProviderAccount() {
    const auth = CC.auth?.getAuth?.();
    return auth?.user?.role === "provider";
  }

  /**
   * Show or hide provider-only UI on the account page.
   *
   * Affects:
   * - The Farmer Portal navbar link on account.html
   * - The owned-farm/provider info card on account.html
   */
  function syncProviderVisibility() {
    const showProviderUi = isProviderAccount();

    if (accountFarmerNavItemEl) {
      accountFarmerNavItemEl.classList.toggle("d-none", !showProviderUi);
    }

    if (providerSectionEl) {
      providerSectionEl.classList.toggle("d-none", !showProviderUi);
    }

    if (!showProviderUi && providerBoxEl) {
      providerBoxEl.innerHTML = "";
    }

    if (!showProviderUi && stripeBoxEl) {
      stripeBoxEl.textContent = "";
    }
  }

  /**
   * Favorites -> Shop handoff:
   * Store selected farm in sessionStorage so index.html can apply it even if
   * query params get stripped by hosting/routing.
   */
  function wireFavoriteShopHandoff() {
    if (!favoritesListEl) return;

    favoritesListEl.addEventListener("click", (e) => {
      const btn = e.target?.closest?.(".js-shop-farm");
      if (!btn) return;

      const farmName = String(btn.dataset.farm || "").trim();
      if (!farmName) return;

      sessionStorage.setItem("cc_store_prefarm", farmName);
      // allow navigation to continue normally
    });
  }

  wireFavoriteShopHandoff();

  /**
   * Attempt to update the user's email.
   *
   * NOTE: This endpoint is a best-guess because the provided API doc does not
   * clearly define an email-change route.
   *
   * If the backend uses something else, we’ll adjust this function to match.
   */
  async function apiChangeEmail(newEmail, currentPassword) {
    // Best-guess route. If your backend uses a different one, swap it here.
    return CC.apiRequest("/auth/change-email/", {
      method: "POST",
      json: {
        email: newEmail,
        password: currentPassword,
      },
    });
  }

  function setPageStatus(msg, kind = "muted") {
    CC.setStatus(pageStatusEl, msg, kind);
  }

  function setInlineStatus(el, msg, kind = "muted") {
    CC.setStatus(el, msg, kind);
  }

  function getLocalJson(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function setLocalJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function buildAddressString(addressObj) {
    if (!addressObj) return "";

    return [
      String(addressObj.address_line1 || "").trim(),
      String(addressObj.city || "").trim(),
      String(addressObj.state || "").trim(),
      String(addressObj.postal_code || "").trim(),
      String(addressObj.country || "US").trim(),
    ]
      .filter(Boolean)
      .join(", ");
  }

  /**
   * Geocode a delivery address into lat/lng using Nominatim.
   *
   * Returns:
   * {
   *   lat: number,
   *   lng: number,
   *   display_name: string
   * }
   */
  function normalizeZip(zip) {
    return String(zip || "")
      .trim()
      .replace(/[^\d-]/g, "")
      .slice(0, 10);
  }

  function normalizeState(state) {
    return String(state || "")
      .trim()
      .toUpperCase();
  }

  function normalizeCity(city) {
    return String(city || "").trim();
  }

  function normalizeStreet(street) {
    return String(street || "").trim();
  }

  function buildAddressString(addressObj) {
    if (!addressObj) return "";

    return [
      String(
        addressObj.address_line1 || addressObj.street_address || "",
      ).trim(),
      String(addressObj.city || "").trim(),
      String(addressObj.state || "").trim(),
      String(addressObj.postal_code || addressObj.zip || "").trim(),
      String(addressObj.country || "US").trim(),
    ]
      .filter(Boolean)
      .join(", ");
  }

  function buildLookupCandidates(addressObj) {
    const street = normalizeStreet(
      addressObj?.address_line1 || addressObj?.street_address || "",
    );
    const city = normalizeCity(addressObj?.city || "");
    const state = normalizeState(addressObj?.state || "");
    const zip = normalizeZip(addressObj?.postal_code || addressObj?.zip || "");
    const country = String(addressObj?.country || "US").trim();

    const whole = [street, city, state, zip, country]
      .filter(Boolean)
      .join(", ");

    return [
      {
        label: "street + zip",
        query: [street, zip, country].filter(Boolean).join(", "),
      },
      {
        label: "whole address",
        query: whole,
      },
      {
        label: "street + zip + state",
        query: [street, zip, state, country].filter(Boolean).join(", "),
      },
      {
        label: "street + zip + city",
        query: [street, zip, city, country].filter(Boolean).join(", "),
      },
      {
        label: "city + zip + state",
        query: [city, zip, state, country].filter(Boolean).join(", "),
      },
    ].filter((c) => c.query && c.query.replace(/[, ]/g, "").length >= 5);
  }

  async function runGeocodeQuery(query) {
    const url =
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "1",
        addressdetails: "1",
      }).toString();

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Geocoding failed (HTTP ${res.status})`);
    }

    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit) return null;

    const lat = Number(hit.lat);
    const lng = Number(hit.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return {
      lat,
      lng,
      display_name: String(hit.display_name || query).trim(),
    };
  }

  async function geocodeDeliveryAddress(addressObj) {
    if (
      Number.isFinite(Number(addressObj?.lat)) &&
      Number.isFinite(Number(addressObj?.lng))
    ) {
      return {
        lat: Number(addressObj.lat),
        lng: Number(addressObj.lng),
        display_name:
          String(addressObj.preferred_delivery_address || "").trim() ||
          buildAddressString(addressObj),
      };
    }

    const candidates = buildLookupCandidates(addressObj);

    if (!candidates.length) {
      throw new Error("Address is missing required fields.");
    }

    let lastHttpError = null;

    for (const candidate of candidates) {
      try {
        setInlineStatus(
          addressModalStatusEl,
          `Checking address lookup: ${candidate.label}…`,
          "muted",
        );

        const result = await runGeocodeQuery(candidate.query);
        if (result) {
          return result;
        }
      } catch (err) {
        lastHttpError = err;
      }
    }

    if (lastHttpError) {
      throw lastHttpError;
    }

    throw new Error(
      "Could not find coordinates for that address after trying multiple address formats.",
    );
  }

  /**
   * Push the user's saved delivery address + coordinates to the API.
   *
   * Uses the same best-guess multi-endpoint pattern already used on this page
   * for profile updates.
   */
  async function apiUpdateDeliveryAddress(addressPayload) {
    const payloadSnake = {
      preferred_delivery_address: addressPayload.preferred_delivery_address,
      address_line1: addressPayload.address_line1,
      city: addressPayload.city,
      state: addressPayload.state,
      postal_code: addressPayload.postal_code,
      country: addressPayload.country,
      lat: addressPayload.lat,
      lng: addressPayload.lng,
    };

    const payloadCamel = {
      preferredDeliveryAddress: addressPayload.preferred_delivery_address,
      addressLine1: addressPayload.address_line1,
      city: addressPayload.city,
      state: addressPayload.state,
      postalCode: addressPayload.postal_code,
      country: addressPayload.country,
      lat: addressPayload.lat,
      lng: addressPayload.lng,
    };

    const candidates = [
      {
        path: "/auth/profile/delivery-address/",
        method: "PATCH",
        json: payloadSnake,
      },
      {
        path: "/auth/profile/delivery-address/",
        method: "PATCH",
        json: payloadCamel,
      },
    ];

    let lastRes = null;

    for (const c of candidates) {
      const res = await CC.apiRequest(c.path, {
        method: c.method,
        json: c.json,
      });

      lastRes = res;

      if (res.status === 401) return res;
      if (res.status === 404) continue;

      if (res.status === 405) {
        const putRes = await CC.apiRequest(c.path, {
          method: "PUT",
          json: c.json,
        });

        lastRes = putRes;

        if (putRes.status === 401) return putRes;
        if (putRes.status === 404) continue;
        if (putRes.ok) return putRes;

        continue;
      }

      if (res.ok) return res;
    }

    return lastRes || { ok: false, status: 0, data: null, raw: "No response" };
  }

  function syncAddressIntoAuthCache(addressPayload) {
    try {
      const auth = CC.auth?.getAuth?.();
      if (!auth || typeof auth !== "object") return;

      const nextAuth = { ...auth };

      if (nextAuth.user && typeof nextAuth.user === "object") {
        nextAuth.user = {
          ...nextAuth.user,
          preferred_delivery_address: addressPayload.preferred_delivery_address,
          lat: addressPayload.lat,
          lng: addressPayload.lng,
        };
      } else {
        nextAuth.preferred_delivery_address =
          addressPayload.preferred_delivery_address;
        nextAuth.lat = addressPayload.lat;
        nextAuth.lng = addressPayload.lng;
      }

      if (typeof CC.auth.setAuth === "function") {
        CC.auth.setAuth(nextAuth);
      }
    } catch {
      // best effort only
    }
  }

  function pickUserFromAuth(auth) {
    // Your auth payload can vary — this tries common shapes without crashing.
    const u =
      auth?.user || auth?.data?.user || auth?.account || auth?.profile || null;

    // Sometimes the token payload is just { access, refresh, username, email }
    const username =
      u?.username ?? auth?.username ?? auth?.user?.username ?? "";
    const email = u?.email ?? auth?.email ?? auth?.user?.email ?? "";

    console.log(u);

    return {
      raw: u,
      username: String(username || "").trim(),
      email: String(email || "").trim(),
    };
  }

  function getAddressFromAuth(auth) {
    const u =
      auth?.user ||
      auth?.data?.user ||
      auth?.account ||
      auth?.profile ||
      auth ||
      null;

    if (!u) return null;

    const lat = Number(u.lat);
    const lng = Number(u.lng);

    const addressObj = {
      address_line1: String(u.address_line1 || u.street_address || "").trim(),
      city: String(u.city || "").trim(),
      state: String(u.state || "").trim(),
      postal_code: String(u.postal_code || u.zip || "").trim(),
      country: String(u.country || "US").trim(),

      preferred_delivery_address: String(
        u.preferred_delivery_address || u.preferredDeliveryAddress || "",
      ).trim(),

      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    };

    const hasStructuredAddress =
      addressObj.address_line1 &&
      addressObj.city &&
      addressObj.state &&
      addressObj.postal_code;

    const hasPreferredAddress = !!addressObj.preferred_delivery_address;
    const hasCoords =
      Number.isFinite(addressObj.lat) && Number.isFinite(addressObj.lng);

    if (!hasStructuredAddress && !hasPreferredAddress && !hasCoords) {
      return null;
    }

    return addressObj;
  }

  function hasUsableSavedAddress(addressObj) {
    if (!addressObj) return false;

    return !!(
      String(addressObj.address_line1 || "").trim() &&
      String(addressObj.city || "").trim() &&
      String(addressObj.state || "").trim() &&
      String(addressObj.postal_code || "").trim()
    );
  }

  function formatAddressLine(a) {
    if (!a) return "—";

    const structuredParts = [
      a.address_line1 || a.street_address || "",
      a.city || "",
      a.state || "",
      a.postal_code || a.zip || "",
    ]
      .map((s) => String(s || "").trim())
      .filter(Boolean);

    if (structuredParts.length) {
      return structuredParts.join(", ");
    }

    const preferred = String(
      a.preferred_delivery_address || a.preferredDeliveryAddress || "",
    ).trim();

    return preferred || "—";
  }

  function renderAddressSummary(sourceLabel, addressObj) {
    if (!addressSummaryEl) return;

    const line = formatAddressLine(addressObj);
    addressSummaryEl.innerHTML = `
      <div class="fw-semibold">${CC.escapeHtml(line)}</div>
    `;
  }

  /**
   * Set the delivery-range badge shown on the account address card.
   *
   * @param {string} text - Badge label shown to the user
   * @param {"success"|"danger"|"warning"|"muted"} kind - Visual badge state
   * @param {string} [note=""] - Optional helper text under the badge
   */
  function setDeliveryBadge(text, kind = "muted", note = "") {
    if (deliveryAddressBadgeEl) {
      const cls =
        kind === "success"
          ? "badge text-bg-success"
          : kind === "danger"
            ? "badge text-bg-danger"
            : kind === "warning"
              ? "badge text-bg-warning"
              : "badge text-bg-light border";

      deliveryAddressBadgeEl.className = cls;
      deliveryAddressBadgeEl.textContent =
        text || "Delivery status unavailable";
    }

    if (deliveryAddressBadgeNoteEl) {
      deliveryAddressBadgeNoteEl.textContent = note || "";
    }
  }

  /**
   * Build the delivery helper's expected customer object using:
   * 1) the best-known address from account page logic
   * 2) auth user lat/lng if available
   *
   * This keeps the account page aligned with the delivery map behavior.
   *
   * @param {object|null} addressObj
   * @returns {object|null}
   */
  function buildDeliveryCustomerRecord(addressObj) {
    const auth = CC.auth?.getAuth?.();
    const user = auth?.user || null;

    if (!addressObj && !user) return null;

    const formattedAddress = formatAddressLine(addressObj);

    return {
      id: user?.id ?? null,
      username: String(user?.username || "").trim(),
      email: String(user?.email || "").trim(),
      role: String(user?.role || "").trim(),

      // Prefer the account page's currently resolved address text,
      // then fall back to auth if the backend eventually adds it there.
      preferred_delivery_address:
        formattedAddress && formattedAddress !== "—"
          ? formattedAddress
          : String(user?.preferred_delivery_address || "").trim(),

      // Future-ready: when API/auth starts returning coordinates,
      // the badge will begin using them automatically.
      lat: Number(user?.lat),
      lng: Number(user?.lng),
    };
  }

  /**
   * Refresh the account-page delivery badge using the shared delivery helpers.
   *
   * Behavior:
   * - Uses HQ config from config.js
   * - Uses the same range math as the map page
   * - Uses delivery test defaults when the API/auth customer coords
   *   are not available yet and ENABLE_DELIVERY_TEST_DEFAULTS is true
   *
   * @param {object|null} addressObj
   */
  function refreshDeliveryAddressBadge(addressObj) {
    const delivery = CC?.delivery;

    if (!delivery) {
      setDeliveryBadge(
        "Delivery helper missing",
        "warning",
        "delivery-shared.js is not loaded on this page.",
      );
      return;
    }

    const config = delivery.getDeliveryConfig();
    const hqCheck = delivery.validateHq(config);

    if (!hqCheck.ok) {
      setDeliveryBadge(
        "Delivery status unavailable",
        "warning",
        `Missing HQ config: ${hqCheck.missing.join(", ")}`,
      );
      return;
    }

    // No usable address yet -> neutral badge
    if (!addressObj) {
      setDeliveryBadge(
        "No address saved",
        "muted",
        "Add a delivery address to check whether you are in range.",
      );
      return;
    }

    const customerRecord = buildDeliveryCustomerRecord(addressObj);
    const customerCheck = delivery.validateCustomer(customerRecord);

    if (!customerCheck.ok) {
      setDeliveryBadge(
        "Delivery status unavailable",
        "warning",
        `Missing customer data: ${customerCheck.missing.join(", ")}`,
      );
      return;
    }

    const distanceFromHq = delivery.milesBetween(
      hqCheck.hq.lat,
      hqCheck.hq.lng,
      customerCheck.customer.lat,
      customerCheck.customer.lng,
    );

    const isInRange = distanceFromHq <= hqCheck.hq.deliveryRange;

    if (isInRange) {
      setDeliveryBadge(
        "In delivery range",
        "success",
        `Your address is ${distanceFromHq.toFixed(2)} miles from HQ.`,
      );
      return;
    }

    setDeliveryBadge(
      "Out of delivery range",
      "danger",
      `Your address is ${distanceFromHq.toFixed(2)} miles from HQ.`,
    );
  }

  // ===========================================================================
  // API calls
  // ===========================================================================

  async function apiGetOrders() {
    // API docs: GET /api/orders/
    return CC.apiRequest("/orders/", { method: "GET" });
  }

  /**
   * Update the signed-in user's first/last name via API.
   *
   * API: /api/auth/profile/name/  [name='update_name']
   * We try PATCH first (typical for partial updates), then fall back to POST.
   */
  async function apiUpdateName(firstNameRaw, lastNameRaw) {
    const first_name = String(firstNameRaw || "").trim();
    const last_name = String(lastNameRaw || "").trim();

    // PUT
    let res = await CC.apiRequest("/auth/profile/name/", {
      method: "PUT",
      json: { first_name, last_name },
    });

    return res;
  }

  async function apiGetFarms() {
    // Used across the app; typically GET /api/farms/
    return CC.apiRequest("/farms/", { method: "GET" });
  }

  /**
   * Update the signed-in user's profile name fields via API.
   *
   * Tries the "new" profile routes first. If your backend only supports one,
   * the first successful one wins.
   *
   * Payload supports both snake_case and camelCase server expectations.
   */
  async function apiUpdateProfileNames(firstNameRaw, lastNameRaw) {
    const firstName = String(firstNameRaw || "").trim();
    const lastName = String(lastNameRaw || "").trim();

    // Keep both shapes available (different backends expect different keys)
    const payloadSnake = { first_name: firstName, last_name: lastName };
    const payloadCamel = { firstName, lastName };

    // Put your confirmed "new" endpoint(s) first in this list
    const candidates = [
      { path: "/auth/profile/", method: "PATCH", json: payloadSnake },
      { path: "/auth/profile/", method: "PATCH", json: payloadCamel },

      { path: "/users/me/", method: "PATCH", json: payloadSnake },
      { path: "/users/me/", method: "PATCH", json: payloadCamel },

      { path: "/account/profile/", method: "PATCH", json: payloadSnake },
      { path: "/account/profile/", method: "PATCH", json: payloadCamel },
    ];

    let lastRes = null;

    for (const c of candidates) {
      const res = await CC.apiRequest(c.path, {
        method: c.method,
        json: c.json,
      });
      lastRes = res;

      // 401 needs to immediately bubble up so page can kick to login cleanly
      if (res.status === 401) return res;

      // If route doesn't exist, keep trying others
      if (res.status === 404) continue;

      // Some APIs disallow PATCH and want PUT
      if (res.status === 405) {
        const putRes = await CC.apiRequest(c.path, {
          method: "PUT",
          json: c.json,
        });
        lastRes = putRes;
        if (putRes.status === 401) return putRes;
        if (putRes.status === 404) continue;
        if (putRes.ok) return putRes;
        continue;
      }

      if (res.ok) return res;
    }

    // Return the last response we saw so caller can show a useful error
    return lastRes || { ok: false, status: 0, data: null, raw: "No response" };
  }

  async function apiGetFavorites() {
    // Not in the doc you uploaded, but your store.js uses a favorites concept.
    // We’ll try: GET /api/favorites/
    return CC.apiRequest("/favorites/", { method: "GET" });
  }

  async function apiPasswordReset(email) {
    // API docs: POST /api/auth/password-reset/
    return CC.apiRequest("/auth/password-reset/", {
      method: "POST",
      json: { email },
    });
  }

  async function apiDeleteAccountBestGuess() {
    // Your API doc doesn’t define account deletion.
    // Best-guess endpoints (we try one; if 404, we tell you clearly).
    return CC.apiRequest("/auth/delete/", { method: "DELETE" });
  }

  // ===========================================================================
  // Page logic
  // ===========================================================================

  async function loadDefaultAddress() {
    // 0) auth/profile address first
    const auth = CC.auth.getAuth?.() || null;
    const authAddr = getAddressFromAuth(auth);

    if (authAddr) {
      renderAddressSummary("Saved on your account", authAddr);

      if (typeof refreshDeliveryAddressBadge === "function") {
        refreshDeliveryAddressBadge(authAddr);
      }

      return authAddr;
    }

    // 1) local override
    const localAddr = getLocalJson(LOCAL_ADDRESS_KEY, null);
    if (hasUsableSavedAddress(localAddr)) {
      renderAddressSummary("Saved on this device", localAddr);

      if (typeof refreshDeliveryAddressBadge === "function") {
        refreshDeliveryAddressBadge(localAddr);
      }

      return localAddr;
    }

    // 2) newest order
    setPageStatus("Loading your latest delivery address…", "muted");
    const res = await apiGetOrders();

    if (res.status === 401) {
      CC.auth.clearAuth();
      window.location.href = "login.html";
      return null;
    }

    if (!res.ok) {
      renderAddressSummary("No saved address", null);

      if (typeof refreshDeliveryAddressBadge === "function") {
        refreshDeliveryAddressBadge(null);
      }

      setPageStatus(
        "Could not load orders to get a delivery address.",
        "warning",
      );
      return null;
    }

    const orders = Array.isArray(res.data) ? res.data : [];
    if (!orders.length) {
      renderAddressSummary("No orders yet", null);

      if (typeof refreshDeliveryAddressBadge === "function") {
        refreshDeliveryAddressBadge(null);
      }

      setPageStatus(
        "No orders found yet — you can still save an address locally.",
        "muted",
      );
      return null;
    }

    // Pick the newest by created_at if present, otherwise first
    const newest = [...orders].sort((a, b) => {
      const at = Date.parse(a?.created_at || "") || 0;
      const bt = Date.parse(b?.created_at || "") || 0;
      return bt - at;
    })[0];

    const inferred = {
      address_line1: newest?.street_address || newest?.address_line1 || "",
      city: newest?.city || "",
      state: newest?.state || "",
      postal_code: newest?.postal_code || "",
      country: newest?.country || "US",
    };

    if (hasUsableSavedAddress(inferred)) {
      renderAddressSummary("Newest order", inferred);

      if (typeof refreshDeliveryAddressBadge === "function") {
        refreshDeliveryAddressBadge(inferred);
      }

      setPageStatus("", "success");
      return inferred;
    }

    renderAddressSummary("No usable address found", null);

    if (typeof refreshDeliveryAddressBadge === "function") {
      refreshDeliveryAddressBadge(null);
    }

    setPageStatus(
      "Orders loaded, but no usable address fields were found.",
      "warning",
    );
    return null;
  }

  function prefillAddressModal(addressObj) {
    const authAddr = getAddressFromAuth(CC.auth.getAuth?.() || null);
    const localAddr = getLocalJson(LOCAL_ADDRESS_KEY, null);

    const a = addressObj || authAddr || localAddr || null;

    if (addrLine1El)
      addrLine1El.value = a?.address_line1 || a?.street_address || "";
    if (addrCityEl) addrCityEl.value = a?.city || "";
    if (addrStateEl) addrStateEl.value = a?.state || "";
    if (addrZipEl) addrZipEl.value = a?.postal_code || a?.zip || "";
  }

  async function loadFavorites() {
    if (!favoritesListEl) return;

    favoritesListEl.innerHTML = `<div class="text-muted small">Loading favorites…</div>`;
    favoritesNoteEl && (favoritesNoteEl.textContent = "");

    const res = await apiGetFavorites();

    if (res.status === 401) {
      CC.auth.clearAuth();
      window.location.href = "login.html";
      return;
    }

    // If endpoint doesn’t exist (404), we explain it rather than breaking the page
    if (!res.ok) {
      favoritesListEl.innerHTML = `
        <div class="alert alert-warning mb-0">
          <div class="fw-semibold">Favorites couldn’t be loaded.</div>
          <div class="small mt-1">This usually means the API endpoint is different (or not implemented yet).</div>
        </div>
      `;
      favoritesNoteEl &&
        (favoritesNoteEl.textContent = `Debug: GET /favorites/ → HTTP ${res.status}`);
      return;
    }

    const favorites = Array.isArray(res.data) ? res.data : [];
    if (!favorites.length) {
      favoritesListEl.innerHTML = `
        <div class="alert alert-info mb-0">
          <div class="fw-semibold">No favorites yet.</div>
          <div class="small mt-1">Go to the store and star a farm to save it here.</div>
        </div>
      `;
      return;
    }

    let farmsLookup = [];
    try {
      const farmsRes = await apiGetFarms();
      if (farmsRes.ok && Array.isArray(farmsRes.data)) {
        farmsLookup = farmsRes.data;
      }
    } catch {
      farmsLookup = [];
    }

    const farmById = new Map();
    const farmByName = new Map();

    farmsLookup.forEach((farm) => {
      const id = Number(farm?.id ?? farm?.farm_id);
      const name = String(farm?.name ?? farm?.farm_name ?? "")
        .trim()
        .toLowerCase();

      if (Number.isFinite(id)) farmById.set(id, farm);
      if (name) farmByName.set(name, farm);
    });

    const favoriteRows = favorites
      .map((f) => {
        if (typeof f === "string") {
          const name = String(f).trim();
          const lookup = farmByName.get(name.toLowerCase()) || null;

          return {
            name,
            logo_url: String(
              lookup?.logo_url ?? lookup?.logo ?? lookup?.image_url ?? "",
            ).trim(),
          };
        }

        const id = Number(f?.id ?? f?.farm_id ?? f?.farm?.id);
        const name = String(
          f?.farm_name ?? f?.farm?.farm_name ?? f?.farm?.name ?? f?.name ?? "",
        ).trim();

        const lookup =
          (Number.isFinite(id) ? farmById.get(id) : null) ||
          farmByName.get(name.toLowerCase()) ||
          null;

        return {
          name,
          logo_url: String(
            f?.logo_url ??
              f?.farm?.logo_url ??
              lookup?.logo_url ??
              lookup?.logo ??
              lookup?.image_url ??
              "",
          ).trim(),
        };
      })
      .filter((row) => row.name);

    favoritesListEl.innerHTML = favoriteRows
      .map((farm) => {
        const logoHtml = farm.logo_url
          ? `
            <img
              src="${CC.escapeHtml(farm.logo_url)}"
              alt="${CC.escapeHtml(farm.name)} logo"
              class="cc-farm-logo-thumb"
              loading="lazy"
              onerror="this.outerHTML='<div class=&quot;cc-farm-logo-fallback&quot;>${CC.escapeHtml(
                (farm.name[0] || "F").toUpperCase(),
              )}</div>'"
            />
          `
          : `
            <div class="cc-farm-logo-fallback">
              ${CC.escapeHtml((farm.name[0] || "F").toUpperCase())}
            </div>
          `;

        return `
          <div class="cc-account-favorite-card">
            <div class="cc-account-favorite-card__left">
              <div class="cc-account-favorite-card__media">
                ${logoHtml}
              </div>

              <div class="fw-semibold">${CC.escapeHtml(farm.name)}</div>
            </div>

            <a
              class="btn cc-btn-outline btn-sm js-shop-farm"
              href="index.html?farm=${encodeURIComponent(farm.name)}"
              data-farm="${CC.escapeHtml(farm.name)}"
            >
              Shop
            </a>
          </div>
        `;
      })
      .join("");
  }

  function detectOwnedFarm(farms) {
    for (const f of farms) {
      if (f.is_owner) {
        return { name: f.name, f: f };
      }
    }

    return null;
  }

  async function loadProviderInfo(username) {
    if (!providerBoxEl) return;
    if (!isProviderAccount()) return;

    const res = await apiGetFarms();

    if (res.status === 401) {
      providerBoxEl.innerHTML = `<div class="text-muted">Farm ownership check requires login.</div>`;
      return;
    }

    if (!res.ok) {
      providerBoxEl.innerHTML = `
        <div class="alert alert-warning mb-0">
          Couldn’t load farms to check ownership (HTTP ${res.status}).
        </div>
      `;
      return;
    }

    const farms = Array.isArray(res.data) ? res.data : [];
    const owned = detectOwnedFarm(farms);

    if (!owned) {
      providerBoxEl.innerHTML = `
        <div class="text-muted">
          No owned farm detected for <span class="fw-semibold">${CC.escapeHtml(username || "this account")}</span>.
        </div>
        <div class="small text-muted mt-2">
          If you’re a provider, use the Farmer Portal login and make sure your farm lists you as the owner.
        </div>
      `;
      return;
    }

    providerBoxEl.innerHTML = `
      <div class="fw-semibold">
        <h3>You are the owner of: ${CC.escapeHtml(owned.name)}</h3>
        <p class="cc-provider-meta">${CC.escapeHtml(owned.f.description)}</p>
        <p class="cc-provider-meta">Located in: ${CC.escapeHtml(owned.f.location)}</p>
      </div>
    `;
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  function wireEvents(userKey, username, email) {
    logoutBtn?.addEventListener("click", () => {
      CC.auth.clearAuth();
      window.location.href = "index.html";
    });

    profileForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      const firstName = String(accFirstEl?.value || "").trim();
      const lastName = String(accLastEl?.value || "").trim();

      saveProfileBtn && (saveProfileBtn.disabled = true);
      setPageStatus("Saving profile…", "muted");

      try {
        const res = await apiUpdateName(firstName, lastName);

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

        // Best-effort: keep auth cache in sync for other pages that read CC.auth
        try {
          const auth = CC.auth.getAuth?.() || {};
          const nextAuth = { ...auth };

          if (nextAuth.user && typeof nextAuth.user === "object") {
            nextAuth.user = {
              ...nextAuth.user,
              first_name: firstName,
              last_name: lastName,
            };
          }

          CC.auth.saveAuth?.(nextAuth);
        } catch {
          // no-op
        }

        setPageStatus("", "success");
      } catch (err) {
        setPageStatus(err?.message || String(err), "danger");
      } finally {
        saveProfileBtn && (saveProfileBtn.disabled = false);
      }
    });

    // When opening the modal, prefill newEmail with current email and clear password
    document
      .getElementById("changeEmailModal")
      ?.addEventListener("show.bs.modal", () => {
        setInlineStatus(changeEmailStatusEl, "");
        if (newEmailEl)
          newEmailEl.value = String(accEmailEl?.value || "").trim();
        if (confirmPasswordEl) confirmPasswordEl.value = "";
      });

    // Handle change email submit
    changeEmailForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      const nextEmail = String(newEmailEl?.value || "").trim();
      const currentPassword = String(confirmPasswordEl?.value || "").trim();

      if (!nextEmail) {
        setInlineStatus(
          changeEmailStatusEl,
          "Please enter a new email.",
          "danger",
        );
        return;
      }

      if (!currentPassword) {
        setInlineStatus(
          changeEmailStatusEl,
          "Please enter your current password.",
          "danger",
        );
        return;
      }

      saveEmailBtn && (saveEmailBtn.disabled = true);
      setInlineStatus(changeEmailStatusEl, "Updating email…", "muted");

      try {
        const res = await apiChangeEmail(nextEmail, currentPassword);

        if (res.status === 401) {
          CC.auth.clearAuth();
          window.location.href = "login.html";
          return;
        }

        if (!res.ok) {
          // 404 = endpoint doesn’t exist yet / name differs
          if (res.status === 404) {
            throw new Error(
              "Email update isn’t supported by the API yet (endpoint not found). If you tell me what route your backend uses, I’ll wire it up.",
            );
          }

          throw new Error(
            res.data?.error ||
              res.data?.detail ||
              res.raw ||
              `HTTP ${res.status}`,
          );
        }

        // If backend returns updated email, use it; otherwise use what user entered.
        const updatedEmail = String(
          res.data?.email || res.data?.user?.email || nextEmail,
        ).trim();

        // Update UI immediately
        if (accEmailEl) accEmailEl.value = updatedEmail;

        // Update auth cache if your auth store keeps email (best effort)
        try {
          const auth = CC.auth.getAuth?.() || {};
          const nextAuth = { ...auth };

          if (nextAuth.user && typeof nextAuth.user === "object") {
            nextAuth.user = { ...nextAuth.user, email: updatedEmail };
          } else {
            nextAuth.email = updatedEmail;
          }

          // If your auth helper exposes a setter, use it. If not, we just skip safely.
          if (typeof CC.auth.setAuth === "function") CC.auth.setAuth(nextAuth);
        } catch {
          // No-op: not fatal if we can’t update the cache shape
        }

        setInlineStatus(changeEmailStatusEl, "Email updated.", "success");

        // Close modal
        const modalEl = document.getElementById("changeEmailModal");
        if (modalEl && window.bootstrap?.Modal) {
          const instance =
            window.bootstrap.Modal.getInstance(modalEl) ||
            new window.bootstrap.Modal(modalEl);
          instance.hide();
        }
      } catch (err) {
        setInlineStatus(
          changeEmailStatusEl,
          err?.message || String(err),
          "danger",
        );
      } finally {
        saveEmailBtn && (saveEmailBtn.disabled = false);
      }
    });

    // When modal opens, prefill with best-known address
    document
      .getElementById("addressModal")
      ?.addEventListener("show.bs.modal", () => {
        setInlineStatus(addressModalStatusEl, "");
        const localAddr = getLocalJson(LOCAL_ADDRESS_KEY, null);
        prefillAddressModal(localAddr);
      });

    addressForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      const basePayload = {
        address_line1: String(addrLine1El?.value || "").trim(),
        city: String(addrCityEl?.value || "").trim(),
        state: String(addrStateEl?.value || "").trim(),
        postal_code: String(addrZipEl?.value || "").trim(),
        country: "US",
      };

      if (
        !basePayload.address_line1 ||
        !basePayload.city ||
        !basePayload.state ||
        !basePayload.postal_code
      ) {
        setInlineStatus(
          addressModalStatusEl,
          "Please fill out all address fields.",
          "danger",
        );
        return;
      }

      const submitBtn = addressForm.querySelector('button[type="submit"]');
      submitBtn && (submitBtn.disabled = true);

      try {
        setInlineStatus(
          addressModalStatusEl,
          "Converting address to coordinates…",
          "muted",
        );

        const geo = await geocodeDeliveryAddress(basePayload);

        const fullPayload = {
          ...basePayload,
          preferred_delivery_address:
            geo.display_name || buildAddressString(basePayload),
          lat: geo.lat,
          lng: geo.lng,
        };

        setInlineStatus(
          addressModalStatusEl,
          "Saving address to your account…",
          "muted",
        );

        const res = await apiUpdateDeliveryAddress(fullPayload);

        if (res.status === 401) {
          CC.auth.clearAuth();
          window.location.href = "login.html";
          return;
        }

        // Keep local device cache regardless so checkout still has the address.
        setLocalJson(LOCAL_ADDRESS_KEY, fullPayload);
        renderAddressSummary("Saved on this device", fullPayload);
        syncAddressIntoAuthCache(fullPayload);

        if (typeof refreshDeliveryAddressBadge === "function") {
          refreshDeliveryAddressBadge(fullPayload);
        }

        if (!res.ok) {
          setPageStatus(
            "Address saved locally and geocoded, but DB sync is not supported by the API route yet.",
            "warning",
          );
          setInlineStatus(
            addressModalStatusEl,
            "Saved locally. Geocoding worked, but the API did not accept the profile update.",
            "warning",
          );
          return;
        }

        setPageStatus("", "success");
        setInlineStatus(addressModalStatusEl, "Address saved.", "success");

        const modalEl = document.getElementById("addressModal");
        if (modalEl && window.bootstrap?.Modal) {
          const instance =
            window.bootstrap.Modal.getInstance(modalEl) ||
            new window.bootstrap.Modal(modalEl);
          instance.hide();
        }
      } catch (err) {
        setInlineStatus(
          addressModalStatusEl,
          err?.message || String(err),
          "danger",
        );
      } finally {
        submitBtn && (submitBtn.disabled = false);
      }
    });

    passwordResetForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!resetEmailEl) return;

      const targetEmail = String(resetEmailEl.value || "").trim();
      if (!targetEmail) {
        setInlineStatus(securityStatusEl, "Please enter an email.", "danger");
        return;
      }

      sendResetBtn && (sendResetBtn.disabled = true);
      setInlineStatus(securityStatusEl, "Sending reset email…", "muted");

      try {
        const res = await apiPasswordReset(targetEmail);

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

        setInlineStatus(
          securityStatusEl,
          "If that email exists, you should receive a password reset link shortly.",
          "success",
        );
      } catch (err) {
        setInlineStatus(
          securityStatusEl,
          err?.message || String(err),
          "danger",
        );
      } finally {
        sendResetBtn && (sendResetBtn.disabled = false);
      }
    });

    deleteAccountBtn?.addEventListener("click", async () => {
      const ok = window.confirm(
        "Delete your account permanently?\n\nThis cannot be undone.",
      );
      if (!ok) return;

      setInlineStatus(dangerStatusEl, "Attempting account deletion…", "muted");

      try {
        const res = await apiDeleteAccountBestGuess();

        if (res.status === 401) {
          CC.auth.clearAuth();
          window.location.href = "login.html";
          return;
        }

        if (!res.ok) {
          // Most likely: 404 because endpoint doesn’t exist
          throw new Error(
            res.status === 404
              ? "Account deletion is not supported by the API yet (endpoint not found)."
              : res.data?.error ||
                  res.data?.detail ||
                  res.raw ||
                  `HTTP ${res.status}`,
          );
        }

        // If it worked:
        CC.auth.clearAuth();
        setInlineStatus(
          dangerStatusEl,
          "Account deleted. Logging out…",
          "success",
        );
        setTimeout(() => (window.location.href = "index.html"), 700);
      } catch (err) {
        setInlineStatus(dangerStatusEl, err?.message || String(err), "danger");
      }
    });

    // Set reset email default
    if (resetEmailEl) resetEmailEl.value = email || "";
  }

  // ===========================================================================
  // Init
  // ===========================================================================

  CC.onReady(async () => {
    // This page is account-only, but we still let page.js handle auth UI toggles.
    if (!CC.auth.isLoggedIn()) return;

    setPageStatus("Loading account…", "muted");

    const auth = CC.auth.getAuth?.() || null;
    const picked = pickUserFromAuth(auth);

    const username = picked.username;
    const email = picked.email;

    syncProviderVisibility();

    // Use a stable local key per-account
    const userKey = username || email || "anonymous";

    const u = picked.raw || {};
    if (accFirstEl)
      accFirstEl.value = String(u.first_name ?? u.firstName ?? "").trim();
    if (accLastEl)
      accLastEl.value = String(u.last_name ?? u.lastName ?? "").trim();

    // Populate top fields
    if (accUsernameEl) accUsernameEl.value = username || "—";
    if (accEmailEl) accEmailEl.value = email || "—";

    // Load address (local override OR newest order)
    const inferred = await loadDefaultAddress();

    // Prefill modal with best-known
    prefillAddressModal(inferred);

    // Load favorites + provider info

    if (isProviderAccount()) {
      await Promise.allSettled([loadFavorites(), loadProviderInfo(username)]);
    } else await Promise.allSettled([loadFavorites()]);

    wireEvents(userKey, username, email);
    setPageStatus("", "success");
  });
})();
