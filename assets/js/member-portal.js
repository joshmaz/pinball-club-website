(function () {
  var PASSWORD_RECOVERY_STORAGE_KEY = "snh_pw_recovery_v1";
  var PASSWORD_RECOVERY_TTL_MS = 1000 * 60 * 45; // 45 minutes
  var passwordRecoveryListenerAttached = false;

  function getClient() {
    return window.snhSupabase || null;
  }

  function hasPasswordRecoveryHash() {
    return window.location.hash.indexOf("type=recovery") !== -1;
  }

  function setPasswordRecoveryIntent(active) {
    try {
      if (active) {
        var payload = JSON.stringify({
          v: 1,
          exp: Date.now() + PASSWORD_RECOVERY_TTL_MS
        });
        window.sessionStorage.setItem(PASSWORD_RECOVERY_STORAGE_KEY, payload);
      } else {
        window.sessionStorage.removeItem(PASSWORD_RECOVERY_STORAGE_KEY);
      }
    } catch (err) {
      // ignore storage failures (private mode, blocked storage, etc.)
    }
  }

  function isPasswordRecoveryIntentActive() {
    try {
      var raw = window.sessionStorage.getItem(PASSWORD_RECOVERY_STORAGE_KEY);
      if (!raw) return false;

      // Back-compat for older "1" flag
      if (raw === "1") return true;

      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.exp !== "number") {
        window.sessionStorage.removeItem(PASSWORD_RECOVERY_STORAGE_KEY);
        return false;
      }
      if (Date.now() > parsed.exp) {
        window.sessionStorage.removeItem(PASSWORD_RECOVERY_STORAGE_KEY);
        return false;
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function capturePasswordRecoveryIntentFromLocation() {
    if (hasPasswordRecoveryHash()) {
      setPasswordRecoveryIntent(true);
    }
  }

  function attachPasswordRecoveryListener() {
    if (passwordRecoveryListenerAttached) return;
    var client = getClient();
    if (!client || !client.auth || typeof client.auth.onAuthStateChange !== "function") {
      return;
    }

    passwordRecoveryListenerAttached = true;
    client.auth.onAuthStateChange(function (event, session) {
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecoveryIntent(true);
      }
    });
  }

  function clearPasswordRecoveryIntent() {
    setPasswordRecoveryIntent(false);
  }

  function getFriendlyAuthErrorMessage(err) {
    if (!err || !err.message) return "Unable to complete that request right now.";
    return err.message;
  }

  async function getSession() {
    var client = getClient();
    if (!client) return null;
    var result = await client.auth.getSession();
    return result && result.data ? result.data.session : null;
  }

  async function signOut() {
    var client = getClient();
    if (!client) return;
    await client.auth.signOut();
  }

  async function updatePassword(newPassword) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.auth.updateUser({ password: newPassword });
    if (result.error) throw result.error;
    clearPasswordRecoveryIntent();
    return result.data;
  }

  async function updatePasswordWithCurrentPassword(currentPassword, newPassword, email) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    if (!currentPassword) throw new Error("Current password is required.");

    var sessionResult = await client.auth.getSession();
    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
    var userEmail = email || (session && session.user ? session.user.email : "");
    if (!userEmail) throw new Error("Could not verify your account email.");

    var signInResult = await client.auth.signInWithPassword({
      email: userEmail,
      password: currentPassword
    });
    if (signInResult.error) throw signInResult.error;

    return updatePassword(newPassword);
  }

  async function requireAuth(options) {
    options = options || {};
    var session = await getSession();
    if (session && session.user) return session;
    if (options.redirectToSignin) {
      var next = encodeURIComponent(window.location.pathname.split("/").pop() || "members.html");
      window.location.href = "signin.html?next=" + next;
    }
    return null;
  }

  async function applyAuthChrome(options) {
    options = options || {};
    var statusEl = document.getElementById(options.statusElementId || "auth-status");
    var logoutBtn = document.getElementById(options.logoutButtonId || "logout-btn");
    var membersLinks = document.querySelectorAll(options.membersLinkSelector || "[data-members-link]");
    var session = await getSession();
    var user = session && session.user;
    var authLabel = user ? user.email : "";
    var recoveryActive = isPasswordRecoveryIntentActive();

    if (user && user.id) {
      try {
        var profile = await fetchProfile(user.id, user.email);
        if (profile && profile.display_name) {
          authLabel = profile.display_name;
        }
      } catch (err) {
        authLabel = user.email;
      }
    }

    if (statusEl) {
      if (!user) {
        statusEl.textContent = "";
      } else if (recoveryActive) {
        statusEl.textContent = "Password reset in progress for " + authLabel + ".";
      } else {
        statusEl.textContent = "Signed in as " + authLabel;
      }
    }
    if (logoutBtn) {
      logoutBtn.hidden = !user;
    }
    for (var i = 0; i < membersLinks.length; i += 1) {
      membersLinks[i].setAttribute("href", user ? "members.html" : "signin.html");
      membersLinks[i].textContent = user ? "My Account" : "Members";
    }
    return session;
  }

  async function fetchProfile(userId, email) {
    var client = getClient();
    if (!client) return { user_id: userId, email: email || "", display_name: "" };
    var result = await client
      .from("members")
      .select("id,user_id,email,display_name,created_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }
    if (result.data) return result.data;
    return { user_id: userId, email: email || "", display_name: "" };
  }

  async function upsertProfile(profile) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client
      .from("members")
      .upsert(profile, { onConflict: "user_id" })
      .select("id,user_id,email,display_name,created_at")
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function fetchMembership(userId) {
    var client = getClient();
    if (!client) return null;
    var memberResult = await client
      .from("members")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (memberResult.error || !memberResult.data) {
      return null;
    }

    var result = await client
      .from("memberships")
      .select("status,tier,end_date,created_at")
      .eq("member_id", memberResult.data.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) {
      return null;
    }
    return result.data || null;
  }

  function formatDate(isoDate) {
    if (!isoDate) return "Not set";
    var parsed = new Date(isoDate);
    if (Number.isNaN(parsed.getTime())) return "Not set";
    return parsed.toLocaleDateString();
  }

  window.SNHMemberPortal = {
    getFriendlyAuthErrorMessage: getFriendlyAuthErrorMessage,
    getSession: getSession,
    signOut: signOut,
    updatePassword: updatePassword,
    updatePasswordWithCurrentPassword: updatePasswordWithCurrentPassword,
    requireAuth: requireAuth,
    applyAuthChrome: applyAuthChrome,
    fetchProfile: fetchProfile,
    upsertProfile: upsertProfile,
    fetchMembership: fetchMembership,
    formatDate: formatDate,
    isPasswordRecoveryIntentActive: isPasswordRecoveryIntentActive,
    clearPasswordRecoveryIntent: clearPasswordRecoveryIntent,
    capturePasswordRecoveryIntentFromLocation: capturePasswordRecoveryIntentFromLocation
  };

  capturePasswordRecoveryIntentFromLocation();
  attachPasswordRecoveryListener();
})();
