import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import OpenAI from 'openai';
import { PERSONAS, extractRecommendedPersonaIds } from './personas.js';
import { FACILITATOR_SYSTEM_PROMPT, SECRETARY_SYSTEM_PROMPT } from './facilitator.js';
import type { ChatMessage } from './session.js';
import {
  createSession,
  getSession,
  getSessionOwner,
  updateSession,
  appendFacilitatorMessage,
  setPersonaOutput,
  appendPersonaFollowup,
  listSessionsByOwner,
  getOrCreateShareToken,
  clearShareToken,
  getSessionByShareToken,
} from './session.js';
import { getOrIssueUserToken, getUserToken, clientIp } from './auth.js';
import { checkCreateSession, checkLlmCall } from './rate-limit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '../public');

const client = new OpenAI({
  apiKey:  process.env.NVIDIA_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  baseURL: process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
});
const MODEL      = process.env.NVIDIA_MODEL ?? 'meta/llama-3.1-8b-instruct';
const MODEL_FAST = process.env.NVIDIA_FAST_MODEL ?? MODEL;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.ico': 'image/x-icon',
};

function sse(res: http.ServerResponse, data: object) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startSSE(res: http.ServerResponse) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
}

interface StreamOpts {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  retries: number;
}

async function streamChat(
  opts: StreamOpts,
  onChunk: (text: string) => void,
): Promise<{ text: string; error?: string }> {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: opts.systemPrompt },
  ];
  if (opts.history) for (const m of opts.history) messages.push(m);
  if (opts.userPrompt) messages.push({ role: 'user', content: opts.userPrompt });

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    let text = '';
    let started = false;
    try {
      const stream = await client.chat.completions.create(
        { model: opts.model, max_tokens: opts.maxTokens, temperature: opts.temperature, stream: true, messages },
        { signal: ac.signal },
      );
      try {
        for await (const chunk of stream) {
          const t = chunk.choices[0]?.delta?.content ?? '';
          if (t) { started = true; text += t; onChunk(t); }
        }
        clearTimeout(timer);
        return { text };
      } catch (innerErr: unknown) {
        clearTimeout(timer);
        lastError = innerErr instanceof Error ? innerErr.message : String(innerErr);
        if (started) return { text, error: lastError };
        // mid-stream-but-no-chunk error → fall through to retry path
      }
    } catch (createErr: unknown) {
      clearTimeout(timer);
      lastError = createErr instanceof Error ? createErr.message : String(createErr);
    }
    if (attempt < opts.retries) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return { text: '', error: lastError };
}

const TIMEOUT_FACILITATOR = Number(process.env.LUFFY_TIMEOUT_FACILITATOR_MS ?? 30_000);
const TIMEOUT_PERSONA     = Number(process.env.LUFFY_TIMEOUT_PERSONA_MS ?? 45_000);
const TIMEOUT_SUMMARY     = Number(process.env.LUFFY_TIMEOUT_SUMMARY_MS ?? 60_000);

async function handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse) {
  const ip = clientIp(req);
  const limit = checkCreateSession(ip);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    json(res, 429, { error: `召集太频繁，请 ${limit.retryAfterSec} 秒后再试` });
    return;
  }
  const body = await readBody(req);
  let parsed: { question?: unknown };
  try { parsed = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
  const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
  if (!question) { json(res, 400, { error: '请输入你的困惑' }); return; }
  if (question.length > 2000) { json(res, 400, { error: '困惑太长（上限 2000 字）' }); return; }
  const ownerToken = getOrIssueUserToken(req, res);
  const session = createSession(question, ownerToken);
  json(res, 201, { id: session.id, question: session.question });
}

function ensureOwner(req: http.IncomingMessage, res: http.ServerResponse, id: string): boolean {
  const owner = getSessionOwner(id);
  if (owner === undefined) { json(res, 404, { error: 'session 不存在' }); return false; }
  if (owner === null) return true; // legacy sessions without owner: allow
  const tok = getUserToken(req);
  if (tok && tok === owner) return true;
  json(res, 403, { error: '无权访问该会话' });
  return false;
}

function ensureLlmQuota(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const limit = checkLlmCall(clientIp(req));
  if (limit.ok) return true;
  res.setHeader('Retry-After', String(limit.retryAfterSec));
  json(res, 429, { error: `调用太频繁，请 ${limit.retryAfterSec} 秒后再试` });
  return false;
}

function handleListSessions(req: http.IncomingMessage, res: http.ServerResponse) {
  const tok = getUserToken(req);
  if (!tok) { json(res, 200, { sessions: [] }); return; }
  const sessions = listSessionsByOwner(tok).map((s) => ({
    id: s.id,
    question: s.question,
    step: s.step,
    hasSummary: s.hasSummary,
    createdAt: s.createdAt.getTime(),
  }));
  json(res, 200, { sessions });
}

function handleShareCreate(res: http.ServerResponse, id: string) {
  const token = getOrCreateShareToken(id);
  if (!token) { json(res, 404, { error: 'session 不存在' }); return; }
  json(res, 200, { token, url: `/shared.html?t=${token}` });
}

