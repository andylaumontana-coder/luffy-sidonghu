import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// point persistence at a fresh temp dir before importing session.ts
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luffy-test-'));
process.env.LUFFY_DATA_DIR = tmp;

const {
  createSession,
  getSession,
  updateSession,
  appendFacilitatorMessage,
  setPersonaOutput,
  appendPersonaFollowup,
  listSessionsByOwner,
  getOrCreateShareToken,
  clearShareToken,
  getSessionByShareToken,
} = await import('../src/session.ts');

test('createSession + getSession roundtrip', () => {
  const s = createSession('我要不要换工作？', 'owner-A');
  assert.equal(s.step, 2);
  assert.equal(s.question, '我要不要换工作？');
  const got = getSession(s.id);
  assert.ok(got);
  assert.equal(got!.id, s.id);
  assert.equal(got!.facilitatorHistory.length, 0);
  assert.deepEqual(got!.personaOutputs, {});
  assert.equal(got!.selectedPersonas, null);
  assert.equal(got!.summary, null);
});

test('updateSession patches fields', () => {
  const s = createSession('q', 'owner-A');
  updateSession(s.id, { step: 4, definedTopic: 'topic', selectedPersonas: ['jobs', 'naval'] });
  const got = getSession(s.id)!;
  assert.equal(got.step, 4);
  assert.equal(got.definedTopic, 'topic');
  assert.deepEqual(got.selectedPersonas, ['jobs', 'naval']);
});

test('appendFacilitatorMessage preserves order', () => {
  const s = createSession('q', 'owner-A');
  appendFacilitatorMessage(s.id, 'user', 'm1');
  appendFacilitatorMessage(s.id, 'assistant', 'm2');
  appendFacilitatorMessage(s.id, 'user', 'm3');
  const got = getSession(s.id)!;
  assert.deepEqual(
    got.facilitatorHistory,
    [
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
    ],
  );
});

test('setPersonaOutput upserts', () => {
  const s = createSession('q', 'owner-A');
  setPersonaOutput(s.id, 'jobs', 'first');
  setPersonaOutput(s.id, 'jobs', 'second');
  setPersonaOutput(s.id, 'naval', 'naval-msg');
  const got = getSession(s.id)!;
  assert.equal(got.personaOutputs.jobs, 'second');
  assert.equal(got.personaOutputs.naval, 'naval-msg');
});

test('persona followups grouped per persona, ordered', () => {
  const s = createSession('q', 'owner-A');
  appendPersonaFollowup(s.id, 'jobs', 'user', 'a1');
  appendPersonaFollowup(s.id, 'jobs', 'assistant', 'a2');
  appendPersonaFollowup(s.id, 'naval', 'user', 'b1');
  appendPersonaFollowup(s.id, 'jobs', 'user', 'a3');
  const got = getSession(s.id)!;
  assert.deepEqual(got.personaFollowups.jobs, [
    { role: 'user', content: 'a1' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'a3' },
  ]);
  assert.deepEqual(got.personaFollowups.naval, [
    { role: 'user', content: 'b1' },
  ]);
});

test('listSessionsByOwner is scoped + newest first', () => {
  const a1 = createSession('one', 'owner-list-A');
  const a2 = createSession('two', 'owner-list-A');
  createSession('other', 'owner-list-B');
  const list = listSessionsByOwner('owner-list-A');
  const ids = list.map((x) => x.id);
  assert.deepEqual(ids, [a2.id, a1.id]);
});

test('share token lifecycle: create → idempotent → resolve → revoke', () => {
  const s = createSession('q-share', 'owner-A');
  const t1 = getOrCreateShareToken(s.id);
  assert.ok(t1);
  const t2 = getOrCreateShareToken(s.id);
  assert.equal(t1, t2, 'share token should be idempotent');
  const resolved = getSessionByShareToken(t1!);
  assert.equal(resolved?.id, s.id);
  clearShareToken(s.id);
  assert.equal(getSessionByShareToken(t1!), undefined);
});

test('share token returns null for unknown session', () => {
  assert.equal(getOrCreateShareToken('does-not-exist'), null);
});
