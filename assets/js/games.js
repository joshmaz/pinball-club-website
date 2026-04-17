const IMAGE_BASE_PATH = "assets/images/machines";
const KINETICIST_ICON_PATH = "assets/images/kineticist-k.png";
const GAMES_URL = "data/games.json";

function createGamesList(games) {
  const list = document.createElement("ul");
  list.className = "games-list";

  for (const game of games) {
    const item = document.createElement("li");
    item.className = "games-list-item";

    const title = document.createElement("strong");
    title.textContent = game.title;
    item.appendChild(title);

    const filename = game.imageFilename;
    const imagePath = filename ? `${IMAGE_BASE_PATH}/${filename}` : "";
    if (imagePath) {
      const image = document.createElement("img");
      image.className = "game-card-image";
      image.src = imagePath;
      image.alt = game.title;
      image.loading = "lazy";
      item.appendChild(image);
    }

    const details = document.createElement("p");
    details.className = "games-details";
    details.textContent = game.details;
    item.appendChild(details);

    const kineticistUrl = game.kineticistUrl;
    if (kineticistUrl) {
      const linkRow = document.createElement("div");
      linkRow.className = "games-actions";

      const link = document.createElement("a");
      link.className = "games-kineticist-link";
      link.href = kineticistUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = `View ${game.title} on Kineticist`;
      link.setAttribute("aria-label", `View ${game.title} on Kineticist`);

      const icon = document.createElement("img");
      icon.className = "games-kineticist-icon";
      icon.src = KINETICIST_ICON_PATH;
      icon.alt = "";
      icon.loading = "lazy";
      icon.decoding = "async";
      link.appendChild(icon);

      linkRow.appendChild(link);

      item.appendChild(linkRow);
    }

    list.appendChild(item);
  }

  return list;
}

function showMessage(container, title, details) {
  container.replaceChildren();
  const card = document.createElement("div");
  card.className = "games-list-item";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const p = document.createElement("p");
  p.textContent = details;
  card.appendChild(h3);
  card.appendChild(p);
  container.appendChild(card);
}

function renderGames(currentGames, previousGames) {
  const currentContainer = document.getElementById("games-current");
  const previousContainer = document.getElementById("games-previous");

  if (currentContainer) {
    currentContainer.replaceChildren(createGamesList(currentGames));
  }
  if (previousContainer) {
    previousContainer.replaceChildren(createGamesList(previousGames));
  }
}

async function loadGames() {
  const currentContainer = document.getElementById("games-current");
  const previousContainer = document.getElementById("games-previous");
  if (!currentContainer || !previousContainer) {
    console.error("Games containers were not found.");
    return;
  }

  try {
    const response = await fetch(GAMES_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status} ${response.statusText}) for ${GAMES_URL}`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error(`Invalid data in ${GAMES_URL}`);
    }
    if (!Array.isArray(data.currentGames) || !Array.isArray(data.previousGames)) {
      throw new Error(`Invalid data format in ${GAMES_URL}: expected currentGames and previousGames arrays.`);
    }

    renderGames(data.currentGames, data.previousGames);
  } catch (error) {
    console.error("Error loading games:", error);
    showMessage(
      currentContainer,
      "Unable to load games",
      `We could not load the games list right now. Details: ${error.message}`
    );
    showMessage(previousContainer, "Unable to load previous titles", "Please try again in a moment.");
  }
}

loadGames();
