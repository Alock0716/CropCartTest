/**
 * ============================================================================
 * page.js — Shared “page boot” logic
 * ----------------------------------------------------------------------------
 * Requires:
 * - config.js
 * - utils.js (window.CC)
 *
 * Responsibilities:
 * - Enforce auth on protected pages (based on <body data-page="...">)
 * - Redirect logged-in users away from auth pages
 * - Toggle UI blocks via data-auth="in" and data-auth="out"
 *
 * NOTE: Logic preserved from project source.
 * ============================================================================
 */

(function initPageBoot() {
  "use strict";

  const CC = window.CC;
  if (!CC) {
    console.warn(
      "page.js: window.CC not found. Make sure utils.js is loaded before page.js",
    );
    return;
  }

  /* ==========================================================================
   * AUTH UI TOGGLING
   * ========================================================================== */

  function toggleAuthSections() {
    const loggedIn = CC.auth.isLoggedIn();

    CC.qsa("[data-auth='in']").forEach((el) =>
      el.classList.toggle("d-none", !loggedIn),
    );

    CC.qsa("[data-auth='out']").forEach((el) =>
      el.classList.toggle("d-none", loggedIn),
    );
  }

  /* ==========================================================================
   * ROUTE GUARDS
   * ========================================================================== */

  function enforcePageAuth() {
    const page = document.body?.dataset?.page || "";

    // Pages that require auth
    const PROTECTED_PAGES = new Set(["orders", "account", "checkout", "farmer"]);

    // Pages intended for users who are NOT logged in
    const AUTH_PAGES = new Set([
      "login",
      "register",
      "auth",
      "password-reset",
      "password-reset-confirm",
    ]);

    // 1) Require login for protected pages
    if (PROTECTED_PAGES.has(page) && !CC.auth.isLoggedIn()) {
      CC.auth.saveReturnToCurrentPage();
      window.location.href = "login.html";
      return;
    }

    // 2) Farmer page requires provider role
    if (page === "farmer") {
      const auth = CC.auth.getAuth();

      if (!auth?.user || auth.user.role !== "provider") {
        window.location.href = "account.html";
        return;
      }
    }

    // 3) Prevent logged-in users from viewing login/register/etc.
    if (AUTH_PAGES.has(page) && CC.auth.isLoggedIn()) {
      window.location.href = "account.html";
      return;
    }
  }

  /* ==========================================================================
   * BOOT
   * ========================================================================== */

  CC.onReady(() => {
    enforcePageAuth();
    toggleAuthSections();

    // Sync if auth changes in another tab
    window.addEventListener("storage", (e) => {
      if (e.key === "token" || e.key === "cc_auth" || e.key === "cc_remember") {
        toggleAuthSections();
        enforcePageAuth();
      }
    });
  });
})();