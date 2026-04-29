import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, type ChatClient, type StreamOpts, type ChatChunk } from '../src/llm.ts';

const baseOpts: StreamOpts = {
  model: 'fake/model',
  systemPrompt: 'sys',
  userPrompt: 'hi',
  maxTokens: 10,
  temperature: 0,
  timeoutMs: 1000,
  retries: 1,
};

function asChunks(parts: string[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield { choices: [{ delta: { content: p } }] };
    },
  };
}

function asyncErrorAfter(parts: string[], err: Error): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield { choices: [{ delta: { content: p } }] };
      throw err;
    },
  };
}

function clientFromCalls(
  fns: Array<(signal: AbortSignal) => Promise<AsyncIterable<ChatChunk>>>,
): { client: ChatClient; calls: () => number } {
  let i = 0;
  const client: ChatClient = {
    chat: {
      completions: {
        async create(_p, opts) {
          const fn = fns[Math.min(i, fns.length - 1)];
          i++;
          return fn(opts.signal);
        },
      },
    },
  };
  return { client, calls: () => i };
}

test('streamChat happy path returns full text and emits chunks', async () => {
  const { client } = clientFromCalls([async () => asChunks(['hel', 'lo ', 'world'])]);
  const chunks: string[] = [];
  const r = await streamChat(client, baseOpts, (t) => chunks.push(t));
  assert.equal(r.text, 'hello world');
  assert.equal(r.error, undefined);
  assert.deepEqual(chunks, ['hel', 'lo ', 'world']);
});

test('streamChat retries on create() throw and succeeds on attempt 2', async () => {
  const { client, calls } = clientFromCalls([
    async () => { throw new Error('boom'); },
    async () => asChunks(['ok']),
  ]);
  const r = await streamChat(client, { ...baseOpts, retries: 1 }, () => {});
  assert.equal(r.text, 'ok');
  assert.equal(r.error, undefined);
  assert.equal(calls(), 2);
});

test('streamChat returns error after exhausting retries', async () => {
  const { client, calls } = clientFromCalls([
    async () => { throw new Error('boom-1'); },
    async () => { throw new Error('boom-2'); },
  ]);
  const r = await streamChat(client, { ...baseOpts, retries: 1 }, () => {});
  assert.equal(r.text, '');
  assert.match(r.error ?? '', /boom-2/);
  assert.equal(calls(), 2);
});

test('streamChat does NOT retry once chunks have been emitted (mid-stream error)', async () => {
  const { client, calls } = clientFromCalls([
    async () => asyncErrorAfter(['par', 'tial'], new Error('mid-stream-die')),
    async () => asChunks(['should-not-be-called']),
  ]);
  const chunks: string[] = [];
  const r = await streamChat(client, { ...baseOpts, retries: 1 }, (t) => chunks.push(t));
  assert.equal(r.text, 'partial');
  assert.match(r.error ?? '', /mid-stream-die/);
  assert.equal(calls(), 1, 'should not retry after chunks were emitted');
  assert.deepEqual(chunks, ['par', 'tial']);
});

test('streamChat retries when stream throws BEFORE any chunk', async () => {
  const failingFirst: AsyncIterable<ChatChunk> = {
    async *[Symbol.asyncIterator]() { throw new Error('immediate'); },
  };
  const { client, calls } = clientFromCalls([
    async () => failingFirst,
    async () => asChunks(['recovered']),
  ]);
  const r = await streamChat(client, { ...baseOpts, retries: 1 }, () => {});
  assert.equal(r.text, 'recovered');
  assert.equal(r.error, undefined);
  assert.equal(calls(), 2);
});

test('streamChat aborts via signal when timeoutMs elapses', async () => {
  let abortedSignal: AbortSignal | null = null;
  const { client } = clientFromCalls([
    (signal) => new Promise((_resolve, reject) => {
      abortedSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  ]);
  const r = await streamChat(client, { ...baseOpts, timeoutMs: 30, retries: 0 }, () => {});
  assert.equal(r.text, '');
  assert.match(r.error ?? '', /aborted/);
  assert.ok(abortedSignal && abortedSignal.aborted);
});

test('streamChat passes system + history + user in order', async () => {
  let captured: { messages: { role: string; content: string }[] } | null = null;
  const client: ChatClient = {
    chat: {
      completions: {
        async create(p) {
          captured = p;
          return asChunks(['ok']);
        },
      },
    },
  };
  await streamChat(client, {
    ...baseOpts,
    systemPrompt: 'SYS',
    history: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ],
    userPrompt: 'q2',
  }, () => {});
  assert.ok(captured);
  assert.deepEqual(captured!.messages.map((m) => [m.role, m.content]), [
    ['system', 'SYS'],
    ['user', 'q1'],
    ['assistant', 'a1'],
    ['user', 'q2'],
  ]);
});
