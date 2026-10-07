(function () {
  var auth = window.SNHSiteAuth;
  function entry(slug) {
    return Object.prototype.hasOwnProperty.call(auth.ROLE_CATALOG, slug) ? auth.ROLE_CATALOG[slug] : null;
  }
  function name(slug) { return entry(slug) ? entry(slug).displayName : "Unrecognized role"; }
  function errorMessage(error) {
    var text = window.SNHMemberPortal.getFriendlyAuthErrorMessage(error);
    Object.keys(auth.ROLE_CATALOG).forEach(function (slug) {
      text = text.replace(new RegExp("\\b" + slug + "\\b", "g"), function () { return name(slug); });
    });
    return text.replace(/\bClub Admin\b/g, function () { return name("club_admin"); });
  }
  function assignments(roles) {
    return (roles || []).filter(function (slug) { return !entry(slug) || entry(slug).assignable; });
  }
  function assignable(roles) {
    return window.SNHMemberPortal.ASSIGNABLE_MEMBER_ROLES.filter(function (slug) {
      return auth.canAssignMemberRole(roles, slug);
    });
  }
  function intro(roles) {
    var text = "Look up members, review website responsibilities, and update membership status.";
    var targets = assignable(roles);
    if (targets.length) {
      text += targets.length === window.SNHMemberPortal.ASSIGNABLE_MEMBER_ROLES.length
        ? " Manage website role assignments, including administrator roles."
        : " Assign or remove the website roles available to you in the role selector.";
    }
    return text;
  }
  function removalMessage(roles, slug, memberName) {
    var remaining = roles.filter(function (role) { return role !== slug; });
    var text = "Remove " + name(slug) + " from " + memberName + "?";
    if (auth.getEffectiveRoles(remaining).indexOf(slug) !== -1) {
      var sources = remaining.filter(function (role) { return auth.getEffectiveRoles([role]).indexOf(slug) !== -1; });
      text += " " + name(slug) + " access will remain through " + sources.map(name).join(", ") + ".";
    }
    return text;
  }
  function node(tag, text, className) {
    var el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function badge(slug) {
    var role = entry(slug);
    var kind = !role ? "unknown" : role.domain === "website" ? "website" : role.level;
    var el = node("span", "", "member-role-badge member-role-badge--" + kind);
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", kind === "editor" ? "M4 16 16 4l4 4L8 20H4v-4Zm9-9 4 4" :
      kind === "unknown" ? "M12 4v10m0 4v2" : "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z");
    svg.appendChild(path);
    if (kind === "website") {
      var star = document.createElementNS("http://www.w3.org/2000/svg", "path");
      star.setAttribute("d", "m12 7 1.2 2.6 2.8.4-2 2 .5 2.8-2.5-1.3-2.5 1.3L10 12 8 10l2.8-.4Z");
      svg.appendChild(star);
    }
    el.append(svg, node("span", name(slug)));
    return el;
  }
  function renderAssignments(container, roles) {
    container.replaceChildren();
    var assigned = assignments(roles);
    if (!assigned.length) { container.textContent = "None"; return; }
    var list = node("ul", "", "member-role-badges");
    assigned.forEach(function (slug) { var li = node("li"); li.appendChild(badge(slug)); list.appendChild(li); });
    container.appendChild(list);
  }
  function renderAccess(container, roles) {
    container.replaceChildren();
    var effective = auth.getEffectiveRoles(roles);
    var recognized = assignments(roles).filter(function (slug) { return entry(slug); });
    if (!effective.length) {
      container.appendChild(node("p", assignments(roles).length ? "No recognized website access is available." :
        "No website roles are assigned. Website responsibilities are separate from membership status."));
      return;
    }
    var list = node("ul", "", "member-role-access");
    recognized.forEach(function (slug) {
      var inherited = auth.getEffectiveRoles([slug]).filter(function (role) {
        return role !== slug && entry(role).assignable;
      });
      // Presentation only: group included access by the catalog's direct children.
      var direct = entry(slug).inherits;
      var text = direct.length ? "Included through " + name(slug) + ": " + direct.map(name).join(", ") + "." :
        name(slug) + ": routine upkeep in this area of the website.";
      if (inherited.length > direct.length) text += " Each domain Admin includes its Editor access.";
      if (entry(slug).level === "admin") text += " Includes upkeep and reserved administrative actions.";
      list.appendChild(node("li", text));
    });
    container.appendChild(list);
    var targets = assignable(roles);
    if (targets.length) container.appendChild(node("p", targets.length === window.SNHMemberPortal.ASSIGNABLE_MEMBER_ROLES.length
      ? "Can manage all website role assignments, subject to administrator protections."
      : "Can manage the role assignments available in Member Tools."));
    if (recognized.some(function (slug) { return entry(slug).domain === "website" && entry(slug).level === "admin"; })) {
      container.appendChild(node("p", "Website-wide administration includes Operations, audit access and door-code management."));
    }
    if (effective.indexOf("website_volunteer") !== -1) {
      container.appendChild(node("p", name("website_volunteer") + ": derived from these website responsibilities; includes maintaining club notes and issue status.", "member-role-derived"));
    }
  }
  function renderProfile(container, roles, failed) {
    container.replaceChildren();
    if (failed) { container.appendChild(node("p", "Couldn’t load your website roles. Reload the page to try again.", "member-role-load-error")); return; }
    container.appendChild(node("h4", "Assigned roles"));
    var assigned = node("div"); renderAssignments(assigned, roles); container.appendChild(assigned);
    container.appendChild(node("h4", "Effective access"));
    var access = node("div"); renderAccess(access, roles); container.appendChild(access);
  }
  window.SNHMemberRolePresentation = { name: name, errorMessage: errorMessage, assignments: assignments, assignable: assignable,
    intro: intro, removalMessage: removalMessage, badge: badge,
    renderAssignments: renderAssignments, renderAccess: renderAccess, renderProfile: renderProfile };
})();
