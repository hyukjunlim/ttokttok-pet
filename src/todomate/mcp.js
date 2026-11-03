'use strict';

// TodoMate through Kakao PlayMCP (CONSTRAINTS.md, Network and TodoMate schedule): connecting and a
// small MCP client. TodoMate's own MCP server lets only PlayMCP sign in, so the pet talks to
// PlayMCP's gateway: the user's PlayMCP toolbox, with TodoMate in it.
//
// PlayMCP lets only its partners' servers register apps, so the pet connects the way PlayMCP's
// guide tells agents run by the user to (OpenClaw's way): the user makes a connection prompt in the
// toolbox, and the one-time token in it is traded for the gateway's tokens. Those are renewed at
// PlayMCP's sign-in server as they expire, and are the only thing kept (feature.js stores them
// encrypted).
//
// The client calls only loadTodoItems, loadTodoItemsByDateRange and loadGoals (READ_TOOLS); anything
// else is refused here, so no code path can change a todo. `fetch` is injectable so tests need no
// network.

const MCP_URL = 'https://playmcp.kakao.com/mcp';
const EXCHANGE_URL = 'https://playmcp.kakao.com/api/v1/auths/otts:exchange';
const TOKEN_URL = 'https://playauth.kakao.com/playmcp/oauth2/token';
const CLIENT_ID = 'HElMUWdVoroTsrXxezeTSemg8gXzzCKWARb5MJux8gY';   // the guide's, for agents run by the user
const TOOLBOX_URL = 'https://playmcp.kakao.com/toolbox';
const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const TODO_LIMIT = 500;   // loadTodoItems gives 100 a day unless asked for more
const RANGE_LIMIT = 2000;
const READ_TOOLS = ['loadTodoItems', 'loadTodoItemsByDateRange', 'loadGoals'];
const MAX_TOOL_PAGES = 10;

class TodomateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TodomateError';
    this.code = code;
  }
}

// The connection no longer works (refused, revoked or expired): the user has to connect again.
class TodomateAuthError extends TodomateError {
  constructor(message = 'PlayMCP 연결이 만료되었습니다. 다시 연결해 주세요.') {
    super('auth', message);
    this.name = 'TodomateAuthError';
  }
}

const b64url = (buf) => buf.toString('base64url');

async function request(fetch, url, init, timeoutMs = TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    throw new TodomateError('network', err?.name === 'TimeoutError' ? 'PlayMCP가 응답하지 않습니다.' : 'PlayMCP에 연결하지 못했습니다.');
  }
}

async function jsonOf(res, what) {
  try {
    return await res.json();
  } catch {
    throw new TodomateError('bad_response', `${what}의 응답을 읽지 못했습니다.`);
  }
}

// ---------------------------------------------------------------- tokens

// { accessToken, refreshToken, expiresAt, clientId } from a token endpoint answer.
function tokensOf(j, clientId, now, previous = {}) {
  if (typeof j?.access_token !== 'string' || !j.access_token) throw new TodomateError('bad_response', 'PlayMCP가 토큰을 주지 않았습니다.');
  const life = Number(j.expires_in);
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : previous.refreshToken ?? null,
    expiresAt: Number.isFinite(life) && life > 0 ? now + life * 1000 : null,
    clientId,
  };
}

async function tokenRequest(fetch, params) {
  const res = await request(fetch, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, resource: MCP_URL }).toString(),
  });
  if (res.status === 400 || res.status === 401) {
    const j = await res.json().catch(() => null);
    if (params.grant_type === 'refresh_token' || j?.error === 'invalid_grant') throw new TodomateAuthError();
    throw new TodomateError('token', `PlayMCP 로그인에 실패했습니다 (${typeof j?.error === 'string' ? j.error.slice(0, 40) : res.status}).`);
  }
  if (!res.ok) throw new TodomateError(`http_${res.status}`, `PlayMCP 로그인 오류 (HTTP ${res.status})`);
  return jsonOf(res, 'PlayMCP 로그인');
}

