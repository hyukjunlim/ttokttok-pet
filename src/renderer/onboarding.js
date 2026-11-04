'use strict';

// Getting started (see src/onboarding.js): one step at a time, drawn from the state the main
// process sends. The page keeps only where you are and what you skipped.

(() => {
  const api = window.gettingStarted;
  const WEB_POLL_MS = 2000;   // the extension connecting sends no news; ask while waiting for it

  let state = null;
  let step = 0;
  let modeChosen = false;
  const skipped = new Set();
  const ticked = new Map();   // usage place key -> ticked (only those you changed)
  const practiced = new Set();   // the modes whose practice you finished
  let pollTimer = null;

  const STEPS = [
    { key: 'mode', name: 'Mode' },
    { key: 'usage', name: 'Claude usage', skippable: true },
    { key: 'etl', name: 'SNU eTL', skippable: true, when: (s) => s.etl.available },
    { key: 'todomate', name: 'TodoMate', skippable: true, when: (s) => s.todomate?.available },
    { key: 'slack', name: 'Slack', skippable: true, when: (s) => s.slack?.available },
    { key: 'web', name: 'Web chats', skippable: true, when: (s) => s.web.available },
    { key: 'phone', name: 'Phone', skippable: true, when: (s) => s.phone?.available },
    { key: 'try', name: 'Try it', skippable: true },
    { key: 'end', name: 'Done' },
  ];

  const PRACTICE = {
    pet: {
      click: ['Click the bubble', 'Opens that session in its app. (The practice one just makes the pet wave.)'],
      dismiss: ['Hover the bubble and click its ×', 'Marks it done, so it goes away until something new happens.'],
      hide: [['Press ', keys('Ctrl', 'Alt', 'P'), ' twice'], 'Hides the pet, then shows it again.'],
      menu: ['Right-click the pet', 'The menu with every setting. Clicking the pet itself brings Claude to the front.'],
    },
    folder: {
      click: ['Click a practice session', 'A real one opens in its app, beside the sidebar.'],
      step: [['Press ', keys('Ctrl', 'Tab'), ', then ', keys('Ctrl', 'Shift', 'Tab')],
        'Steps to the next or the previous session, and opens it. Works while Claude, Codex or the sidebar is in front.'],
      rowMenu: ['Right-click a practice session', 'Mark as done, Mark as Ready, Hide from the sidebar.'],
      hide: [['Press ', keys('Ctrl', 'Alt', 'P'), ' twice'], 'Hides the sidebar, then shows it again.'],
      menu: ['Right-click the pet at the bottom', 'The menu with every setting.'],
    },
  };

  const $ = (id) => document.getElementById(id);

  // h('div.class.other', { attr: value, onclick }, ...children); strings become text.
  function h(spec, props, ...children) {
    const [tag, ...classes] = spec.split('.');
    const node = document.createElement(tag || 'div');
    if (classes.length) node.className = classes.join(' ');
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function keys(...names) {
    const out = [];
    names.forEach((n, i) => {
      if (i) out.push('+');
      out.push(h('kbd', { text: n }));
    });
    return h('span', null, out);
  }

  function steps() {
    return state ? STEPS.filter((s) => !s.when || s.when(state)) : STEPS.slice(0, 1);
  }

  function statusOf(key) {
    if (key === 'mode') return modeChosen ? 'done' : 'todo';
    if (key === 'usage' && state.usage.places.some((p) => p.set)) return 'done';
    if (key === 'etl' && state.etl.enabled) return 'done';
    if (key === 'todomate' && state.todomate.enabled) return 'done';
    if (key === 'slack' && state.slack.enabled) return 'done';
    if (key === 'web' && state.web.on && state.web.connected > 0) return 'done';
    if (key === 'phone' && state.phone.on && state.phone.paired > 0) return 'done';
    if (key === 'try' && practiced.has(state.mode)) return 'done';
    return skipped.has(key) ? 'skipped' : 'todo';
  }

  function petEl(extra = '') {
    const el = h(`div.pet${state.pet?.pixelArt ? '.pixel' : ''}${extra}`, { 'aria-hidden': 'true' });
    if (state.pet?.url) el.style.backgroundImage = `url("${state.pet.url}")`;
    return el;
  }

  // ---------------------------------------------------------------- the steps

  const views = {
    mode() {
      const card = (value, title, what, scene) => h('button.card', {
        type: 'button', role: 'radio', 'aria-checked': String(state.mode === value),
        onclick: () => { modeChosen = true; api.act('mode', value); },
      }, h('span.tick'), scene, h('strong', { text: title }), h('span.what', { text: what }));
      return [
        h('h1', { id: 'step-title', text: 'How should the pet sit on your screen?' }),
        h('p.lead', { text: "Ttokttok Pet keeps track of what's waiting for you: Claude Code sessions, Codex threads, web chats, SNU eTL, TodoMate and Slack. Set up what you use, then try it out." }),
        h('div.cards', { role: 'radiogroup', 'aria-label': 'Mode' },
          card('pet', 'Floating pet', 'A small pet above your windows, with a bubble for each session that needs you, is working or is done.',
            h('div.scene.pet-mode', { 'aria-hidden': 'true' }, h('div.win'), h('div.mini-pill.one'), h('div.mini-pill.two'), petEl())),
          card('folder', 'Folder sidebar', 'A sidebar on the left listing every session by machine and folder. Claude and Codex fill the rest of the screen.',
            h('div.scene.folder-mode', { 'aria-hidden': 'true' },
              h('div.side', null, h('div.line'), h('div.line.on'), h('div.line'), h('div.line'), h('div.line')), h('div.win'), petEl()))),
        h('p.note', null, 'Change it any time: tray menu → ', h('em', { text: 'Mode' }), '.'),
      ];
    },

    usage() {
      const u = state.usage;
      // This PC and WSL start ticked; a server, only when you tick it.
      const isTicked = (p) => (ticked.has(p.key) ? ticked.get(p.key) : !p.set && !p.key.startsWith('ssh:'));
      const rows = u.places.map((p) => {
        const error = u.errors[p.key];
        return h('label.place', null,
          h('input', {
            type: 'checkbox', checked: isTicked(p) || p.set, disabled: p.set || u.busy,
            onchange: (e) => ticked.set(p.key, e.target.checked),
          }),
          h('span.where', null, p.label, h('br'), h('span.note', { text: p.note })),
          h(`span.state${p.set ? '.ok' : error ? '.error' : ''}`, { text: p.set ? 'Set up ✓' : error || '' }));
      });
      const wanted = u.places.filter((p) => !p.set && isTicked(p)).map((p) => p.key);
      return [
        h('h1', { id: 'step-title', text: "Claude's weekly limits" }),
        h('p.lead', { text: "The pet shows how much of your Claude plan's weekly limit you've used. It gets the figures from a small mod for Claude Code, which saves them after each reply." }),
        u.places.length
          ? [
            h('div.places', null, rows),
            u.busy
              ? h('div.status', null, h('span.dot'), `${u.busy}…`)
              : u.places.every((p) => p.set)
                ? h('div.status.ok', null, h('span.dot'), 'Set up. Claude Code sessions you start from now on save their usage.')
                : h('button.btn.primary.small', {
                  type: 'button', disabled: !wanted.length, onclick: () => api.act('usage', wanted),
                }, 'Set up on the ticked machines'),
          ]
          : h('p', { text: "Claude Code isn't on this PC, in WSL or on an SSH host the Claude app connects to, so there's nothing to set up. Skip this." }),
        h('p.note.gap', null,
          'It adds two entries to the ', h('code', { text: 'env' }), " of each machine's ", h('code', { text: '~/.claude/settings.json' }),
          ', keeping a backup. Codex needs nothing: the pet reads its limits itself. ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.act('doc', 'usage'); } }, 'How it works…')),
      ];
    },

    etl() {
      return [
        h('h1', { id: 'step-title' }, 'SNU eTL ', h('span.note', { text: '(optional)' })),
        h('p.lead', { text: "If you study at SNU, the pet tells you about assignment deadlines, new notices and today's classes from eTL." }),
        h('p', { text: "It needs an eTL access token. You make one on eTL's settings page; the pet keeps it encrypted on this PC and contacts nothing but eTL." }),
        state.etl.enabled
          ? h('div.status.ok', null, h('span.dot'), 'Connected. Deadlines and notices show as bubbles.')
          : h('p', null, h('button.btn.primary.small', { type: 'button', onclick: () => api.act('etl') }, 'Connect eTL…'),
            h('span.note', { text: ' Opens the token window (eTL 토큰 등록).' })),
        h('p.note.gap', null, 'Not at SNU? Skip this. Later: tray menu → ', h('em', { text: 'Sources' }), ' → ', h('em', { text: 'eTL' }), '.'),
      ];
    },

    todomate() {
      return [
        h('h1', { id: 'step-title' }, 'TodoMate ', h('span.note', { text: '(optional)' })),
        h('p.lead', { text: "If you keep your day in TodoMate, the pet shows today's timed items (like “13:00 팀 미팅” in the Schedule category) next to your classes, and counts down to the dates in D-Day." }),
        h('p', { text: 'It reads TodoMate through Kakao PlayMCP and never changes a todo. First add 투두메이트 to your PlayMCP toolbox; the button then opens the toolbox and asks for its connection prompt.' }),
        state.todomate.enabled
          ? h('div.status.ok', null, h('span.dot'), "Connected. Today's schedule shows as bubbles.")
          : h('p', null, h('button.btn.primary.small', { type: 'button', onclick: () => api.act('todomate') }, 'Connect TodoMate…'),
            h('span.note', { text: ' Opens the PlayMCP toolbox in the browser.' })),
        h('p.note.gap', null, "Don't use TodoMate? Skip this. Later: tray menu → ", h('em', { text: 'Sources' }), ' → ', h('em', { text: '투두메이트 일정' }), '.'),
      ];
    },

    slack() {
      return [
        h('h1', { id: 'step-title' }, 'Slack presentations ', h('span.note', { text: '(optional)' })),
        h('p.lead', { text: 'If your lab or class keeps its presentation schedule in a Slack canvas, the pet counts down to each of your turns every morning, from D-7 down to D-Day.' }),
        h('p', { text: "It needs a Slack user token (from a small app you make with the canvases:read scope), the canvas's link and your name as the canvas writes it. The pet keeps the token encrypted on this PC and only reads that canvas." }),
        state.slack.enabled
          ? h('div.status.ok', null, h('span.dot'), 'Set up. Your turns show as bubbles.')
          : h('p', null, h('button.btn.primary.small', { type: 'button', onclick: () => api.act('slack') }, 'Set up Slack…'),
            h('span.note', { text: ' Opens the setup window (Slack 발표).' })),
        h('p.note.gap', null, 'No such canvas? Skip this. Later: tray menu → ', h('em', { text: 'Sources' }), ' → ', h('em', { text: 'Slack 발표' }), '.'),
      ];
    },

    web() {
      const w = state.web;
      const copy = (text, label = 'Copy') => h('button.btn.small', {
        type: 'button',
        onclick: (e) => {
          api.act('copy', text);
          e.currentTarget.textContent = 'Copied';
        },
      }, label);
      return [
        h('h1', { id: 'step-title' }, 'Web chats ', h('span.note', { text: '(optional)' })),
        h('p.lead', { text: "Chats on claude.ai, ChatGPT and Gemini can get bubbles too, from a small extension for Chrome or Edge. It tells the pet only each chat's title, address and whether a reply is being written." }),
        h('label.switch', null,
          h('input', { type: 'checkbox', checked: w.on, onchange: (e) => api.act('web', e.target.checked) }),
          'Show claude.ai, ChatGPT and Gemini chats'),
        w.on
          ? [
            h('ol.steps', null,
              h('li', null, h('div', null, "Open your browser's extensions page.",
                h('div.actions', null,
                  h('span.pair', null, h('code', { text: 'chrome://extensions' }), copy('chrome://extensions')),
                  h('span.pair', null, h('code', { text: 'edge://extensions' }), copy('edge://extensions'))))),
              h('li', null, h('div', null, 'Turn on ', h('strong', { text: 'Developer mode' }), ' (top right of that page).')),
              h('li', null, h('div', null, 'Click ', h('strong', { text: 'Load unpacked' }), ' and pick this folder:',
                h('div.actions', null, h('code', { text: w.folder })),
                h('div.actions', null,
                  h('button.btn.small', { type: 'button', onclick: () => api.act('extensionFolder') }, 'Open folder'),
                  copy(w.folder, 'Copy path'))))),
            w.connected > 0
              ? h('div.status.ok', null, h('span.dot'), `Extension connected${w.connected > 1 ? ` in ${w.connected} browsers` : ''}. Reload any chat tabs you had open.`)
              : h('div.status', { role: 'status' }, h('span.dot'), 'Waiting for the extension… this updates by itself once it’s loaded.'),
          ]
          : h('p.note', null, 'Off. Later: tray menu → ', h('em', { text: 'Sources' }), ' → ', h('em', { text: 'Web chats' }), '.'),
      ];
    },

    // Each part of the setup in order: Tailscale here, Serve, the phone's side, the code, the Home
    // Screen. A part says what's missing until it's done, and the later ones wait for it.
    phone() {
      const p = state.phone;
      const ts = p.tailscale;
      const signedIn = Boolean(ts?.installed && ts.running && ts.name);
      const button = (label, onclick, { primary = false, disabled = false } = {}) => h(`button.btn.small${primary ? '.primary' : ''}`, { type: 'button', disabled, onclick }, label);
      const check = () => button(p.busy === 'check' ? 'Checking…' : 'Check again', () => api.act('phoneCheck'), { disabled: Boolean(p.busy) });
      const ok = (text) => h('span.ticked', { text: ` ${text} ✓` });
      // Tailscale's own link from what it said, else its admin console, where HTTPS is turned on.
      const tailscalePage = (p.error || '').match(/https:\/\/login\.tailscale\.com\/[^\s"'<>)]+/)?.[0] || 'https://login.tailscale.com/admin/dns';

      const here = !ts
        ? h('span.note', { text: 'Checking…' })
        : !ts.installed
          ? ['Install it and sign in.', h('div.actions', null, button('Open tailscale.com/download', () => api.act('phoneOpen', 'https://tailscale.com/download')), check())]
          : !signedIn
            ? ['Sign in to it on this PC.', h('div.actions', null, check())]
            : ok(ts.name);
      const serve = !signedIn
        ? h('span.note', { text: 'After step 1.' })
        : ts.served
          ? ['Your devices reach it at ', h('code', { text: p.address }), ok('')]
          : [
            'This runs ', h('code', { text: `tailscale serve --bg http://127.0.0.1:${p.port}` }), ': only devices signed in to your tailnet can open it.',
            h('div.actions', null, button(p.busy === 'serve' ? 'Setting up…' : 'Set up Tailscale Serve', () => api.act('phoneServe'), { primary: true, disabled: Boolean(p.busy) })),
            p.error && h('div.said', null,
              h('p', null, 'Tailscale said: ', h('code', { text: p.error })),
              h('p.note', { text: 'The first time, Tailscale may ask you to turn on HTTPS certificates for your tailnet. Turn them on, then set up Serve again.' }),
              button('Open the Tailscale page', () => api.act('phoneOpen', tailscalePage))),
          ];
      const address = ts?.served && p.address
        ? h('div.actions', null, h('span.pair', null, h('code', { text: p.address }),
          h('button.btn.small', { type: 'button', onclick: (e) => { api.act('copy', p.address); e.currentTarget.textContent = 'Copied'; } }, 'Copy')))
        : h('span.note', { text: ' the address from step 2.' });
      const code = p.code
        ? [h('div.code', { text: `${p.code.slice(0, 3)} ${p.code.slice(3)}`, 'aria-label': `Pairing code ${p.code.split('').join(' ')}` }),
          h('span.note', { text: 'Works once, for 10 minutes. ' }), button('New code', () => api.act('phoneCode'))]
        : p.paired > 0
          ? [ok(`${p.paired} phone${p.paired > 1 ? 's' : ''} paired`), ' ', button('Pair another phone', () => api.act('phoneCode'))]
          : button('Show the pairing code', () => api.act('phoneCode'), { disabled: !ts?.served });

      return [
        h('h1', { id: 'step-title' }, 'Your phone ', h('span.note', { text: '(optional)' })),
        h('p.lead', { text: 'See what the pet shows on your phone, and get a notification when a chat finishes or eTL has news. The phone reaches this PC through Tailscale, from your own devices only; the PC has to stay on.' }),
        h('label.switch', null,
          h('input', { type: 'checkbox', checked: p.on, onchange: (e) => api.act('phone', e.target.checked) }),
          'Show the sidebar on my phone, with notifications'),
        p.on
          ? [
            !p.serving && h('div.status.error', { role: 'alert' }, h('span.dot'), `Port ${p.port} is taken by another program, so the pet can't serve the page.`),
            h('ol.steps', null,
              h('li', null, h('div', null, h('strong', { text: 'Tailscale on this PC. ' }), here)),
              h('li', null, h('div', null, h('strong', { text: 'Let your phone reach the pet. ' }), serve)),
              h('li', null, h('div', null, h('strong', { text: 'On your phone, ' }),
                'install Tailscale, sign in with the same account, turn it on, and open', address)),
              h('li', null, h('div', null, h('strong', { text: 'Enter the pairing code there. ' }), code)),
              h('li', null, h('div', null, h('strong', { text: 'Add the page to the Home Screen' }),
                ' (an iPhone needs that for notifications: Share → Add to Home Screen, then open it from there) and tap ',
                h('em', { text: 'Turn on notifications' }), '.', p.notifying > 0 && ok('Notifications on')))),
          ]
          : h('p.note', null, 'Off. Later: tray menu → ', h('em', { text: 'Phone' }), '.'),
        h('p.note.gap', null, 'Tray menu → ', h('em', { text: 'Phone' }), ' → ', h('em', { text: 'Send a test notification' }),
          ' checks that notifications arrive. Taps open the Claude and ChatGPT apps, so have those on the phone too.'),
      ];
    },

    try() {
      const mode = state.mode;
      const tried = new Set(state.practice?.mode === mode ? state.practice.tried : []);
      const list = Object.entries(PRACTICE[mode]);
      const left = list.filter(([k]) => !tried.has(k)).length;
      return [
        h('h1', { id: 'step-title', text: `Try it on the ${mode === 'pet' ? 'pet' : 'sidebar'}` }),
        h('p.lead', {
          text: mode === 'pet'
            ? 'A practice bubble is next to your pet now. Try each of these; they tick as you do them.'
            : 'Two practice sessions are at the top of your sidebar now. Try each of these; they tick as you do them.',
        }),
        h('div.practice', null,
          h('ol.todo', null, list.map(([k, [what, how]]) => h(`li${tried.has(k) ? '.done' : ''}`, null,
            h(`span.mark${tried.has(k) ? '.done' : ''}`, { text: tried.has(k) ? '✓' : '', 'aria-hidden': 'true' }),
            h('span', null, what, tried.has(k) && h('span.sr', { text: ' (done)' }), h('span.how', { text: how }))))),
          mode === 'pet'
            ? h('div.preview', { 'aria-hidden': 'true' }, h('div.caption', { text: 'On your screen' }),
              h('div.pill', null, h('span.icon'), h('span', null, h('span.label', { text: 'Practice' }), ' Click me', h('br'),
                h('span.detail', { text: 'Ttokttok Pet · now' })), h('span.x', { text: '×' })),
              petEl())
            : h('div.preview.folder-mode', { 'aria-hidden': 'true' }, h('div.caption', { text: 'At the top of your sidebar' }),
              h('div.mini-sidebar', null,
                h('div.head', { text: 'Practice' }),
                h('div.r.waiting.sel', null, 'Answer me', h('span.s', { text: 'Needs you' })),
                h('div.r.review', null, 'Read me', h('span.s', { text: 'Ready' })),
                h('div.head.next', { text: 'Local' }),
                h('div.r.quiet', { text: 'your sessions…' })),
              petEl())),
        h('p.note.gap', {
          text: left
            ? `${left} to go. The practice ${mode === 'pet' ? 'bubble goes' : 'sessions go'} when you leave this step.`
            : 'All done.',
        }),
      ];
    },

    end() {
      const line = (ok, text) => h('li', null, h(`span.mark${ok ? '.done' : '.skipped'}`, { text: ok ? '✓' : '–' }), text);
      const s = (key) => statusOf(key) === 'done';
      return [
        h('h1', { id: 'step-title', text: "You're all set" }),
        h('p.lead', { text: 'Ttokttok Pet starts with Windows and keeps watching in the background.' }),
        h('ul.summary', null,
          line(true, state.mode === 'pet' ? 'Floating pet' : 'Folder sidebar'),
          line(s('usage'), s('usage') ? 'Claude’s weekly limits' : 'Claude’s weekly limits: skipped'),
          state.etl.available && line(s('etl'), s('etl') ? 'SNU eTL' : 'SNU eTL: skipped'),
          state.todomate?.available && line(s('todomate'), s('todomate') ? 'TodoMate' : 'TodoMate: skipped'),
          state.slack?.available && line(s('slack'), s('slack') ? 'Slack presentations' : 'Slack presentations: skipped'),
          state.web.available && line(s('web'), s('web') ? 'Web chats' : 'Web chats: skipped'),
          state.phone?.available && line(s('phone'), s('phone') ? 'Phone' : 'Phone: skipped')),
        h('p.note', null, 'Bring this back any time: tray menu → ', h('em', { text: 'Getting started…' })),
      ];
    },
  };

  // ---------------------------------------------------------------- drawing, moving between steps

  function render() {
    const list = steps();
    step = Math.min(step, list.length - 1);
    const current = list[step];
    if (current.key === 'try' && state) {
      const tried = state.practice?.mode === state.mode ? state.practice.tried : [];
      if (Object.keys(PRACTICE[state.mode]).every((k) => tried.includes(k))) practiced.add(state.mode);
    }
    $('rail').replaceChildren(...list.map((s, i) => {
      const st = state ? statusOf(s.key) : 'todo';
      const mark = h(`span.mark${st === 'done' ? '.done' : st === 'skipped' ? '.skipped' : ''}`, {
        text: st === 'done' ? '✓' : st === 'skipped' ? '–' : '', 'aria-hidden': 'true',
      });
      return h('li', null, h('button', {
        type: 'button', 'aria-current': i === step ? 'step' : null, onclick: () => go(i),
        'aria-label': st === 'todo' ? s.name : `${s.name}, ${st}`,
      }, mark, h('span.name', { text: s.name })));
    }));
    $('content').replaceChildren(...(state ? [views[current.key]()].flat(Infinity).filter(Boolean) : []));
    $('back').classList.toggle('hidden', step === 0);
    $('skip').hidden = !current.skippable || statusOf(current.key) === 'done';
    $('next').textContent = current.key === 'end' ? 'Close' : 'Next';
    pollWeb(current.key === 'web' && state?.web.on && !(state.web.connected > 0));
  }

  function go(i) {
    const list = steps();
    const before = list[step]?.key;
    step = Math.max(0, Math.min(list.length - 1, i));
    const after = list[step].key;
    if (before !== after) {
      if (after === 'try') api.act('practice', state.mode);
      else if (before === 'try') api.act('practice', null);
      if (after === 'phone' && state.phone.on) api.act('phoneCheck');   // Tailscale may have changed since
    }
    render();
    $('content').focus({ preventScroll: true });
    $('content').scrollTop = 0;
  }

  function pollWeb(on) {
    if (on && !pollTimer) pollTimer = setInterval(() => api.act('refresh'), WEB_POLL_MS);
    else if (!on && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  $('back').addEventListener('click', () => go(step - 1));
  $('skip').addEventListener('click', () => {
    const key = steps()[step].key;
    if (statusOf(key) !== 'done') skipped.add(key);
    go(step + 1);
  });
  $('next').addEventListener('click', () => {
    const key = steps()[step].key;
    if (key === 'end') return api.act('close');
    if (key === 'mode') modeChosen = true;
    go(step + 1);
  });

  api.onState((next) => {
    state = next;
    render();
  });
  api.ready();
})();
