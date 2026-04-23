const IMAGE_BASE_PATH = "assets/images/machines";
const KINETICIST_ICON_PATH = "assets/images/kineticist-k.png";
const PINSIDE_ICON_PATH = "assets/images/pinside_logo-ball.png";
/** Rasterized from the www.ipdb.org favicon for consistency with other provider PNGs. */
const IPDB_ICON_PATH = "assets/images/ipdb-favicon.png";
const GAMES_URL = "data/games.json";

/**
 * @param {{ address?: string, joinedClubDate?: string, leftClubDate?: string, pinballMapLocationId?: number }[]} stints
 */
function formatLocationStints(stints) {
  if (!Array.isArray(stints) || stints.length === 0) {
    return "";
  }
  const lines = [];
  for (const s of stints) {
    const where = (s.address && String(s.address).trim()) || "Club location";
    const from = s.joinedClubDate ? String(s.joinedClubDate).trim() : "";
    const through = s.leftClubDate ? String(s.leftClubDate).trim() : "";
    let line = where;
    if (from && through) {
      line += `: ${from} – ${through}`;
    } else if (from) {
      line += `: from ${from}`;
    } else if (through) {
      line += `: through ${through}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

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

    const stintsText = formatLocationStints(game.locationStints);
    if (stintsText) {
      const stintsEl = document.createElement("p");
      stintsEl.className = "games-location-stints";
      stintsEl.textContent = stintsText;
      item.appendChild(stintsEl);
    }

    const kineticistUrl = game.kineticistUrl;
    const pinsideUrl = game.pinsideUrl;
    const ipdbUrl = game.ipdbUrl;
    if (kineticistUrl || pinsideUrl || ipdbUrl) {
      const linkRow = document.createElement("div");
      linkRow.className = "games-actions";

      if (kineticistUrl) {
        const kineticistLink = document.createElement("a");
        kineticistLink.className = "games-provider-link games-kineticist-link";
        kineticistLink.href = kineticistUrl;
        kineticistLink.target = "_blank";
        kineticistLink.rel = "noopener";
        kineticistLink.title = `View ${game.title} on Kineticist`;
        kineticistLink.setAttribute("aria-label", `View ${game.title} on Kineticist`);

        const kineticistIcon = document.createElement("img");
        kineticistIcon.className = "games-provider-icon";
        kineticistIcon.src = KINETICIST_ICON_PATH;
        kineticistIcon.alt = "";
        kineticistIcon.loading = "lazy";
        kineticistIcon.decoding = "async";
        kineticistLink.appendChild(kineticistIcon);

        linkRow.appendChild(kineticistLink);
      }

      if (pinsideUrl) {
        const pinsideLink = document.createElement("a");
        pinsideLink.className = "games-provider-link games-pinside-link";
        pinsideLink.href = pinsideUrl;
        pinsideLink.target = "_blank";
        pinsideLink.rel = "noopener";
        pinsideLink.title = `View ${game.title} on Pinside`;
        pinsideLink.setAttribute("aria-label", `View ${game.title} on Pinside`);

        const pinsideIcon = document.createElement("img");
        pinsideIcon.className = "games-provider-icon";
        pinsideIcon.src = PINSIDE_ICON_PATH;
        pinsideIcon.alt = "";
        pinsideIcon.loading = "lazy";
        pinsideIcon.decoding = "async";
        pinsideLink.appendChild(pinsideIcon);

        linkRow.appendChild(pinsideLink);
      }

      if (ipdbUrl) {
        const ipdbLink = document.createElement("a");
        ipdbLink.className = "games-provider-link games-ipdb-link";
        ipdbLink.href = ipdbUrl;
        ipdbLink.target = "_blank";
        ipdbLink.rel = "noopener";
        ipdbLink.title = `View ${game.title} on the Internet Pinball Database`;
        ipdbLink.setAttribute("aria-label", `View ${game.title} on the Internet Pinball Database`);

        const ipdbIcon = document.createElement("img");
        ipdbIcon.className = "games-provider-icon";
        ipdbIcon.src = IPDB_ICON_PATH;
        ipdbIcon.alt = "";
        ipdbIcon.loading = "lazy";
        ipdbIcon.decoding = "async";
        ipdbLink.appendChild(ipdbIcon);

        linkRow.appendChild(ipdbLink);
      }

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
