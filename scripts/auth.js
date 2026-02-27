/**
 * ============================================================================
 * auth.js — login/register + navbar auth UI (SOURCE-BASED REGEN)
 * ----------------------------------------------------------------------------
 * IMPORTANT:
 * - Logic/behavior preserved from project source file.
 * - Changes are ORGANIZATION + COMMENTS only.
 *
 * Requires:
 * - config.js (defines window.__CROPCART_CONFIG__)
 * - utils.js  (defines window.CC)
 *
 * What this file does:
 * - Renders auth dropdown/login link into #authNav
 * - Wires login.html form (and guest cart sync into DB cart on login)
 * - Wires register.html form (normal user registration)
 * - Wires farmer-register.html form (provider registration)
 * - Wires provider registration status checker
 * - Wires password reset request + confirm forms
 * ============================================================================
 */

(function initAuthPageScripts() {
  "use strict";

  const CC = window.CC;
  if (!CC) {
    console.warn(
      "auth.js: window.CC not found. Make sure utils.js is loaded before auth.js",
    );
    return;
  }

  /* ==========================================================================
   * API ROUTES (from your server API help)
   * ========================================================================== */

  const LOGIN_PATH = "/auth/login/";
  const REGISTER_PATH = "/auth/register/";
  const PASSWORD_RESET_REQUEST_PATH = "/auth/password-reset/";
  const PASSWORD_RESET_CONFIRM_BASE = "/auth/password-reset-confirm/";
  const PROVIDER_REGISTER_PATH = "/auth/register-provider/";
  const PROVIDER_REG_STATUS_BASE = "/auth/registration-status/";

  // Farmer auth endpoints (kept for later; preserved from source)
  const FARMER_LOGIN_PATH = "/auth/login-provider/";
  const FARMER_REGISTER_PATH = "/auth/register-provider/";

  /* ==========================================================================
   * NAVBAR AUTH UI
   * ========================================================================== */

  function renderNavbarAuth() {
    const authNavEl = document.getElementById("authNav");
    if (!authNavEl) return;

    const auth = CC.auth.getAuth();

    // Logged out: show single "Login / Register" button
    if (!auth) {
      authNavEl.innerHTML = `
        <a class="btn cc-btn-outline ms-lg-2" href="login.html">Login / Register</a>
      `;
      return;
    }

    // Logged in: dropdown
    const displayName = auth.user?.username || auth.user?.email || "My Account";

    authNavEl.innerHTML = `
      <div class="dropdown">
        <a class="nav-link dropdown-toggle" href="#" id="accountDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
          ${CC.escapeHtml(displayName)}
        </a>
        <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="accountDropdown">
          <li><a class="dropdown-item" href="account.html">My Account</a></li>
          <li><a class="dropdown-item" href="orders.html">My Orders</a></li>
          <li><hr class="dropdown-divider" /></li>
          <li><button class="dropdown-item text-danger" id="logoutBtn" type="button">Log out</button></li>
        </ul>
      </div>
    `;

    document.getElementById("logoutBtn")?.addEventListener("click", () => {
      CC.auth.logout("index.html");
    });
  }

  /* ==========================================================================
   * LOGIN (login.html)
   * ========================================================================== */

  function wireLoginForm() {
    const form = document.getElementById("loginForm");
    if (!form) return;

    const statusEl = document.getElementById("pageStatus");
    const rememberEl = document.getElementById("rememberMe");
    const loginBtn = document.getElementById("loginBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const fd = new FormData(form);
      const username = String(fd.get("username") || "").trim();
      const password = String(fd.get("password") || "");

      if (!username || !password) {
        CC.setStatus(statusEl, "Please enter username and password.", "danger");
        return;
      }

      CC.setStatus(statusEl, "Signing you in…", "muted");
      if (loginBtn) loginBtn.disabled = true;

      try {
        const parsed = await CC.apiRequest(LOGIN_PATH, {
          method: "POST",
          json: { username, password },
        });

        if (!parsed.ok) {
          const msg =
            parsed.data?.detail ||
            parsed.data?.error ||
            parsed.data?.message ||
            (parsed.raw
              ? `Server error: ${parsed.raw}`
              : `Login failed (HTTP ${parsed.status}).`);
          CC.setStatus(statusEl, msg, "danger");
          return;
        }

        CC.auth.saveAuth(parsed.data, !!rememberEl?.checked);

        // If visitor built a cart while logged out, merge it into their DB cart now.
        // Uses POST /api/cart/add/ for each cached item.
        try {
          const result = await CC.cartCache.syncGuestCartToServer();
          if (result?.attempted) {
            CC.setStatus(
              statusEl,
              `Signed in ✓  (synced ${result.synced}/${result.attempted} saved cart item(s))`,
              "success",
            );
          }
        } catch {
          // Do not fail login if sync fails
        }

        const returnTo = CC.auth.consumeReturnTo("index.html");
        window.location.href = returnTo;
      } catch (err) {
        CC.setStatus(
          statusEl,
          `Network error: ${err?.message || err}`,
          "danger",
        );
      } finally {
        if (loginBtn) loginBtn.disabled = false;
      }
    });
  }

  /* ==========================================================================
   * NORMAL USER REGISTER (register.html)
   * ========================================================================== */

  function wireRegisterForm() {
    const form = document.getElementById("registerForm");
    if (!form) return;

    const statusEl = document.getElementById("pageStatus");
    const registerBtn = document.getElementById("registerBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const username = document.getElementById("username")?.value?.trim() || "";
      const email = document.getElementById("email")?.value?.trim() || "";
      const password = document.getElementById("password")?.value || "";
      const confirm = document.getElementById("confirmPassword")?.value || "";

      if (!username || !email || !password) {
        CC.setStatus(
          statusEl,
          "Username, email, and password are required.",
          "danger",
        );
        return;
      }

      if (password.trim().length < 8) {
        CC.setStatus(
          statusEl,
          "Password must be at least 8 characters and not blank.",
          "danger",
        );
        return;
      }

      if (confirm && password !== confirm) {
        CC.setStatus(statusEl, "Passwords do not match.", "danger");
        return;
      }

      CC.setStatus(statusEl, "Creating account…", "muted");
      if (registerBtn) registerBtn.disabled = true;

      try {
        const parsed = await CC.apiRequest(REGISTER_PATH, {
          method: "POST",
          json: { username, email, password },
        });

        if (!parsed.ok) {
          const msg =
            CC.formatFieldErrors(parsed.data) ||
            parsed.data?.detail ||
            parsed.data?.error ||
            parsed.data?.message ||
            (parsed.raw
              ? `Server error: ${parsed.raw}`
              : `Registration failed (HTTP ${parsed.status}).`);

          CC.setStatus(statusEl, msg, "danger");
          return;
        }

        CC.setStatus(
          statusEl,
          "✅ Account created! Sending you to login…",
          "success",
        );
        setTimeout(() => {
          window.location.href = "login.html";
        }, 650);
      } catch (err) {
        CC.setStatus(
          statusEl,
          `Network error: ${err?.message || err}`,
          "danger",
        );
      } finally {
        if (registerBtn) registerBtn.disabled = false;
      }
    });
  }

  /* ==========================================================================
   * FARMER / PROVIDER REGISTER (farmer-register.html)
   * ========================================================================== */

  function wireFarmerRegisterForm() {
    const form = document.getElementById("farmerRegisterForm");
    if (!form) return;

    const statusEl = document.getElementById("pageStatus");
    const btn = document.getElementById("farmerRegisterBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      // --- Account fields ---
      const username =
        document.getElementById("providerUsername")?.value?.trim() || "";
      const email =
        document.getElementById("providerEmail")?.value?.trim() || "";
      const password = document.getElementById("providerPassword")?.value || "";
      const confirm =
        document.getElementById("providerConfirmPassword")?.value || "";

      // --- Farm fields ---
      const farm_name =
        document.getElementById("farmName")?.value?.trim() || "";
      const farm_description =
        document.getElementById("farmDescription")?.value?.trim() || "";
      const farm_location =
        document.getElementById("farmLocation")?.value?.trim() || "";

      if (!username || !email || !password || !farm_name) {
        CC.setStatus(
          statusEl,
          "Username, email, password, and farm name are required.",
          "danger",
        );
        return;
      }

      if (password.trim().length < 8) {
        CC.setStatus(
          statusEl,
          "Password must be at least 8 characters and not blank.",
          "danger",
        );
        return;
      }

      if (password !== confirm) {
        CC.setStatus(statusEl, "Passwords do not match.", "danger");
        return;
      }

      CC.setStatus(statusEl, "Submitting your application…", "muted");
      if (btn) btn.disabled = true;

      try {
        const payload = {
          username,
          email,
          password,
          farm_name,
          ...(farm_description ? { farm_description } : {}),
          ...(farm_location ? { farm_location } : {}),
        };

        const parsed = await CC.apiRequest(PROVIDER_REGISTER_PATH, {
          method: "POST",
          json: payload,
        });

        if (!parsed.ok) {
          const msg =
            CC.formatFieldErrors(parsed.data) ||
            parsed.data?.detail ||
            parsed.data?.error ||
            parsed.data?.message ||
            (parsed.raw
              ? `Server error: ${parsed.raw}`
              : `Registration failed (HTTP ${parsed.status}).`);

          CC.setStatus(statusEl, msg, "danger");
          return;
        }

        const regId = parsed.data?.registration_id;

        // Save locally so the status checker can auto-fill.
        if (regId) {
          localStorage.setItem("cc_provider_registration_id", String(regId));
          const regInput = document.getElementById("registrationId");
          if (regInput) regInput.value = String(regId);
        }

        CC.setStatus(
          statusEl,
          `✅ Submitted! Your registration ID is ${regId ?? "(unknown)"} — you can check status on the right.`,
          "success",
        );

        // Optional: clear password fields after submit
        document.getElementById("providerPassword").value = "";
        document.getElementById("providerConfirmPassword").value = "";
      } catch (err) {
        CC.setStatus(
          statusEl,
          `Network error: ${err?.message || err}`,
          "danger",
        );
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  function wireFarmerStatusCheckForm() {
    const form = document.getElementById("farmerStatusForm");
    if (!form) return;

    const resultEl = document.getElementById("statusCheckResult");
    const btn = document.getElementById("checkStatusBtn");
    const input = document.getElementById("registrationId");

    // Auto-fill if we have a previous id
    const saved = localStorage.getItem("cc_provider_registration_id");
    if (input && saved && !input.value) input.value = saved;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const idRaw = String(input?.value || "").trim();
      const idNum = Number(idRaw);

      if (!Number.isFinite(idNum) || idNum <= 0) {
        CC.setStatus(
          resultEl,
          "Enter a valid registration ID (a number).",
          "danger",
        );
        return;
      }

      if (btn) btn.disabled = true;
      CC.setStatus(resultEl, "Checking…", "muted");

      try {
        const parsed = await CC.apiRequest(
          `${PROVIDER_REG_STATUS_BASE}${idNum}/`,
          { method: "GET" },
        );

        if (!parsed.ok) {
          const msg =
            parsed.data?.error ||
            parsed.data?.detail ||
            parsed.data?.message ||
            (parsed.raw
              ? `Server error: ${parsed.raw}`
              : `Status lookup failed (HTTP ${parsed.status}).`);

          CC.setStatus(resultEl, msg, "danger");
          return;
        }

        const status =
          parsed.data?.status_display || parsed.data?.status || "unknown";
        const message = parsed.data?.message || "Status returned.";

        localStorage.setItem("cc_provider_registration_id", String(idNum));
        CC.setStatus(resultEl, `✅ ${status}: ${message}`, "success");
      } catch (err) {
        CC.setStatus(
          resultEl,
          `Network error: ${err?.message || err}`,
          "danger",
        );
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  /* ==========================================================================
   * PASSWORD RESET (password-reset.html + password-reset-confirm.html)
   * ========================================================================== */

  function wirePasswordResetRequestForm() {
    const form = document.getElementById("passwordResetRequestForm");
    if (!form) return;

    const statusEl = document.getElementById("pageStatus");
    const btn = document.getElementById("resetRequestBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const email = String(
        document.getElementById("resetEmail")?.value || "",
      ).trim();
      if (!email) {
        CC.setStatus(statusEl, "Please enter your email.", "danger");
        return;
      }

      btn && (btn.disabled = true);
      CC.setStatus(statusEl, "Sending reset email…", "muted");

      try {
        const res = await CC.apiRequest(PASSWORD_RESET_REQUEST_PATH, {
          method: "POST",
          json: { email },
        });

        const msg =
          res.data?.message ||
          "If that email exists, a reset link has been sent.";

        if (!res.ok) {
          CC.setStatus(
            statusEl,
            res.data?.error || res.data?.detail || msg,
            "danger",
          );
          return;
        }

        CC.setStatus(statusEl, `✅ ${msg}`, "success");
        form.reset();
      } catch (err) {
        CC.setStatus(
          statusEl,
          `Network error: ${err?.message || err}`,
          "danger",
        );
      } finally {
        btn && (btn.disabled = false);
      }
    });
  }

  function wirePasswordResetConfirmForm() {
    const form = document.getElementById("passwordResetConfirmForm");
    if (!form) return;

    const statusEl = document.getElementById("pageStatus");
    const btn = document.getElementById("resetConfirmBtn");

    // Optional: auto-fill uid/token from query string (?uid=...&token=...)
    try {
      const qs = new URLSearchParams(window.location.search);
      const uid = qs.get("uid");
      const token = qs.get("token");
      if (uid) document.getElementById("resetUid").value = uid;
      if (token) document.getElementById("resetToken").value = token;
    } catch {
      // ignore
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const uid = String(
        document.getElementById("resetUid")?.value || "",
      ).trim();
      const token = String(
        document.getElementById("resetToken")?.value || "",
      ).trim();
      const newPassword = String(
        document.getElementById("newPassword")?.value || "",
      );

      if (!uid || !token || !newPassword) {
        CC.setStatus(
          statusEl,
          "Please fill out uid, token, and your new password.",
          "danger",
        );
        return;
      }

      btn && (btn.disabled = true);
      CC.setStatus(statusEl, "Setting new password…", "muted");

      try {
        const endpoint = `${PASSWORD_RESET_CONFIRM_BASE}${encodeURIComponent(uid)}/${encodeURIComponent(token)}/`;

        const res = await CC.apiRequest(endpoint, {
          method: "POST",
          json: { new_password: newPassword },
        });

        if (!res.ok) {
          CC.setStatus(
            statusEl,
            res.data?.error ||
              res.data?.detail ||
              res.raw ||
              "Password reset failed.",
            "danger",
          );
          return;
        }

        CC.setStatus(
          statusEl,
          "✅ Password reset successful. Sending you to login…",
          "success",
        );
        setTimeout(() => (window.location.href = "login.html"), 800);
      } catch (err) {
        CC.setStatus(
          statusEl,
          `Network error: ${err?.message || err}`,
          "danger",
        );
      } finally {
        btn && (btn.disabled = false);
      }
    });
  }

  /* ==========================================================================
   * BOOT
   * ========================================================================== */

  CC.onReady(() => {
    renderNavbarAuth();
    wireLoginForm();
    wireRegisterForm();
    wirePasswordResetRequestForm();
    wirePasswordResetConfirmForm();

    // Provider (Farmer) registration + status check
    wireFarmerRegisterForm();
    wireFarmerStatusCheckForm();
  });
})();