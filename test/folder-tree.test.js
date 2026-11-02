'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTree, splitPath, attentionIds, hiddenMenu } = require('../src/folder-tree');

const NOW = Date.parse('2026-10-25T00:00:00Z');
const ago = (days) => NOW - days * 24 * 60 * 60 * 1000;

// ~/.ssh/config and Codex's connections, as on a PC that works on one lab server and in WSL.
const SSH_HOSTS = [
  { alias: 'lab', hostName: '192.0.2.10', user: null, port: null },
  { alias: 'wsl-ubuntu', hostName: '127.0.0.1', user: null, port: null },
];
const CONNECTIONS = [
  { hostId: 'remote-ssh-discovered:lab', name: 'lab', target: 'lab', port: null },
  { hostId: 'remote-ssh-discovered:wsl-ubuntu', name: 'wsl-ubuntu', target: 'wsl-ubuntu', port: null },
];

const claude = (id, cwd, extra = {}) => ({
  id, kind: 'desktop', title: id, cwd, machineKey: null, machine: null, status: 'idle', since: ago(1), lastActivityAt: ago(1), ...extra,
});
const onLab = { machineKey: 'ssh:me@192.0.2.10:22', machine: '192.0.2.10' };
const codex = (id, cwd, hostId = 'local', extra = {}) => ({
  id: `codex:${id}`, kind: 'codex', title: id, cwd, hostId, status: 'idle', since: ago(2), lastActivityAt: ago(2), ...extra,
});

const build = (claudeList, codexList) => buildTree({
  claude: claudeList, codex: codexList, sshHosts: SSH_HOSTS, codexConnections: CONNECTIONS, defaultWsl: 'Ubuntu', now: NOW,
});
const titles = (n) => n.sessions.map((s) => s.title);

test('a quiet session you marked shows as Ready; one with news of its own shows that', () => {
  const [lab] = buildTree({
    claude: [claude('paper figures', '/data/me/projects/BirdCount', onLab), claude('stride', '/data/me/projects/RiverSurvey', { ...onLab, status: 'running', since: NOW - 500 })],
    sshHosts: SSH_HOSTS, codexConnections: CONNECTIONS, marked: { 'paper figures': NOW - 1000, stride: NOW - 1000 }, now: NOW,
  });
  const [projects] = lab.folders;
  const [bb, retro] = [...projects.children].sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual([bb.sessions[0].status, bb.sessions[0].since, retro.sessions[0].status], ['review', NOW - 1000, 'running']);
  assert.equal(lab.attention, 1);   // a folded machine says so
});

test('the two apps\' names for one server meet, and a parent folder\'s session stays at the parent', () => {
  const [lab] = build(
    [claude('paper figures', '/data/me/projects/BirdCount', onLab), claude('stride', '/data/me/projects/RiverSurvey', onLab)],
    [codex('compare descriptors', '/data/me/projects', 'remote-ssh-discovered:lab'), codex('outline stride', '/data/me/projects/RiverSurvey', 'remote-ssh-discovered:lab')],
  );
  assert.equal(lab.key, 'ssh:192.0.2.10:22');
  assert.equal(lab.label, 'lab');                         // the alias, not the address
  assert.equal(lab.folders.length, 1);
  const [projects] = lab.folders;
  assert.equal(projects.label, '/data/me/projects');      // the folders above it are one row
  assert.deepEqual(titles(projects), ['compare descriptors']);
  assert.deepEqual(projects.children.map((c) => [c.label, titles(c).sort()]), [
    ['BirdCount', ['paper figures']],
    ['RiverSurvey', ['outline stride', 'stride']],      // both apps' sessions in one folder
  ]);
});

test('WSL is one host whether the path came as a distro, a share, Codex\'s local threads, or an SSH loopback', () => {
  const hosts = build(
    [claude('tok', '/home/me/tok', { machineKey: 'wsl:Ubuntu', machine: 'Ubuntu' }), claude('share', '\\\\wsl$\\Ubuntu\\home\\me\\tok')],
    [codex('chem', '/home/me/chem'), codex('loop', '/home/me/tok', 'remote-ssh-discovered:wsl-ubuntu')],
  );
  assert.deepEqual(hosts.map((h) => [h.key, h.label]), [['wsl:ubuntu', 'WSL']]);
  // With a second distro, each names its own.
  const two = build([claude('tok', '\\\\wsl$\\Ubuntu\\home\\me\\tok'), claude('deb', '\\\\wsl$\\Debian\\home\\me\\deb')]);
  assert.deepEqual(two.map((h) => h.label), ['WSL · Debian', 'WSL · Ubuntu']);
  const [home] = hosts[0].folders;
  assert.equal(home.label, '/home/me');
  assert.deepEqual(home.children.map((c) => [c.label, titles(c).sort()]), [['tok', ['loop', 'share', 'tok']], ['chem', ['chem']]]);
});

