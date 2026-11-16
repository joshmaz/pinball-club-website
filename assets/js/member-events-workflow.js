(function () {
  function onReady(callback) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", callback, { once: true });
    else callback();
  }

  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function formatValue(field, value) {
    if (value == null || value === "") return "(empty)";
    if (field === "starts_at") {
      var date = new Date(value);
      return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York"
      }).format(date) : String(value);
    }
    if (field === "matchplay_format") {
      return String(value).replace(/_/g, " ").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
    }
    if (field === "external_links" && Array.isArray(value)) {
      return value.map(function (link) { return link && link.label ? link.label + ": " + link.url : (link && link.url) || ""; }).filter(Boolean).join(" · ") || "(no links)";
    }
    return String(value);
  }

  function sourceSummary(tournament) {
    var parts = [];
    if (tournament.status) parts.push("Match Play status: " + tournament.status);
    if (tournament.organizer_name) parts.push("Organizer: " + tournament.organizer_name);
    if (tournament.series_name || tournament.series_id) parts.push("Series: " + (tournament.series_name || tournament.series_id));
    return parts.join(" · ");
  }

  async function refreshEventList() {
    if (typeof window.snhRefreshMemberEventsList === "function") {
      await window.snhRefreshMemberEventsList();
      return;
    }
    var refresh = document.getElementById("member-events-refresh");
    if (refresh) refresh.click();
  }

  function requestTournamentReview(tournament) {
    var details = document.querySelector(".member-matchplay-direct-search");
    if (details) details.open = true;
    var input = document.getElementById("member-matchplay-tournament");
    var form = document.getElementById("member-matchplay-review-form");
    if (input && form) {
      input.value = tournament.url || String(tournament.id || "");
      if (typeof form.requestSubmit === "function") form.requestSubmit();
    }
  }

  function renderScan(data, container, status) {
    container.replaceChildren();
    container.hidden = false;
    var date = new Date(data.scanned_at);
    if (data.reconciliation) {
      status.textContent = (data.complete ? "MatchPlay inventory completed" : "MatchPlay inventory stopped before all pages were read") +
        " at " + (Number.isFinite(date.getTime())
          ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(date)
          : "the latest available time") + ".";
    } else {
      status.textContent = "Checked Match Play at " + (Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(date)
        : "the latest available time") + ".";
    }
    if (Array.isArray(data.warnings) && data.warnings.length) status.textContent += " " + data.warnings.join(" ");

    var counts = node("p", "member-matchplay-scan-summary");
    if (data.reconciliation && data.counts) {
      counts.textContent = data.source_records + " MatchPlay records in scope · " +
        data.counts.linked + " already linked · " + data.counts.changed + " with proposed changes · " +
        data.counts.ambiguous + " ambiguous · " + data.counts.unchanged + " matched with no changes · " +
        data.counts.no_match + " with no club match.";
      var organizer = data.scope.organizer;
      var scopeText = organizer
        ? "Organizer inventory: " + organizer.name + " (MatchPlay ID " + organizer.id + "), plus title searches: " + data.scope.searches.join("; ")
        : "Title searches: " + data.scope.searches.join("; ") + " (organizer inventory unavailable)";
      container.appendChild(node("p", "member-form-hint", "Scope: " + scopeText + " · " + data.scope.pagination + "."));
    } else {
      counts.textContent = data.additions.length + " possible additions · " + data.updates.length +
        " events with changes · " + data.possible_matches.length + " possible matches · " + data.unchanged + " unchanged.";
    }
    container.appendChild(counts);

    if (data.additions.length) {
      var addSection = node("section", "member-matchplay-scan-group");
      addSection.appendChild(node("h5", null, "Possible new events"));
      data.additions.forEach(function (tournament) {
        var card = node("article", "member-matchplay-scan-card");
        card.appendChild(node("h6", null, tournament.title || "Untitled tournament"));
        var details = [formatValue("starts_at", tournament.starts_at), tournament.location, formatValue("matchplay_format", tournament.matchplay_format)].filter(Boolean);
        if (details.length) card.appendChild(node("p", "member-form-hint", details.join(" · ")));
        var source = sourceSummary(tournament);
        if (source) card.appendChild(node("p", "member-form-hint", source));
        if (tournament.description) card.appendChild(node("p", "member-matchplay-scan-description", tournament.description));
        var link = node("a", null, "View on Match Play ↗");
        link.href = tournament.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.appendChild(link);
        var approve = node("button", "club-button", "Approve and add unpublished event");
        approve.type = "button";
        approve.addEventListener("click", async function () {
          approve.disabled = true;
          approve.textContent = "Adding…";
          try {
            await window.SNHMemberPortal.saveEventForAdmin({
              title: tournament.title || "Match Play event",
              description: tournament.description || "",
              location: tournament.location || "",
              starts_at: tournament.starts_at || null,
              ends_at: null,
              all_day: false,
              time_known: !!tournament.starts_at,
              lifecycle_status: "scheduled",
              external_links: [
                { url: tournament.url, label: "Match Play" },
                ...(tournament.series_url ? [{ url: tournament.series_url, label: "Match Play series" }] : [])
              ],
              source: "matchplay",
              published: false,
              matchplay_format: tournament.matchplay_format || null
            });
            approve.textContent = "Added as unpublished event";
            approve.classList.remove("club-button");
            await refreshEventList();
          } catch (error) {
            approve.disabled = false;
            approve.textContent = "Approve and add unpublished event";
            status.textContent = "Could not add event: " + (error.message || "Unknown error");
          }
        });
        card.appendChild(approve);
        addSection.appendChild(card);
      });
      container.appendChild(addSection);
    }

    if (data.updates.length) {
      var updateSection = node("section", "member-matchplay-scan-group");
      updateSection.appendChild(node("h5", null, "Changes to review"));
      data.updates.forEach(function (entry) {
        var card = node("article", "member-matchplay-scan-card");
        card.appendChild(node("h6", null, entry.event.title || "Club event"));
        var source = sourceSummary(entry.tournament);
        if (source) card.appendChild(node("p", "member-form-hint", source));
        var link = node("a", null, "View on Match Play ↗");
        link.href = entry.tournament.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.appendChild(link);
        entry.changes.forEach(function (change) {
          var row = node("div", "member-matchplay-change");
          var copy = node("div", "member-matchplay-change-copy");
          copy.appendChild(node("strong", null, change.label));
          copy.appendChild(node("p", null, "Club: " + formatValue(change.field, change.current)));
          copy.appendChild(node("p", null, "Match Play: " + formatValue(change.field, change.proposed)));
          row.appendChild(copy);
          var controls = node("div", "member-matchplay-change-controls");
          var markRescheduled = null;
          var rescheduleNote = null;
          if (change.field === "starts_at") {
            var label = node("label", "members-checkbox-label");
            markRescheduled = document.createElement("input");
            markRescheduled.type = "checkbox";
            label.appendChild(markRescheduled);
            label.appendChild(document.createTextNode("Record as rescheduled"));
            controls.appendChild(label);
            rescheduleNote = document.createElement("input");
            rescheduleNote.type = "text";
            rescheduleNote.maxLength = 1000;
            rescheduleNote.placeholder = "Optional reschedule note";
            rescheduleNote.hidden = true;
            markRescheduled.addEventListener("change", function () { rescheduleNote.hidden = !markRescheduled.checked; });
            controls.appendChild(rescheduleNote);
          }
          var approve = node("button", "members-sidebar-link", "Approve field");
          approve.type = "button";
          approve.addEventListener("click", async function () {
            approve.disabled = true;
            approve.textContent = "Applying…";
            try {
              await window.SNHMemberPortal.updateEventFieldForAdmin(
                entry.event.id, change.field, change.proposed,
                change.field === "starts_at" ? { markRescheduled: !!(markRescheduled && markRescheduled.checked), rescheduleNote: rescheduleNote && rescheduleNote.value } : {}
              );
              approve.textContent = "Applied";
              await refreshEventList();
            } catch (error) {
              approve.disabled = false;
              approve.textContent = "Approve field";
              status.textContent = "Could not apply change: " + (error.message || "Unknown error");
            }
          });
          controls.appendChild(approve);
          row.appendChild(controls);
          card.appendChild(row);
        });
        updateSection.appendChild(card);
      });
      container.appendChild(updateSection);
    }

    if (data.possible_matches.length) {
      var matchSection = node("section", "member-matchplay-scan-group");
      matchSection.appendChild(node("h5", null, "Possible matches to review"));
      data.possible_matches.forEach(function (item) {
        var card = node("article", "member-matchplay-scan-card");
        card.appendChild(node("h6", null, item.tournament.title || "Untitled tournament"));
        var candidates = item.candidates || [];
        if (data.reconciliation && candidates.length) {
          card.appendChild(node("p", "member-form-hint",
            "Compare the dates and event details, then choose the club record this MatchPlay tournament belongs to. Review and save the event form to apply links or fill missing details."));
          candidates.forEach(function (candidate) {
            var reviewCandidate = node("button", "members-sidebar-link",
              "Review for “" + (candidate.title || "Untitled event") + "”" +
              (candidate.starts_at ? " · " + formatValue("starts_at", candidate.starts_at) : "") +
              (candidate.published === false ? " · Unpublished" : " · Published") +
              (candidate.has_matchplay_link ? " · Already linked" : ""));
            reviewCandidate.type = "button";
            reviewCandidate.addEventListener("click", function () {
              document.dispatchEvent(new CustomEvent("snh:historical-matchplay-review", {
                detail: { event_id: candidate.id, tournament: item.tournament }
              }));
            });
            card.appendChild(reviewCandidate);
          });
        } else {
          var names = candidates.map(function (candidate) {
            return candidate.title + (candidate.starts_at ? " · " + formatValue("starts_at", candidate.starts_at) : "");
          });
          card.appendChild(node("p", "member-form-hint", names.length ? "Possible club matches: " + names.join("; ") : "Could match an existing club event."));
          var review = node("button", "members-sidebar-link", "Review tournament");
          review.type = "button";
          review.addEventListener("click", function () { requestTournamentReview(item.tournament); });
          card.appendChild(review);
        }
        matchSection.appendChild(card);
      });
      container.appendChild(matchSection);
    }

    if (!data.additions.length && !data.updates.length && !data.possible_matches.length) {
      container.appendChild(node("p", null, data.reconciliation
        ? "No changes or ambiguous matches need review. Unmatched records were counted above and were not added."
        : "No new or changed Match Play events were found."));
    }
  }

  onReady(function () {
    var button = document.getElementById("member-matchplay-scan");
    var status = document.getElementById("member-matchplay-scan-status");
    var results = document.getElementById("member-matchplay-scan-results");
    if (!button || !status || !results) return;
    button.addEventListener("click", async function () {
      button.disabled = true;
      button.textContent = "Checking Match Play…";
      status.textContent = "";
      results.hidden = true;
      try {
        var data = await window.SNHMemberPortal.scanMatchplayEvents();
        renderScan(data, results, status);
      } catch (error) {
        status.textContent = "Could not check Match Play: " + (error.message || "Unknown error");
      } finally {
        button.disabled = false;
        button.textContent = "Find additions and updates";
      }
    });
    var historyButton = document.getElementById("member-matchplay-backfill");
    var historyStatus = document.getElementById("member-matchplay-backfill-status");
    var historyResults = document.getElementById("member-matchplay-backfill-results");
    if (historyButton && historyStatus && historyResults) {
      historyButton.addEventListener("click", async function () {
        historyButton.disabled = true;
        historyButton.textContent = "Scanning MatchPlay history…";
        historyStatus.textContent = "";
        historyResults.hidden = true;
        try {
          var data = await window.SNHMemberPortal.reconcileMatchplayEvents();
          renderScan(data, historyResults, historyStatus);
        } catch (error) {
          historyStatus.textContent = "Could not reconcile MatchPlay history: " +
            (error && error.message ? error.message : "Please try again.");
        } finally {
          historyButton.disabled = false;
          historyButton.textContent = "Scan MatchPlay history";
        }
      });
    }
  });
})();
