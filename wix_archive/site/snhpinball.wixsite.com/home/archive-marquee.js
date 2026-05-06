/**
 * Static-archive replacement for the Wix home slideshow (nine club photos).
 * Images load from static.wixstatic.com (same CDN as the original site).
 */
(function () {
  const IDS = [
    'fb7b05_5efb990805f1423bad7af29ce1660456~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_60c62518f5604dbfbf915e13b8f1366d~mv2_d_1936_2592_s_2.jpg',
    'fb7b05_7d005ae1b6f44539b5bff136d4435fa2~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_c76d9f404f3e4aaeb84b90d66d0b45cf~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_ceb045e00e86482295dca6d415623fc4~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_af10fcf827d540949141dd7e0b9e42b7~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_1374523374ac47a695eb73be9c1be82f~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_ccf48267cc5e46bda8561c8713ce997d~mv2_d_1936_1936_s_2.jpg',
    'fb7b05_59b16299759a43e4a19be509313da16d~mv2_d_1936_1936_s_2.jpg',
  ];

  function wixImageUrl(id) {
    var base = 'https://static.wixstatic.com/media/' + id;
    return (
      base +
      '/v1/fill/w_520,h_400,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/' +
      id
    );
  }

  function buildSet(clone) {
    var set = document.createElement('div');
    set.className = 'archive-marquee-set';
    if (clone) set.setAttribute('aria-hidden', 'true');

    IDS.forEach(function (id, idx) {
      var fig = document.createElement('figure');
      fig.className = 'archive-marquee-figure';

      var img = document.createElement('img');
      img.className = 'archive-marquee-img';
      img.src = wixImageUrl(id);
      img.alt =
        'Southern New Hampshire Pinball Club photo ' + (idx + 1) + ' of ' + IDS.length;
      img.loading = 'lazy';
      img.decoding = 'async';

      fig.appendChild(img);
      set.appendChild(fig);
    });

    return set;
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

    track.appendChild(buildSet(false));
    track.appendChild(buildSet(true));

    viewport.appendChild(track);
    wrap.appendChild(viewport);

    var note = document.createElement('div');
    note.className = 'archive-marquee-note';
    note.textContent = 'Photo strip (museum replay)';
    wrap.appendChild(note);

    root.appendChild(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
