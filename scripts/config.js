/**
 * ============================================================================
 * config.js — Global runtime configuration
 * ----------------------------------------------------------------------------
 * Purpose:
 * - Defines window.__CROPCART_CONFIG__ used by utils.js + page scripts
 * - Exposes backwards-compatible globals (API_URL / API_BASE_URL)
 * - Exposes STRIPE_PUBLISHABLE_KEY for checkout.js
 *
 * NOTE: Values/logic preserved from the project source.
 * ============================================================================
 */

window.__CROPCART_CONFIG__ = {
  // --------------------------------------------------------------------------
  // API / Server URLs
  // --------------------------------------------------------------------------

  // Live URL:
  API_URL: "http://3.142.227.162/api",

  // Stripe Connect helper server (local)
  STRIPE_API_URL: "http://127.0.0.1:4242/api/stripe/connect/",

  // --------------------------------------------------------------------------
  // Stripe Client
  // --------------------------------------------------------------------------

  STRIPE_PUBLISHABLE_KEY:
    "pk_test_51Sk6SlCV7Fz3POGDgrPnonTC2bjA0qby5WUYR5LdzBwqGhKq9ugdxbl4uxwqNVixB9vJQTDj1Eb2A2V4K9PSDHUx00LHvclWTn",

  // --------------------------------------------------------------------------
  // Test URL/PKey For Stripe testing (kept as comments from source)
  // --------------------------------------------------------------------------
  // API_URL: "http://localhost:4242/api",
  // STRIPE_PUBLISHABLE_KEY: 'pk_test_51RVcKk2el6TPjGkD0aHuRepUS2rLzkDSs4QRvyQ4esIXr666R69y8Mte3l81vdaXoSe2vznV1w2Ljeegq6tzrtjm00BKBnc3Q4',

  // --------------------------------------------------------------------------
  // App behavior toggles
  // --------------------------------------------------------------------------

  DEFAULT_DELIVERY_RADIUS_MILES: 15,
  ENABLE_FARMER_PORTAL: true,
};

// ---------------------------------------------------------------------------
// Backwards-compatible globals (legacy scripts depend on these)
// ---------------------------------------------------------------------------

// Example: "http://3.142.227.162/api"
window.API_URL = window.__CROPCART_CONFIG__.API_URL;
window.API_BASE_URL = window.__CROPCART_CONFIG__.API_URL;

// Stripe key used by checkout pages
window.STRIPE_PUBLISHABLE_KEY =
  window.__CROPCART_CONFIG__.STRIPE_PUBLISHABLE_KEY;