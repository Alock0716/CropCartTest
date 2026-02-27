/**
 * page.js — shared “page boot” logic
 *
 * Requires:
 * - config.js
 * - utils.js (window.CC)
 *
 * What this file does
 * - Enforces auth on protected pages (based on <body data-page="...">)
 * - Redirects already-logged-in users away from login/register
 * - Toggles UI sections using data-auth="in" and data-auth="out"
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

  function toggleAuthSections() {
    const loggedIn = CC.auth.isLoggedIn();
    CC.qsa("[data-auth='in']").forEach((el) =>
      el.classList.toggle("d-none", !loggedIn),
    );
    CC.qsa("[data-auth='out']").forEach((el) =>
      el.classList.toggle("d-none", loggedIn),
    );
  }

  function enforcePageAuth() {
    const page = document.body?.dataset?.page || "";

    const PROTECTED_PAGES = new Set([
      "orders",
      "account",
      "checkout",
      "farmer",
    ]);

    const AUTH_PAGES = new Set([
      "login",
      "register",
      "auth",
      "password-reset",
      "password-reset-confirm",
    ]);

    // ---- 1. Require login for protected pages ----
    if (PROTECTED_PAGES.has(page) && !CC.auth.isLoggedIn()) {
      CC.auth.saveReturnToCurrentPage();
      window.location.href = "login.html";
      return;
    }

    // ---- 2. Special rule: Farmer page requires provider role ----
    if (page === "farmer") {
      const auth = CC.auth.getAuth();

      if (!auth?.user || auth.user.role !== "provider") {
        window.location.href = "account.html";
        return;
      }
    }

    // ---- 3. Prevent logged-in users from seeing login/register ----
    if (AUTH_PAGES.has(page) && CC.auth.isLoggedIn()) {
      window.location.href = "account.html";
      return;
    }
  }

  CC.onReady(() => {
    enforcePageAuth();
    toggleAuthSections();

    window.addEventListener("storage", (e) => {
      // If auth/token changes in another tab, update this page’s UI
      if (e.key === "token" || e.key === "cc_auth" || e.key === "cc_remember") {
        toggleAuthSections();
        enforcePageAuth();
      }
    });
  });
})();
