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

  var EXTERNAL_PROVIDER_IFPA = "ifpa";
  var EXTERNAL_PROVIDER_STERN = "stern_insider";

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
    var base = {
      user_id: userId,
      email: email || "",
      first_name: "",
      last_name: "",
      display_name: "",
      avatar_url: "",
      ifpa_player_id: "",
      stern_insider_username: ""
    };
    if (!client) return base;

    var result = await client
      .from("members")
      .select("id,user_id,email,first_name,last_name,display_name,avatar_url,created_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }
    if (result.data) {
      base = result.data;
    }

    var externalRows = [];
    var externalRpc = await client.rpc("snh_get_my_external_accounts");
    if (!externalRpc.error) {
      var rpcData = externalRpc.data;
      if (typeof rpcData === "string") {
        try {
          rpcData = JSON.parse(rpcData);
        } catch (e) {
          rpcData = [];
        }
      }
      if (Array.isArray(rpcData)) {
        externalRows = rpcData;
      } else if (rpcData && typeof rpcData === "object") {
        externalRows = [rpcData];
      }
    } else if (base.id) {
      var externalResult = await client
        .from("external_accounts")
        .select("provider_slug,account_handle,account_url")
        .eq("member_id", base.id);
      if (!externalResult.error && Array.isArray(externalResult.data)) {
        externalRows = externalResult.data;
      }
    }

    for (var i = 0; i < externalRows.length; i += 1) {
      var ext = externalRows[i] || {};
      var slug = String(ext.provider_slug || "").toLowerCase();
      if (slug === EXTERNAL_PROVIDER_IFPA || slug === "ifpa_player" || slug === "ifpa_profile") {
        var ifpaDigits = String(ext.account_handle || "").replace(/\D/g, "").slice(0, 12);
        if (ifpaDigits) {
          base.ifpa_player_id = ifpaDigits;
        }
      } else if (
        slug === EXTERNAL_PROVIDER_STERN ||
        slug === "stern" ||
        slug === "sterninsider" ||
        slug === "stern_insider_username"
      ) {
        var sternHandle = String(ext.account_handle || "").trim();
        if (sternHandle) {
          base.stern_insider_username = sternHandle;
        }
      }
    }

    return base;
  }

  /** Canonical IFPA web profile URL for a numeric player id (digits only, max 12). */
  function buildIfpaPlayerProfileUrl(playerId) {
    var id = playerId ? String(playerId).replace(/\D/g, "").slice(0, 12) : "";
    if (!id) return "";
    return "https://www.ifpapinball.com/player.php?p=" + id;
  }

  async function upsertExternalAccount(memberId, providerSlug, accountHandle, accountUrl) {
    var client = getClient();
    if (!client || !memberId || !providerSlug) return;
    var handle = accountHandle ? String(accountHandle).trim() : "";
    var url = accountUrl ? String(accountUrl).trim() : "";
    if (!handle && !url) {
      await client.from("external_accounts").delete().eq("member_id", memberId).eq("provider_slug", providerSlug);
      return;
    }
    var result = await client.from("external_accounts").upsert(
      {
        member_id: memberId,
        provider_slug: providerSlug,
        account_handle: handle,
        account_url: url
      },
      { onConflict: "member_id,provider_slug" }
    );
    if (result.error) throw result.error;
  }

  async function upsertProfile(profile) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");

    var row = {
      user_id: profile.user_id,
      email: profile.email,
      first_name: profile.first_name,
      last_name: profile.last_name,
      display_name: profile.display_name
    };
    if (Object.prototype.hasOwnProperty.call(profile, "avatar_url")) {
      row.avatar_url = profile.avatar_url ? String(profile.avatar_url).trim() : "";
    }
    var result = await client
      .from("members")
      .upsert(row, { onConflict: "user_id" })
      .select("id,user_id,email,first_name,last_name,display_name,avatar_url,created_at")
      .single();
    if (result.error) throw result.error;

    var memberId = result && result.data && result.data.id ? result.data.id : "";
    if (memberId) {
      var ifpaDigitsForExternal = Object.prototype.hasOwnProperty.call(profile, "ifpa_player_id")
        ? String(profile.ifpa_player_id || "").replace(/\D/g, "").slice(0, 12)
        : "";
      var sternHandleForExternal = Object.prototype.hasOwnProperty.call(profile, "stern_insider_username")
        ? String(profile.stern_insider_username || "").trim()
        : "";
      await upsertExternalAccount(
        memberId,
        EXTERNAL_PROVIDER_IFPA,
        ifpaDigitsForExternal,
        buildIfpaPlayerProfileUrl(ifpaDigitsForExternal)
      );
      await upsertExternalAccount(memberId, EXTERNAL_PROVIDER_STERN, sternHandleForExternal, "");
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

  /** Canonical role groups used by members UI + Supabase policy assumptions. */
  var ROLE_GROUPS = Object.freeze({
    MEMBERSHIP_MANAGE_ACCESS: Object.freeze(["membership_editor", "membership_admin", "club_admin"]),
    EVENTS_MANAGE_ACCESS: Object.freeze(["events_editor", "events_admin", "club_admin"]),
    EVENTS_DELETE_ACCESS: Object.freeze(["events_admin", "club_admin"]),
    PHOTOS_ACCESS: Object.freeze(["photos_editor", "photos_admin", "club_admin"]),
    GAMES_ACCESS: Object.freeze(["games_editor", "games_admin", "club_admin"])
  });

  function uniqueRoleList(roleArrays) {
    var out = [];
    for (var i = 0; i < roleArrays.length; i += 1) {
      var arr = roleArrays[i] || [];
      for (var j = 0; j < arr.length; j += 1) {
        if (out.indexOf(arr[j]) === -1) out.push(arr[j]);
      }
    }
    return out;
  }

  function rolesToCsv(rolesList) {
    return (rolesList || []).join(",");
  }

  /** Role slugs assignable from the member admin panel (matches portal RBAC groups). */
  var ASSIGNABLE_MEMBER_ROLES = Object.freeze(
    uniqueRoleList([
      ROLE_GROUPS.MEMBERSHIP_MANAGE_ACCESS,
      ROLE_GROUPS.EVENTS_MANAGE_ACCESS,
      ROLE_GROUPS.PHOTOS_ACCESS,
      ROLE_GROUPS.GAMES_ACCESS
    ])
  );

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

  async function listEventsForAdmin() {
    var client = getClient();
    if (!client) return null;
    var result = await client
      .from("events")
      .select("id,title,description,location,starts_at,external_url,source,published,updated_at")
      .order("starts_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (result.error) return null;
    return Array.isArray(result.data) ? result.data : [];
  }

  async function saveEventForAdmin(eventInput) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var payload = {
      title: eventInput.title,
      description: eventInput.description || null,
      location: eventInput.location || null,
      starts_at: eventInput.starts_at || null,
      external_url: eventInput.external_url || null,
      source: eventInput.source || "manual",
      published: !!eventInput.published
    };
    if (eventInput.id) {
      payload.id = eventInput.id;
    }
    var result = await client
      .from("events")
      .upsert(payload, { onConflict: "id" })
      .select("id")
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function deleteEventForAdmin(eventId) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.from("events").delete().eq("id", eventId);
    if (result.error) throw result.error;
  }

  async function gamesEditorLoad() {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_editor_load");
    if (result.error) throw result.error;
    var data = result.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (e) {
        data = null;
      }
    }
    return data;
  }

  async function gamesUpsert(gameId, fields) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_upsert", { p_game_id: gameId, p_fields: fields });
    if (result.error) throw result.error;
  }

  async function gamesUpsertStint(gameId, stint) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_upsert_stint", { p_game_id: gameId, p_stint: stint });
    if (result.error) throw result.error;
    return result.data;
  }

  async function gamesDeleteStint(stintId) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_delete_stint", { p_stint_id: stintId });
    if (result.error) throw result.error;
  }

  async function gamesSetManualAtClub(gameId, overrideBool, note) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_set_manual_at_club", {
      p_game_id: gameId,
      p_override: overrideBool,
      p_note: note || null
    });
    if (result.error) throw result.error;
  }

  async function gamesClearManualAtClub(gameId) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_clear_manual_at_club", { p_game_id: gameId });
    if (result.error) throw result.error;
  }

  async function gamesGetSaleListing(gameId) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_get_sale_listing", { p_game_id: gameId });
    if (result.error) throw result.error;
    return result.data;
  }

  async function gamesSetSaleListing(gameId, listing) {
    var client = getClient();
    if (!client) throw new Error("Supabase is not available.");
    var result = await client.rpc("snh_games_set_sale_listing", { p_game_id: gameId, p_listing: listing });
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
    ROLE_GROUPS: ROLE_GROUPS,
    rolesToCsv: rolesToCsv,
    ASSIGNABLE_MEMBER_ROLES: ASSIGNABLE_MEMBER_ROLES,
    fetchMemberAdminStats: fetchMemberAdminStats,
    listMembersForAdmin: listMembersForAdmin,
    grantMemberRole: grantMemberRole,
    revokeMemberRole: revokeMemberRole,
    listEventsForAdmin: listEventsForAdmin,
    saveEventForAdmin: saveEventForAdmin,
    deleteEventForAdmin: deleteEventForAdmin,
    gamesEditorLoad: gamesEditorLoad,
    gamesUpsert: gamesUpsert,
    gamesUpsertStint: gamesUpsertStint,
    gamesDeleteStint: gamesDeleteStint,
    gamesSetManualAtClub: gamesSetManualAtClub,
    gamesClearManualAtClub: gamesClearManualAtClub,
    gamesGetSaleListing: gamesGetSaleListing,
    gamesSetSaleListing: gamesSetSaleListing,
    buildIfpaPlayerProfileUrl: buildIfpaPlayerProfileUrl,
    formatDate: formatDate,
    isPasswordRecoveryIntentActive: isPasswordRecoveryIntentActive,
    clearPasswordRecoveryIntent: clearPasswordRecoveryIntent,
    capturePasswordRecoveryIntentFromLocation: capturePasswordRecoveryIntentFromLocation
  };

  capturePasswordRecoveryIntentFromLocation();
  attachPasswordRecoveryListener();
})();
