/**
 * Static-archive slideshow: logo, six club photos, parking (8 slides).
 * Clone of logo after parking for seamless forward loop (no rewind).
 * Timing: 3s initial dwell on logo; ~440ms slide; 1.5s hold per slide.
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
      id: 'fb7b05_c76d9f404f3e4aaeb84b90d66d0b45cf~mv2_d_1936_1936_s_2.jpg',
      alt: 'Club photos',
    },
    {
      id: 'fb7b05_ceb045e00e86482295dca6d415623fc4~mv2_d_1936_1936_s_2.jpg',
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

    var logicalCount = SLIDES.length;
    var cloneCount = 1;
    var panelCount = logicalCount + cloneCount;

    track.style.width = panelCount * 100 + '%';

    function appendSlide(spec, idx, isClone) {
      var slide = document.createElement('div');
      slide.className = 'archive-marquee-slide';
      slide.style.flex = '0 0 ' + 100 / panelCount + '%';
      if (isClone) {
        slide.setAttribute('aria-hidden', 'true');
      }

      var img = document.createElement('img');
      img.className = 'archive-marquee-img';
      img.src = wixImageUrl(spec.id);
      img.alt = isClone ? spec.alt + ' (loop)' : spec.alt;
      img.loading = idx === 0 && !isClone ? 'eager' : 'lazy';
      img.decoding = 'async';

      slide.appendChild(img);
      track.appendChild(slide);
    }

    SLIDES.forEach(function (spec, idx) {
      appendSlide(spec, idx, false);
    });
    appendSlide(SLIDES[0], 0, true);

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
      var pct = -(index / panelCount) * 100;
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
      if (index >= logicalCount) {
        return;
      }
      index += 1;
      applyOffset(true);
    }

    function onTransitionEnd(ev) {
      if (ev.propertyName !== 'transform') return;
      if (ev.target !== track) return;

      if (index === logicalCount) {
        track.classList.remove('is-transitioning');
        index = 0;
        applyOffset(false);
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(scheduleDwell);
        });
        return;
      }

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
