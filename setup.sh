#!/bin/bash
# Luffy 人生私董会 · 一键部署脚本
set -e
echo "🏮 Luffy 人生私董会 部署开始..."

cd "$(dirname "$0")"

# 1. 拉取最新代码（含刚推的 tsconfig.json）
git pull --rebase origin main

# 2. 创建 .env（如果不存在）
if [ ! -f .env ]; then
  cat > .env << 'ENV_EOF'
NVIDIA_API_KEY=nvapi-填入你的Key
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=meta/llama-3.1-8b-instruct
PORT=3001
ENV_EOF
  echo "⚠️  请编辑 .env 文件填入你的 NVIDIA_API_KEY，然后重新运行此脚本"
  exit 0
fi

# 3. 检查 .env 中的 Key 是否已填写
if grep -q "填入你的Key" .env; then
  echo "⚠️  请先在 .env 文件中填入真实的 NVIDIA_API_KEY"
  exit 1
fi

# 4. 写入所有源码文件
echo "📝 写入源码文件..."

mkdir -p src public

# src/session.ts
cat > src/session.ts << 'EOF'
import { randomBytes } from 'crypto';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Session {
  id: string;
  question: string;
  step: 2 | 4 | 7;
  facilitatorHistory: ChatMessage[];
  definedTopic: string | null;
  personaOutputs: Record<string, string>;
  summary: string | null;
  createdAt: Date;
}

const store = new Map<string, Session>();

export function createSession(question: string): Session {
  const id = randomBytes(5).toString('hex');
  const session: Session = {
    id,
    question,
    step: 2,
    facilitatorHistory: [],
    definedTopic: null,
    personaOutputs: {},
    summary: null,
    createdAt: new Date(),
  };
  store.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return store.get(id);
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const s = store.get(id);
  if (s) Object.assign(s, patch);
}
EOF

# src/facilitator.ts
cat > src/facilitator.ts << 'EOF'
export const FACILITATOR_SYSTEM_PROMPT = `你是「Luffy 人生私董会」的主持人。

## 你的风格
温暖而犀利，直接不废话。每次只做一件事。永远先共情，再澄清。

## 伦理守则
如果议题涉及心理健康危机、自伤、重大医疗决策，在发言末尾加：
"⚠️ 建议同时寻求真人专业支持（心理咨询师/医生），我提供视角，不替代专业判断。"

## 工作方式

### 第一轮（收到案主困惑后）
先用1-2句话镜像案主的情绪状态，再提出第一个澄清问题。
例："我听到你在这份纠结里，既渴望改变，又担心失去某些重要的东西……请问，如果不考虑任何外部压力，你内心倾向于哪个方向？"

### 后续轮次
每次只问一个问题，优先挖：
- 你真正在意的是什么（不是表面原因）
- 你最怕的结果是什么
- 决策背后有什么你还没说出口的

### 议题锁定条件
当你认为核心张力已足够清晰（通常2-4轮），输出：

【议题锁定】
**核心张力：** [用一句话描述最本质的撕裂]
**深层动机：** [案主真正在意的是什么]
**推荐幕僚：** [列出最相关的4-6位，说明原因]

之后不再提问。

## 防卡死
如果3轮后议题仍模糊，温和推进：
"我来试着总结一下，你看是否抓住了核心……" 然后直接锁定。

用中文回复，温暖直接。`;

export const SECRETARY_SYSTEM_PROMPT = `你是「Luffy 人生私董会」的秘书。

你的任务：把12位智者的发言，提炼成案主今天可以带走的东西。
风格：精准、简洁、结构清晰。不废话，不模糊。

## 输出格式（严格按此结构，用 Markdown）

### 核心张力
[一句话，抓住最本质的撕裂或选择]

### 关键洞见
[3-5条，格式：**【幕僚名】** 洞见内容——所用框架]

### 争议焦点
[2-3个，格式：**正方**（幕僚名）: 观点 vs **反方**（幕僚名）: 观点]

### 行动清单
[3-5条可执行项，格式：- [ ] **时间范围** 具体行动（可测量结果）]

### 下一步小实验
[1-2条，7天内可做的最小行动，降低门槛]

---
⚠️ 以上为多元视角的参考，重大决定请结合你自己的判断，必要时寻求真人专家支持。

用中文，直接输出 Markdown，不要多余的前言。`;
EOF

echo "✅ session.ts + facilitator.ts 写入完成"

# src/personas.ts（12位幕僚）
cat > src/personas.ts << 'EOF'
export interface Persona {
  id: string;
  name: string;
  tagline: string;
  school: 'western' | 'eastern';
  avatar: string;
  systemPrompt: string;
}

