(function () {
  const DESKTOP_MAX_VISIBLE = 9;
  const MOBILE_MAX_VISIBLE = 5;
  const MOBILE_MEDIA_QUERY = "(max-width: 700px)";
  const HIGHLIGHTS_URL = "data/highlights.json";
  const STATIC_IMAGE_BASE = "assets/images/highlights/processed/";

  function shuffleInPlace(array) {
    for (let i = array.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
    return array;
  }

  function pickVariant(asset, name) {
    const variants = (asset && asset.variants) || [];
    for (let i = 0; i < variants.length; i += 1) {
      if (variants[i] && variants[i].variant === name) return variants[i];
    }
    return null;
  }

  function buildPublicPhotoUrl(objectKey) {
    const cfg = window.SNH_CONFIG || {};
    const supabaseUrl = String(cfg.supabaseUrl || "").replace(/\/+$/, "");
    if (!supabaseUrl || !objectKey) return "";
    const encoded = String(objectKey)
      .split("/")
      .map(function (part) { return encodeURIComponent(part); })
      .join("/");
    return supabaseUrl + "/storage/v1/object/public/photos-public/" + encoded;
  }

  function createCard(item) {
    const figure = document.createElement("figure");
    figure.className = "home-highlight-card";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "home-highlight-trigger";
    trigger.setAttribute("aria-label", "Open photo: " + item.caption);
    trigger.dataset.imageSrc = item.fullSrc || item.thumbSrc;
    trigger.dataset.imageAlt = item.alt;

    const image = document.createElement("img");
    image.src = item.thumbSrc || item.fullSrc;
    image.alt = item.alt;
    image.loading = "lazy";
    image.decoding = "async";

    const caption = document.createElement("figcaption");
    caption.textContent = item.caption;

    trigger.appendChild(image);
    figure.appendChild(trigger);
    figure.appendChild(caption);
    return figure;
  }

  function createLightbox() {
    const overlay = document.createElement("div");
    overlay.className = "home-lightbox";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Expanded highlight photo");

    const panel = document.createElement("div");
    panel.className = "home-lightbox-panel";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "home-lightbox-close";
    closeButton.setAttribute("aria-label", "Close photo");
    closeButton.textContent = "Close";

    const image = document.createElement("img");
    image.className = "home-lightbox-image";
    image.alt = "";

    panel.appendChild(image);
    panel.appendChild(closeButton);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    return { overlay, panel, closeButton, image };
  }

  function setupLightbox(grid) {
    const lightbox = createLightbox();
    let lastTrigger = null;

    function closeLightbox() {
      lightbox.overlay.hidden = true;
      lightbox.image.src = "";
      if (lastTrigger) {
        lastTrigger.focus();
      }
    }

    function openLightbox(trigger) {
      const src = trigger.dataset.imageSrc;
      const alt = trigger.dataset.imageAlt || "";
      if (!src) return;
      lastTrigger = trigger;
      lightbox.image.src = src;
      lightbox.image.alt = alt;
      lightbox.overlay.hidden = false;
      lightbox.closeButton.focus();
    }

    grid.addEventListener("click", function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest(".home-highlight-trigger");
      if (!trigger) return;
      openLightbox(trigger);
    });

    lightbox.closeButton.addEventListener("click", closeLightbox);
    lightbox.overlay.addEventListener("click", function (event) {
      if (event.target === lightbox.overlay) {
        closeLightbox();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (!lightbox.overlay.hidden && event.key === "Escape") {
        closeLightbox();
      }
    });
  }

  function sanitizeStaticHighlights(input) {
    if (!Array.isArray(input)) return [];
    return input
      .filter(function (item) {
        return (
          item &&
          typeof item.filename === "string" && item.filename &&
          typeof item.alt === "string" && item.alt &&
          typeof item.caption === "string" && item.caption
        );
      })
      .map(function (item) {
        const src = STATIC_IMAGE_BASE + item.filename;
        return {
          source: "static",
          alt: item.alt,
          caption: item.caption,
          thumbSrc: src,
          fullSrc: src
        };
      });
  }

  function flattenDynamicAlbums(albums) {
    if (!Array.isArray(albums)) return [];
    const out = [];
    for (let i = 0; i < albums.length; i += 1) {
      const album = albums[i];
      if (!album || !Array.isArray(album.assets)) continue;
      for (let j = 0; j < album.assets.length; j += 1) {
        const asset = album.assets[j];
        if (!asset) continue;
        const web = pickVariant(asset, "web");
        const thumb = pickVariant(asset, "thumb") || web;
        if (!web || !web.objectKey) continue;
        const fullSrc = buildPublicPhotoUrl(web.objectKey);
        const thumbSrc = thumb && thumb.objectKey ? buildPublicPhotoUrl(thumb.objectKey) : fullSrc;
        if (!fullSrc) continue;
        out.push({
          source: "dynamic",
          alt: asset.altText || asset.caption || "Club photo",
          caption: asset.caption || album.title || "Club photo",
          thumbSrc: thumbSrc,
          fullSrc: fullSrc
        });
      }
    }
    return out;
  }

  function renderHighlightsMessage(grid, message) {
    grid.textContent = "";
    const msg = document.createElement("p");
    msg.className = "home-highlights-message";
    msg.textContent = message;
    grid.appendChild(msg);
  }

  async function loadDynamicHighlights() {
    const client = window.snhSupabase;
    if (!client || typeof client.rpc !== "function") return null;
    try {
      const result = await client.rpc("snh_public_photo_albums");
      if (result.error) return null;
      let data = result.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (_e) { data = null; }
      }
      const flattened = flattenDynamicAlbums(data || []);
      return flattened;
    } catch (_e) {
      return null;
    }
  }

  async function loadStaticHighlights() {
    const response = await fetch(HIGHLIGHTS_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Highlights request failed (" + response.status + ")");
    }
    const payload = await response.json();
    return sanitizeStaticHighlights(payload.highlights);
  }

  async function loadHighlights() {
    const dynamic = await loadDynamicHighlights();
    if (dynamic && dynamic.length > 0) return dynamic;
    return loadStaticHighlights();
  }

  async function initHighlights() {
    const grid = document.getElementById("home-highlights-grid");
    if (!grid) return;

    let highlights;
    try {
      highlights = await loadHighlights();
    } catch (err) {
      console.error("Highlights data:", err);
      renderHighlightsMessage(grid, "Highlights are temporarily unavailable.");
      return;
    }

    if (!highlights || highlights.length === 0) {
      renderHighlightsMessage(grid, "No highlight photos published yet.");
      return;
    }

    const maxVisible = window.matchMedia(MOBILE_MEDIA_QUERY).matches
      ? MOBILE_MAX_VISIBLE
      : DESKTOP_MAX_VISIBLE;
    const randomized = shuffleInPlace(highlights.slice());
    const selection = randomized.slice(0, Math.min(maxVisible, randomized.length));

    const fragment = document.createDocumentFragment();
    selection.forEach(function (item) {
      fragment.appendChild(createCard(item));
    });

    grid.textContent = "";
    grid.appendChild(fragment);
    setupLightbox(grid);
  }

  initHighlights();
})();
