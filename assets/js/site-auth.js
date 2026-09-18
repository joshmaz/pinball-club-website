(function () {
  var sessionPromise = null;
  var rolesPromiseByUserId = Object.create(null);

  var ROLE_GROUPS = Object.freeze({
    MEMBERSHIP_MANAGE_ACCESS: Object.freeze(["membership_editor", "membership_admin", "club_admin"]),
    EVENTS_MANAGE_ACCESS: Object.freeze(["events_editor", "events_admin", "club_admin"]),
    EVENTS_DELETE_ACCESS: Object.freeze(["events_admin", "club_admin"]),
    PHOTOS_ACCESS: Object.freeze(["photos_editor", "photos_admin", "club_admin"]),
    GAMES_ACCESS: Object.freeze(["games_editor", "games_admin", "club_admin"])
  });

  var CAPABILITY_ROLES = Object.freeze({
    "membership.manage": ROLE_GROUPS.MEMBERSHIP_MANAGE_ACCESS,
    "events.manage": ROLE_GROUPS.EVENTS_MANAGE_ACCESS,
    "events.delete": ROLE_GROUPS.EVENTS_DELETE_ACCESS,
    "photos.manage": ROLE_GROUPS.PHOTOS_ACCESS,
    "games.manage": ROLE_GROUPS.GAMES_ACCESS
  });

  function getClient() {
    return window.snhSupabase || null;
  }

  async function getSession(options) {
    options = options || {};
    if (!sessionPromise || options.refresh) {
      var client = getClient();
      if (!client || !client.auth) return null;
      sessionPromise = client.auth.getSession().then(function (result) {
        if (result && result.error) throw result.error;
        return result && result.data ? result.data.session : null;
      }).catch(function (err) {
        sessionPromise = null;
        throw err;
      });
    }
    return sessionPromise;
  }

  async function getCurrentUser(options) {
    var session = await getSession(options);
    return session && session.user ? session.user : null;
  }

  function clearCache() {
    sessionPromise = null;
    rolesPromiseByUserId = Object.create(null);
  }

  function onAuthStateChange(callback) {
    var client = getClient();
    if (!client || !client.auth || typeof client.auth.onAuthStateChange !== "function") {
      return { data: { subscription: null } };
    }
    return client.auth.onAuthStateChange(function (event, session) {
      sessionPromise = Promise.resolve(session || null);
      rolesPromiseByUserId = Object.create(null);
      if (typeof callback === "function") callback(event, session || null);
    });
  }

  async function signOut() {
    var client = getClient();
    if (!client || !client.auth) return;
    var result = await client.auth.signOut();
    clearCache();
    if (result && result.error) throw result.error;
  }

  function currentRelativeUrl() {
    var pathname = window.location.pathname.split("/").pop() || "members.html";
    return pathname + (window.location.search || "") + (window.location.hash || "");
  }

  async function requireAuth(options) {
    options = options || {};
    var session = await getSession();
    if (session && session.user) return session;
    if (options.redirectToSignin) {
      var next = encodeURIComponent(options.next || currentRelativeUrl());
      window.location.href = "signin.html?next=" + next;
    }
    return null;
  }

  async function fetchMemberRoles(userId, options) {
    options = options || {};
    if (!userId) return [];
    if (!rolesPromiseByUserId[userId] || options.refresh) {
      var client = getClient();
      if (!client) return [];
      rolesPromiseByUserId[userId] = (async function () {
        var memberResult = await client.from("members").select("id").eq("user_id", userId).maybeSingle();
        if (memberResult.error || !memberResult.data || !memberResult.data.id) return [];
        var rolesResult = await client
          .from("member_roles")
          .select("role_slug")
          .eq("member_id", memberResult.data.id);
        if (rolesResult.error) return [];
        return (rolesResult.data || [])
          .map(function (row) { return row && row.role_slug ? String(row.role_slug) : ""; })
          .filter(Boolean);
      })().catch(function (err) {
        delete rolesPromiseByUserId[userId];
        throw err;
      });
    }
    return rolesPromiseByUserId[userId];
  }

  function memberHasAnyRole(userRoles, requiredRoles) {
    var req = Array.isArray(requiredRoles)
      ? requiredRoles
      : String(requiredRoles || "").split(",");
    req = req.map(function (role) { return String(role).trim(); }).filter(Boolean);
    if (!req.length) return true;
    var roles = userRoles || [];
    return req.some(function (role) { return roles.indexOf(role) !== -1; });
  }

  function rolesToCsv(rolesList) {
    return (rolesList || []).join(",");
  }

  function can(userRoles, capability) {
    var requiredRoles = CAPABILITY_ROLES[String(capability || "")];
    return !!requiredRoles && memberHasAnyRole(userRoles, requiredRoles);
  }

  window.SNHSiteAuth = {
    ROLE_GROUPS: ROLE_GROUPS,
    CAPABILITY_ROLES: CAPABILITY_ROLES,
    getSession: getSession,
    getCurrentUser: getCurrentUser,
    onAuthStateChange: onAuthStateChange,
    signOut: signOut,
    requireAuth: requireAuth,
    fetchMemberRoles: fetchMemberRoles,
    memberHasAnyRole: memberHasAnyRole,
    rolesToCsv: rolesToCsv,
    can: can,
    clearCache: clearCache
  };

  // Keep cached state accurate when Supabase refreshes, signs in, or signs out.
  onAuthStateChange();
})();
