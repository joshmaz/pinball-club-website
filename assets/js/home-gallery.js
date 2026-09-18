(function () {
  const IMAGE_BASE_PATH = "assets/images/machines";
  const GAMES_URL = "data/games.json";
  const INTERVAL_MS = 3000;

  function catalogSourceIsDb() {
    return !!(window.SNH_CONFIG && window.SNH_CONFIG.gamesCatalogSource === "db");
  }

  async function fetchGames() {
    if (catalogSourceIsDb()) {
      const client = window.snhSupabase;
      if (!client || typeof client.from !== "function") throw new Error("Supabase client not available.");
      const result = await client.from("games_catalog_v1").select("game");
      if (result.error) throw result.error;
      return (result.data || []).map(function (row) { return row && row.game; }).filter(Boolean);
    }
    const response = await fetch(GAMES_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const data = await response.json();
    return data.games || [];
  }

  function resolveImage(game) {
    if (game && game.primaryImage && game.primaryImage.url) return String(game.primaryImage.url).trim();
    return game && game.imageFilename ? IMAGE_BASE_PATH + "/" + game.imageFilename : "";
  }

  function shuffleInPlace(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = array[i];
      array[i] = array[j];
      array[j] = t;
    }
    return array;
  }

  async function init() {
    const imgElement = document.getElementById("gallery-image");
    if (!imgElement) return;

    try {
      const games = await fetchGames();
      const all = games.filter(function (g) {
        return resolveImage(g);
      });
      if (all.length === 0) return;

      shuffleInPlace(all);
      let currentIndex = 0;
      function showCurrent() {
        const g = all[currentIndex];
        imgElement.src = resolveImage(g);
        imgElement.alt = g.title + ", pinball machine from the club collection";
      }
      showCurrent();
      setInterval(function () {
        currentIndex = (currentIndex + 1) % all.length;
        showCurrent();
      }, INTERVAL_MS);
    } catch (err) {
      console.error("Home gallery:", err);
    }
  }

  init();
})();
