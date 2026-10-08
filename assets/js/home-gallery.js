(function () {
  const CYCLE_MS = 3000;
  async function init() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;
    const track = document.getElementById('gallery-track');
    const caption = document.getElementById('gallery-caption');
    const status = document.getElementById('gallery-status');
    const previous = document.getElementById('gallery-previous');
    const next = document.getElementById('gallery-next');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false, hovered = false, focused = false, browsing = false;
    let current = 0, games = [], slides = [], pointerStart, animations = [], generation = 0, resumeTimer;
    const active = () => visible && !document.hidden;
    const wrap = index => (index + games.length) % games.length;
    function stopAnimations() {
      generation++;
      animations.forEach(animation => animation.cancel());
      animations = [];
    }
    function syncMotion() {
      const running = active() && !motion.matches && !hovered && !focused && !browsing;
      animations.forEach(animation => running ? animation.play() : animation.pause());
    }
    function animateCycle() {
      if (!active() || motion.matches || games.length < 2 || animations.length) return;
      const token = ++generation;
      animations = slides.map((slide, i) => {
        const slot = i - 1;
        return slide.element.animate([
          { transform: `translateX(${slot * 110 + 8}%)`, opacity: slot === 0 ? 1 : .18, offset: 0 },
          { transform: `translateX(${slot * 110 - 8}%)`, opacity: slot === 0 ? 1 : .18, offset: .8, easing: 'cubic-bezier(.45, 0, .55, 1)' },
          { transform: `translateX(${(slot - 1) * 110 + 8}%)`, opacity: slot === 1 ? 1 : .18, offset: 1 }
        ], { duration: CYCLE_MS, easing: 'linear', fill: 'forwards' });
      });
      animations[1].onfinish = () => {
        if (token !== generation) return;
        // Never create the next neighbor while offscreen, even if completion was already queued.
        if (!active()) return;
        current = wrap(current + 1);
        stopAnimations();
        render();
      };
      syncMotion();
    }
    function sizeImages() {
      if (!active()) return;
      const width = Math.ceil(track.clientWidth * 0.7);
      slides.forEach(slide => { if (slide.img.srcset) slide.img.sizes = `${width}px`; });
    }
    function makeSlide(index) {
      const game = games[index];
      const element = document.createElement('div');
      element.className = 'gallery-slide';
      const img = document.createElement('img');
      img.decoding = 'async';
      img.draggable = false;
      // Set the slot before candidate URLs to avoid fetching with a stale/default sizes value.
      const variants = window.SNHGameImages.variants(game.primaryImage);
      if (variants.length) {
        img.sizes = `${Math.ceil(track.clientWidth * 0.7)}px`;
        img.srcset = variants.map(v => `${v.url} ${v.width}w`).join(', ');
        img.src = (variants.find(v => v.width >= 640) || variants[variants.length - 1]).url;
      } else img.src = game.primaryImage.url;
      img.alt = `${game.title}, pinball machine from the club collection`;
      element.append(img);
      return { index, element, img };
    }
    function position(slide, slot) {
      slide.element.style.transform = `translateX(${slot * 110 + (motion.matches || games.length < 2 ? 0 : 8)}%)`;
      slide.element.classList.toggle('is-current', slot === 0);
      slide.element.setAttribute('aria-hidden', String(slot !== 0));
    }
    function render() {
      if (!active() || !games.length) return;
      if (animations.some(animation => animation.playState === 'finished')) {
        current = wrap(current + 1);
        stopAnimations();
      }
      if (animations.length) { sizeImages(); syncMotion(); return; }
      const indices = games.length === 1 ? [current] : [wrap(current - 1), current, wrap(current + 1)];
      const old = [...slides];
      slides = indices.map((index, i) => {
        // Consume reused nodes once (the two-game case has the same neighbor on both sides).
        const found = old.findIndex(slide => slide.index === index);
        const slide = found < 0 ? makeSlide(index) : old.splice(found, 1)[0];
        position(slide, games.length === 1 ? 0 : i - 1);
        track.append(slide.element);
        return slide;
      });
      old.forEach(slide => slide.element.remove());
      caption.textContent = games[current].title;
      sizeImages();
      animateCycle();
    }
    function advance(direction) {
      if (!active() || games.length < 2) return;
      browsing = true;
      clearTimeout(resumeTimer);
      stopAnimations();
      current = wrap(current + direction);
      status.textContent = games[current].title;
      render();
      // Touch users can browse repeatedly; resume after three seconds of inactivity.
      if (!hovered && !focused) resumeTimer = setTimeout(() => { browsing = false; syncMotion(); }, CYCLE_MS);
    }
    previous.addEventListener('click', () => advance(-1));
    next.addEventListener('click', () => advance(1));
    gallery.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { hovered = true; syncMotion(); } });
    gallery.addEventListener('pointerleave', () => { hovered = false; browsing = false; syncMotion(); });
    gallery.addEventListener('focusin', event => { focused = event.target.matches(':focus-visible'); syncMotion(); });
    gallery.addEventListener('focusout', event => {
      if (!gallery.contains(event.relatedTarget)) { focused = false; browsing = false; syncMotion(); }
    });
    gallery.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); advance(event.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    track.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') pointerStart = { x: event.clientX, y: event.clientY };
    });
    track.addEventListener('pointerup', event => {
      if (!pointerStart) return;
      const dx = event.clientX - pointerStart.x, dy = event.clientY - pointerStart.y;
      pointerStart = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) advance(dx < 0 ? 1 : -1);
    });
    track.addEventListener('pointercancel', () => { pointerStart = null; });
    document.addEventListener('visibilitychange', () => {
      clearTimeout(resumeTimer);
      if (!document.hidden) { hovered = false; focused = false; browsing = false; render(); }
      syncMotion();
    });
    motion.addEventListener('change', () => { stopAnimations(); render(); });
    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (active()) { hovered = false; focused = false; browsing = false; render(); }
      syncMotion();
    }, { threshold: 0 });
    observer.observe(gallery);
    new ResizeObserver(sizeImages).observe(track);
    try {
      const result = await window.SNHPublicData.loadGames();
      games = result.data.filter(game => game.primaryImage && game.primaryImage.url);
      for (let i = games.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [games[i], games[j]] = [games[j], games[i]];
      }
      current = Math.floor(Math.random() * games.length) || 0;
      if (!games.length) { caption.textContent = 'Explore the collection on our Games page.'; return; }
      previous.hidden = next.hidden = games.length < 2;
      render();
    } catch (error) {
      caption.textContent = 'Explore the collection on our Games page.';
      console.error('Home carousel:', error);
    }
  }
  init();
})();
