import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate persistence + relax limits before importing server.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luffy-server-test-'));
process.env.LUFFY_DATA_DIR = tmp;
process.env.LUFFY_LIMIT_CREATE_PER_HOUR = '1000';
process.env.LUFFY_LIMIT_LLM_PER_HOUR = '2'; // small so we can hit the limit deterministically

const { server } = await import('../src/server.ts');

let baseUrl = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Resp {
  status: number;
  cookie: string | null;
  body: string;
  json: () => unknown;
}

async function req(
  method: string,
  pathStr: string,
  opts: { body?: string; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Resp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  const r = await fetch(baseUrl + pathStr, { method, body: opts.body, headers });
  const body = await r.text();
  return {
    status: r.status,
    cookie: r.headers.get('set-cookie'),
    body,
    json: () => JSON.parse(body),
  };
}

function extractCookie(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  const m = setCookie.match(/luffy_uid=[a-f0-9]+/);
  return m ? m[0] : undefined;
}

test('GET /api/personas returns 12 entries without systemPrompt', async () => {
  const r = await req('GET', '/api/personas');
  assert.equal(r.status, 200);
  const d = r.json() as { personas: { id: string; name: string; systemPrompt?: string }[] };
  assert.equal(d.personas.length, 12);
  for (const p of d.personas) assert.equal(p.systemPrompt, undefined);
});

test('POST /api/sessions issues cookie + creates session', async () => {
  const r = await req('POST', '/api/sessions', { body: '{"question":"test q"}' });
  assert.equal(r.status, 201);
  const cookie = extractCookie(r.cookie);
  assert.ok(cookie, 'Set-Cookie should be present');
  const d = r.json() as { id: string };
  assert.match(d.id, /^[a-f0-9]{16}$/);
});

test('POST /api/sessions rejects non-JSON body', async () => {
  const r = await req('POST', '/api/sessions', { body: 'not-json' });
  assert.equal(r.status, 400);
});

test('POST /api/sessions rejects empty question', async () => {
  const r = await req('POST', '/api/sessions', { body: '{"question":""}' });
  assert.equal(r.status, 400);
});

test('POST /api/sessions rejects oversize body with 413', async () => {
  const big = '{"question":"' + 'x'.repeat(80_000) + '"}';
  const r = await req('POST', '/api/sessions', { body: big });
  assert.equal(r.status, 413);
});

test('GET /api/sessions/:id requires the same cookie (403 otherwise)', async () => {
  const create = await req('POST', '/api/sessions', { body: '{"question":"owned"}' });
  const cookie = extractCookie(create.cookie)!;
  const id = (create.json() as { id: string }).id;

  const ownerView = await req('GET', `/api/sessions/${id}`, { cookie });
  assert.equal(ownerView.status, 200);

  const noCookie = await req('GET', `/api/sessions/${id}`);
  assert.equal(noCookie.status, 403);

  const wrongCookie = await req('GET', `/api/sessions/${id}`, {
    cookie: 'luffy_uid=00000000000000000000000000000000',
  });
  assert.equal(wrongCookie.status, 403);
});

test('GET /api/sessions/:id returns 404 for unknown id', async () => {
  const r = await req('GET', '/api/sessions/deadbeef', {
    cookie: 'luffy_uid=00000000000000000000000000000000',
  });
  assert.equal(r.status, 404);
});

test('share lifecycle: create → public read → revoke', async () => {
  const create = await req('POST', '/api/sessions', { body: '{"question":"shareable"}' });
  const cookie = extractCookie(create.cookie)!;
  const id = (create.json() as { id: string }).id;

  const share1 = await req('POST', `/api/sessions/${id}/share`, { cookie });
  assert.equal(share1.status, 200);
  const { token } = share1.json() as { token: string };

  // Idempotent: re-creating returns same token
  const share2 = await req('POST', `/api/sessions/${id}/share`, { cookie });
  assert.equal((share2.json() as { token: string }).token, token);

  // Public read does NOT need cookie
  const pub = await req('GET', `/api/share/${token}`);
  assert.equal(pub.status, 200);
  assert.equal((pub.json() as { question: string }).question, 'shareable');

  // Revoke
  const del = await req('DELETE', `/api/sessions/${id}/share`, { cookie });
  assert.equal(del.status, 200);

  const after = await req('GET', `/api/share/${token}`);
  assert.equal(after.status, 404);
});

test('GET /api/sessions lists only the cookie owner\'s sessions', async () => {
  const a = await req('POST', '/api/sessions', { body: '{"question":"alice 1"}' });
  const aCookie = extractCookie(a.cookie)!;
  await req('POST', '/api/sessions', { body: '{"question":"alice 2"}', cookie: aCookie });

  const b = await req('POST', '/api/sessions', { body: '{"question":"bob"}' });
  const bCookie = extractCookie(b.cookie)!;

  const aList = await req('GET', '/api/sessions', { cookie: aCookie });
  const aQuestions = ((aList.json() as { sessions: { question: string }[] }).sessions).map((s) => s.question);
  assert.ok(aQuestions.includes('alice 1') && aQuestions.includes('alice 2'));
  assert.ok(!aQuestions.includes('bob'));

  const noCookie = await req('GET', '/api/sessions');
  assert.deepEqual(noCookie.json(), { sessions: [] });
});

test('static file serving blocks ../ traversal', async () => {
  const r = await req('GET', '/../../package.json');
  // Either 403 (blocked by prefix check) or 404 (URL got normalized away)
  assert.ok(r.status === 403 || r.status === 404, `unexpected ${r.status}`);
});

test('unknown route under /api/sessions/:id returns 404', async () => {
  const create = await req('POST', '/api/sessions', { body: '{"question":"u"}' });
  const cookie = extractCookie(create.cookie)!;
  const id = (create.json() as { id: string }).id;
  const r = await req('GET', `/api/sessions/${id}/something`, { cookie });
  assert.equal(r.status, 404);
});

test('followup on persona that has not spoken returns 400', async () => {
  const create = await req('POST', '/api/sessions', { body: '{"question":"fu"}' });
  const cookie = extractCookie(create.cookie)!;
  const id = (create.json() as { id: string }).id;
  const r = await req('POST', `/api/sessions/${id}/personas/jobs/followup`, {
    cookie, body: '{"message":"hi"}',
  });
  assert.equal(r.status, 400);
});

test('followup on unknown persona returns 404', async () => {
  const create = await req('POST', '/api/sessions', { body: '{"question":"u"}' });
  const cookie = extractCookie(create.cookie)!;
  const id = (create.json() as { id: string }).id;
  const r = await req('POST', `/api/sessions/${id}/personas/nobody/followup`, {
    cookie, body: '{"message":"hi"}',
  });
  assert.equal(r.status, 404);
});

// NOTE: keep this last — once the LLM-quota bucket is exhausted, subsequent
// LLM-gated routes will all 429 within the same test process.
test('LLM rate limit returns 429 after threshold', async () => {
  const create = await req('POST', '/api/sessions', { body: '{"question":"limit"}' });
  const cookie = extractCookie(create.cookie)!;
  const id = (create.json() as { id: string }).id;
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(baseUrl + `/api/sessions/${id}/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{"personas":[]}',
    });
    codes.push(r.status);
    await r.body?.cancel();
  }
  assert.ok(codes.filter((c) => c === 429).length >= 2, `expected 429s, got ${codes.join(',')}`);
});
