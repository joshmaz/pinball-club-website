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
    var base = { user_id: userId, email: email || "", display_name: "" };
    if (!client) return base;

    var result = await client
      .from("members")
      .select("id,user_id,email,display_name,created_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }
    if (result.data) {
      base = result.data;
    }

    var user = null;
    var userResult = await client.auth.getUser();
    if (userResult && userResult.data && userResult.data.user && !userResult.error) {
      user = userResult.data.user;
    }
    var meta = (user && user.user_metadata) || {};
    base.avatar_url = typeof meta.avatar_url === "string" ? meta.avatar_url : "";
    base.ifpa_player_id = readIfpaPlayerIdFromMetadata(meta);
    return base;
  }

  function readIfpaPlayerIdFromMetadata(meta) {
    meta = meta || {};
    if (meta.ifpa_player_id != null && String(meta.ifpa_player_id).trim() !== "") {
      var id = String(meta.ifpa_player_id).replace(/\D/g, "").slice(0, 12);
      if (id) return id;
    }
    if (typeof meta.ifpa_profile_url === "string") {
      var m = meta.ifpa_profile_url.match(/[?&]p=(\d+)/i);
      if (m && m[1]) return m[1].slice(0, 12);
    }
    return "";
  }

  /** Canonical IFPA web profile URL for a numeric player id (digits only, max 12). */
  function buildIfpaPlayerProfileUrl(playerId) {
    var id = playerId ? String(playerId).replace(/\D/g, "").slice(0, 12) : "";
    if (!id) return "";
    return "https://www.ifpapinball.com/player.php?p=" + id;
  }

  async function upsertProfile(profile) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");

    var row = {
      user_id: profile.user_id,
      email: profile.email,
      display_name: profile.display_name
    };
    var result = await client
      .from("members")
      .upsert(row, { onConflict: "user_id" })
      .select("id,user_id,email,display_name,created_at")
      .single();
    if (result.error) throw result.error;

    var wantsMeta =
      Object.prototype.hasOwnProperty.call(profile, "avatar_url") ||
      Object.prototype.hasOwnProperty.call(profile, "ifpa_player_id");
    if (wantsMeta) {
      var sessionResult = await client.auth.getSession();
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
      var existing = (session && session.user && session.user.user_metadata) || {};
      var nextMeta = Object.assign({}, existing);
      if (Object.prototype.hasOwnProperty.call(profile, "avatar_url")) {
        nextMeta.avatar_url = profile.avatar_url ? String(profile.avatar_url).trim() : "";
      }
      if (Object.prototype.hasOwnProperty.call(profile, "ifpa_player_id")) {
        var ifpaDigits = profile.ifpa_player_id ? String(profile.ifpa_player_id).replace(/\D/g, "").slice(0, 12) : "";
        nextMeta.ifpa_player_id = ifpaDigits;
        nextMeta.ifpa_profile_url = "";
      }
      var metaResult = await client.auth.updateUser({ data: nextMeta });
      if (metaResult.error) throw metaResult.error;
    }

    return result.data;
  }

  /**
   * Role slugs from public.member_roles for this auth user (via members.id).
   * Returns [] if no member row, table missing, or RLS/query error.
   */
  async function fetchMemberRoles(userId) {
    if (!userId) return [];
    var client = getClient();
    if (!client) return [];

    var memberResult = await client.from("members").select("id").eq("user_id", userId).maybeSingle();
    if (memberResult.error || !memberResult.data || !memberResult.data.id) {
      return [];
    }

    var rolesResult = await client
      .from("member_roles")
      .select("role_slug")
      .eq("member_id", memberResult.data.id);
    if (rolesResult.error) {
      return [];
    }
    var rows = rolesResult.data || [];
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].role_slug) out.push(String(rows[i].role_slug));
    }
    return out;
  }

  function memberHasAnyRole(userRoles, rolesCsv) {
    if (!rolesCsv || !String(rolesCsv).trim()) return true;
    var req = String(rolesCsv)
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    if (!req.length) return true;
    for (var i = 0; i < req.length; i += 1) {
      if (userRoles.indexOf(req[i]) !== -1) return true;
    }
    return false;
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

  /** Role slugs assignable from the member admin panel (matches member_roles check + portal RBAC). */
  var ASSIGNABLE_MEMBER_ROLES = Object.freeze([
    "club_admin",
    "members_manager",
    "events_editor",
    "events_admin",
    "photos_editor",
    "photos_admin",
    "games_editor",
    "games_admin"
  ]);

  async function fetchMemberAdminStats() {
    var client = getClient();
    if (!client) return null;
    var result = await client.rpc("snh_get_member_admin_stats");
    if (result.error) return null;
    var data = result.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return null;
      }
    }
    return data;
  }

  async function listMembersForAdmin() {
    var client = getClient();
    if (!client) return null;
    var result = await client.rpc("snh_list_members_for_admin");
    if (result.error) return null;
    var data = result.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return null;
      }
    }
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") return [data];
    return [];
  }

  async function grantMemberRole(memberId, roleSlug) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_grant_member_role", {
      p_member_id: memberId,
      p_role_slug: roleSlug
    });
    if (result.error) throw result.error;
  }

  async function revokeMemberRole(memberId, roleSlug) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_revoke_member_role", {
      p_member_id: memberId,
      p_role_slug: roleSlug
    });
    if (result.error) throw result.error;
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
    fetchMemberRoles: fetchMemberRoles,
    memberHasAnyRole: memberHasAnyRole,
    ASSIGNABLE_MEMBER_ROLES: ASSIGNABLE_MEMBER_ROLES,
    fetchMemberAdminStats: fetchMemberAdminStats,
    listMembersForAdmin: listMembersForAdmin,
    grantMemberRole: grantMemberRole,
    revokeMemberRole: revokeMemberRole,
    buildIfpaPlayerProfileUrl: buildIfpaPlayerProfileUrl,
    formatDate: formatDate,
    isPasswordRecoveryIntentActive: isPasswordRecoveryIntentActive,
    clearPasswordRecoveryIntent: clearPasswordRecoveryIntent,
    capturePasswordRecoveryIntentFromLocation: capturePasswordRecoveryIntentFromLocation
  };

  capturePasswordRecoveryIntentFromLocation();
  attachPasswordRecoveryListener();
})();