test("Codex's chats in VS Code or a terminal say so, and one in WSL sits under WSL", () => {
  const hosts = build([], [
    codex('ext', '/home/me/urban-map', 'local', { client: 'vscode', machineKey: 'wsl:Ubuntu', machine: 'Ubuntu' }),
    codex('tui', '/data/me/projects', 'remote-ssh-discovered:lab', { client: 'terminal' }),
    codex('app', '/data/me/projects', 'remote-ssh-discovered:lab'),
  ]);
  const rows = (n) => [...n.sessions, ...n.children.flatMap(rows)];
  assert.deepEqual(hosts.map((h) => [h.label, h.folders.flatMap(rows).map((s) => [s.title, s.app]).sort()]), [
    ['WSL', [['ext', 'codex-vscode']]],
    ['lab', [['app', 'codex'], ['tui', 'codex-terminal']]],
  ]);
});

test('Windows paths match without case, /mnt/c is this PC, and an inner folder is shown below its parent', () => {
  const [pc] = build(
    [claude('home', 'C:\\Users\\Me'), claude('pet', 'c:\\users\\me\\ttokttok-pet', { lastActivityAt: ago(0.5) })],
    [codex('etl', '/mnt/c/Users/Me/ttokttok-pet')],
  );
  assert.equal(pc.key, 'pc');
  const [me] = pc.folders;
  assert.equal(me.label, 'C:\\Users\\Me');
  assert.deepEqual(titles(me), ['home']);
  assert.deepEqual(me.children.map((c) => [c.label, titles(c)]), [['ttokttok-pet', ['pet', 'etl']]]);
});

