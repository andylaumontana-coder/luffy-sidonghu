import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import OpenAI from 'openai';
import { PERSONAS } from './personas.js';
import { FACILITATOR_SYSTEM_PROMPT, SECRETARY_SYSTEM_PROMPT } from './facilitator.js';
import { createSession, getSession, updateSession } from './session.js';

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

async function handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req);
  const { question } = JSON.parse(body);
  if (!question?.trim()) { json(res, 400, { error: '请输入你的困惑' }); return; }
  const session = createSession(question.trim());
  json(res, 201, { id: session.id, question: session.question });
}

function handleGetSession(res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  json(res, 200, {
    id: s.id, question: s.question, step: s.step,
    definedTopic: s.definedTopic,
    facilitatorHistory: s.facilitatorHistory,
    personaOutputs: s.personaOutputs, summary: s.summary,
  });
}

async function handleFacilitator(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  const body = await readBody(req);
  const { message } = JSON.parse(body);
  const userMsg = message?.trim() || s.question;
  s.facilitatorHistory.push({ role: 'user', content: userMsg });
  startSSE(res);
  let fullText = '';
  try {
    const stream = await client.chat.completions.create({
      model: MODEL_FAST, max_tokens: 600, temperature: 0.75, stream: true,
      messages: [
        { role: 'system', content: FACILITATOR_SYSTEM_PROMPT },
        ...s.facilitatorHistory.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) { fullText += text; sse(res, { type: 'chunk', text }); }
    }
  } catch (err: unknown) {
    sse(res, { type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  s.facilitatorHistory.push({ role: 'assistant', content: fullText });
  const locked = fullText.includes('【议题锁定】');
  if (locked) updateSession(id, { definedTopic: fullText, step: 4 });
  sse(res, { type: 'done', locked });
  res.end();
}

async function handlePersonas(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  const context = [`案主困惑：${s.question}`, s.definedTopic ? `\n主持人总结的议题：\n${s.definedTopic}` : ''].join('');
  startSSE(res);
  await Promise.all(PERSONAS.map(async (persona) => {
    sse(res, { type: 'start', persona: persona.id });
    let fullText = '';
    try {
      const stream = await client.chat.completions.create({
        model: MODEL, max_tokens: 450, temperature: 0.85, stream: true,
        messages: [{ role: 'system', content: persona.systemPrompt }, { role: 'user', content: context }],
      });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? '';
        if (text) { fullText += text; sse(res, { type: 'chunk', persona: persona.id, text }); }
      }
    } catch (err: unknown) {
      sse(res, { type: 'error', persona: persona.id, message: err instanceof Error ? err.message : String(err) });
    }
    s.personaOutputs[persona.id] = fullText;
    sse(res, { type: 'done', persona: persona.id });
  }));
  sse(res, { type: 'all_done' });
  res.end();
}

async function handleSummary(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const s = getSession(id);
  if (!s) { json(res, 404, { error: 'session 不存在' }); return; }
  const personaLines = PERSONAS
    .filter((p) => s.personaOutputs[p.id])
    .map((p) => `【${p.name}·${p.tagline}】\n${s.personaOutputs[p.id]}`)
    .join('\n\n---\n\n');
  const prompt = `案主困惑：${s.question}\n\n主持人锁定的议题：\n${s.definedTopic ?? '（未澄清）'}\n\n12位幕僚的发言：\n${personaLines}\n\n请根据以上内容生成结构化总结。`;
  startSSE(res);
  let fullText = '';
  try {
    const stream = await client.chat.completions.create({
      model: MODEL, max_tokens: 1200, temperature: 0.6, stream: true,
      messages: [{ role: 'system', content: SECRETARY_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) { fullText += text; sse(res, { type: 'chunk', text }); }
    }
  } catch (err: unknown) {
    sse(res, { type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  updateSession(id, { summary: fullText, step: 7 });
  sse(res, { type: 'done' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  if (method === 'POST' && url === '/api/sessions') { await handleCreateSession(req, res); return; }
  const m = url.match(/^\/api\/sessions\/([^/]+)(\/(.+))?$/);
  if (m) {
    const [, sid, , sub] = m;
    if (method === 'GET' && !sub) { handleGetSession(res, sid); return; }
    if (method === 'POST' && sub === 'facilitator') { await handleFacilitator(req, res, sid); return; }
    if (method === 'POST' && sub === 'personas') { await handlePersonas(req, res, sid); return; }
    if (method === 'POST' && sub === 'summary') { await handleSummary(req, res, sid); return; }
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
