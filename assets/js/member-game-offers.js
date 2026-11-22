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
    canReadReview = canReview || membership?.club_designation === "board";
    byId("offer-review-mode").textContent = canReview
      ? "Review private submissions and choose what to publish for member feedback."
      : "You can review private offers and notes with read-only Board access.";

    await refresh();
    byId("member-offers").hidden = !eligible;
    byId("offer-nav").hidden = !eligible;
    byId("offer-review-link").hidden = !canReadReview;
    byId("offer-review").hidden = !canReadReview;
    showStatus(eligible ? "" : "An active, email-confirmed website account is required to submit or browse offers.");

    if (eligible) {
      try {
        const games = await result(client.from("games_catalog_v1").select("id:game->>id,title:game->>title").order("slug"));
        for (const game of games.filter(game => game.id && game.title).sort((a, b) => a.title.localeCompare(b.title))) {
          const existing = Array.from(catalog.options).find(option => option.value === game.id);
          if (existing) existing.textContent = game.title;
          else catalog.add(new Option(game.title, game.id));
        }
      } catch {
        catalog.options[0].textContent = "Catalog unavailable · enter a title manually";
      }
    }
  }

  init().catch(() => showStatus("Game offers could not load. Reload the page to try again.", "error"));
})();
