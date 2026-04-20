(function () {
  const IMAGE_BASE_PATH = "assets/images/machines";
  const GAMES_URL = "data/games.json";
  const INTERVAL_MS = 3000;

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
      const response = await fetch(GAMES_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = await response.json();
      const all = []
        .concat(data.currentGames || [], data.previousGames || [])
        .filter(function (g) {
          return g && g.imageFilename;
        });
      if (all.length === 0) return;

      shuffleInPlace(all);
      let currentIndex = 0;
      function showCurrent() {
        const g = all[currentIndex];
        imgElement.src = IMAGE_BASE_PATH + "/" + g.imageFilename;
        imgElement.alt = g.title + " — pinball machine from the club collection";
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
