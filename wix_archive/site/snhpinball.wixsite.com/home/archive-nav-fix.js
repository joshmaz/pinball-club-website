/**
 * Static archive: ensure Wix nav links target index.html files on S3/CloudFront.
 */
(function () {
  var PREFIX = '/wix_archive/site/snhpinball.wixsite.com/home/index.html';
  var SLUGS = ['about-us', 'events', 'grid', 'menu', 'merch', 'our-games'];

  function fixRelativeHref(href) {
    if (!href || href.indexOf('://') !== -1 || href.indexOf('mailto:') === 0) {
      return href;
    }

    var pathPart = href.split(/[?#]/)[0];
    var suffix = href.slice(pathPart.length);

    if (pathPart.endsWith('/index.html')) {
      return href;
    }

    if (pathPart === '..' || pathPart === '../' || pathPart === '.') {
      return '../index.html' + suffix;
    }

    for (var i = 0; i < SLUGS.length; i++) {
      var slug = SLUGS[i];
      if (pathPart === slug || pathPart === slug + '/') {
        return slug + '/index.html' + suffix;
      }
      if (pathPart === '../' + slug || pathPart === '../' + slug + '/') {
        return '../' + slug + '/index.html' + suffix;
      }
    }

    return href;
  }

  function fixAbsoluteHref(href) {
    if (!href || href.indexOf(PREFIX) !== 0) {
      return href;
    }

    var pathPart = href;
    var query = '';
    var hash = '';
    var qIdx = href.indexOf('?');
    var hIdx = href.indexOf('#');
    if (qIdx !== -1) {
      pathPart = href.slice(0, qIdx);
      query = href.slice(qIdx, hIdx === -1 ? undefined : hIdx);
    }
    if (hIdx !== -1) {
      if (qIdx === -1) pathPart = href.slice(0, hIdx);
      hash = href.slice(hIdx);
    }

    if (pathPart.endsWith('/index.html')) {
      return href;
    }

    if (pathPart === PREFIX || pathPart === PREFIX + '/') {
      return PREFIX + '/index.html' + query + hash;
    }

    for (var i = 0; i < SLUGS.length; i++) {
      var slugPath = PREFIX + '/' + SLUGS[i];
      if (pathPart === slugPath || pathPart === slugPath + '/') {
        return slugPath + '/index.html' + query + hash;
      }
    }

    return href;
  }

  function fixHref(href) {
    if (!href) return href;
    if (href.indexOf(PREFIX) === 0) return fixAbsoluteHref(href);
    return fixRelativeHref(href);
  }

  function patchAnchor(anchor) {
    var href = anchor.getAttribute('href');
    var fixed = fixHref(href);
    if (fixed && fixed !== href) {
      anchor.setAttribute('href', fixed);
    }
  }

  function patchAll(root) {
    var scope = root || document;
    var anchors = scope.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      patchAnchor(anchors[i]);
    }
  }

  function run() {
    patchAll(document);

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'A') patchAnchor(node);
          patchAll(node);
        }
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