// Fresh tokens for ones near or past expiry, or the same ones. Throws TodomateAuthError when the
// refresh token no longer works.
async function refreshTokens(tokens, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  if (tokens.expiresAt == null || tokens.expiresAt - EXPIRY_MARGIN_MS > now) return tokens;
  if (!tokens.refreshToken) throw new TodomateAuthError();
  const j = await tokenRequest(fetch, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: tokens.clientId });
  return tokensOf(j, tokens.clientId, now, tokens);
}

// ---------------------------------------------------------------- connecting

// PlayMCP's toolbox makes a connection prompt for agents run by the user ("OpenClaw와 연결"):
// text with a one-time token, good for 10 minutes. The pet takes only that token from it.
const OTT_RE = /oneTimeToken\s*[:=]\s*["']?([0-9a-f]{32,128})\b/i;
const BARE_OTT_RE = /^\s*([0-9a-f]{32,128})\s*$/i;

// The one-time token in a pasted connection prompt (or the token alone), or null.
function oneTimeTokenOf(text) {
  const s = String(text ?? '').slice(0, 20000);
  return (OTT_RE.exec(s) ?? BARE_OTT_RE.exec(s))?.[1] ?? null;
}

const timeOf = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

// Trades a one-time token for the gateway's tokens, as PlayMCP's guide for external agents does
// (playmcp.kakao.com/llms/mcp-connection-guide.md). Returns { accessToken, refreshToken, expiresAt,
// clientId }.
async function exchangeOneTimeToken(ott, { fetch = globalThis.fetch } = {}) {
  if (!/^[0-9a-f]{32,128}$/i.test(String(ott))) throw new TypeError('잘못된 일회용 토큰입니다.');
  const res = await request(fetch, EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify({ tokenValue: ott }),
  });
  if (res.status !== 200) {
    throw new TodomateError('ott', '연결 프롬프트가 만료되었거나 이미 쓰였습니다. PlayMCP 도구함에서 새로 만들어 주세요.');
  }
  const j = await jsonOf(res, 'PlayMCP 연결');
  const access = j?.accessToken?.tokenValue;
  if (typeof access !== 'string' || !access) throw new TodomateError('bad_response', 'PlayMCP가 토큰을 주지 않았습니다.');
  const refresh = j?.refreshToken?.tokenValue;
  return {
    accessToken: access,
    refreshToken: typeof refresh === 'string' && refresh ? refresh : null,
    expiresAt: timeOf(j.accessToken.expiresAt) || null,
    clientId: CLIENT_ID,
  };
}

// ---------------------------------------------------------------- MCP over Streamable HTTP

// The JSON-RPC message answering `id` in a response that's JSON or an SSE stream.
async function messageOf(res, id) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    const text = await res.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        continue;
      }
      if (msg?.id === id) return msg;
    }
    throw new TodomateError('bad_response', 'PlayMCP의 응답에 결과가 없습니다.');
  }
  const msg = await jsonOf(res, 'PlayMCP');
  const found = Array.isArray(msg) ? msg.find((m) => m?.id === id) : msg;
  if (found?.id !== id) throw new TodomateError('bad_response', 'PlayMCP의 응답에 결과가 없습니다.');
  return found;
}

