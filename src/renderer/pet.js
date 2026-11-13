'use strict';

(() => {
  const api = window.pet;
  const stage = document.getElementById('stage');
  const petEl = document.getElementById('pet');
  const spriteEl = document.getElementById('sprite');
  const trayEl = document.getElementById('tray');
  const meterEl = document.createElement('div');   // the weekly limits, at the pet's end of the stack
  const badgeEl = document.getElementById('badge');
  const player = new window.SpritePlayer(spriteEl);
  player.onMeasured = (headroom) => {
    stage.style.setProperty('--headroom', String(Math.min(0.5, headroom)));
    updateShape();
  };
  player.onShapeChange = () => updateShape();

  const LABELS = { waiting: 'Needs you', failed: 'Error', review: 'Ready', running: 'Running', background: 'Background' };
  const BUSY = new Set(['running', 'background']);   // still going: nothing to dismiss
  const ATTENTION = new Set(['waiting', 'failed', 'review']);
  const NOTICES = new Set(['etl', 'slack', 'todomate', 'resets', 'practice']);   // bubbles that aren't sessions
  const ETL_LINK = /^https:\/\/myetl\.snu\.ac\.kr\//;
  const SHADOW_ROOM = 16;          // px kept around the bubbles so their shadows aren't cut off

  let sessions = [];
  let showActivity = true;
  let showSessions = true;     // ... sessions' bubbles too, not only eTL's, Slack's and TodoMate's
  let usage = [];              // weekly limits: [{ app, name, percent, elapsed, resetsIn }]
  let drag = null;
  let awaitingLanding = false;
  let scale = 0.75;
  let petCenterX = window.innerWidth / 2;
  let bubbleMargin = 12;
  let previous = new Map();

  // ---------------------------------------------------------- layout

  api.onPet((pet) => {
    player.setSheet(pet);
    petEl.setAttribute('aria-label', `${pet.displayName}, your pet`);
  });
  api.onMotion(({ alwaysAnimate }) => player.setAlwaysAnimate(alwaysAnimate));

  let lastLayout = null;
  window.addEventListener('resize', () => lastLayout && applyLayout(lastLayout));
  api.onLayout(applyLayout);

  function applyLayout(l) {
    lastLayout = l;
    scale = l.scale;
    bubbleMargin = l.margin;
    const dpr = window.devicePixelRatio || 1;
    const w = 192 * scale;
    const h = 208 * scale;
    const left = Math.round(l.petLeft * dpr) / dpr;    // whole device pixels keep pixel art crisp
    petCenterX = left + w / 2;
    stage.style.setProperty('--pet-w', `${w}px`);
    stage.style.setProperty('--pet-h', `${h}px`);
    stage.style.setProperty('--pet-left', `${left}px`);
    stage.classList.toggle('above', l.layout === 'above');
    stage.classList.toggle('below', l.layout === 'below');
    placeBubbles();
  }

  // Center each bubble over the pet, but keep it inside the window (which stays on the
  // pet's monitor) with a margin, so near an edge the bubbles slide inward.
  function placeBubbles() {
    const width = window.innerWidth;
    const maxWidth = width - 2 * bubbleMargin;
    for (const el of trayEl.children) {
      el.style.maxWidth = `${maxWidth}px`;
      const w = el.offsetWidth;
      const x = Math.min(Math.max(petCenterX - w / 2, bubbleMargin), width - bubbleMargin - w);
      el.style.marginLeft = `${Math.round(x)}px`;
    }
    fitTray();
    updateShape();
  }

  // Every session gets a bubble. The window grows to fit the stack (up to the monitor's edge);
  // if even that isn't enough, the stack scrolls.
  let reportedHeight = -1;
  function fitTray() {
    const needed = trayEl.children.length ? trayEl.scrollHeight + SHADOW_ROOM : 0;
    if (Math.abs(needed - reportedHeight) > 1) {
      reportedHeight = needed;
      api.traySize(needed);
    }
    trayEl.classList.toggle('scroll', trayEl.scrollHeight > trayEl.clientHeight + 1);
  }

  // ---------------------------------------------------------- sessions

  api.onSessions((payload) => {
    sessions = payload.sessions || [];
    showActivity = payload.showActivity !== false;
    showSessions = payload.showSessions !== false;
    reactToChanges();
    render();
    player.setBase(acting()[0]?.status || 'idle');   // background has no animation: the pet idles
  });

  // What the pet acts out: the most urgent of the list, less the sessions when their bubbles are
  // hidden (eTL's, Slack's and TodoMate's only); then a session's Needs you or Ready doesn't move it.
  function acting() {
    return showActivity && !showSessions ? sessions.filter((s) => NOTICES.has(s.kind)) : sessions;
  }

  api.onUsage((items) => {
    usage = Array.isArray(items) ? items : [];
    renderMeter();
    render();
  });

  function reactToChanges() {
    const list = acting();
    const next = new Map(list.map((s) => [s.id, s.status]));
    let finished = false;
    for (const [id, status] of next) {
      const before = previous.get(id);
      if (BUSY.has(before) && status === 'review') finished = true;
    }
    previous = next;
    if (finished && list[0]?.status === 'review') player.playOnce('jumping');
  }

  let renderedIds = new Set();

  function render() {
    trayEl.replaceChildren();
    if (usage.length) trayEl.append(meterEl);   // next to the pet, with the bubbles beyond it
    const visible = showActivity ? acting() : [];   // None: no bubbles, and the pet acts out everything
    for (const s of visible) {
      const el = pill(s);
      if (!renderedIds.has(s.id)) el.classList.add('enter');
      trayEl.append(el);
    }
    renderedIds = new Set(visible.map((s) => s.id));
    placeBubbles();

    // With every bubble hidden, a badge on the pet counts sessions that need attention. With only
    // sessions' hidden there's none.
    const attention = sessions.filter((s) => ATTENTION.has(s.status)).length;
    const badge = showActivity ? 0 : attention;
    badgeEl.hidden = badge <= 0;
    badgeEl.textContent = badge > 9 ? '9+' : String(badge);
    badgeEl.className = attention ? 'attention' : '';
    updateShape();
  }

  function pill(s) {
    const el = document.createElement('div');
    el.className = `pill status-${s.status}`;
    el.setAttribute('role', 'listitem');
    const codex = s.kind === 'codex';
    const etl = s.kind === 'etl';
    const slack = s.kind === 'slack';    // a presentation reminder from a Slack canvas
    const todomate = s.kind === 'todomate';   // an item of today's TodoMate schedule
    const resets = s.kind === 'resets';       // an account's rate-limit reset, counting down; its title names the app
    const web = s.kind === 'web';        // a claude.ai, ChatGPT or Gemini chat in the browser
    const cli = s.kind === 'cli';        // Claude Code in VS Code or a terminal
    const client = s.client === 'vscode' ? 'VS Code' : 'Terminal';   // ... and Codex's chats there
    const source = web ? s.siteName || s.site : etl ? 'eTL' : slack ? 'Slack' : todomate ? 'TodoMate' : resets ? '' : codex ? (s.client ? `Codex · ${client}` : 'Codex')
      : s.kind === 'practice' ? 'Ttokttok Pet' : cli ? client : 'Claude';
    // No hover tooltip (it pops up over the other bubbles); screen readers still get the details.
    const where = s.remote ? (codex ? `on ${s.remote}` : `SSH · ${s.remote}`) : '';
    // The main process opens an eTL link only on eTL's own site (see sessionUrl there).
    const action = (cli || (codex && s.client)) && s.client !== 'vscode' ? 'Terminal session (no link)'
      : codex && s.client ? 'Click to open in VS Code'
      : etl && !s.assistant && !ETL_LINK.test(s.url || '') ? 'eTL notice (no link)'
        : s.clearOnClick ? 'Click to clear until tomorrow'
        : todomate ? 'TodoMate schedule (no link)'
        : slack && !s.url ? 'Slack reminder (no link)'
          : `Click to open in ${web ? 'the browser' : source}`;
    el.setAttribute('aria-label', [s.title, s.detail, where, action].filter(Boolean).join(', '));

    const icon = document.createElement('span');
    icon.className = 'icon';
    el.append(icon);

    const text = document.createElement('span');
    text.className = 'text';
    const line = document.createElement('span');
    line.className = 'line1';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = s.badge || LABELS[s.status] || s.status;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title;
    line.append(label, title);
    // "Claude · tokenizer · 5m": which app, the project, how long. A long project name gets cut
    // short, but the time stays visible.
    const detail = document.createElement('span');
    detail.className = 'detail';
    const ago = formatAgo(s.since);
    // Today's classes and TodoMate schedule read as one timeline (timeline.js), without the app.
    detail.append(span('what', [s.startsAt == null && source, s.project].filter(Boolean).join(' · ')));
    if (ago) detail.append(span('ago', `· ${ago}`));
    text.append(line, detail);
    el.append(text);

    // The eTL 비서 bubble is 'background' only to sit last; its × turns it off (as the tray menu does).
    if (!BUSY.has(s.status) || s.assistant) {
      const close = document.createElement('button');
      close.className = 'close';
      close.type = 'button';
      close.setAttribute('aria-label', s.assistant ? 'Turn off this bubble' : 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        api.dismiss(s.id);
      });
      el.append(close);
    }

    el.addEventListener('click', () => {
      api.activate(s.id);
      player.playOnce('waving');
    });
    el.addEventListener('animationend', () => updateShape());   // it has settled where it was laid out
    return el;
  }

  // One bubble with a row per app: how much of its weekly limit is used (the fill, and the number
  // on the right), against how far into the week it is (the line across the row). A fill past the
  // line means you're using it faster than the week goes by. Clicking it does nothing (the window's
  // shape covers it, so the click doesn't reach what's behind either).
  meterEl.className = 'meter';
  meterEl.setAttribute('role', 'listitem');

  // The week line is 2px, rounded to whole screen pixels. At 175% scaling 2px is 3.5 pixels, and
  // each row's line would come out 3 or 4 wide depending on where it falls.
  function sizeWeekLine() {
    const dpr = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty('--now-width', `${Math.max(1, Math.round(2 * dpr)) / dpr}px`);
    matchMedia(`(resolution: ${dpr}dppx)`).addEventListener('change', () => {
      sizeWeekLine();
      updateShape();
    }, { once: true });
  }
  sizeWeekLine();

  function renderMeter() {
    meterEl.replaceChildren(...usage.map(gauge));
    const said = usage.map((u) => [`${u.name} ${u.percent}% used`, u.elapsed != null && `${u.elapsed}% into the week`]
      .filter(Boolean).join(', '));
    meterEl.setAttribute('aria-label', `Weekly limits: ${said.join('; ')}`);
  }

  function gauge(u) {
    const el = document.createElement('div');
    el.className = `gauge ${u.app}`;
    const fill = span('fill', '');
    fill.style.width = `${u.percent}%`;
    el.append(fill);
    if (u.elapsed != null) {
      const now = span('now', '');
      now.style.left = `${u.elapsed}%`;
      el.append(now);
    }
    el.append(span('name', u.name), span('pct', `${u.percent}%`));
    // Rows with a solid fill (Claude's) draw their text twice more, each copy cut at the fill's
    // edge: the usual color outside the fill, and the fill's own text color over it.
    for (const [layer, clip] of [['base', `inset(0 0 0 ${u.percent}%)`], ['ink', `inset(0 ${100 - u.percent}% 0 0)`]]) {
      const copy = span(layer, '');
      copy.append(span('name', u.name), span('pct', `${u.percent}%`));
      copy.style.clipPath = clip;
      el.append(copy);
    }
    return el;
  }

  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function formatAgo(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  setInterval(render, 30_000);     // keep "3m ago" fresh

  // ---------------------------------------------------------- the window's shape

  // The window takes the mouse only where something is drawn, the pet and the bubbles, and a click
  // anywhere else goes to the window behind it (see src/shape.js). Windows tells apart what's in
  // the shape and what isn't, so nothing here follows the cursor. Each rectangle is reported as a
  // distance from the edge of the window the content is anchored to (the bottom, while the
  // bubbles are above the pet), so the main process can keep it in place while it resizes the
  // window.
  // Room around each bubble for its shadow. It has to be drawn inside the shape, and where the
  // shape ends the shadow is cut off, so this reaches as far as the shadow does: in the dark
  // theme over a white page it is down to 1/255 about 25 px out to the sides, 16 above (it falls
  // 6 px down) and 31 below. Less shows as a faint box around the stack.
  const BUBBLE_REACH = { left: 26, top: 18, right: 26, bottom: 32 };
  let shapeKey = '';

  function updateShape() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const above = stage.classList.contains('above');
    const rects = [];
    const cover = (left, top, right, bottom) => {
      const x0 = Math.max(0, Math.floor(left));
      const y0 = Math.max(0, Math.floor(top));
      const x1 = Math.min(width, Math.ceil(right));
      const y1 = Math.min(height, Math.ceil(bottom));
      if (x1 > x0 && y1 > y0) rects.push([x0, above ? height - y1 : y0, x1 - x0, y1 - y0]);
    };
    const box = spriteEl.getBoundingClientRect();
    for (const [x, y, w, h] of player.shapeRects(box.width, box.height)) {
      cover(box.left + x, box.top + y, box.left + x + w, box.top + y + h);
    }
    if (!badgeEl.hidden) {
      const r = badgeEl.getBoundingClientRect();
      cover(r.left - 4, r.top - 4, r.right + 4, r.bottom + 4);
    }
    const tray = trayEl.getBoundingClientRect();
    for (const el of trayEl.children) {
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, tray.top);          // a scrolled stack is cut off by the tray
      const bottom = Math.min(r.bottom, tray.bottom);
      if (bottom > top) cover(r.left - BUBBLE_REACH.left, top - BUBBLE_REACH.top, r.right + BUBBLE_REACH.right, bottom + BUBBLE_REACH.bottom);
    }
    const key = `${above}|${JSON.stringify(rects)}`;
    if (key === shapeKey) return;
    shapeKey = key;
    api.setShape({ layout: above ? 'above' : 'below', rects });
  }

  trayEl.addEventListener('scroll', () => updateShape());
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => updateShape()).observe(trayEl);

  function overPet(clientX, clientY) {
    const r = spriteEl.getBoundingClientRect();
    return player.hitTest(clientX - r.left, clientY - r.top, r.width, r.height);
  }

  // ---------------------------------------------------------- hover, drag, throw, click

  let hoverArmed = true;
  spriteEl.addEventListener('pointermove', (e) => {
    const over = overPet(e.clientX, e.clientY);
    if (over && hoverArmed && !drag && !player.transient) {
      hoverArmed = false;
      player.playOnce('jumping');
    }
    if (!over) hoverArmed = true;
  });
  petEl.addEventListener('pointerleave', () => {
    hoverArmed = true;
  });

  petEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !overPet(e.clientX, e.clientY)) return;
    e.preventDefault();
    petEl.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false, samples: [{ x: e.screenX, y: e.screenY, t: e.timeStamp }] };
    petEl.classList.add('dragging');
    api.dragStart(e.screenX, e.screenY);
  });

  petEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // If a release event is missed, a button-free move ends the drag.
    if (!(e.buttons & 1)) {
      endDrag(e, true);
      return;
    }
    drag.samples.push({ x: e.screenX, y: e.screenY, t: e.timeStamp });
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 100) drag.samples.shift();
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    drag.x = e.screenX;
    drag.y = e.screenY;
    if (dx >= 4) player.hold('running-right');
    else if (dx <= -4) player.hold('running-left');
    api.dragMove(e.screenX, e.screenY);
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    petEl.classList.remove('dragging');
    if (petEl.hasPointerCapture(e.pointerId)) petEl.releasePointerCapture(e.pointerId);
    let vx = 0;
    let vy = 0;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (d.moved && !cancelled && dt > 0.01) {
      vx = ((last.x - first.x) / dt) * 1.6;
      vy = ((last.y - first.y) / dt) * 1.6;
    }
    awaitingLanding = d.moved;
    api.dragEnd(vx, vy);
    if (!d.moved && !cancelled) {
      api.activate(null);
      player.playOnce('waving');
    }
  }

  petEl.addEventListener('pointerup', (e) => endDrag(e, false));
  petEl.addEventListener('pointercancel', (e) => endDrag(e, true));
  petEl.addEventListener('lostpointercapture', (e) => endDrag(e, true));

  api.onLanded(() => {
    if (awaitingLanding) {
      awaitingLanding = false;
      player.release();
    }
  });

  petEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.contextMenu(e.screenX, e.screenY);
  });

  api.onWake(() => player.playOnce('waving', 3));   // a longer hello than a click's

  api.ready();
})();
