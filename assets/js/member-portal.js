(function () {
  function getClient() {
    return window.snhSupabase || null;
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

    if (statusEl) {
      statusEl.textContent = user ? "Signed in as " + user.email : "";
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
    requireAuth: requireAuth,
    applyAuthChrome: applyAuthChrome,
    fetchProfile: fetchProfile,
    upsertProfile: upsertProfile,
    fetchMembership: fetchMembership,
    formatDate: formatDate
  };
})();
