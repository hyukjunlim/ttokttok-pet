'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexRpc } = require('../src/codex-accounts/rpc');

function runTurn(rpc, threadId, text, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let answer = '';
    const timer = setTimeout(() => finish(new Error('Test turn timed out.')), timeoutMs);
    const closed = () => finish(new Error('Codex closed during the test turn.'));
    const receive = (m) => {
      const p = m.params;
      if (p?.threadId !== threadId) return;
      if (m.method === 'item/agentMessage/delta') answer += p.delta || '';
      if (m.method === 'turn/completed') {
        if (p.turn?.status === 'completed') finish(null, answer.trim());
        else finish(new Error(`Test turn ended with status ${p.turn?.status || 'unknown'}.`));
      }
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      rpc.off('notification', receive);
      rpc.off('closed', closed);
      error ? reject(error) : resolve(value);
    };
    rpc.on('notification', receive);
    rpc.on('closed', closed);
    rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] }).catch((error) => finish(error));
  });
}

async function continuity({ executable, homes, factory = (o) => new CodexRpc(o) }) {
  const clients = [];
  const open = async (home) => {
    const rpc = factory({ executable, home });
    clients.push(rpc);
    await rpc.initialize();
    return rpc;
  };
  try {
    const first = await open(homes[0]);
    const cwd = path.join(homes[0], 'continuity-work');
    fs.mkdirSync(cwd, { recursive: true });
    const started = await first.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'untrusted' });
    const marker = `probe-${randomUUID()}`;
    await runTurn(first, started.thread.id, `Remember this test marker: ${marker}. Reply only ACK. Do not use tools or read files.`);
    const saved = await first.request('thread/read', { threadId: started.thread.id, includeTurns: false });
    if (!saved.thread?.path) throw new Error('Codex did not return a resumable rollout path.');
    first.close();
    // Wait for the original writer to exit before opening its rollout in another process.
    if (first.child.exitCode == null) await new Promise((resolve) => first.child.once('close', resolve));
    const second = await open(homes[1]);
    const resumed = await second.request('thread/resume', {
      threadId: started.thread.id, path: saved.thread.path,
      cwd, sandbox: 'read-only', approvalPolicy: 'untrusted',
    });
    const answer = await runTurn(second, resumed.thread.id, 'What was the test marker? Reply only with that exact marker. Do not use tools or read files.');
    return {
      threadIdPreserved: resumed.thread.id === started.thread.id,
      workingDirectoryPreserved: resumed.thread.cwd === cwd,
      markerRecalled: answer === marker,
      // A synthetic successful turn does not establish safe retry of a partially executed real turn.
      failedTurnReplayVerified: false,
    };
  } finally { clients.forEach((rpc) => rpc.close()); }
}

async function main() {
  const [id, executable] = process.argv.slice(2);
  if (!id || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !executable) throw new Error('Usage: node tools/codex-continuity-probe.js PROBE-ID CODEX-EXE');
  const root = path.join(os.homedir(), '.ttokttok-pet', 'account-probes', id);
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
  if (!previous.independentUsageVerified || previous.accountHomes?.length < 2) throw new Error('Independent account usage must pass first.');
  const homes = previous.accountHomes.slice(0, 2);
  if (homes.some((p) => { const r = path.relative(root, p); return r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r); })) throw new Error('Test homes must belong to the isolated probe.');
  const result = await continuity({ executable, homes });
  fs.writeFileSync(path.join(root, 'continuity.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { runTurn, continuity };