test('sessions without a folder of their own go under No folder', () => {
  const [pc] = build(
    [claude('scratch', 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b\\scratch-1'), claude('none', null)],
    [codex('brief', '/mnt/c/Users/me/Documents/Codex/2026-08-19/morning-brief')],
  );
  assert.deepEqual(pc.folders, []);
  assert.deepEqual(pc.loose.map((s) => s.title).sort(), ['brief', 'none', 'scratch']);
});

test('hosts come in a fixed order; folders by their latest session; folded when quiet for a month', () => {
  const hosts = build(
    [claude('lab old', '/data/old', { ...onLab, lastActivityAt: ago(60), since: ago(60) }), claude('lab new', '/data/new', onLab), claude('pc', 'C:\\x')],
    [codex('wsl', '/home/me/x')],
  );
  assert.deepEqual(hosts.map((h) => h.kind), ['pc', 'wsl', 'ssh']);
  const [data] = hosts[2].folders;
  assert.equal(data.label, '/data');                     // two folders in it: it stays a row of its own
  assert.deepEqual(data.children.map((f) => [f.label, f.open]), [['new', true], ['old', false]]);
});

test('a folder counts what needs you and what is working below it, so a folded one can say so', () => {
  const [lab] = build(
    [claude('asks', '/data/p/a', { ...onLab, status: 'waiting' }), claude('runs', '/data/p/b', { ...onLab, status: 'running' })],
    [codex('done', '/data/p', 'remote-ssh-discovered:lab', { status: 'review' })],
  );
  const [p] = lab.folders;
  assert.deepEqual([p.attention, p.busy], [2, 1]);
  assert.deepEqual([lab.attention, lab.busy], [2, 1]);
});

test('Mark all as done takes what shows Needs you, Error or Ready, on every machine and in No folder', () => {
  const hosts = buildTree({
    claude: [
      claude('asks', '/data/p/a', { ...onLab, status: 'waiting' }), claude('runs', '/data/p/b', { ...onLab, status: 'running' }),
      claude('broke', null, { status: 'failed' }), claude('marked', 'C:\\x'), claude('quiet', 'C:\\y'),
    ],
    codex: [codex('done', '/data/p', 'remote-ssh-discovered:lab', { status: 'review' })],
    sshHosts: SSH_HOSTS, codexConnections: CONNECTIONS, marked: { marked: NOW - 1000 }, now: NOW,
  });
  assert.deepEqual(attentionIds(hosts).sort(), ['asks', 'broke', 'codex:done', 'marked']);
});

test('paths are read the way each app writes them', () => {
  assert.deepEqual(splitPath('\\\\wsl.localhost\\Ubuntu').segments, []);
  assert.equal(splitPath('\\\\wsl.localhost\\Ubuntu').host.key, 'wsl:ubuntu');
  assert.deepEqual(splitPath('/mnt/d/data').segments, ['D:', 'data']);
  assert.deepEqual(splitPath('C:/Users/me/').segments, ['C:', 'Users', 'me']);
  assert.equal(splitPath('relative/path'), null);
  assert.equal(splitPath(null), null);
});

test('web chats come first, right under Chat, newest first, each with its site\'s mark', () => {
  const chat = (id, site, extra = {}) => ({
    id: `web:${site}:${id}`, kind: 'web', site, title: id, status: 'idle', since: 0, lastActivityAt: ago(1), ...extra,
  });
  const hosts = buildTree({
    claude: [claude('pc', 'C:\\x')],
    chats: [chat('gpt old', 'chatgpt', { lastActivityAt: ago(3) }), chat('plan', 'claude', { status: 'review' }), chat('gpt new', 'chatgpt', { status: 'running', lastActivityAt: ago(0.5) })],
    now: NOW,
  });
  assert.deepEqual(hosts.map((h) => [h.key, h.label]), [['chat', 'Chat'], ['pc', 'Local']]);
  const [c] = hosts;
  assert.deepEqual(c.folders, []);
  assert.deepEqual(c.loose.map((s) => [s.title, s.app]), [['gpt new', 'chatgpt'], ['plan', 'claude-web'], ['gpt old', 'chatgpt']]);
  assert.deepEqual([c.attention, c.busy], [1, 1]);
  assert.equal(buildTree({ chats: [], claude: [claude('pc', 'C:\\x')], now: NOW })[0].key, 'pc');   // no chats, no heading
});

test("a Gemini chat sits under Chat with Gemini's own mark", () => {
  const [c] = buildTree({ chats: [{ id: 'web:gemini:671b3f7b87a71fc7', kind: 'web', site: 'gemini', title: 'MICC', status: 'review', since: ago(0.1), lastActivityAt: ago(0.1) }], now: NOW });
  assert.deepEqual([c.key, c.loose.map((s) => [s.title, s.app, s.status])], ['chat', [['MICC', 'gemini', 'review']]]);
});

test('a fork sits right under the session it came from, and a family where its newest session would', () => {
  const at = (days) => ({ lastActivityAt: ago(days), since: ago(days) });
  const [lab] = build(
    [
      claude('local_qiskit', '/data/me/projects', { ...onLab, ...at(3) }),
      claude('local_btw', '/data/me/projects', { ...onLab, ...at(0.1), forkOf: 'local_qiskit' }),
      claude('local_fork', '/data/me/projects', { ...onLab, ...at(1), forkOf: 'local_qiskit' }),
      claude('local_deeper', '/data/me/projects', { ...onLab, ...at(2), forkOf: 'local_fork' }),
      claude('local_other', '/data/me/projects', { ...onLab, ...at(0.5) }),
      claude('local_elsewhere', '/data/me/other', { ...onLab, ...at(0.2), forkOf: 'local_qiskit' }),
    ],
    [
      codex('compare', '/data/me/projects', 'remote-ssh-discovered:lab', at(4)),
      codex('compare (2)', '/data/me/projects', 'remote-ssh-discovered:lab', { ...at(5), forkOf: 'codex:compare' }),
    ],
  );
  const projects = lab.folders[0].children.find((c) => c.label === 'projects');
  assert.deepEqual(projects.sessions.map((s) => [s.title, s.nest ?? 0]), [
    ['local_qiskit', 0], ['local_btw', 1], ['local_fork', 1], ['local_deeper', 2],
    ['local_other', 0],
    ['compare', 0], ['compare (2)', 1],
  ]);
  const other = lab.folders[0].children.find((c) => c.label === 'other');
  assert.deepEqual(other.sessions.map((s) => [s.title, s.nest ?? 0]), [['local_elsewhere', 0]], 'its parent is in another folder');
});

test('forks that name each other in a loop are still listed, once each', () => {
  const [pc] = build([claude('a', 'C:\\x', { forkOf: 'b' }), claude('b', 'C:\\x', { forkOf: 'a', lastActivityAt: ago(0.5) })], []);
  assert.deepEqual(pc.folders[0].sessions.map((s) => s.title).sort(), ['a', 'b']);
});

test('the hidden sessions are listed by machine and folder, each with Show all here', () => {
  const hosts = build(
    [claude('pet', 'C:\\Users\\me\\pet'), claude('pet-old', 'C:\\Users\\me\\pet\\old'), claude('lab-run', '/data/me/run', onLab)],
    [codex('wsl-chat', '/home/me/notes')],
  );
  const shown = [];
  const menu = hiddenMenu(hosts, (ids) => shown.push(ids));
  const shape = (items) => items.map((i) => (i.submenu ? [i.label, shape(i.submenu)] : i.label ?? '—'));
  assert.deepEqual(shape(menu), [
    ['Local  (2)', ['Show all 2 here', '—', ['C:\\Users\\me\\pet  (2)', ['Show all 2 here', '—', 'pet', ['old  (1)', ['Show it', '—', 'pet-old']]]]]],
    ['WSL  (1)', ['Show it', '—', ['/home/me/notes  (1)', ['Show it', '—', 'wsl-chat']]]],
    ['lab  (1)', ['Show it', '—', ['/data/me/run  (1)', ['Show it', '—', 'lab-run']]]],
  ]);
  menu[0].submenu[0].click();                       // Local's Show all here
  menu[0].submenu[2].submenu[3].submenu[2].click();  // pet-old alone
  assert.deepEqual(shown, [['pet', 'pet-old'], ['pet-old']]);
});