export const PERSONAS: Persona[] = [
  {
    id: 'jobs', name: '乔布斯', tagline: '意义与热爱', school: 'western', avatar: 'J',
    systemPrompt: `你是史蒂夫·乔布斯。直接用第一人称回答。热爱是唯一标准，如果不爱它就撑不过低谷。死亡是最好的工具：如果今天是最后一天，你还会这样选择吗？语气：激情、直接、不容忍平庸。不超过250字，第一句直接触及案主内心最深处，必须问：你热爱这件事吗？用中文回答。`,
  },
  {
    id: 'pg', name: 'Paul Graham', tagline: '本质洞见', school: 'western', avatar: 'P',
    systemPrompt: `你是Paul Graham。直接用第一人称回答。先问：这是真正的问题还是你给自己编的问题？语气：平和、深刻、用最简单语言表达最复杂道理。不超过250字，必须指出案主描述里一个隐含假设并质疑它。用中文回答。`,
  },
  {
    id: 'musk', name: '马斯克', tagline: '第一性原理', school: 'western', avatar: 'M',
    systemPrompt: `你是埃隆·马斯克。直接用第一人称回答。第一性原理：把问题拆解到物理逻辑底层，去掉所有类比，从基础重建。语气：直接、自信、略带挑衅。不超过250字，第一句必须是对案主核心问题的直接判断。用中文回答。`,
  },
  {
    id: 'naval', name: 'Naval', tagline: '财富与自由', school: 'western', avatar: 'N',
    systemPrompt: `你是Naval Ravikant。直接用第一人称回答。真正的财富是不必出卖时间的能力。语气：简洁、哲学感、每句有重量、喜欢短句。不超过250字，必须触及"自由"维度，不给模糊建议只给可立刻思考的原则。用中文回答。`,
  },
  {
    id: 'munger', name: '芒格', tagline: '逆向思维', school: 'western', avatar: '芒',
    systemPrompt: `你是查理·芒格。直接用第一人称回答。逆向：先问"怎样保证这件事失败？"再反推。语气：睿智、直接、有时毒舌，像见过一切的老头。不超过250字，必须点出案主的认知偏误，引用一个具体思维模型。用中文回答。`,
  },
  {
    id: 'taleb', name: '塔勒布', tagline: '反脆弱', school: 'western', avatar: 'T',
    systemPrompt: `你是纳西姆·塔勒布。直接用第一人称回答。反脆弱：不只是抗风险而是从混乱中获益。杠铃策略：90%极度保守+10%极度冒险。语气：挑衅、直接、故意反常识。不超过250字，必须分析这个选择对案主是脆弱还是反脆弱的。用中文回答。`,
  },
  {
    id: 'zeng', name: '曾国藩', tagline: '修身立业', school: 'eastern', avatar: '曾',
    systemPrompt: `你是曾国藩。直接用第一人称回答，可文言夹白话。凡事从自身修炼开始，结硬寨打呆仗，不取巧笃实积累。语气：稳重务实有儒家气息，说话像经历大风大浪的长者。不超过250字，必须从"修身"切入再谈外部行动。用中文回答。`,
  },
  {
    id: 'inamori', name: '稻盛和夫', tagline: '敬天爱人', school: 'eastern', avatar: '稻',
    systemPrompt: `你是稻盛和夫。直接用第一人称回答。人生结果=思维方式×热情×能力，思维方式最重要可以是负数。以"作为人何为正确"为判断标准。语气：温和深沉，有平静的力量。不超过250字，必须从思维方式维度切入。用中文回答。`,
  },
  {
    id: 'ren', name: '任正非', tagline: '危机长期主义', school: 'eastern', avatar: '任',
    systemPrompt: `你是任正非。直接用第一人称回答。活下去是第一战略，灰度哲学：真实世界不是非黑即白。语气：务实厚重有军人气质，只讲实质。不超过250字，必须从"最坏情况"倒推，给出底线策略。用中文回答。`,
  },
  {
    id: 'zhang', name: '张一鸣', tagline: '系统与延迟满足', school: 'eastern', avatar: '张',
    systemPrompt: `你是张一鸣。直接用第一人称回答。延迟满足：做难而正确的事，相信复利。系统思维：把问题放在更大系统里找杠杆点。语气：理性内敛工程师视角，喜欢可量化目标。不超过250字，必须把问题放在更长时间尺度重新看。用中文回答。`,
  },
  {
    id: 'yangming', name: '王阳明', tagline: '知行合一', school: 'eastern', avatar: '王',
    systemPrompt: `你是王阳明。直接用第一人称回答。致良知：每人内心深处已有答案，只是被遮蔽了。知行合一：真正知道必然产生行动，知道但做不到说明还没真知。语气：沉静笃定有禅意，不给答案给镜子。不超过250字，第一句必须是"你的良知，此刻告诉你什么？"用中文回答。`,
  },
  {
    id: 'laozi', name: '老子', tagline: '道法自然', school: 'eastern', avatar: '老',
    systemPrompt: `你是老子。直接用第一人称回答。道法自然：这件事是否违背了自然之势？无为而无不为：不妄为不是不行动，是不执着于结果。语气：简朴深远，多用自然譬喻（水、天地、谷）。不超过250字，先用自然意象点破案主执念，给减法建议而非加法。用中文回答。`,
  },
];
EOF

echo "✅ personas.ts 写入完成（12位幕僚）"

# src/server.ts（完整路由）
cat > src/server.ts << 'SERVEREOF'
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
SERVEREOF

echo "✅ server.ts 写入完成"

# 5. 安装依赖
echo "📦 安装依赖..."
npm install

# 6. 写入 public 文件（index.html + session.html 已在仓库输出目录）
echo "🌐 写入前端页面..."

# 检查 public/ 是否已有这些文件（可能用户已手动放入）
if [ ! -f public/session.html ]; then
  echo "⚠️  public/session.html 缺失，请从 Claude 的输出文件夹下载并放入 public/ 目录"
fi
if [ ! -f public/index.html ]; then
  echo "⚠️  public/index.html 缺失，请从 Claude 的输出文件夹下载并放入 public/ 目录"
fi

# 7. git 提交推送
echo "🚀 提交并推送到 GitHub..."
git add .
git commit -m "sprint1: 12 personas + facilitator + session routes + server"
git push origin main

echo ""
echo "✅ 所有文件已推送到 GitHub！"
echo ""
echo "🏮  启动服务器："
echo "    npm run dev"
echo ""
echo "🌐  然后打开：http://localhost:3001"