function handleShareDelete(res: http.ServerResponse, id: string) {
  clearShareToken(id);
  json(res, 200, { ok: true });
}

function handleSharedView(res: http.ServerResponse, token: string) {
  const s = getSessionByShareToken(token);
  if (!s) { json(res, 404, { error: '分享链接无效或已撤销' }); return; }
  json(res, 200, {
    id: s.id,
    question: s.question,
    step: s.step,
    definedTopic: s.definedTopic,
    personaOutputs: s.personaOutputs,
    selectedPersonas: s.selectedPersonas,
    summary: s.summary,
    createdAt: s.createdAt.getTime(),
  });
}

function handleGetSession(res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  json(res, 200, {
    id: s.id, question: s.question, step: s.step,
    definedTopic: s.definedTopic,
    facilitatorHistory: s.facilitatorHistory,
    personaOutputs: s.personaOutputs,
    personaFollowups: s.personaFollowups,
    selectedPersonas: s.selectedPersonas,
    summary: s.summary,
  });
}

async function handleFacilitator(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  const body = await readBody(req);
  const { message } = JSON.parse(body);
  const userMsg = message?.trim() || s.question;
  s.facilitatorHistory.push({ role: 'user', content: userMsg });
  appendFacilitatorMessage(id, 'user', userMsg);
  startSSE(res);
  const { text: fullText, error } = await streamChat(
    {
      model: MODEL_FAST,
      systemPrompt: FACILITATOR_SYSTEM_PROMPT,
      userPrompt: '',
      history: s.facilitatorHistory,
      maxTokens: 600, temperature: 0.75,
      timeoutMs: TIMEOUT_FACILITATOR, retries: 1,
    },
    (text) => sse(res, { type: 'chunk', text }),
  );
  if (error) sse(res, { type: 'error', message: error });
  if (fullText) appendFacilitatorMessage(id, 'assistant', fullText);
  const locked = fullText.includes('【议题锁定】');
  if (locked) {
    const recommended = extractRecommendedPersonaIds(fullText);
    const selectedPersonas = recommended.length >= 3 ? recommended : null;
    updateSession(id, { definedTopic: fullText, step: 4, selectedPersonas });
  }
  sse(res, { type: 'done', locked });
  res.end();
}

async function handlePersonas(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  // optional body { personas: string[] } overrides the saved selection
  const body = await readBody(req);
  if (body) {
    try {
      const parsed = JSON.parse(body) as { personas?: unknown };
      if (Array.isArray(parsed.personas)) {
        const valid = parsed.personas.filter(
          (x): x is string => typeof x === 'string' && PERSONAS.some((p) => p.id === x),
        );
        if (valid.length > 0) {
          updateSession(id, { selectedPersonas: valid });
          s.selectedPersonas = valid;
        }
      }
    } catch { /* ignore malformed body */ }
  }
  const activePersonas = s.selectedPersonas
    ? PERSONAS.filter((p) => s.selectedPersonas!.includes(p.id))
    : PERSONAS;
  const context = [`案主困惑：${s.question}`, s.definedTopic ? `\n主持人总结的议题：\n${s.definedTopic}` : ''].join('');
  startSSE(res);
  await Promise.all(activePersonas.map(async (persona) => {
    sse(res, { type: 'start', persona: persona.id });
    const cached = s.personaOutputs[persona.id];
    if (cached && cached.length > 0) {
      sse(res, { type: 'chunk', persona: persona.id, text: cached });
      sse(res, { type: 'done', persona: persona.id, cached: true });
      return;
    }
    const { text: fullText, error } = await streamChat(
      {
        model: MODEL,
        systemPrompt: persona.systemPrompt,
        userPrompt: context,
        maxTokens: 450, temperature: 0.85,
        timeoutMs: TIMEOUT_PERSONA, retries: 1,
      },
      (text) => sse(res, { type: 'chunk', persona: persona.id, text }),
    );
    if (error) sse(res, { type: 'error', persona: persona.id, message: error });
    if (fullText) setPersonaOutput(id, persona.id, fullText);
    sse(res, { type: 'done', persona: persona.id, ok: !error && !!fullText });
  }));
  sse(res, { type: 'all_done' });
  res.end();
}

