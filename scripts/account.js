/**
 * account.js — Account page behavior (API integrated where possible)
 *
 * What it does:
 * - Shows user info from CC.auth (username/email) + optional first/last
 * - Finds a “default delivery address” from:
 *    1) localStorage override (cc_saved_address_v1)
 *    2) newest order (GET /api/orders/) since the API stores address on orders
 * - Shows favorites (tries GET /favorites/ — fails gracefully if API differs)
 * - Shows provider-owned farm if detectable from GET /farms/
 * - Password “change” is done via reset email (POST /api/auth/password-reset/)
 * - Delete account button exists, but endpoint may not be supported (fails gracefully)
 */
(function initAccountPage() {
  "use strict";

  const CC = window.CC;

  const ROOT_BASE = String(String(CC.API_URL).replace(/\/api$/i, ""));

  // -------------------------
  // DOM
  // -------------------------
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

  // Favorites

  const refreshFavoritesBtn = document.getElementById("refreshFavoritesBtn");
  const favoritesListEl = document.getElementById("favoritesList");
  const favoritesNoteEl = document.getElementById("favoritesNote");

  // Provider
  const providerBoxEl = document.getElementById("providerBox");
  const stripeBoxEl = document.getElementById("stripeBox");

  // Security
  const passwordResetForm = document.getElementById("passwordResetForm");
  const resetEmailEl = document.getElementById("resetEmail");
  const sendResetBtn = document.getElementById("sendResetBtn");
  const securityStatusEl = document.getElementById("securityStatus");

  // Danger
  const deleteAccountBtn = document.getElementById("deleteAccountBtn");
  const dangerStatusEl = document.getElementById("dangerStatus");

  // -------------------------
  // Local keys
  // -------------------------
  const LOCAL_ADDRESS_KEY = "cc_saved_address_v1";

  // -------------------------
  // Helpers
  // -------------------------
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

  function pickUserFromAuth(auth) {
    // Your auth payload can vary — this tries common shapes without crashing.
    const u =
      auth?.user || auth?.data?.user || auth?.account || auth?.profile || null;

    // Sometimes the token payload is just { access, refresh, username, email }
    const username =
      u?.username ?? auth?.username ?? auth?.user?.username ?? "";
    const email = u?.email ?? auth?.email ?? auth?.user?.email ?? "";

    return {
      raw: u,
      username: String(username || "").trim(),
      email: String(email || "").trim(),
    };
  }

  function formatAddressLine(a) {
    if (!a) return "—";
    const parts = [
      a.address_line1 || a.street_address || "",
      a.city || "",
      a.state || "",
      a.postal_code || a.zip || "",
    ]
      .map((s) => String(s || "").trim())
      .filter(Boolean);

    return parts.length ? parts.join(", ") : "—";
  }

  function renderAddressSummary(sourceLabel, addressObj) {
    if (!addressSummaryEl) return;

    const line = formatAddressLine(addressObj);
    addressSummaryEl.innerHTML = `
      <div class="fw-semibold">${CC.escapeHtml(line)}</div>
      <div class="text-muted mt-1">Source: ${CC.escapeHtml(sourceLabel)}</div>
    `;
  }

  // -------------------------
  // API calls
  // -------------------------
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

  // -------------------------
  // Page logic
  // -------------------------
  async function loadDefaultAddress() {
    // 1) local override
    const localAddr = getLocalJson(LOCAL_ADDRESS_KEY, null);
    if (
      localAddr?.address_line1 &&
      localAddr?.city &&
      localAddr?.state &&
      localAddr?.postal_code
    ) {
      renderAddressSummary("Saved on this device", localAddr);
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
      setPageStatus(
        "Could not load orders to get a delivery address.",
        "warning",
      );
      return null;
    }

    const orders = Array.isArray(res.data) ? res.data : [];
    if (!orders.length) {
      renderAddressSummary("No orders yet", null);
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

    if (
      inferred.address_line1 &&
      inferred.city &&
      inferred.state &&
      inferred.postal_code
    ) {
      renderAddressSummary("Newest order", inferred);
      setPageStatus("Loaded address from your newest order.", "success");
      return inferred;
    }

    renderAddressSummary("No usable address found", null);
    setPageStatus(
      "Orders loaded, but no usable address fields were found.",
      "warning",
    );
    return null;
  }

  function prefillAddressModal(addressObj) {
    // Prefill modal inputs (local first, then inferred)
    const a = addressObj || getLocalJson(LOCAL_ADDRESS_KEY, null) || null;

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

    // Support a few shapes:
    // - ["Farm A", "Farm B"]
    // - [{farm_name:"..."}, {farm:"..."}]
    const names = favorites
      .map((f) => {
        if (typeof f === "string") return f;
        return f?.farm_name ?? f?.farm ?? f?.name ?? "";
      })
      .map((s) => String(s || "").trim())
      .filter(Boolean);

    favoritesListEl.innerHTML = names
      .map((name) => {
        return `
        <div class="d-flex align-items-center justify-content-between border rounded-4 bg-white p-3">
          <div class="fw-semibold">${CC.escapeHtml(name)}</div>
          <a class="btn cc-btn-outline btn-sm" href="index.html?farm=${encodeURIComponent(name)}">Shop</a>
        </div>
      `;
      })
      .join("");

    favoritesNoteEl &&
      (favoritesNoteEl.textContent = `Loaded ${names.length} favorite farm(s).`);
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

    const res = await apiGetFarms();

    if (res.status === 401) {
      // Some APIs allow farms unauth; if you require auth and it fails, just show a neutral message.
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
        <h3>You are the owner of: ${CC.escapeHtml(owned.name)}<h3>
        <p style="font-size:medium">${CC.escapeHtml(owned.f.description)}</p>
        <p style="font-size:medium"> Located in: ${CC.escapeHtml(owned.f.location)}</p>
      </div>
    `;
  }

  // -------------------------
  // Events
  // -------------------------
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

        setPageStatus("Profile saved.", "success");
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

    addressForm?.addEventListener("submit", (e) => {
      e.preventDefault();

      const payload = {
        address_line1: String(addrLine1El?.value || "").trim(),
        city: String(addrCityEl?.value || "").trim(),
        state: String(addrStateEl?.value || "").trim(),
        postal_code: String(addrZipEl?.value || "").trim(),
        country: "US",
      };

      if (
        !payload.address_line1 ||
        !payload.city ||
        !payload.state ||
        !payload.postal_code
      ) {
        setInlineStatus(
          addressModalStatusEl,
          "Please fill out all address fields.",
          "danger",
        );
        return;
      }

      setLocalJson(LOCAL_ADDRESS_KEY, payload);
      renderAddressSummary("Saved on this device", payload);
      setPageStatus("Saved address locally.", "success");
      setInlineStatus(addressModalStatusEl, "Saved!", "success");

      // Close modal
      const modalEl = document.getElementById("addressModal");
      if (modalEl && window.bootstrap?.Modal) {
        const instance =
          window.bootstrap.Modal.getInstance(modalEl) ||
          new window.bootstrap.Modal(modalEl);
        instance.hide();
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

  // -------------------------
  // Init
  // -------------------------
  CC.onReady(async () => {
    // This page is account-only, but we still let page.js handle auth UI toggles.
    if (!CC.auth.isLoggedIn()) return;

    setPageStatus("Loading account…", "muted");

    apiUpdateName();

    const auth = CC.auth.getAuth?.() || null;
    const picked = pickUserFromAuth(auth);

    const username = picked.username;
    const email = picked.email;

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
    prefillAddressModal(getLocalJson(LOCAL_ADDRESS_KEY, null) || inferred);

    // Load favorites + provider info
    await Promise.allSettled([loadFavorites(), loadProviderInfo(username)]);

    wireEvents(userKey, username, email);
    setPageStatus("Account loaded.", "success");
  });
})();
