(function () {
  const list = document.getElementById('pingolf-list');
  const status = document.getElementById('pingolf-status');
  const search = document.getElementById('pingolf-search');
  const only = document.getElementById('pingolf-only');
  const all = document.getElementById('pingolf-all');
  const missing = document.getElementById('pingolf-missing');
  const portal = window.SNHMemberPortal;
  const rows = [];
  let canEdit = false;
  let authVersion = 0;

  function button(label, action) {
    const node = profileText('button', label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function updateFilters() {
    const query = search.value.trim().toLowerCase();
    let count = 0;
    for (const row of rows) {
      row.item.hidden = !row.game.title.toLowerCase().includes(query)
        || (only.checked && !row.targets.length)
        || (canEdit && missing.checked && row.state === 'loaded' && row.targets.length > 0);
      if (!row.item.hidden) count++;
    }
    if (!rows.length) status.textContent = 'No games are on the floor.';
    else if (!count) status.textContent = 'No games match these filters.';
    else status.textContent = `${count} of ${rows.length} games on the floor`;
  }

  function targetLine(target) {
    const line = profileText('div', '', 'pingolf-target');
    const score = target.scoreThreshold;
    const objective = target.description;
    const objectiveTarget = objective && target.targetType !== 'score';
    if (score) line.append(profileText('strong', score.replace(/\B(?=(\d{3})+(?!\d))/g, ',')));
    if (objective) line.append(profileText('span', objective));
    function copyControl(label, value) {
      const control = button(label, async () => {
        try {
          await navigator.clipboard.writeText(value);
          if (control.textContent === label) {
            control.textContent = 'Copied';
            setTimeout(() => { control.textContent = label; }, 1500);
          }
        } catch {
          control.textContent = 'Copy failed · retry';
          setTimeout(() => { control.textContent = label; }, 1500);
        }
      });
      return control;
    }
    if (score) line.append(copyControl('Copy score', score));
    if (objectiveTarget) line.append(copyControl('Copy objective', objective));
    return line;
  }

  function renderTargets(row) {
    const targets = [...row.targets].sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred));
    const shown = all.checked ? targets : targets.slice(0, 1);
    row.display.replaceChildren(...shown.map(targetLine));
    if (row.state === 'loading') row.display.append(profileText('small', 'Loading club targets…'));
    if (row.state === 'failed') {
      row.display.append(profileText('small', 'Club targets unavailable. '),
        button('Retry', async () => { await loadTargets(row); updateFilters(); }));
    }
    if (row.state === 'loaded' && !shown.length) row.display.append(profileText('span', 'No target yet'));
    row.edit.textContent = row.targets.length ? 'Edit targets' : 'Add target';
  }

  async function loadTargets(row) {
    if (!gameHasCatalogUuid(row.game)) {
      row.state = 'failed';
      renderTargets(row);
      return;
    }
    row.state = 'loading';
    renderTargets(row);
    try {
      const data = await gameProfileRpc('snh_public_game_more_info', { p_game_id: row.game.id });
      row.targets = data?.pingolfTargets || [];
      row.state = 'loaded';
    } catch {
      row.state = 'failed';
    }
    renderTargets(row);
  }

  function renderEditor(row, records, target = {}) {
    const form = document.createElement('form');
    const fields = document.createElement('fieldset');
    fields.className = 'pingolf-fields';
    const feedback = profileText('p', '');
    feedback.setAttribute('role', 'status');
    function field(label, node) {
      const wrap = profileText('label', label);
      wrap.append(node);
      fields.append(wrap);
      return node;
    }
    const choice = field('Target to edit', document.createElement('select'));
    const addOption = profileText('option', 'Add a target');
    addOption.value = '';
    addOption.disabled = records.length >= 10;
    choice.append(addOption);
    for (const record of records) {
      const option = profileText('option', record.description);
      option.value = record.id;
      choice.append(option);
    }
    choice.value = target.id || '';
    choice.addEventListener('change', () => renderEditor(row, records, records.find(record => record.id === choice.value)));

    const description = field('Target description', document.createElement('input'));
    description.required = true;
    description.value = target.description || '';
    const type = field('Target type', document.createElement('select'));
    for (const [value, label] of [['score', 'Score'], ['feature', 'Feature objective'], ['progression', 'Progression objective'], ['hybrid', 'Hybrid']]) {
      const option = profileText('option', label);
      option.value = value;
      type.append(option);
    }
    type.value = target.targetType || 'score';
    const score = field('Score threshold (optional)', document.createElement('input'));
    score.inputMode = 'numeric';
    score.pattern = '[0-9]+';
    score.value = target.scoreThreshold || '';
    const notes = field('Internal notes', document.createElement('input'));
    notes.value = target.notes || '';
    const preferred = field('Preferred target', document.createElement('input'));
    preferred.type = 'checkbox';
    preferred.checked = !!target.isPreferred;
    const save = profileText('button', target.id ? 'Save target' : 'Add target');
    save.type = 'submit';
    fields.append(save, button('Cancel', () => closeEditor(row)));
    form.append(fields, feedback);
    row.editor.replaceChildren(form);
    choice.focus();

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!canEdit || fields.disabled) return;
      const scoreValue = score.value.trim();
      if (!description.value.trim() || (scoreValue && (!/^\d+$/.test(scoreValue) || BigInt(scoreValue) <= 0n || BigInt(scoreValue) > 9223372036854775807n))) {
        feedback.textContent = 'Enter a description and, if used, a positive whole-number score within the supported range.';
        return;
      }
      fields.disabled = true;
      feedback.textContent = 'Saving…';
      try {
        await portal.pingolfTargetUpsert(target.id, row.game.id, {
          description: description.value.trim(), targetType: type.value,
          scoreThreshold: scoreValue || null, notes: notes.value.trim() || null,
          isPreferred: preferred.checked
        });
      } catch (error) {
        feedback.textContent = portal.getFriendlyAuthErrorMessage(error);
        fields.disabled = false;
        return;
      }
      if (form.isConnected) {
        closeEditor(row);
        row.feedback.textContent = 'Target saved.';
      }
      await loadTargets(row);
      updateFilters();
    });
  }

  function closeEditor(row) {
    row.editor.replaceChildren();
    row.editor.hidden = true;
    row.edit.setAttribute('aria-expanded', 'false');
    if (!row.edit.hidden) row.edit.focus();
  }

  async function openEditor(row) {
    if (!row.editor.hidden) {
      if (row.editor.querySelector('fieldset')?.disabled) return;
      closeEditor(row);
      return;
    }
    row.feedback.textContent = '';
    row.editor.hidden = false;
    row.edit.setAttribute('aria-expanded', 'true');
    const loading = profileText('p', 'Loading editor…');
    row.editor.replaceChildren(loading);
    try {
      const records = await portal.pingolfTargetsListEditor(row.game.id);
      if (canEdit && loading.isConnected) renderEditor(row, records, records[0]);
    } catch (error) {
      if (loading.isConnected) loading.textContent = portal.getFriendlyAuthErrorMessage(error);
    }
  }

  function addRow(game, index) {
    const item = profileText('li', '', 'pingolf-row');
    const name = profileText('h2', game.title);
    const body = document.createElement('div');
    const display = document.createElement('div');
    const editor = profileText('div', '', 'pingolf-editor');
    editor.id = `pingolf-editor-${index}`;
    editor.hidden = true;
    const feedback = profileText('small', '');
    feedback.setAttribute('role', 'status');
    const row = { game, item, display, editor, feedback, targets: [], state: 'loading' };
    row.edit = button('Add target', () => { if (canEdit) void openEditor(row); });
    row.edit.hidden = !canEdit || !gameHasCatalogUuid(game);
    row.edit.setAttribute('aria-controls', editor.id);
    row.edit.setAttribute('aria-expanded', 'false');
    body.append(display, row.edit, feedback, editor);
    item.append(name, body);
    list.append(item);
    renderTargets(row);
    return row;
  }

  async function refreshAccess() {
    const version = ++authVersion;
    const allowed = await currentUserCanManageGames();
    if (version !== authVersion) return;
    canEdit = allowed;
    document.getElementById('pingolf-missing-label').hidden = !allowed;
    for (const row of rows) {
      row.edit.hidden = !allowed || !gameHasCatalogUuid(row.game);
      if (!allowed && !row.editor.hidden) closeEditor(row);
    }
    if (rows.length) updateFilters();
  }

  search.addEventListener('input', updateFilters);
  only.addEventListener('change', () => {
    if (only.checked) missing.checked = false;
    updateFilters();
  });
  missing.addEventListener('change', () => {
    if (missing.checked) only.checked = false;
    updateFilters();
  });
  all.addEventListener('change', () => rows.forEach(renderTargets));
  window.SNHSiteAuth?.onAuthStateChange((event) => {
    if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(event)) setTimeout(refreshAccess, 0);
  });
  void refreshAccess();

  async function loadLineup() {
    try {
      const data = await fetchGamesCatalogPayload();
      enrichGamesPayload(data);
      const today = todayIsoDate();
      const lineup = data.games.filter(game => !isSoftDeletedGame(game) && isGameActiveOnDate(game, today));
      lineup.sort((a, b) => a.title.localeCompare(b.title));
      rows.push(...lineup.map(addRow));
      updateFilters();
      let next = 0;
      await Promise.all(Array.from({ length: 5 }, async () => {
        while (next < rows.length) {
          await loadTargets(rows[next++]);
          updateFilters();
        }
      }));
    } catch {
      status.textContent = 'Could not load today’s lineup. Reload the page to try again.';
    }
  }

  void loadLineup();
})();
