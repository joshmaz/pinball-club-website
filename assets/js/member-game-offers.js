(function () {
  "use strict";

  const byId = id => document.getElementById(id);
  const form = byId("offer-form");
  const status = byId("offer-status");
  const catalog = form.elements.game_id;
  const auth = window.SNHSiteAuth;
  const client = window.snhSupabase;
  const offerFields = [
    ["condition", "Condition"], ["availability", "Availability"],
    ["loan_terms", "Loan duration"], ["transport", "Transportation"]
  ];
  let editingId = null;
  let eligible = false;
  let canReview = false;
  let canCorrect = false;
  let canReadReview = false;

  function showStatus(message, tone = "") {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function node(tag, text) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    return element;
  }

  function button(label, action) {
    const element = node("button", label);
    element.type = "button";
    if (action) element.addEventListener("click", action);
    return element;
  }

  async function result(request) {
    const response = await request;
    if (response.error) throw response.error;
    return response.data;
  }

  function rpc(name, args) {
    return result(client.rpc(name, args));
  }

  async function mutate(control, action, message, after) {
    control.disabled = true;
    try {
      await action();
      if (after) after();
      showStatus(message, "success");
      try {
        await refresh();
      } catch {
        showStatus(message + " The lists could not refresh. Reload the page to see the change.", "error");
      }
    } catch {
      showStatus("The change could not be saved. Check your access or reload the page and try again.", "error");
    } finally {
      control.disabled = false;
    }
  }

  function card(title) {
    const article = node("article");
    article.className = "membership-card";
    article.append(node("h3", title));
    return article;
  }

  function details(offer, fields) {
    const list = node("dl");
    for (const [key, label] of fields) {
      if (offer[key]) list.append(node("dt", label), node("dd", offer[key]));
    }
    return list;
  }

  function fillList(id, offers, render, empty) {
    byId(id).replaceChildren(...(offers.length ? offers.map(render) : [node("p", empty)]));
  }

  function resetForm() {
    editingId = null;
    form.reset();
    byId("offer-form-title").textContent = "Offer a game";
    form.querySelector('button[type="submit"]').textContent = "Submit offer";
    byId("cancel-offer-edit").hidden = true;
  }

  function editOffer(offer) {
    editingId = offer.id;
    if (offer.game_id && !Array.from(catalog.options).some(option => option.value === offer.game_id)) {
      catalog.add(new Option(offer.title, offer.game_id));
    }
    catalog.value = offer.game_id || "";
    form.elements.title.value = offer.title;
    for (const [key] of offerFields) form.elements[key].value = offer[key] || "";
    byId("offer-form-title").textContent = "Edit offer";
    form.querySelector('button[type="submit"]').textContent = "Save changes";
    byId("cancel-offer-edit").hidden = false;
    form.elements.title.focus();
  }

  function offerStatus(offer) {
    const closed = { withdrawn: "Withdrawn", declined: "Declined", account_deleted: "Closed" };
    return closed[offer.close_reason] || (offer.published || offer.published_title ? "Published for feedback" : "Awaiting review");
  }

  function ownOffer(offer) {
    const article = card(offer.title);
    article.append(node("p", offerStatus(offer)), details(offer, offerFields));
    if (!offer.close_reason) {
      const actions = node("div");
      actions.className = "offer-actions members-profile-form";
      const edit = button("Edit offer", () => editOffer(offer));
      const withdraw = button("Withdraw", () => {
        if (!window.confirm("Withdraw this offer and remove it from published candidates?")) return;
        mutate(withdraw, () => rpc("snh_withdraw_game_offer", { p_id: offer.id }), "Offer withdrawn.", () => {
          if (editingId === offer.id) resetForm();
        });
      });
      actions.append(edit, withdraw);
      article.append(actions);
    }
    return article;
  }

  function publishedOffer(offer) {
    const article = card(offer.title);
    const actions = node("div");
    actions.className = "members-profile-form";
    const interest = button("I’d play this!", () => mutate(interest, () => rpc("snh_set_game_offer_interest", {
      p_id: offer.id, p_interested: !offer.interested
    }), offer.interested ? "Interest removed." : "Interest saved."));
    interest.setAttribute("aria-pressed", String(offer.interested));
    actions.append(interest);
    article.append(node("p", offer.summary), actions);
    return article;
  }

  function reviewField(labelText, field, value, maxLength) {
    field.value = value;
    field.maxLength = maxLength;
    const label = node("label", labelText);
    label.className = "club-field";
    label.append(field);
    return label;
  }

  function reviewOffer(offer) {
    const article = card(offer.title);
    article.append(node("p", offerStatus(offer)), details(offer, [...offerFields, ["coordinator_note", "Private note"]]));
    if (offer.published_title) {
      article.append(node("h4", "Published to members"), node("p", offer.published_title), node("p", offer.published_summary));
    }

    if (!canReview || offer.closed_at) return article;
    const editor = node("form");
    editor.className = "members-profile-form";
    const title = node("input");
    const summary = node("textarea");
    const note = node("textarea");
    title.required = true;
    summary.required = true;
    editor.append(
      reviewField("Member-facing title", title, offer.published_title || offer.title, 160),
      reviewField("Member-facing summary", summary, offer.published_summary || "", 1000),
      reviewField("Private coordinator note", note, offer.coordinator_note || "", 4000),
      node("p", "Check the title and summary for identifying or private details before publishing.")
    );

    const preview = node("details");
    const previewTitle = node("h4");
    const previewSummary = node("p");
    function updatePreview() {
      previewTitle.textContent = title.value.trim() || "Candidate title";
      previewSummary.textContent = summary.value.trim() || "Enter a member-facing summary to preview it here.";
    }
    updatePreview();
    title.addEventListener("input", updatePreview);
    summary.addEventListener("input", updatePreview);
    preview.append(node("summary", "Preview member-facing candidate"), previewTitle, previewSummary);
    editor.append(preview);

    const actions = node("div");
    actions.className = "offer-actions";
    const publish = node("button", offer.published_title ? "Update publication" : "Publish for feedback");
    publish.type = "submit";
    const review = (control, action, message) => {
      const controls = [...actions.querySelectorAll("button")];
      controls.forEach(element => { element.disabled = true; });
      mutate(control, () => rpc("snh_review_game_offer", {
        p_id: offer.id, p_action: action, p_title: title.value.trim() || null,
        p_summary: summary.value.trim() || null, p_note: note.value.trim() || null
      }), message).finally(() => controls.forEach(element => { element.disabled = false; }));
    };
    editor.addEventListener("submit", event => {
      event.preventDefault();
      if (!title.value.trim() || !summary.value.trim()) {
        showStatus("Enter a member-facing title and summary before publishing.", "error");
        return;
      }
      review(publish, "publish", "Candidate published for feedback.");
    });
    actions.append(publish);
    if (offer.published_title) {
      const unpublish = button("Unpublish", () => review(unpublish, "unpublish", "Candidate unpublished."));
      actions.append(unpublish);
    }
    const decline = button("Decline", () => {
      if (window.confirm("Decline and close this offer?")) review(decline, "decline", "Offer declined.");
    });
    actions.append(decline);
    editor.append(actions);
    article.append(editor);
    return article;
  }

  async function refresh() {
    await Promise.all([
      eligible && rpc("snh_my_game_offers").then(offers => fillList("own-offer-list", offers, ownOffer, "You have no offers yet.")),
      eligible && rpc("snh_published_game_offers").then(offers => fillList("published-offer-list", offers, publishedOffer, "No candidates are published yet.")),
      canReadReview && rpc("snh_rotation_game_offers").then(offers => fillList("review-offer-list", offers, reviewOffer, "There are no offers to review."))
    ]);
  }

  catalog.addEventListener("change", () => {
    if (catalog.value) form.elements.title.value = catalog.selectedOptions[0].textContent;
  });
  byId("cancel-offer-edit").addEventListener("click", resetForm);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!form.elements.title.value.trim()) {
      showStatus("Enter a game title.", "error");
      form.elements.title.focus();
      return;
    }
    const args = { p_id: editingId, p_game_id: catalog.value || null };
    for (const name of ["title", ...offerFields.map(([key]) => key)]) {
      args["p_" + name] = form.elements[name].value.trim() || null;
    }
    mutate(event.submitter || form.querySelector('button[type="submit"]'),
      () => rpc("snh_save_game_offer", args),
      editingId ? "Offer updated and returned to review." : "Offer submitted for review.", resetForm);
  });

  async function refreshPlacements() {
    let placements;
    try {
      placements = await rpc("snh_cabinet_placement_history");
    } catch (error) {
      if (error.code === "PGRST202") return null;
      throw error;
    }
    byId("placement-history").hidden = false;
    byId("placement-history-link").hidden = false;
    fillList("placement-list", placements, placement => {
      const article = card(placement.title + " · " + placement.label);
      article.append(node("p", placement.departure_confirmed_at ? "Departed" : "Currently placed"),
        details(placement, [["location", "Location"], ["arrived_on", "Arrival date"], ["departed_on", "Departure date"]]));
      if (!canCorrect) return article;
      const disclosure = node("details");
      const editor = node("form");
      editor.className = "members-profile-form";
      const location = node("input");
      const arrival = node("input");
      const departure = node("input");
      const reason = node("input");
      location.required = true;
      reason.required = true;
      arrival.type = "date";
      departure.type = "date";
      departure.disabled = !placement.departure_confirmed_at;
      editor.append(reviewField("Location", location, placement.location, 160),
        reviewField("Arrival date", arrival, placement.arrived_on || "", 10),
        reviewField("Departure date", departure, placement.departed_on || "", 10),
        reviewField("Correction reason", reason, "", 250));
      const submit = node("button", "Save correction");
      editor.append(submit);
      editor.addEventListener("submit", async event => {
        event.preventDefault();
        const status = byId("placement-status");
        submit.disabled = true;
        try {
          await rpc("snh_correct_cabinet_placement", {
            p_id: placement.id, p_location: location.value.trim(),
            p_arrived_on: arrival.value || null, p_departed_on: departure.value || null,
            p_reason: reason.value.trim()
          });
          status.textContent = "Placement corrected.";
          status.dataset.tone = "success";
          await refreshPlacements();
        } catch {
          status.textContent = "Could not save or refresh the correction. Verify the dates and reload before retrying.";
          status.dataset.tone = "error";
        } finally {
          submit.disabled = false;
        }
      });
      disclosure.append(node("summary", "Correct placement"), editor);
      article.append(disclosure);
      return article;
    }, "No cabinet placements have been confirmed.");
    return placements;
  }

  function startRotationPlanner(games) {
    const cabinetForm = byId("cabinet-form");
    const planForm = byId("rotation-plan-form");
    const planStatus = byId("rotation-status");
    const controls = byId("rotation-controls");
    const cancelEdit = byId("cancel-plan-edit");
    let planId = null;

    function feedback(message, tone = "") {
      planStatus.textContent = message;
      planStatus.dataset.tone = tone;
    }

    function clearPlan() {
      planId = null;
      planForm.reset();
      for (const name of ["incoming", "arrival", "outgoing", "departure"]) planForm.elements[name].disabled = false;
      byId("rotation-form-title").textContent = "New plan";
      cancelEdit.hidden = true;
    }

    function editPlan(plan) {
      planId = plan.id;
      planForm.elements.incoming.value = plan.incoming_cabinet_id || "";
      planForm.elements.outgoing.value = plan.outgoing_cabinet_id || "";
      planForm.elements.arrival.value = plan.arrival_on || "";
      planForm.elements.departure.value = plan.departure_on || "";
      planForm.elements.note.value = plan.note || "";
      planForm.elements.incoming.disabled = planForm.elements.arrival.disabled = Boolean(plan.arrival_placement_id);
      planForm.elements.outgoing.disabled = planForm.elements.departure.disabled = Boolean(plan.departure_placement_id);
      byId("rotation-form-title").textContent = "Edit plan";
      cancelEdit.hidden = false;
      (planForm.elements.incoming.disabled ? planForm.elements.outgoing : planForm.elements.incoming).focus();
    }

    async function refreshPlans() {
      const [{ cabinets, plans }, placements] = await Promise.all([
        rpc("snh_rotation_workspace"), refreshPlacements()
      ]);
      const open = new Map((placements || []).filter(placement => !placement.departure_confirmed_at)
        .map(placement => [placement.cabinet_id, placement]));
      const labels = new Map(cabinets.map(cabinet => [cabinet.id, cabinet.title + " · " + cabinet.label]));
      for (const field of [planForm.elements.incoming, planForm.elements.outgoing]) {
        const previous = field.value;
        field.replaceChildren(field.options[0], ...Array.from(labels, ([id, label]) => new Option(label, id)));
        field.value = labels.has(previous) ? previous : "";
      }
      fillList("rotation-plan-list", plans, plan => {
        const pendingArrival = plan.incoming_cabinet_id && !plan.arrival_placement_id;
        const pendingDeparture = plan.outgoing_cabinet_id && !plan.departure_placement_id;
        const pending = pendingArrival || pendingDeparture;
        const article = card(plan.canceled_at ? "Canceled plan" : pending ? "Tentative move" : "Confirmed move");
        const parts = [
          [plan.incoming_cabinet_id, plan.arrival_on, "arrival", plan.arrival_placement_id],
          [plan.outgoing_cabinet_id, plan.departure_on, "departure", plan.departure_placement_id]
        ];
        for (const [id, date, direction, confirmed] of parts) {
          if (!id) continue;
          const title = direction === "arrival" ? "Arrival" : "Departure";
          article.append(node("p", title + " · " + labels.get(id)
            + (confirmed ? " · Confirmed" : date ? " · " + date : " · Date open")));
          if (canReview && placements && !plan.canceled_at && !confirmed) {
            article.append(confirmationForm(plan, direction, id, open.get(id)));
          }
        }
        if (plan.note) article.append(details(plan, [["note", "Private note"]]));
        if (canReview && pending && !plan.canceled_at) {
          const actions = node("div");
          actions.className = "offer-actions members-profile-form";
          const cancel = button("Cancel plan", () => {
            if (!window.confirm("Cancel this tentative rotation plan?")) return;
            save(cancel, () => rpc("snh_cancel_rotation_plan", { p_id: plan.id }), "Plan canceled.", () => {
              if (planId === plan.id) clearPlan();
            });
          });
          actions.append(button("Edit plan", () => editPlan(plan)), cancel);
          article.append(actions);
        }
        return article;
      }, "There are no rotation plans yet.");
    }

    function confirmationForm(plan, direction, cabinet, placement) {
      if (direction === "departure" && !placement) {
        return node("p", "Confirm an arrival for this cabinet before recording its departure.");
      }
      const disclosure = node("details");
      const editor = node("form");
      editor.className = "members-profile-form";
      const date = node("input");
      date.type = "date";
      editor.append(reviewField("Observed date (optional)", date, "", 10));
      const location = node("input");
      if (direction === "arrival") {
        location.required = true;
        editor.append(reviewField("Placement location", location, "", 160));
      } else {
        editor.append(node("p", "Departing from " + placement.location));
      }
      const submit = node("button", direction === "arrival" ? "Record arrival" : "Record departure");
      editor.append(submit);
      editor.addEventListener("submit", event => {
        event.preventDefault();
        save(submit, () => rpc("snh_confirm_rotation_move", {
          p_plan: plan.id, p_direction: direction, p_observed_on: date.value || null,
          p_location: location.value.trim() || null, p_expected_cabinet: cabinet,
          p_expected_placement: direction === "departure" ? placement.id : null
        }), direction === "arrival" ? "Arrival confirmed." : "Departure confirmed.", () => {
          if (planId === plan.id) clearPlan();
        });
      });
      disclosure.append(node("summary", direction === "arrival" ? "Confirm arrival" : "Confirm departure"), editor);
      return disclosure;
    }

    async function save(control, action, message, after) {
      control.disabled = true;
      try {
        await action();
        after?.();
        feedback(message, "success");
        try {
          await refreshPlans();
        } catch {
          feedback(message + " Reload the page to refresh the plans.", "error");
        }
      } catch (error) {
        feedback(error.code === "23505"
          ? "That cabinet already has an active plan or placement that conflicts with this change."
          : "The change could not be saved. Check your access and try again.", "error");
      } finally {
        control.disabled = false;
      }
    }

    for (const game of games) cabinetForm.elements.game_id.add(new Option(game.title, game.id));
    cabinetForm.addEventListener("submit", event => {
      event.preventDefault();
      const label = cabinetForm.elements.label.value.trim();
      if (!label) {
        feedback("Enter a cabinet label.", "error");
        return;
      }
      save(event.submitter || cabinetForm.querySelector('button[type="submit"]'),
        () => rpc("snh_register_game_cabinet", { p_game_id: cabinetForm.elements.game_id.value, p_label: label }),
        "Cabinet registered.", () => cabinetForm.reset());
    });
    cancelEdit.addEventListener("click", clearPlan);
    planForm.addEventListener("submit", event => {
      event.preventDefault();
      const { incoming, outgoing, arrival, departure, note } = planForm.elements;
      if ((!incoming.value && !outgoing.value) || (incoming.value && incoming.value === outgoing.value)
        || (arrival.value && !incoming.value) || (departure.value && !outgoing.value)) {
        feedback("Choose at least one cabinet, use different cabinets for a swap, and enter dates only for selected moves.", "error");
        return;
      }
      save(event.submitter || planForm.querySelector('button[type="submit"]'), () => rpc("snh_save_rotation_plan", {
        p_id: planId, p_incoming: incoming.value || null, p_outgoing: outgoing.value || null,
        p_arrival: arrival.value || null, p_departure: departure.value || null, p_note: note.value.trim() || null
      }), "Rotation plan saved.", clearPlan);
    });

    byId("rotation-plans").hidden = false;
    byId("rotation-plans-link").hidden = false;
    refreshPlans().then(() => {
      controls.hidden = !canReview;
      if (canReview && !games.length) feedback("The catalog is unavailable. Existing cabinets can still be used in plans.");
    }).catch(error => feedback(error.code === "PGRST202"
      ? "Rotation planning is unavailable until the planning migration is applied."
      : "Rotation plans could not load. Reload the page to try again.", "error"));
  }

  async function init() {
    if (!client || !auth) throw new Error("Account service unavailable");
    const session = await auth.requireAuth({ redirectToSignin: true, next: "bring-a-game.html" });
    if (!session) return;
    auth.onAuthStateChange((_event, next) => {
      if (next?.user?.id !== session.user.id) window.location.reload();
    });

    const [allowed, roles, membership] = await Promise.all([
      rpc("snh_game_offer_eligible"),
      auth.loadMemberRoles(session.user.id),
      result(client.from("members").select("club_designation").eq("user_id", session.user.id).maybeSingle())
    ]);
    eligible = allowed === true;
    canReview = auth.memberHasAnyRole(roles, "game_coordinator");
    canCorrect = auth.memberHasAnyRole(roles, "games_admin");
    canReadReview = canReview || membership?.club_designation === "board";
    byId("offer-review-mode").textContent = canReview
      ? "Review private submissions and choose what to publish for member feedback."
      : "You can review private offers and notes with read-only Board access.";

    await refresh();
    byId("member-offers").hidden = !eligible;
    byId("offer-nav").hidden = !eligible && !canReadReview && !canCorrect;
    byId("offer-review-link").hidden = !canReadReview;
    byId("offer-review").hidden = !canReadReview;
    showStatus(eligible ? "" : "An active, email-confirmed website account is required to submit or browse offers.");

    let games = [];
    if (eligible || canReview) {
      try {
        const rows = await result(client.from("games_catalog_v1").select("id:game->>id,title:game->>title").order("slug"));
        games = rows.filter(game => game.id && game.title).sort((a, b) => a.title.localeCompare(b.title));
        for (const game of games) {
          const existing = Array.from(catalog.options).find(option => option.value === game.id);
          if (existing) existing.textContent = game.title;
          else catalog.add(new Option(game.title, game.id));
        }
      } catch {
        catalog.options[0].textContent = "Catalog unavailable · enter a title manually";
      }
    }
    if (canReadReview) startRotationPlanner(games);
    else if (canCorrect) await refreshPlacements();
  }

  init().catch(() => showStatus("Game offers could not load. Reload the page to try again.", "error"));
})();
