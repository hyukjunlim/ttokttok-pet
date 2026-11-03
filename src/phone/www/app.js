'use strict';

// The phone page: what the pet's sidebar shows (src/renderer/folder.js), from the pet on the PC
// (src/phone/server.js). Machines and folders fold as they do there; a tap on a session opens its
// app, Claude or ChatGPT (or Gemini for a Gemini chat), an eTL notice opens in LearningX and a Slack
// reminder in Slack, by the link links.js makes.

(() => {
  const LABELS = { waiting: 'Needs you', failed: 'Error', review: 'Ready', running: 'Running', background: 'Background' };
  const APP_NAME = {
    claude: 'Claude', codex: 'Codex', vscode: 'VS Code', terminal: 'Terminal', 'codex-vscode': 'VS Code', 'codex-terminal': 'Terminal',
  };
  const { hrefOf, appName } = self.phoneLinks;
  const POLL_MS = 4000;
  const LIVE_MS = 15_000;            // longer than this without an answer: the PC is out of reach
  const ANDROID = /Android/i.test(navigator.userAgent);
  const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const PUSH = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const $ = (id) => document.getElementById(id);
  let state = null;
  let etag = null;
  let lastOk = 0;
  let timer = null;
  let highlight = decodeURIComponent((location.hash.match(/^#item=(.+)$/) || [])[1] || '') || null;
  const fold = loadFold();          // key -> open, where you changed it

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------------------------------------------------------- links into the apps

  function linkRow(cls, open) {
    const href = hrefOf(open);
    const a = el('a', cls);
    if (href) {
      a.href = href;
      // An intent opens the app over this page; a web address opens beside it.
      if (!href.startsWith('intent:')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    }
    return a;
  }

  // ---------------------------------------------------------- the PC's data

  async function poll() {
    clearTimeout(timer);
    try {
      const res = await fetch('/api/state', { headers: etag ? { 'If-None-Match': etag } : {}, cache: 'no-store' });
      if (res.status === 401) {
        showPair();
        return;
      }
      if (res.status === 200) {
        etag = res.headers.get('ETag');
        state = await res.json();
        render();
      } else if (res.status !== 304) {
        throw new Error(`HTTP ${res.status}`);
      }
      lastOk = Date.now();
      showMain();
    } catch {
      // The PC is asleep, or the phone is off the tailnet: keep showing what came last.
    }
    renderLink();
    if (document.visibilityState === 'visible') timer = setTimeout(poll, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
    else clearTimeout(timer);
  });

  function renderLink() {
    const live = Date.now() - lastOk < LIVE_MS;
    const link = $('link');
    if ($('main').hidden) {
      link.textContent = '';
      return;
    }
    link.classList.toggle('live', live);
    link.textContent = live ? 'Live' : lastOk ? `PC out of reach · ${formatAgo(lastOk)} ago` : 'Connecting…';
  }

  // ---------------------------------------------------------- pairing

  function showPair() {
    $('pair').hidden = false;
    $('main').hidden = true;
  }

  function showMain() {
    $('pair').hidden = true;
    if (!$('main').hidden) return;
    $('main').hidden = false;
    renderAlerts();
  }

  function deviceName() {
    if (/iPhone/i.test(navigator.userAgent)) return 'iPhone';
    if (/iPad/i.test(navigator.userAgent) || (IOS && !/iPhone/i.test(navigator.userAgent))) return 'iPad';
    const m = navigator.userAgent.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/);
    return ANDROID ? (m?.[1]?.trim() || 'Android phone') : 'Browser';
  }

  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pair-error').textContent = '';
    const res = await post('/api/pair', { code: $('code').value, name: deviceName() }).catch(() => null);
    if (res?.ok) {
      $('code').value = '';
      etag = null;
      poll();
    } else {
      $('pair-error').textContent = res ? 'That code didn\'t work. Ask the pet for a new one.' : 'The PC is out of reach.';
    }
  });

  $('unpair').addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
    await (await reg?.pushManager.getSubscription().catch(() => null))?.unsubscribe().catch(() => {});
    await post('/api/unpair', {}).catch(() => null);
    state = null;
    etag = null;
    showPair();
  });

  function post(url, body, method = 'POST') {
    return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  // ---------------------------------------------------------- notifications

  async function renderAlerts() {
    const box = $('alerts');
    box.replaceChildren();
    if (!PUSH) {
      // An iPhone has notifications only for a page added to the Home Screen.
      if (IOS && !STANDALONE) box.append(el('p', '', 'For notifications, add this page to the Home Screen: Share → Add to Home Screen, then open it from there.'));
      box.hidden = !box.childElementCount;
      return;
    }
    const sub = await subscription();
    const res = await fetch('/api/push-key', { cache: 'no-store' }).catch(() => null);
    const known = res?.ok ? (await res.json()).subscribed : false;
    $('test').hidden = !(sub && known);
    if (sub && known && Notification.permission === 'granted') {
      box.hidden = true;
      return;
    }
    const button = el('button', '', Notification.permission === 'denied' ? 'Notifications are blocked in settings' : 'Turn on notifications');
    button.type = 'button';
    button.disabled = Notification.permission === 'denied';
    button.addEventListener('click', () => turnOnNotifications(button));
    box.append(el('p', '', 'Get a notification when a chat finishes or needs you, and for new eTL notices.'), button);
    box.hidden = false;
  }

  async function subscription() {
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
  }

  // The permission has to be asked for in the tap itself, before anything else waits.
  function turnOnNotifications(button) {
    const asked = Notification.requestPermission();
    button.disabled = true;
    (async () => {
      if ((await asked) !== 'granted') throw new Error('Notifications weren\'t allowed.');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await (await fetch('/api/push-key', { cache: 'no-store' })).json();
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
      const res = await post('/api/push', { subscription: sub.toJSON() });
      if (!res.ok) throw new Error('The pet didn\'t take the subscription.');
    })().then(renderAlerts, (err) => {
      button.disabled = false;
      $('alerts').append(el('p', 'error', err.message));
    });
  }

  function sameKey(sub, key) {
    const k = sub.options?.applicationServerKey;
    if (!k) return true;
    const a = new Uint8Array(k);
    const b = fromB64u(key);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }

  function fromB64u(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  $('test').addEventListener('click', async () => {
    const res = await post('/api/test-push', {}).catch(() => null);
    if (!res?.ok) $('alerts').append(el('p', 'error', 'The test notification didn\'t go out.'));
  });

  // A tap on a notification: the page shows that session or notice.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type !== 'show') return;
    highlight = e.data.id;
    if (state) render();
  });

  // ---------------------------------------------------------- the tree

  function render() {
    if (!state) return;
    const tree = $('tree');
    tree.replaceChildren(...state.hosts.map(hostEl));
    $('empty').hidden = state.hosts.length > 0;
    renderNotices();
    renderMeter();
    if (highlight) {
      const row = [...document.querySelectorAll('[data-id]')].find((r) => r.dataset.id === highlight);
      if (row) {
        row.classList.add('highlight');
        row.scrollIntoView({ block: 'center' });
        highlight = null;
        history.replaceState(null, '', '/');
      }
    }
  }

  function hostEl(h) {
    const open = isOpen(h.key, true);
    const wrap = el('div', `host${open ? ' open' : ''}`);
    wrap.setAttribute('role', 'group');
    const head = el('button', 'host-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'host-name', h.label));
    if (!open) head.append(...pips(h));
    head.addEventListener('click', () => setOpen(h.key, !open));
    wrap.append(head);
    if (open) {
      const kids = el('div', 'children');
      for (const f of h.folders) kids.append(folderEl(f, 0));
      if (h.kind === 'chat') for (const s of h.loose) kids.append(sessionEl(s, 0));
      else if (h.loose.length) {
        kids.append(folderEl({ key: `${h.key}|loose`, label: 'No folder', path: '', sessions: h.loose, children: [], open: true, attention: 0, busy: 0 }, 0));
      }
      wrap.append(kids);
    }
    return wrap;
  }

  function folderEl(n, depth) {
    const open = isOpen(n.key, n.open);
    const wrap = el('div', `folder${open ? ' open' : ''}`);
    const row = el('button', 'row');
    row.type = 'button';
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(open));
    row.append(el('span', 'chevron', '▶'), el('span', 'name', n.label));
    if (!open) row.append(...pips(n));
    row.addEventListener('click', () => setOpen(n.key, !open));
    wrap.append(row);
    if (open) {
      const kids = el('div', 'children');
      for (const s of n.sessions) kids.append(sessionEl(s, depth + 1));
      for (const c of n.children) kids.append(folderEl(c, depth + 1));
      wrap.append(kids);
    }
    return wrap;
  }

  function sessionEl(s, depth) {
    const row = linkRow(`row session status-${s.status}`, s.open);
    row.dataset.id = s.id;
    row.style.setProperty('--depth', String(depth + (s.nest || 0)));   // a fork, under the session it came from
    row.setAttribute('role', 'treeitem');
    const label = LABELS[s.status];
    const app = s.siteName || APP_NAME[s.app] || '';
    row.setAttribute('aria-label', [s.title, app, label, `Opens ${appName(s.open?.app) || 'the app'}`].filter(Boolean).join(', '));
    row.append(el('span', 'chevron', s.nest ? '└' : null), el('span', `app ${s.app}`), el('span', 'name', s.title));
    row.append(label ? el('span', 'state', label) : el('span', 'ago', formatAgo(s.lastActivityAt)));
    return row;
  }

  function pips(n) {
    if (n.attention > 0) return [el('span', 'pip attention')];
    if (n.busy > 0) return [el('span', 'pip busy')];
    return [];
  }

  function isOpen(key, byDefault) {
    return Object.hasOwn(fold, key) ? fold[key] : byDefault;
  }

  function setOpen(key, open) {
    fold[key] = open;
    try {
      localStorage.setItem('fold', JSON.stringify(fold));
    } catch {
      // private browsing: folding lasts until the page closes
    }
    render();
  }

  function loadFold() {
    try {
      const saved = JSON.parse(localStorage.getItem('fold') || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------- eTL and the weekly limits

  function renderNotices() {
    const box = $('notices');
    box.hidden = !state.notices.length;
    box.replaceChildren(...state.notices.map((s) => {
      const row = linkRow(`row session notice status-${s.status}`, s.open);
      row.dataset.id = s.id;
      row.setAttribute('aria-label', [s.badge, s.title, s.project, `Opens ${appName(s.open?.app) || 'the app'}`].filter(Boolean).join(', '));
      const text = el('span', 'text');
      text.append(el('span', 'name', s.title));
      if (s.project) text.append(el('span', 'sub', s.project));
      row.append(el('span', 'state', s.badge || LABELS[s.status] || ''), text);
      return row;
    }));
  }

  function renderMeter() {
    const box = $('meter');
    box.hidden = !state.usage.length;
    box.replaceChildren(...state.usage.map((u) => {
      const g = el('div', `gauge ${u.app}`);
      const label = el('div', 'gauge-label');
      label.append(el('span', 'name', u.name), el('span', 'pct', `${u.percent}%`));
      const track = el('div', 'track');
      const fill = el('span', 'fill');
      fill.style.width = `${Math.min(100, Math.max(0, u.percent))}%`;
      track.append(fill);
      if (u.elapsed != null) {
        const now = el('span', 'now');
        now.style.left = `${u.elapsed}%`;
        track.append(now);
      }
      const note = [u.resetsIn && `resets in ${u.resetsIn}`, u.age && `as of ${u.age} ago`].filter(Boolean).join(' · ');
      g.append(label, track);
      if (note) g.append(el('div', 'gauge-note', note));
      return g;
    }));
  }

  function formatAgo(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  // ---------------------------------------------------------- start

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  poll();
  setInterval(renderLink, 5000);
})();