async function handlePersonaFollowup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  personaId: string,
) {
  const persona = PERSONAS.find((p) => p.id === personaId);
  if (!persona) { json(res, 404, { error: '幕僚不存在' }); return; }
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  const original = s.personaOutputs[personaId];
  if (!original) { json(res, 400, { error: '该幕僚还没发言，无法追问' }); return; }
  const body = await readBody(req);
  let parsed: { message?: unknown };
  try { parsed = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
  const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  if (!message) { json(res, 400, { error: '请输入追问内容' }); return; }
  if (message.length > 1000) { json(res, 400, { error: '追问太长（上限 1000 字）' }); return; }

  const seedUser = `案主困惑：${s.question}` + (s.definedTopic ? `\n\n主持人锁定的议题：\n${s.definedTopic}` : '');
  const history = s.personaFollowups[personaId] ?? [];
  const messages: ChatMessage[] = [
    { role: 'user', content: seedUser },
    { role: 'assistant', content: original },
    ...history,
    { role: 'user', content: message },
  ];

  appendPersonaFollowup(id, personaId, 'user', message);
  startSSE(res);
  const { text: fullText, error } = await streamChat(
    {
      model: MODEL,
      systemPrompt: persona.systemPrompt,
      userPrompt: '',
      history: messages,
      maxTokens: 450, temperature: 0.85,
      timeoutMs: TIMEOUT_PERSONA, retries: 1,
    },
    (text) => sse(res, { type: 'chunk', text }),
  );
  if (error) sse(res, { type: 'error', message: error });
  if (fullText) appendPersonaFollowup(id, personaId, 'assistant', fullText);
  sse(res, { type: 'done', ok: !error && !!fullText });
  res.end();
}

async function handleSummary(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  startSSE(res);
  if (s.summary && s.summary.length > 0) {
    sse(res, { type: 'chunk', text: s.summary });
    sse(res, { type: 'done', cached: true });
    res.end();
    return;
  }
  const personaLines = PERSONAS
    .filter((p) => s.personaOutputs[p.id])
    .map((p) => `【${p.name}·${p.tagline}】\n${s.personaOutputs[p.id]}`)
    .join('\n\n---\n\n');
  const prompt = `案主困惑：${s.question}\n\n主持人锁定的议题：\n${s.definedTopic ?? '（未澄清）'}\n\n12位幕僚的发言：\n${personaLines}\n\n请根据以上内容生成结构化总结。`;
  const { text: fullText, error } = await streamChat(
    {
      model: MODEL,
      systemPrompt: SECRETARY_SYSTEM_PROMPT,
      userPrompt: prompt,
      maxTokens: 1200, temperature: 0.6,
      timeoutMs: TIMEOUT_SUMMARY, retries: 1,
    },
    (text) => sse(res, { type: 'chunk', text }),
  );
  if (error) sse(res, { type: 'error', message: error });
  if (fullText) updateSession(id, { summary: fullText, step: 7 });
  sse(res, { type: 'done' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  if (method === 'POST' && url === '/api/sessions') { await handleCreateSession(req, res); return; }
  if (method === 'GET'  && url === '/api/sessions') { handleListSessions(req, res); return; }
  const sm = url.match(/^\/api\/share\/([a-f0-9]+)$/);
  if (sm && method === 'GET') { handleSharedView(res, sm[1]); return; }
  const fm = url.match(/^\/api\/sessions\/([^/]+)\/personas\/([^/]+)\/followup$/);
  if (fm && method === 'POST') {
    const [, sid, pid] = fm;
    if (!ensureOwner(req, res, sid)) return;
    if (!ensureLlmQuota(req, res)) return;
    await handlePersonaFollowup(req, res, sid, pid);
    return;
  }
  const m = url.match(/^\/api\/sessions\/([^/]+)(\/(.+))?$/);
  if (m) {
    const [, sid, , sub] = m;
    if (method === 'GET' && !sub) {
      if (!ensureOwner(req, res, sid)) return;
      handleGetSession(res, sid); return;
    }
    if (method === 'POST' && sub === 'facilitator') {
      if (!ensureOwner(req, res, sid)) return;
      if (!ensureLlmQuota(req, res)) return;
      await handleFacilitator(req, res, sid); return;
    }
    if (method === 'POST' && sub === 'personas') {
      if (!ensureOwner(req, res, sid)) return;
      if (!ensureLlmQuota(req, res)) return;
      await handlePersonas(req, res, sid); return;
    }
    if (method === 'POST' && sub === 'summary') {
      if (!ensureOwner(req, res, sid)) return;
      if (!ensureLlmQuota(req, res)) return;
      await handleSummary(req, res, sid); return;
    }
    if (method === 'POST'   && sub === 'share') {
      if (!ensureOwner(req, res, sid)) return;
      handleShareCreate(res, sid); return;
    }
    if (method === 'DELETE' && sub === 'share') {
      if (!ensureOwner(req, res, sid)) return;
      handleShareDelete(res, sid); return;
    }
    json(res, 404, { error: 'unknown route' }); return;
  }
  if (method === 'GET') {
    const fp = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url.split('?')[0]);
    try {
      const content = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': (MIME[path.extname(fp)] ?? 'text/plain') + '; charset=utf-8' });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }
  res.writeHead(405); res.end();
});

function tryListen(port: number) {
  server.listen(port)
    .on('listening', () => { console.log(`\n🏮  Luffy 人生私董会\n👉  http://localhost:${port}\n模型: ${MODEL}\n`); })
    .on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && port < 3010) tryListen(port + 1);
      else { console.error(e.message); process.exit(1); }
    });
}
tryListen(Number(process.env.PORT ?? 3001));
