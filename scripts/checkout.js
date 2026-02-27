/**
 * checkout.js — Checkout flow (real DB/API + Stripe)
 *
 * Flow:
 * 1) GET /api/cart/ to show summary
 * 2) POST /api/orders/checkout/ with address to create order + PaymentIntent
 * 3) Stripe Payment Element confirms payment
 * 4) POST /api/orders/<order_id>/confirm/ to finalize on server (decrement stock, mark paid, etc.)
 *
 * Requires:
 * - config.js + utils.js (window.CC)
 * - Stripe.js loaded in checkout.html
 */

(function initCheckoutPage() {
  "use strict";

  const CC = window.CC;

  // ----- DOM -----
  const statusEl = document.getElementById("pageStatus");

  const checkoutForm = document.getElementById("checkoutForm");
  const placeOrderBtn = document.getElementById("placeOrderBtn");

  const summaryItemsEl = document.getElementById("summaryItems");
  const sumSubtotalEl = document.getElementById("sumSubtotal");
  const sumTaxEl = document.getElementById("sumTax");
  const sumTotalEl = document.getElementById("sumTotal");

  const payBtn = document.getElementById("payBtn");
  const payMsgEl = document.getElementById("payMsg");

  // ----- State -----
  let cart = null;

  // Stripe state
  let stripe = null;
  let elements = null;

  // Order state
  let activeOrderId = null;
  let activePaymentIntentId = null;

  const PENDING_ORDER_KEY = "cc_pending_order";

  // -------------------------
  // Address cache (shared with account.js)
  // -------------------------
  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";

  function getLocalAddress() {
    try {
      const raw = localStorage.getItem(LOCAL_ADDRESS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setLocalAddress(addr) {
    try {
      localStorage.setItem(LOCAL_ADDRESS_KEY, JSON.stringify(addr));
    } catch {
      // If storage is blocked/private mode, silently ignore.
    }
  }

  function prefillShippingFormFromCache() {
    // These IDs must exist in checkout.html
    const addrEl = document.getElementById("shipAddress");
    const cityEl = document.getElementById("shipCity");
    const stateEl = document.getElementById("shipState");
    const zipEl = document.getElementById("shipZip");

    if (!addrEl || !cityEl || !stateEl || !zipEl) return;

    const cached = getLocalAddress();
    if (!cached) return;

    // Only prefill empty fields (don’t stomp what the user already typed)
    if (!String(addrEl.value || "").trim())
      addrEl.value = cached.address_line1 || cached.street_address || "";
    if (!String(cityEl.value || "").trim()) cityEl.value = cached.city || "";
    if (!String(stateEl.value || "").trim()) stateEl.value = cached.state || "";
    if (!String(zipEl.value || "").trim())
      zipEl.value = cached.postal_code || cached.zip || "";
  }

  function setPayMsg(text, kind = "muted") {
    if (!payMsgEl) return;
    payMsgEl.textContent = text || "";
    payMsgEl.className =
      "small " +
      (kind === "danger"
        ? "text-danger"
        : kind === "success"
          ? "text-success"
          : "text-muted");
  }

  function handleUnauthorized() {
    CC.auth.clearAuth();
    window.location.href = "login.html";
  }

  /**
   * Load the cart for the summary panel.
   */
  async function fetchCart() {
    CC.setStatus(statusEl, "Loading cart…", "muted");

    const res = await CC.apiRequest("/cart/", { method: "GET" });
    if (res.status === 401) return handleUnauthorized();

    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    cart = res.data;
    return cart;
  }

  /**
   * Render the summary from cart (before order is created).
   * Once the order is created, we will replace totals with server-calculated amounts.
   */
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
      sumTotalEl.textContent = CC.formatMoney(0);

      // Disable checkout actions
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
    sumTotalEl.textContent = CC.formatMoney(cartTotal);

    CC.setStatus(statusEl, "Cart loaded.", "success");
  }

  /**
   * Convert delivery form into the backend-required checkout payload.
   *
   * API expects:
   * { country, state, postal_code, city, address_line1 }
   */
  function buildCheckoutPayload() {
    const addressLine1 =
      document.getElementById("shipAddress")?.value?.trim() || "";
    const city = document.getElementById("shipCity")?.value?.trim() || "";
    const state = document.getElementById("shipState")?.value?.trim() || "";
    const postal = document.getElementById("shipZip")?.value?.trim() || "";

    const payload = {
      country: "US",
      state,
      postal_code: postal,
      city,
      address_line1: addressLine1,
    };

    // If it's usable, persist it so Account + Checkout stay in sync.
    if (
      payload.address_line1 &&
      payload.city &&
      payload.state &&
      payload.postal_code
    ) {
      setLocalAddress({
        address_line1: payload.address_line1,
        city: payload.city,
        state: payload.state,
        postal_code: payload.postal_code,
        country: payload.country,
        updatedAt: new Date().toISOString(),
      });
    }

    return payload;
  }

  /**
   * Create an order + PaymentIntent on your backend.
   * The backend returns:
   * { order: {...}, payment_intent_id, client_secret }
   */
  async function createOrder() {
    CC.setStatus(statusEl, "Creating order…", "muted");
    setPayMsg("");

    const payload = buildCheckoutPayload();

    const res = await CC.apiRequest("/orders/checkout/", {
      method: "POST",
      json: payload,
    });

    console.log("checkout status/raw:", res.status, res.raw);

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    const order = res.data?.order;
    const clientSecret = res.data?.client_secret;
    const paymentIntentId = res.data?.payment_intent_id;

    if (!order?.id || !clientSecret || !paymentIntentId) {
      throw new Error(
        "Checkout response missing order id / client secret / payment intent id.",
      );
    }

    activeOrderId = order.id;
    activePaymentIntentId = paymentIntentId;

    // Save so we can finalize even if Stripe redirects for 3DS
    sessionStorage.setItem(
      PENDING_ORDER_KEY,
      JSON.stringify({
        orderId: activeOrderId,
        paymentIntentId: activePaymentIntentId,
      }),
    );

    // Render server totals (authoritative)
    sumSubtotalEl.textContent = CC.formatMoney(order.subtotal_amount ?? 0);
    sumTaxEl.textContent = CC.formatMoney(order.tax_amount ?? 0);
    sumTotalEl.textContent = CC.formatMoney(order.total_amount ?? 0);

    return { order, clientSecret, paymentIntentId };
  }

  /**
   * Mount the Stripe Payment Element using the client secret.
   */
  async function mountStripe(clientSecret) {
    const pk =
      window.STRIPE_PUBLISHABLE_KEY ||
      CC.getConfigValue("STRIPE_PUBLISHABLE_KEY", "");
    if (!pk) throw new Error("Stripe publishable key is missing in config.js");

    stripe = stripe || window.Stripe(pk);
    elements = stripe.elements({ clientSecret });

    const paymentElement = elements.create("payment");
    paymentElement.mount("#payment-element");

    payBtn.disabled = false;
    setPayMsg("Payment ready. Click Pay now to complete purchase.", "success");
  }

  /**
   * After Stripe says payment succeeded, tell your backend to confirm and finalize.
   */
  async function confirmOrderOnServer(orderId, paymentIntentId) {
    CC.setStatus(statusEl, "Finalizing order…", "muted");

    const res = await CC.apiRequest(`/orders/${orderId}/confirm/`, {
      method: "POST",
      json: { payment_intent_id: paymentIntentId },
    });

    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) {
      throw new Error(
        res.data?.error || res.data?.detail || res.raw || `HTTP ${res.status}`,
      );
    }

    sessionStorage.removeItem(PENDING_ORDER_KEY);
    CC.setStatus(
      statusEl,
      "✅ Payment confirmed. Order is finalized!",
      "success",
    );
  }

  /**
   * Handle a return from Stripe (3DS / redirect) by reading URL params.
   * Stripe may return payment_intent & payment_intent_client_secret.
   */
  async function handleStripeReturnIfAny() {
    const params = new URLSearchParams(window.location.search);
    const paymentIntentIdFromUrl = params.get("payment_intent");

    if (!paymentIntentIdFromUrl) return;

    // We need the order id to call /confirm/
    let pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING_ORDER_KEY) || "null");
    } catch {
      pending = null;
    }

    if (!pending?.orderId) {
      setPayMsg(
        "Returned from Stripe, but order context is missing. Check Orders page.",
        "danger",
      );
      return;
    }

    try {
      await confirmOrderOnServer(pending.orderId, paymentIntentIdFromUrl);
      setPayMsg("✅ Payment confirmed and order finalized.", "success");

      // Clean URL
      params.delete("payment_intent");
      params.delete("payment_intent_client_secret");
      params.delete("redirect_status");
      const clean =
        window.location.pathname +
        (params.toString() ? `?${params.toString()}` : "");
      window.history.replaceState({}, "", clean);

      // Optional: send user to orders
      setTimeout(() => (window.location.href = "orders.html"), 900);
    } catch (err) {
      setPayMsg(err?.message || String(err), "danger");
    }
  }

  /**
   * Pay button handler: confirms payment with Stripe, then confirms on server.
   */
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

      // If no redirect was required, we can finalize immediately
      const status = result.paymentIntent?.status;
      const piId = result.paymentIntent?.id || activePaymentIntentId;

      if (status === "succeeded") {
        await confirmOrderOnServer(activeOrderId, piId);
        setPayMsg("✅ Payment confirmed. Redirecting to orders…", "success");
        setTimeout(() => (window.location.href = "orders.html"), 900);
        return;
      }

      // If processing or requires_action, Stripe will typically redirect or keep state.
      setPayMsg(
        `Payment status: ${status || "unknown"}. If prompted, complete verification.`,
        "muted",
      );
      payBtn.disabled = false;
    } catch (err) {
      setPayMsg(err?.message || String(err), "danger");
      payBtn.disabled = false;
    }
  }

  CC.onReady(async () => {
    if (!CC.auth.isLoggedIn()) {
      // page.js will redirect checkout anyway (protected), but this guards against weird edge cases
      window.location.href = "login.html";
      return;
    }

    // If user returned from Stripe (3DS), finalize the order.
    await handleStripeReturnIfAny();

    try {
      await fetchCart();
      renderCartSummary();
    } catch (err) {
      CC.setStatus(statusEl, err?.message || String(err), "danger");
      return;
    }

    // Pull cached delivery address saved from Account page (or prior checkouts)
    prefillShippingFormFromCache();

    checkoutForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (!cart?.items?.length) {
        CC.setStatus(statusEl, "Your cart is empty.", "danger");
        return;
      }

      placeOrderBtn.disabled = true;

      try {
        const { clientSecret } = await createOrder();
        await mountStripe(clientSecret);

        CC.setStatus(statusEl, "Order created. Payment is ready.", "success");
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
