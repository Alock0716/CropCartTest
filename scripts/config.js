window.__CROPCART_CONFIG__ = {
  //Live URL/Pkey:
  API_URL: "http://3.142.227.162/api",

  STRIPE_API_URL: "http://127.0.0.1:4242/api/stripe/connect/",

  STRIPE_PUBLISHABLE_KEY:
    "pk_test_51Sk6SlCV7Fz3POGDgrPnonTC2bjA0qby5WUYR5LdzBwqGhKq9ugdxbl4uxwqNVixB9vJQTDj1Eb2A2V4K9PSDHUx00LHvclWTn",

  //Test URL/PKey For Stripe testing:
  //API_URL: "http://localhost:4242/api",
  //STRIPE_PUBLISHABLE_KEY: 'pk_test_51RVcKk2el6TPjGkD0aHuRepUS2rLzkDSs4QRvyQ4esIXr666R69y8Mte3l81vdaXoSe2vznV1w2Ljeegq6tzrtjm00BKBnc3Q4',

  //Config Vars
  DEFAULT_DELIVERY_RADIUS_MILES: 15,
  ENABLE_FARMER_PORTAL: true,
};

// ---------------------------------------------------------------------------
// Backwards-compatible globals
// ---------------------------------------------------------------------------
// Some older page scripts referenced API_BASE_URL / API_URL directly.
// We keep these so legacy code doesn't break while you refactor.

// Example: "http://3.142.227.162/api"
window.API_URL = window.__CROPCART_CONFIG__.API_URL;
window.API_BASE_URL = window.__CROPCART_CONFIG__.API_URL;

// Stripe key used by checkout pages
window.STRIPE_PUBLISHABLE_KEY =
  window.__CROPCART_CONFIG__.STRIPE_PUBLISHABLE_KEY;
