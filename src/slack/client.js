'use strict';

// A read-only client for Slack's Web API: it calls canvases.getContent and nothing else
// (CONSTRAINTS.md, Network). The user token goes in the Authorization header only; error messages
// name Slack's error code, never the token or what a lower layer said. `fetch` is injectable so
// tests need no network.

const ENDPOINT = 'https://slack.com/api/canvases.getContent';
const TIMEOUT_MS = 20 * 1000;
const TOKEN_RE = /^xox[a-z]-[\x21-\x7e]+$/;
const CANVAS_ID_RE = /^F[A-Z0-9]{8,}$/;
// A canvas's address in a workspace: https://<workspace>.slack.com/docs/<team>/<canvas>
const CANVAS_URL_RE = /^https:\/\/[a-z0-9-]+\.(?:enterprise\.)?slack\.com\/docs\/(T[A-Z0-9]{8,})\/(F[A-Z0-9]{8,})\/?(?:[?#].*)?$/;
// Slack's answers that mean the token itself is no good (as opposed to this one canvas).
const AUTH_ERRORS = new Set([
  'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission',
  'missing_scope', 'not_allowed_token_type', 'ekm_access_denied',
]);
const MESSAGES = {
  canvas_not_found: '캔버스를 찾지 못했습니다. 링크를 확인하거나, 이 캔버스를 볼 수 있는 계정의 토큰인지 확인해 주세요.',
  access_denied: '이 캔버스를 볼 권한이 없습니다.',
  canvas_disabled_user_team: '이 워크스페이스에서는 캔버스가 꺼져 있습니다.',
  missing_scope: '토큰에 canvases:read 권한이 없습니다. Slack 앱의 User Token Scopes에 추가하고 다시 설치해 주세요.',
  ratelimited: 'Slack이 잠시 요청을 막았습니다. 조금 뒤에 다시 확인합니다.',
};

class SlackError extends Error {
  constructor(code, message = MESSAGES[code] || `Slack 오류: ${code}`) {
    super(message);
    this.name = 'SlackError';
    this.code = code;
  }
}

class SlackAuthError extends SlackError {
  constructor(code) {
    super(code, MESSAGES[code] || `Slack 토큰이 올바르지 않거나 만료되었습니다 (${code}).`);
    this.name = 'SlackAuthError';
  }
}

// The canvas a link (or a bare id) names: { url, canvasId } with the link tidied, or null.
function parseCanvasLink(text) {
  const s = String(text ?? '').trim();
  const m = CANVAS_URL_RE.exec(s);
  if (m) return { url: s.replace(/[?#].*$/, '').replace(/\/$/, ''), canvasId: m[2] };
  return null;
}

function createClient({ token, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new TypeError('Slack 토큰이 없거나 형식이 잘못되었습니다.');
  if (typeof fetch !== 'function') throw new TypeError('fetch를 사용할 수 없습니다.');

  // The canvas as Markdown.
  async function canvasMarkdown(canvasId) {
    if (!CANVAS_ID_RE.test(String(canvasId))) throw new TypeError('잘못된 캔버스 ID입니다.');
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams({ canvas_id: canvasId, content_type: 'markdown' }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new SlackError('network', err?.name === 'TimeoutError' ? 'Slack이 응답하지 않습니다.' : 'Slack에 연결하지 못했습니다.');
    }
    if (res.status === 429) throw new SlackError('ratelimited');
    if (!res.ok) throw new SlackError(`http_${res.status}`, `Slack 오류 (HTTP ${res.status})`);
    let j;
    try {
      j = await res.json();
    } catch {
      throw new SlackError('bad_response', 'Slack의 응답을 읽지 못했습니다.');
    }
    if (j?.ok !== true) {
      const code = typeof j?.error === 'string' && /^[a-z_]{1,60}$/.test(j.error) ? j.error : 'unknown_error';
      throw AUTH_ERRORS.has(code) ? new SlackAuthError(code) : new SlackError(code);
    }
    if (typeof j.content !== 'string') throw new SlackError('bad_response', 'Slack의 응답에 캔버스 내용이 없습니다.');
    return j.content;
  }

  return { canvasMarkdown };
}

module.exports = { SlackAuthError, SlackError, createClient, parseCanvasLink, TOKEN_RE };
