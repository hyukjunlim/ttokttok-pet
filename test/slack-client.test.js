'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SlackAuthError, SlackError, createClient, parseCanvasLink } = require('../src/slack/client');

const TOKEN = 'xoxp-1234-5678-abcdef';

function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
    };
  };
  return { fetch, calls };
}

test('parseCanvasLink: a canvas link names its canvas; anything else is null', () => {
  assert.deepEqual(parseCanvasLink(' https://team-example.slack.com/docs/T01EXAMPLE0/F01EXAMPLE0?x=1 '), {
    url: 'https://team-example.slack.com/docs/T01EXAMPLE0/F01EXAMPLE0', canvasId: 'F01EXAMPLE0',
  });
  assert.equal(parseCanvasLink('http://example.slack.com/docs/T01EXAMPLE0/F01EXAMPLE0'), null);
  assert.equal(parseCanvasLink('https://evil.example/docs/T01EXAMPLE0/F01EXAMPLE0'), null);
  assert.equal(parseCanvasLink('https://slack.com.evil.example/docs/T01EXAMPLE0/F01EXAMPLE0'), null);
  assert.equal(parseCanvasLink(null), null);
});

test('canvasMarkdown posts canvas_id with the token in the Authorization header only', async () => {
  const { fetch, calls } = fakeFetch({ body: { ok: true, content: '# 발표 순서' } });
  assert.equal(await createClient({ token: TOKEN, fetch }).canvasMarkdown('F01EXAMPLE0'), '# 발표 순서');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/canvases.getContent');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.body, 'canvas_id=F01EXAMPLE0&content_type=markdown');
  assert.ok(!String(calls[0].url).includes(TOKEN));
});

test('a token Slack turns down is a SlackAuthError; a missing canvas a SlackError', async () => {
  const revoked = fakeFetch({ body: { ok: false, error: 'token_revoked' } });
  await assert.rejects(createClient({ token: TOKEN, fetch: revoked.fetch }).canvasMarkdown('F01EXAMPLE0'), SlackAuthError);
  const scope = fakeFetch({ body: { ok: false, error: 'missing_scope' } });
  await assert.rejects(createClient({ token: TOKEN, fetch: scope.fetch }).canvasMarkdown('F01EXAMPLE0'), /canvases:read/);
  const missing = fakeFetch({ body: { ok: false, error: 'canvas_not_found' } });
  await assert.rejects(createClient({ token: TOKEN, fetch: missing.fetch }).canvasMarkdown('F01EXAMPLE0'), (err) => err instanceof SlackError && !(err instanceof SlackAuthError));
});

test('network and HTTP failures never quote the token or the lower layer', async () => {
  const down = fakeFetch(new Error(`connect failed with ${TOKEN}`));
  await assert.rejects(createClient({ token: TOKEN, fetch: down.fetch }).canvasMarkdown('F01EXAMPLE0'), (err) => !err.message.includes(TOKEN));
  const limited = fakeFetch({ status: 429, body: {} });
  await assert.rejects(createClient({ token: TOKEN, fetch: limited.fetch }).canvasMarkdown('F01EXAMPLE0'), (err) => err.code === 'ratelimited');
});

test('a token or canvas id of the wrong shape is refused before any request', async () => {
  assert.throws(() => createClient({ token: 'not-a-token', fetch: async () => {} }), TypeError);
  const { fetch, calls } = fakeFetch({ body: { ok: true, content: '' } });
  await assert.rejects(createClient({ token: TOKEN, fetch }).canvasMarkdown('../x'), TypeError);
  assert.equal(calls.length, 0);
});
