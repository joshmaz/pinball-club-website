(function () {
  const INTERVAL_MS = 3000;

  async function fetchGames() {
    const result = await window.SNHPublicData.loadGames();
    return result.data;
  }

  function resolveImage(game) {
    if (game && game.primaryImage && game.primaryImage.url) return String(game.primaryImage.url).trim();
    return "";
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
      const pause = document.getElementById("gallery-pause");
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      let paused = motion.matches;
      function syncPause() {
        if (!pause) return;
        pause.hidden = false;
        pause.textContent = paused ? 'Play slideshow' : 'Pause slideshow';
        pause.setAttribute('aria-pressed', String(paused));
      }
      if (pause) pause.addEventListener('click', () => { paused = !paused; syncPause(); });
      motion.addEventListener('change', () => { paused = motion.matches; syncPause(); });
      syncPause();
      setInterval(function () {
        if (paused || document.hidden) return;
        currentIndex = (currentIndex + 1) % all.length;
        showCurrent();
      }, INTERVAL_MS);
    } catch (err) {
      console.error("Home gallery:", err);
    }
  }

  init();
})();