// A tool's result as data: structuredContent, else its text parts parsed as JSON where they can be.
function payloadOf(result) {
  if (result?.isError) {
    const text = (result.content || []).map((c) => (c?.type === 'text' ? c.text : '')).join(' ').trim();
    throw new TodomateError('tool', `투두메이트 도구 오류: ${text.slice(0, 120) || '알 수 없는 오류'}`);
  }
  if (result?.structuredContent != null) return result.structuredContent;
  return (result?.content || [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => {
      try {
        return JSON.parse(c.text);
      } catch {
        return c.text;
      }
    });
}

// The gateway's name for one of TodoMate's tools: the name itself, or one ending in it (a gateway
// may put the server's name in front), preferring one that says it's TodoMate's.
function toolNamed(tools, name) {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact.name;
  const ends = tools.filter((t) => typeof t.name === 'string' && t.name.endsWith(name) && !/[a-z0-9]/i.test(t.name.at(-name.length - 1) ?? ''));
  const own = ends.find((t) => /todo\s*mate|투두메이트/i.test(`${t.name} ${t.title ?? ''} ${t.description ?? ''}`));
  return (own ?? ends[0])?.name ?? null;
}

// A session with PlayMCP: `getTokens()` and `saveTokens(tokens)` keep the tokens (refreshed here
// as they expire). Returns { loadTodoItems({ year, month, day }), loadGoals(), close() }.
function createClient({ getTokens, saveTokens, fetch = globalThis.fetch, now = Date.now, clientVersion = '0.0.0' }) {
  let sessionId = null;
  let nextId = 1;
  let names = null;   // tool -> the gateway's name for it

  // `force`: refresh even though they haven't expired yet (the gateway refused them).
  async function tokens(force = false) {
    const t = getTokens();
    if (!t) throw new TodomateAuthError('PlayMCP에 연결해 주세요.');
    const fresh = await refreshTokens(force ? { ...t, expiresAt: 0 } : t, { fetch, now: now() });
    if (fresh !== t) saveTokens(fresh);
    return fresh;
  }

  // Refused once, the tokens are refreshed and the request sent again.
  async function post(body, { expectReply = true, retried = false } = {}) {
    const t = await tokens(retried);
    const headers = {
      Authorization: `Bearer ${t.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (body.method !== 'initialize') headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    const res = await request(fetch, MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 401 && !retried && t.refreshToken) return post(body, { expectReply, retried: true });
    if (res.status === 401 || res.status === 403) throw new TodomateAuthError();
    if (res.status === 404 && sessionId) {
      sessionId = null;
      throw new TodomateError('session', 'PlayMCP 세션이 끝났습니다. 다음 확인 때 다시 연결합니다.');
    }
    if (!res.ok && res.status !== 202) throw new TodomateError(`http_${res.status}`, `PlayMCP 오류 (HTTP ${res.status})`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!expectReply) return null;
    const msg = await messageOf(res, body.id);
    if (msg.error) throw new TodomateError('rpc', `PlayMCP 오류: ${String(msg.error.message || msg.error.code).slice(0, 120)}`);
    return msg.result;
  }

  const call = (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });

  async function connect() {
    if (names) return names;
    await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ttokttok-pet', version: clientVersion },
    });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectReply: false });
    const tools = [];
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await call('tools/list', cursor ? { cursor } : undefined);
      tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    const found = Object.fromEntries(READ_TOOLS.map((n) => [n, toolNamed(tools, n)]));
    if (!found.loadTodoItems) {
      throw new TodomateError('no_tool', 'PlayMCP 도구함에 투두메이트가 없습니다. playmcp.kakao.com에서 투두메이트를 도구함에 추가해 주세요.');
    }
    names = found;
    return names;
  }

  async function tool(name, args) {
    if (!READ_TOOLS.includes(name)) throw new TypeError(`${name}: not a read tool`);
    const n = (await connect())[name];
    if (!n) return null;
    return payloadOf(await call('tools/call', { name: n, arguments: args }));
  }

  return {
    loadTodoItems: ({ year, month, day }) => tool('loadTodoItems', { year, month, day, limit: TODO_LIMIT }),
    // `from`, `to`: { year, month, day }, both included.
    loadTodoItemsByDateRange: (from, to) => tool('loadTodoItemsByDateRange', {
      start_year: from.year, start_month: from.month, start_day: from.day,
      end_year: to.year, end_month: to.month, end_day: to.day, limit: RANGE_LIMIT,
    }),
    loadGoals: () => tool('loadGoals', {}),
    // Ends the session with the gateway, best effort.
    async close() {
      const sid = sessionId;
      sessionId = null;
      names = null;
      const t = getTokens();
      if (!sid || !t) return;
      await request(fetch, MCP_URL, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${t.accessToken}`, 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL_VERSION },
      }).catch(() => {});
    },
  };
}

module.exports = {
  MCP_URL,
  READ_TOOLS,
  TOOLBOX_URL,
  TodomateAuthError,
  TodomateError,
  createClient,
  exchangeOneTimeToken,
  messageOf,
  oneTimeTokenOf,
  payloadOf,
  refreshTokens,
  toolNamed,
};
