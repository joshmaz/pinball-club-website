/**
 * Static-archive slideshow: club logo first, parking last, four photos between.
 * Timing: 3s initial dwell on logo; then ~220ms slide; 1.5s hold per slide (loop).
 */
(function () {
  var HOLD_MS = 1500;
  var INITIAL_LOGO_MS = 3000;

  var SLIDES = [
    {
      id: 'fb7b05_1e20a8131fa048708bd65678bb565f1a~mv2.png',
      alt: 'Southern New Hampshire Pinball Club logo',
    },
    {
      id: 'fb7b05_9ab711212eb6499f947c23942dab21df~mv2.jpg',
      alt: 'TNA lock evening',
    },
    {
      id: 'fb7b05_5efb990805f1423bad7af29ce1660456~mv2_d_1936_1936_s_2.jpg',
      alt: 'Club photos',
    },
    {
      id: 'fb7b05_60c62518f5604dbfbf915e13b8f1366d~mv2_d_1936_2592_s_2.jpg',
      alt: 'Club photos',
    },
    {
      id: 'fb7b05_7d005ae1b6f44539b5bff136d4435fa2~mv2_d_1936_1936_s_2.jpg',
      alt: 'Club photos',
    },
    {
      id: 'fb7b05_7605530f626841a3896477cdbafdabb3~mv2.jpg',
      alt: 'Parking',
    },
  ];

  function wixImageUrl(mediaId) {
    var base = 'https://static.wixstatic.com/media/' + mediaId;
    return (
      base +
      '/v1/fill/w_640,h_480,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/' +
      mediaId
    );
  }

  function run() {
    var root = document.getElementById('SldShwGllry0');
    if (!root) return;

    root.classList.add('archive-marquee-host');
    root.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'archive-marquee';

    var viewport = document.createElement('div');
    viewport.className = 'archive-marquee-viewport';

    var track = document.createElement('div');
    track.className = 'archive-marquee-track';

    var n = SLIDES.length;
    track.style.width = n * 100 + '%';

    SLIDES.forEach(function (spec, idx) {
      var slide = document.createElement('div');
      slide.className = 'archive-marquee-slide';
      slide.style.flex = '0 0 ' + 100 / n + '%';

      var img = document.createElement('img');
      img.className = 'archive-marquee-img';
      img.src = wixImageUrl(spec.id);
      img.alt = spec.alt;
      img.loading = idx === 0 ? 'eager' : 'lazy';
      img.decoding = 'async';

      slide.appendChild(img);
      track.appendChild(slide);
    });

    viewport.appendChild(track);
    wrap.appendChild(viewport);

    var note = document.createElement('div');
    note.className = 'archive-marquee-note';
    note.textContent = 'Slideshow (museum replay)';
    wrap.appendChild(note);

    root.appendChild(wrap);

    var index = 0;
    var initialLogoWait = true;
    var dwellTimer = null;

    function clearDwell() {
      if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    }

    function applyOffset(useTransition) {
      var pct = -(index / SLIDES.length) * 100;
      track.style.transform = 'translateX(' + pct + '%)';
      if (useTransition) {
        track.classList.add('is-transitioning');
      } else {
        track.classList.remove('is-transitioning');
      }
    }

    function scheduleDwell() {
      clearDwell();
      var ms = HOLD_MS;
      if (index === 0 && initialLogoWait) {
        ms = INITIAL_LOGO_MS;
        initialLogoWait = false;
      }
      dwellTimer = window.setTimeout(advance, ms);
    }

    function advance() {
      clearDwell();
      index = (index + 1) % SLIDES.length;
      applyOffset(true);
    }

    function onTransitionEnd(ev) {
      if (ev.propertyName !== 'transform') return;
      if (ev.target !== track) return;
      scheduleDwell();
    }

    track.addEventListener('transitionend', onTransitionEnd);

    applyOffset(false);
    scheduleDwell();

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      clearDwell();
      track.removeEventListener('transitionend', onTransitionEnd);
      track.classList.remove('is-transitioning');
      index = 0;
      applyOffset(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
