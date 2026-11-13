'use strict';
(() => {
  const api = window.codexAccounts;
  const box = document.getElementById('accounts');
  const signin = document.getElementById('signin');
  const error = document.getElementById('error');
  const applied = document.getElementById('apply-status');
  let busy = false;
  let latest;
  const drafts = new Map();
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  // `shown`: where an error goes (the Claude tab has its own). Resolves true when it went through.
  async function act(action, data, shown = error) {
    if (busy) return false;
    busy = true;
    shown.hidden = true;
    try {
      const result = await api.act(action, data);
      if (result.error) { shown.textContent = result.error; shown.hidden = false; }
      if (result.state) render(result.state);
      return !result.error;
    } catch { shown.textContent = 'Could not contact the account monitor.'; shown.hidden = false; return false; }
    finally { busy = false; }
  }
  const button = (text, action, data) => { const b = el('button', text); b.type = 'button'; b.addEventListener('click', () => act(action, data)); return b; };
  const date = (value) => new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
  function bankedResets(summary) {
    const section = el('section', null, 'banked-resets');
    section.append(el('h3', 'Banked resets'));
    if (!summary) { section.append(el('p', 'Not provided by Codex.', 'detail')); return section; }
    section.append(el('strong', `${summary.availableCount} available`));
    if (summary.credits === null) {
      section.append(el('p', 'Expiration details are not available.', 'detail'));
      return section;
    }
    const next = summary.credits.find((c) => c.status === 'available' && c.expiresAt != null && c.expiresAt > Date.now());
    if (next) section.append(el('p', `Next expiry: ${date(next.expiresAt)}`, 'detail'));
    if (summary.credits.length < summary.availableCount) section.append(el('p', `Codex returned ${summary.credits.length} detail records for ${summary.availableCount} available resets.`, 'detail'));
    if (summary.credits.length) {
      const details = el('details');
      details.append(el('summary', 'Reset details'));
      for (const credit of summary.credits) {
        const row = el('div', null, 'reset-credit');
        row.append(el('strong', credit.title));
        const status = credit.status === 'available' && credit.expiresAt != null && credit.expiresAt <= Date.now() ? 'Expiration has passed since the last check' : credit.status;
        row.append(el('p', `Status: ${status}`, 'detail'));
        if (credit.grantedAt != null) row.append(el('p', `Granted: ${date(credit.grantedAt)}`, 'detail'));
        row.append(el('p', !credit.expiryKnown ? 'Expiry not provided' : credit.expiresAt === null ? 'No expiry' : `Expires: ${date(credit.expiresAt)}`, 'detail'));
        if (credit.description) row.append(el('p', credit.description, 'detail'));
        details.append(row);
      }
      section.append(details);
    }
    return section;
  }
  function duration(minutes, slot) {
    if (!minutes) return `${slot} limit`;
    if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
    return `${minutes}-minute limit`;
  }
  // ---------------------------------------------------------- tabs

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function select(tab, focus = false) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
    try { localStorage.setItem('accountsTab', tab.id); } catch { /* not kept */ }
  }
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) { e.preventDefault(); select(tabs[(i + step + tabs.length) % tabs.length], true); }
    });
  }
  try { const saved = document.getElementById(localStorage.getItem('accountsTab') || ''); if (tabs.includes(saved)) select(saved); } catch { /* the first tab */ }

  // ---------------------------------------------------------- Claude's resets, entered by hand

  const claudeForm = document.getElementById('claude-form');
  const claudeError = document.getElementById('claude-error');
  const claudeBox = document.getElementById('claude-resets');
  const fields = { kind: document.getElementById('claude-kind'), count: document.getElementById('claude-count'),
    date: document.getElementById('claude-date'), time: document.getElementById('claude-time') };
  const saveButton = document.getElementById('claude-save');
  const cancelButton = document.getElementById('claude-cancel');
  let editing = null;
  function editMode(entry) {
    editing = entry?.id ?? null;
    fields.kind.value = entry?.kind ?? '';
    fields.count.value = String(entry?.count ?? 1);
    fields.date.value = entry?.date ?? '';
    fields.time.value = entry?.time ?? '';
    saveButton.textContent = editing ? 'Save changes' : 'Add reset';
    cancelButton.hidden = !editing;
    if (editing) fields.kind.focus();
  }
  claudeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { kind: fields.kind.value, count: Number(fields.count.value), date: fields.date.value, time: fields.time.value || null };
    if (await act(editing ? 'claude-edit' : 'claude-add', editing ? { id: editing, ...data } : data, claudeError)) editMode(null);
  });
  cancelButton.addEventListener('click', () => editMode(null));
  // '2026-11-16' in the system's format, with its weekday: the date as entered (no time zone to convert).
  const dayOf = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  function renderClaude(entries = []) {
    if (editing && !entries.some((e) => e.id === editing)) editMode(null);
    const kinds = document.getElementById('claude-kinds');
    const known = [...new Set(entries.map((e) => e.kind))];   // the kinds entered before, as suggestions
    if (known.join('\n') !== [...kinds.options].map((o) => o.value).join('\n')) {
      kinds.replaceChildren(...known.map((k) => { const o = el('option'); o.value = k; return o; }));
    }
    claudeBox.replaceChildren();
    if (!entries.length) { claudeBox.append(el('p', 'No Claude resets entered.', 'detail')); return; }
    for (const entry of entries) {
      const card = el('article', null, entry.expired ? 'expired' : null);
      const heading = el('div', null, 'account-heading');
      heading.append(el('h2', `${entry.kind}${entry.count > 1 ? ` × ${entry.count}` : ''}`));
      if (entry.dday) heading.append(el('span', entry.dday, 'applied-badge'));
      card.append(heading);
      const until = `${dayOf(entry.date)}${entry.time ? ` ${entry.time}` : ', end of day'} (KST)`;
      card.append(el('p', entry.expired ? `Expired: ${until}` : `Expires: ${until}`, 'detail'));
      const actions = el('div', null, 'actions');
      if (!entry.expired) {
        const used = el('button', entry.count > 1 ? 'Used one' : 'Used it');
        used.type = 'button';
        used.title = entry.count > 1 ? `One fewer: ${entry.count - 1} left.` : 'Removes this entry.';
        used.addEventListener('click', () => act('claude-use', { id: entry.id }, claudeError));
        const edit = el('button', 'Edit');
        edit.type = 'button';
        edit.addEventListener('click', () => editMode(entry));
        actions.append(used, edit);
      }
      const remove = el('button', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', () => act('claude-remove', { id: entry.id }, claudeError));
      actions.append(remove);
      card.append(actions);
      claudeBox.append(card);
    }
  }

  // ---------------------------------------------------------- Codex

  function render(state) {
    if (!state) return;
    latest = state;
    renderClaude(state.claudeResets);
    document.getElementById('refresh').disabled = state.refreshing;
    document.querySelector('#add button').disabled = Boolean(state.pending);
    if (state.error) { error.textContent = state.error; error.hidden = false; }
    signin.hidden = !state.pending;
    signin.replaceChildren();
    if (state.pending) {
      signin.append(el('h2', 'Connect your account'), el('p', 'Open the sign-in page and enter this code.'), el('code', state.pending.code || 'Preparing…'));
      const actions = el('div', null, 'actions');
      actions.append(button('Open sign-in page', 'signin'), button('Cancel', 'cancel'));
      signin.append(actions);
    }
    applied.hidden = !state.apply;
    applied.replaceChildren();
    if (state.apply) {
      const selected = state.accounts.find((a) => a.id === state.apply.accountId);
      applied.append(el('h2', `${selected?.label || 'Account'} · ${state.apply.busy ? 'Apply' : 'Last Apply result'}`));
      const labels = { checking: 'Checking', not_checked: 'Not checked', needs_login: 'First sign-in required', ready: 'Ready', signing_in: 'Waiting for sign-in', applying: 'Applying', applied: 'Applied', error: 'Needs attention', cancelled: 'Cancelled', not_applied: 'Not applied', unknown: 'Unknown' };
      for (const [target, result] of Object.entries(state.apply.targets)) {
        applied.append(el('p', `${target}: ${labels[result.status] || result.status}${result.error ? ` · ${result.error}` : ''}`));
      }
      if (state.apply.phase === 'partial') applied.append(el('p', 'Only some targets are applied. Check each target’s status before retrying.'));
      if (Object.values(state.apply.targets).some((t) => t.error?.includes('older or unverified'))) applied.append(el('p', 'Only changing the saved CLI login is blocked. Usage monitoring and banked-reset information still work.', 'detail'));
      if (state.apply.pending) {
        applied.append(el('p', `Sign in to ${selected?.label || 'the selected account'} for ${state.apply.pending.target}.`), el('code', state.apply.pending.code));
        applied.append(button('Open sign-in page', 'target-signin'));
      }
      if (state.apply.busy) applied.append(button('Cancel', 'target-cancel'));
    }
    box.replaceChildren();
    const hosts = state.applyTargets || [];
    const hostList = hosts.length > 1 ? `${hosts.slice(0, -1).join(', ')} and ${hosts.at(-1)}` : hosts.join('');
    if (!state.accounts.length) box.append(el('p', 'No accounts connected. Add an account to see its usage.'));
    for (const account of state.accounts) {
      const card = el('article');
      const current = state.currentAccounts?.[account.id];
      const currentTargets = Object.entries(current?.targets || {}).filter(([, value]) => value.status === 'applied').map(([target]) => target);
      const heading = el('div', null, 'account-heading'); heading.append(el('h2', account.label));
      if (currentTargets.length) heading.append(el('span', current.appliedEverywhere ? 'Applied' : `Applied on ${currentTargets.join(', ')}`, 'applied-badge'));
      card.append(heading);
      card.append(el('p', hosts.map((target) => {
        const status = current?.targets?.[target]?.status;
        return `${target}: ${status === 'applied' ? 'Applied' : status === 'other' ? 'Not applied' : 'Status unknown'}`;
      }).join(' · '), 'target-selection detail'));
      const label = el('input'); label.value = drafts.get(account.id) ?? account.label; label.maxLength = 80; label.setAttribute('aria-label', 'Account label');
      label.addEventListener('input', () => drafts.set(account.id, label.value));
      const rename = el('button', 'Save label'); rename.addEventListener('click', async () => { await act('update', { id: account.id, label: label.value }); drafts.delete(account.id); });
      const controls = el('div', null, 'actions'); controls.append(label, rename);
      card.append(controls);
      let status = account.status === 'ready' ? 'Connected' : account.status === 'disabled' ? 'Monitoring paused' : account.status === 'unavailable' ? 'Usage unavailable — refresh or reconnect' : 'Usage not available yet';
      if (account.status === 'duplicate') status = 'This subscription is already shown under another connected account.';
      if (account.status === 'account_changed') status = 'This login changed accounts. Reconnect using the original account.';
      if (account.stale && account.at) status += ' · Last reading is stale';
      card.append(el('p', status, 'detail'));
      for (const w of account.windows) {
        const row = el('section', null, 'window');
        const line = el('div');
        line.append(el('span', `${w.label} · ${duration(w.minutes, w.slot)}`), el('strong', w.expired ? 'Awaiting refresh' : `${Math.round(100 - w.usedPercent)}% remaining`));
        row.append(line);
        if (!w.expired) { const meter = el('progress'); meter.max = 100; meter.value = 100 - w.usedPercent; meter.setAttribute('aria-label', `${account.label} remaining allowance`); row.append(meter); }
        if (w.resetsAt) row.append(el('p', `${w.expired ? 'Previous reset' : 'Resets'}: ${date(w.resetsAt)}`, 'detail'));
        card.append(row);
      }
      card.append(bankedResets(account.bankedResets));
      if (account.at) card.append(el('p', `Last checked: ${new Date(account.at).toLocaleString()}`, 'detail'));
      const actions = el('div', null, 'actions');
      const apply = button(current?.appliedEverywhere ? 'Applied' : 'Apply', 'apply', { id: account.id });
      apply.className = 'apply-button';
      apply.disabled = Boolean(current?.appliedEverywhere || state.apply?.busy || state.pending);
      apply.title = current?.appliedEverywhere ? `Already selected on ${hostList}.` : `Apply this account to ${hostList}.`;
      actions.append(apply);
      actions.append(button(account.enabled ? 'Pause monitoring' : 'Resume monitoring', 'update', { id: account.id, enabled: !account.enabled }), button('Reconnect', 'reconnect', { id: account.id }), button('Disconnect', 'remove', { id: account.id }));
      card.append(actions); box.append(card);
    }
  }
  document.getElementById('add').addEventListener('submit', (e) => { e.preventDefault(); act('add', { label: document.getElementById('label').value }); });
  document.getElementById('refresh').addEventListener('click', () => act('refresh'));
  api.onState(render);
  api.state().then(render).catch(() => { error.textContent = 'Could not load accounts.'; error.hidden = false; });
  setInterval(() => { if (latest && !document.querySelector('input:focus')) api.state().then(render).catch(() => {}); }, 60_000);
})();
