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
  // API / Server URL
  // --------------------------------------------------------------------------
  API_URL: "https://d1nnhq1iqs57tb.cloudfront.net/api",

  // --------------------------------------------------------------------------
  // Stripe Client Variables
  // --------------------------------------------------------------------------

  STRIPE_PUBLISHABLE_KEY:
    "pk_test_51Sk6SlCV7Fz3POGDgrPnonTC2bjA0qby5WUYR5LdzBwqGhKq9ugdxbl4uxwqNVixB9vJQTDj1Eb2A2V4K9PSDHUx00LHvclWTn",


  ENABLE_FARMER_PORTAL: true,

  //using UMU address rn change to be real once i have the real address info
  DELIVERY_RANGE: 15,
  HQ_ADDRESS: "1972 Clark Ave., Alliance, OH 44601",
  HQ_LAT: 40.902174,
  HQ_LONG: -81.108759,
  
  // --------------------------------------------------------------------------
  // Delivery test defaults
  // Temporary testing helpers for missing farm/customer coordinates
  // --------------------------------------------------------------------------
  ENABLE_DELIVERY_TEST_DEFAULTS: true,

  TEST_DELIVERY_ADDRESS: "1151 Melschiemer St. SW, East Sparta, Ohio, USA",

  TEST_FARM_LAT: 40.9000,
  TEST_FARM_LONG: -81.1000,

  TEST_CUSTOMER_LAT: 40.7989,
  TEST_CUSTOMER_LONG: -81.3784,

  // --------------------------------------------------------------------------
  // Service Fee Percentages by Product Category
  // --------------------------------------------------------------------------
  SERVICE_FEES: {
    produce: 0.05,      // 5%
    dairy: 0.06,        // 6%
    meat: 0.08,         // 8%
    baked: 0.04,        // 4%
    pantry: 0.03,       // 3%
    default: 0.05       // fallback
  },
  
};

// ---------------------------------------------------------------------------
// Backwards-compatible globals (legacy scripts depend on these) (TODO: Remove Later)
// ---------------------------------------------------------------------------

// Example: "http://3.142.227.162/api"
window.API_URL = window.__CROPCART_CONFIG__.API_URL;
window.API_BASE_URL = window.__CROPCART_CONFIG__.API_URL;

// Stripe key used by checkout pages
window.STRIPE_PUBLISHABLE_KEY =
  window.__CROPCART_CONFIG__.STRIPE_PUBLISHABLE_KEY;