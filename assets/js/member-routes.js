(function () {
  var PANEL_IDS = Object.freeze([
    "profile", "membership", "club-issues", "member-admin", "events", "photos", "games"
  ]);
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function validPanel(value) {
    var panel = String(value || "").trim();
    return PANEL_IDS.indexOf(panel) !== -1 ? panel : "";
  }

  function validUuid(value) {
    var id = String(value || "").trim();
    return UUID_RE.test(id) ? id : "";
  }

  function read(locationLike) {
    var loc = locationLike || window.location;
    var params = new URLSearchParams(loc.search || "");
    var panel = validPanel(params.get("panel"));
    if (!panel && String(loc.hash || "").indexOf("type=recovery") === -1) {
      panel = validPanel(String(loc.hash || "").replace(/^#/, ""));
    }
    panel = panel || "profile";
    return {
      panel: panel,
      gameId: panel === "games" ? validUuid(params.get("game")) : ""
    };
  }

  function build(panelId, options, locationLike) {
    options = options || {};
    var loc = locationLike || window.location;
    var panel = validPanel(panelId) || "profile";
    var params = new URLSearchParams(loc.search || "");

    if (panel === "profile") params.delete("panel");
    else params.set("panel", panel);

    if (panel !== "games") {
      params.delete("game");
    } else if (Object.prototype.hasOwnProperty.call(options, "gameId")) {
      var gameId = validUuid(options.gameId);
      if (gameId) params.set("game", gameId);
      else params.delete("game");
    } else if (!validUuid(params.get("game"))) {
      params.delete("game");
    }

    var query = params.toString();
    return (loc.pathname || "members.html") + (query ? "?" + query : "");
  }

  function replacePanel(panelId, options) {
    var url = build(panelId, options);
    window.history.replaceState(null, "", url);
    return url;
  }

  function setGame(gameId) {
    return replacePanel("games", { gameId: gameId });
  }

  window.SNHMemberRoutes = {
    PANEL_IDS: PANEL_IDS,
    validPanel: validPanel,
    validUuid: validUuid,
    read: read,
    build: build,
    replacePanel: replacePanel,
    setGame: setGame
  };
})();
