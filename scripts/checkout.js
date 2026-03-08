/**
 * ============================================================================
 * checkout.js — Checkout flow (real DB/API + Stripe + delivery-range gate)
 * ----------------------------------------------------------------------------
 * Flow:
 *  1) GET  /api/cart/                      -> render cart summary
 *  2) Prefill shipping form from saved address
 *  3) On submit, geocode current address if needed
 *  4) Compare customer address to HQ delivery range
 *  5) If out of range, block checkout before order creation
 *  6) If in range, POST /api/orders/checkout/
 *  7) Mount Stripe Payment Element
 *  8) Confirm payment and finalize order
 * ============================================================================
 */

(function initCheckoutPage() {
  "use strict";

  const CC = window.CC;
  const delivery = CC?.delivery || null;

  /* ==========================================================================
   * DOM
   * ========================================================================== */

  const statusEl = document.getElementById("pageStatus");
  const checkoutForm = document.getElementById("checkoutForm");
  const placeOrderBtn = document.getElementById("placeOrderBtn");

  const summaryItemsEl = document.getElementById("summaryItems");
  const sumSubtotalEl = document.getElementById("sumSubtotal");
  const sumTaxEl = document.getElementById("sumTax");
  const sumDeliveryFeeEl = document.getElementById("sumDeliveryFee");
  const deliveryFeeNoteEl = document.getElementById("deliveryFeeNote");
  const sumTotalEl = document.getElementById("sumTotal");

  const payBtn = document.getElementById("payBtn");
  const payMsgEl = document.getElementById("payMsg");
  const checkoutAddressStatusEl = document.getElementById("checkoutAddressStatus");

  const shipAddressEl = document.getElementById("shipAddress");
  const shipCityEl = document.getElementById("shipCity");
  const shipStateEl = document.getElementById("shipState");
  const shipZipEl = document.getElementById("shipZip");

  /* ==========================================================================
   * STATE
   * ========================================================================== */

  let cart = null;
  let stripe = null;
  let elements = null;

  let activeOrderId = null;
  let activePaymentIntentId = null;

  const PENDING_ORDER_KEY = "cc_pending_order";
  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";
  const TEMP_CHECKOUT_ADDRESS_KEY = "cc_checkout_address_geo_v1";

  /* ==========================================================================
   * STORAGE HELPERS
   * ========================================================================== */

  function getJson(storage, key, fallback = null) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function setJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage failures
    }
  }

  function getLocalAddress() {
    return getJson(localStorage, LOCAL_ADDRESS_KEY, null);
  }

  function setLocalAddress(addr) {
    setJson(localStorage, LOCAL_ADDRESS_KEY, addr);
  }

  function getTempCheckoutAddress() {
    return getJson(sessionStorage, TEMP_CHECKOUT_ADDRESS_KEY, null);
  }

  function setTempCheckoutAddress(addr) {
    setJson(sessionStorage, TEMP_CHECKOUT_ADDRESS_KEY, addr);
  }

  /* ==========================================================================
   * UI HELPERS
   * ========================================================================== */

  function setPayMsg(text, kind = "muted") {
    if (!payMsgEl) return;
    payMsgEl.textContent = text || "";
    payMsgEl.className =
      "small " +
      (kind === "danger"
        ? "text-danger"
        : kind === "success"
          ? "text-success"
          : kind === "warning"
            ? "text-warning"
            : "text-muted");
  }

  function setAddressStatus(text, kind = "muted") {
    if (!checkoutAddressStatusEl) return;
    checkoutAddressStatusEl.textContent = text || "";
    checkoutAddressStatusEl.className =
      "small " +
      (kind === "danger"
        ? "text-danger"
        : kind === "success"
          ? "text-success"
          : kind === "warning"
            ? "text-warning"
            : "text-muted");
  }

  function renderDeliveryFee(distanceMiles = null, inRange = false) {
    if (sumDeliveryFeeEl) {
      sumDeliveryFeeEl.textContent = inRange ? "TBD" : "—";
    }

    if (deliveryFeeNoteEl) {
      if (!inRange || !Number.isFinite(distanceMiles)) {
        deliveryFeeNoteEl.textContent = "";
      } else {
        deliveryFeeNoteEl.textContent =
          `Placeholder only. Address is ${distanceMiles.toFixed(2)} miles from HQ.`;
      }
    }
  }

  function handleUnauthorized() {
    CC.auth.clearAuth();
    window.location.href = "login.html";
  }

  /* ==========================================================================
   * ADDRESS HELPERS
   * ========================================================================== */

  function buildAddressString(addressObj) {
    if (!addressObj) return "";

    return [
      String(addressObj.address_line1 || addressObj.street_address || "").trim(),
      String(addressObj.city || "").trim(),
      String(addressObj.state || "").trim(),
      String(addressObj.postal_code || addressObj.zip || "").trim(),
      String(addressObj.country || "US").trim(),
    ]
      .filter(Boolean)
      .join(", ");
  }

  function normalizeAddressValue(v) {
    return String(v || "")
      .trim()
      .replace(/\s+/g, " ")
      .toUpperCase();
  }

  function sameAddress(a, b) {
    if (!a || !b) return false;

    return (
      normalizeAddressValue(a.address_line1 || a.street_address) ===
        normalizeAddressValue(b.address_line1 || b.street_address) &&
      normalizeAddressValue(a.city) === normalizeAddressValue(b.city) &&
      normalizeAddressValue(a.state) === normalizeAddressValue(b.state) &&
      normalizeAddressValue(a.postal_code || a.zip) ===
        normalizeAddressValue(b.postal_code || b.zip)
    );
  }

  function getAddressFromAuth(auth) {
    const user =
      auth?.user || auth?.data?.user || auth?.account || auth?.profile || null;

    if (!user || typeof user !== "object") return null;

    const lat = Number(user.lat);
    const lng = Number(user.lng);

    const addr = {
      address_line1: String(
        user.address_line1 || user.street_address || ""
      ).trim(),
      city: String(user.city || "").trim(),
      state: String(user.state || "").trim(),
      postal_code: String(user.postal_code || user.zip || "").trim(),
      country: String(user.country || "US").trim(),
      preferred_delivery_address: String(
        user.preferred_delivery_address || user.preferredDeliveryAddress || ""
      ).trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    };

    const hasAddressText =
      addr.address_line1 && addr.city && addr.state && addr.postal_code;
    const hasPreferred = !!addr.preferred_delivery_address;
    const hasCoords = Number.isFinite(addr.lat) && Number.isFinite(addr.lng);

    return hasAddressText || hasPreferred || hasCoords ? addr : null;
  }

  function readShippingFormAddress() {
    return {
      address_line1: String(shipAddressEl?.value || "").trim(),
      city: String(shipCityEl?.value || "").trim(),
      state: String(shipStateEl?.value || "").trim(),
      postal_code: String(shipZipEl?.value || "").trim(),
      country: "US",
    };
  }

  function prefillShippingForm() {
    const authAddr = getAddressFromAuth(CC.auth.getAuth?.() || null);
    const localAddr = getLocalAddress();
    const cached = authAddr || localAddr || null;

    if (!cached) return;

    if (!String(shipAddressEl?.value || "").trim()) {
      shipAddressEl.value = cached.address_line1 || cached.street_address || "";
    }
    if (!String(shipCityEl?.value || "").trim()) {
      shipCityEl.value = cached.city || "";
    }
    if (!String(shipStateEl?.value || "").trim()) {
      shipStateEl.value = cached.state || "";
    }
    if (!String(shipZipEl?.value || "").trim()) {
      shipZipEl.value = cached.postal_code || cached.zip || "";
    }
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

    const query = buildAddressString(addressObj);
    if (!query) {
      throw new Error("Please enter a valid delivery address.");
    }

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
      throw new Error(`Address lookup failed (HTTP ${res.status}).`);
    }

    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;

    if (!hit) {
      throw new Error("We could not find coordinates for that address.");
    }

    const lat = Number(hit.lat);
    const lng = Number(hit.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("Address lookup returned invalid coordinates.");
    }

    return {
      lat,
      lng,
      display_name: String(hit.display_name || query).trim(),
    };
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
          address_line1: addressPayload.address_line1,
          city: addressPayload.city,
          state: addressPayload.state,
          postal_code: addressPayload.postal_code,
          country: addressPayload.country,
          lat: addressPayload.lat,
          lng: addressPayload.lng,
        };
      } else {
        nextAuth.preferred_delivery_address =
          addressPayload.preferred_delivery_address;
        nextAuth.address_line1 = addressPayload.address_line1;
        nextAuth.city = addressPayload.city;
        nextAuth.state = addressPayload.state;
        nextAuth.postal_code = addressPayload.postal_code;
        nextAuth.country = addressPayload.country;
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
      { path: "/auth/profile/", method: "PATCH", json: payloadSnake },
      { path: "/auth/profile/", method: "PATCH", json: payloadCamel },
      { path: "/users/me/", method: "PATCH", json: payloadSnake },
      { path: "/users/me/", method: "PATCH", json: payloadCamel },
      { path: "/account/profile/", method: "PATCH", json: payloadSnake },
      { path: "/account/profile/", method: "PATCH", json: payloadCamel },
    ];

    let lastRes = null;

    for (const candidate of candidates) {
      const res = await CC.apiRequest(candidate.path, {
        method: candidate.method,
        json: candidate.json,
      });

      lastRes = res;

      if (res.status === 401) return res;
      if (res.status === 404) continue;

      if (res.status === 405) {
        const putRes = await CC.apiRequest(candidate.path, {
          method: "PUT",
          json: candidate.json,
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

  function buildCheckoutPayload() {
    return {
      country: "US",
      state: String(shipStateEl?.value || "").trim(),
      postal_code: String(shipZipEl?.value || "").trim(),
      city: String(shipCityEl?.value || "").trim(),
      address_line1: String(shipAddressEl?.value || "").trim(),
    };
  }

  async function resolveCheckoutDeliveryDecision() {
    if (!delivery) {
      throw new Error(
        "Delivery helpers are missing. Make sure delivery-shared.js is loaded."
      );
    }

    const formAddress = readShippingFormAddress();

    if (
      !formAddress.address_line1 ||
      !formAddress.city ||
      !formAddress.state ||
      !formAddress.postal_code
    ) {
      throw new Error("Please complete the full delivery address.");
    }

    const authAddr = getAddressFromAuth(CC.auth.getAuth?.() || null);
    const savedAddr = authAddr || getLocalAddress();
    const tempGeo = getTempCheckoutAddress();

    let geo = null;

    if (
      savedAddr &&
      sameAddress(formAddress, savedAddr) &&
      Number.isFinite(Number(savedAddr.lat)) &&
      Number.isFinite(Number(savedAddr.lng))
    ) {
      geo = {
        lat: Number(savedAddr.lat),
        lng: Number(savedAddr.lng),
        display_name:
          String(savedAddr.preferred_delivery_address || "").trim() ||
          buildAddressString(savedAddr),
      };
    } else if (
      tempGeo &&
      sameAddress(formAddress, tempGeo) &&
      Number.isFinite(Number(tempGeo.lat)) &&
      Number.isFinite(Number(tempGeo.lng))
    ) {
      geo = {
        lat: Number(tempGeo.lat),
        lng: Number(tempGeo.lng),
        display_name:
          String(tempGeo.preferred_delivery_address || "").trim() ||
          buildAddressString(tempGeo),
      };
    } else {
      setAddressStatus("Looking up address coordinates…", "muted");
      geo = await geocodeDeliveryAddress(formAddress);
    }

    const enrichedAddress = {
      ...formAddress,
      preferred_delivery_address: geo.display_name || buildAddressString(formAddress),
      lat: geo.lat,
      lng: geo.lng,
      updatedAt: new Date().toISOString(),
    };

    setTempCheckoutAddress(enrichedAddress);

    const hqCheck = delivery.validateHq(delivery.getDeliveryConfig());
    if (!hqCheck?.ok) {
      throw new Error("HQ delivery settings are missing or invalid.");
    }

    const customerCheck = delivery.validateCustomer({
      preferred_delivery_address: enrichedAddress.preferred_delivery_address,
      lat: enrichedAddress.lat,
      lng: enrichedAddress.lng,
    });

    if (!customerCheck?.ok) {
      throw new Error("Customer delivery coordinates are missing.");
    }

    const distanceMiles = delivery.milesBetween(
      hqCheck.hq.lat,
      hqCheck.hq.lng,
      customerCheck.customer.lat,
      customerCheck.customer.lng
    );

    const inRange = distanceMiles <= hqCheck.hq.deliveryRange;

    const savedMatchesCurrent = savedAddr ? sameAddress(savedAddr, enrichedAddress) : false;
    let savedAddressUpdated = false;
    let saveChoice = "unchanged";

    if (!savedAddr || !savedMatchesCurrent) {
      const wantsSave = window.confirm(
        "This checkout address is different from your saved address. Click OK to update your saved delivery address, or Cancel to use this address just for this order."
      );

      if (wantsSave) {
        saveChoice = "save";

        const saveRes = await apiUpdateDeliveryAddress(enrichedAddress);

        if (saveRes.status === 401) {
          handleUnauthorized();
          return null;
        }

        setLocalAddress(enrichedAddress);
        syncAddressIntoAuthCache(enrichedAddress);
        savedAddressUpdated = !!saveRes.ok;

        if (saveRes.ok) {
          setAddressStatus("Saved this address to your account.", "success");
        } else {
          setAddressStatus(
            "Address will be used now and cached locally, but the API did not accept the profile update yet.",
            "warning"
          );
        }
      } else {
        saveChoice = "one_off";
        setAddressStatus("Using this as a one-time delivery address.", "muted");
      }
    } else {
      setAddressStatus("Using your saved delivery address.", "success");
    }

    renderDeliveryFee(distanceMiles, inRange);

    return {
      checkoutPayload: {
        country: enrichedAddress.country,
        state: enrichedAddress.state,
        postal_code: enrichedAddress.postal_code,
        city: enrichedAddress.city,
        address_line1: enrichedAddress.address_line1,
      },
      enrichedAddress,
      inRange,
      distanceMiles,
      deliveryFee: 0,
      saveChoice,
      savedAddressUpdated,
    };
  }

  /* ==========================================================================
   * CART
   * ========================================================================== */

  async function fetchCart() {
    CC.setStatus(statusEl, "Loading cart…", "muted");

    const res = await CC.apiRequest("/cart/", { method: "GET" });
    if (res.status === 401) return handleUnauthorized();

    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`
      );
    }

    cart = res.data;
    return cart;
  }

  function renderCartSummary() {
    if (!summaryItemsEl || !sumSubtotalEl || !sumTaxEl || !sumTotalEl) return;

    summaryItemsEl.innerHTML = "";

    const items = cart?.items || [];
    if (!items.length) {
      summaryItemsEl.innerHTML = `
        <div class="alert alert-warning mb-0">
          Your cart is empty. <a href="index.html" class="alert-link">Go back to the store</a>.
        </div>
      `;
      sumSubtotalEl.textContent = CC.formatMoney(0);
      sumTaxEl.textContent = CC.formatMoney(0);
      if (sumDeliveryFeeEl) sumDeliveryFeeEl.textContent = "—";
      sumTotalEl.textContent = CC.formatMoney(0);

      placeOrderBtn && (placeOrderBtn.disabled = true);
      payBtn && (payBtn.disabled = true);
      return;
    }

    const cartTotal = parseFloat(cart.total_price);

    for (const item of items) {
      const name = CC.escapeHtml(item.product_name || "Item");
      const qty = Number(item.quantity || 1);
      const line = item.subtotal ?? 0;

      const row = document.createElement("div");
      row.className = "d-flex justify-content-between";
      row.innerHTML = `
        <div class="pe-3">
          <div class="fw-semibold">${name}</div>
          <div class="small text-muted">Qty ${qty}</div>
        </div>
        <div class="fw-semibold">${CC.formatMoney(line)}</div>
      `;
      summaryItemsEl.appendChild(row);
    }

    sumSubtotalEl.textContent = CC.formatMoney(cartTotal);
    sumTaxEl.textContent = "—";
    if (sumDeliveryFeeEl) sumDeliveryFeeEl.textContent = "TBD";
    sumTotalEl.textContent = CC.formatMoney(cartTotal);

    if (cartTotal <= 0.50) {
      CC.setStatus(
        statusEl,
        "Minimum purchase amount not reached. Please add more than $0.50 worth of items to complete checkout.",
        "danger"
      );
      return;
    }

    CC.setStatus(statusEl, "", "success");
  }

  /* ==========================================================================
   * ORDER CREATION
   * ========================================================================== */

  async function createOrder(payload) {
    CC.setStatus(statusEl, "Creating order…", "muted");
    setPayMsg("");

    const res = await CC.apiRequest("/orders/checkout/", {
      method: "POST",
      json: payload,
    });

    console.log("checkout status/raw:", res.status, res.raw);

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`
      );
    }

    const order = res.data?.order;
    const clientSecret = res.data?.client_secret;
    const paymentIntentId = res.data?.payment_intent_id;

    if (!order?.id || !clientSecret || !paymentIntentId) {
      throw new Error(
        "Checkout response missing order id / client secret / payment intent id."
      );
    }

    activeOrderId = order.id;
    activePaymentIntentId = paymentIntentId;

    sessionStorage.setItem(
      PENDING_ORDER_KEY,
      JSON.stringify({
        orderId: activeOrderId,
        paymentIntentId: activePaymentIntentId,
      })
    );

    sumSubtotalEl.textContent = CC.formatMoney(order.subtotal_amount ?? 0);
    sumTaxEl.textContent = CC.formatMoney(order.tax_amount ?? 0);

    if (sumDeliveryFeeEl) {
      sumDeliveryFeeEl.textContent = "TBD";
    }

    sumTotalEl.textContent = CC.formatMoney(order.total_amount ?? 0);

    return { order, clientSecret, paymentIntentId };
  }

  /* ==========================================================================
   * STRIPE
   * ========================================================================== */

  async function mountStripe(clientSecret) {
    const pk =
      window.STRIPE_PUBLISHABLE_KEY ||
      CC.getConfigValue("STRIPE_PUBLISHABLE_KEY", "");
    if (!pk) throw new Error("Stripe publishable key is missing in config.js");

    stripe = stripe || window.Stripe(pk);
    elements = stripe.elements({ clientSecret });

    const paymentWrap = document.getElementById("payment-element");
    if (paymentWrap) paymentWrap.innerHTML = "";

    const paymentElement = elements.create("payment");
    paymentElement.mount("#payment-element");

    payBtn.disabled = false;
    setPayMsg("Payment ready. Click Pay now to complete purchase.", "success");
  }

  async function confirmOrderOnServer(orderId, paymentIntentId) {
    CC.setStatus(statusEl, "Finalizing order…", "muted");

    const res = await CC.apiRequest(`/orders/${orderId}/confirm/`, {
      method: "POST",
      json: { payment_intent_id: paymentIntentId },
    });

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`
      );
    }

    sessionStorage.removeItem(PENDING_ORDER_KEY);
    CC.setStatus(
      statusEl,
      "✅ Payment confirmed. Order is finalized!",
      "success"
    );
  }

  async function handleStripeReturnIfAny() {
    const params = new URLSearchParams(window.location.search);
    const paymentIntentIdFromUrl = params.get("payment_intent");

    if (!paymentIntentIdFromUrl) return;

    let pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING_ORDER_KEY) || "null");
    } catch {
      pending = null;
    }

    if (!pending?.orderId) {
      setPayMsg(
        "Returned from Stripe, but order context is missing. Check Orders page.",
        "danger"
      );
      return;
    }

    try {
      await confirmOrderOnServer(pending.orderId, paymentIntentIdFromUrl);
      setPayMsg("✅ Payment confirmed and order finalized.", "success");

      params.delete("payment_intent");
      params.delete("payment_intent_client_secret");
      params.delete("redirect_status");

      const clean =
        window.location.pathname +
        (params.toString() ? `?${params.toString()}` : "");
      window.history.replaceState({}, "", clean);

      setTimeout(() => (window.location.href = "orders.html"), 900);
    } catch (err) {
      setPayMsg(err?.message || String(err), "danger");
    }
  }

  async function handlePayClick() {
    if (!stripe || !elements) return;

    if (!activeOrderId || !activePaymentIntentId) {
      setPayMsg("Order not created yet. Submit your address first.", "danger");
      return;
    }

    payBtn.disabled = true;
    setPayMsg("Processing payment…", "muted");

    try {
      const returnUrl = `${window.location.origin}${window.location.pathname}`;

      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });

      if (result.error) {
        setPayMsg(result.error.message || "Payment failed.", "danger");
        payBtn.disabled = false;
        return;
      }

      const status = result.paymentIntent?.status;
      const piId = result.paymentIntent?.id || activePaymentIntentId;

      if (status === "succeeded") {
        await confirmOrderOnServer(activeOrderId, piId);
        setPayMsg("✅ Payment confirmed. Redirecting to orders…", "success");
        setTimeout(() => (window.location.href = "orders.html"), 900);
        return;
      }

      setPayMsg(
        `Payment status: ${status || "unknown"}. If prompted, complete verification.`,
        "muted"
      );
      payBtn.disabled = false;
    } catch (err) {
      setPayMsg(err?.message || String(err), "danger");
      payBtn.disabled = false;
    }
  }

  /* ==========================================================================
   * BOOT
   * ========================================================================== */

  CC.onReady(async () => {
    if (!CC.auth.isLoggedIn()) {
      window.location.href = "login.html";
      return;
    }

    await handleStripeReturnIfAny();

    try {
      await fetchCart();
      renderCartSummary();
    } catch (err) {
      CC.setStatus(statusEl, err?.message || String(err), "danger");
      return;
    }

    prefillShippingForm();
    renderDeliveryFee(null, false);

    checkoutForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (!cart?.items?.length) {
        CC.setStatus(statusEl, "Your cart is empty.", "danger");
        return;
      }

      placeOrderBtn.disabled = true;
      payBtn.disabled = true;
      setPayMsg("");

      try {
        const deliveryDecision = await resolveCheckoutDeliveryDecision();
        if (!deliveryDecision) return;

        if (!deliveryDecision.inRange) {
          CC.setStatus(
            statusEl,
            `This address is out of delivery range. It is ${deliveryDecision.distanceMiles.toFixed(2)} miles from HQ.`,
            "danger"
          );
          setPayMsg(
            "Checkout blocked because the delivery address is out of range.",
            "danger"
          );
          return;
        }

        CC.setStatus(
          statusEl,
          `Address is in range (${deliveryDecision.distanceMiles.toFixed(2)} miles from HQ). Creating order…`,
          "success"
        );

        const { clientSecret } = await createOrder(deliveryDecision.checkoutPayload);
        await mountStripe(clientSecret);
      } catch (err) {
        CC.setStatus(statusEl, err?.message || String(err), "danger");
        setPayMsg(err?.message || String(err), "danger");
      } finally {
        placeOrderBtn.disabled = false;
      }
    });

    payBtn?.addEventListener("click", handlePayClick);
  });
})();