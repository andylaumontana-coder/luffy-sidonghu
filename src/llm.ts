import { logEvent } from './log.js';

export interface ChatChunk {
  choices: { delta?: { content?: string } }[];
}

export interface CreateChatParams {
  model: string;
  max_tokens: number;
  temperature: number;
  stream: true;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

// Minimal subset of openai's interface that streamChat actually uses.
// Tests inject a fake; production passes the real OpenAI client.
export interface ChatClient {
  chat: {
    completions: {
      create(
        params: CreateChatParams,
        opts: { signal: AbortSignal },
      ): Promise<AsyncIterable<ChatChunk>>;
    };
  };
}

export interface StreamOpts {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  retries: number;
  // observability tags (logged on completion)
  sessionId?: string;
  role?: 'facilitator' | 'persona' | 'summary' | 'followup';
  personaId?: string;
}

export interface StreamResult {
  text: string;
  error?: string;
}

export async function streamChat(
  client: ChatClient,
  opts: StreamOpts,
  onChunk: (text: string) => void,
): Promise<StreamResult> {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: opts.systemPrompt },
  ];
  if (opts.history) for (const m of opts.history) messages.push(m);
  if (opts.userPrompt) messages.push({ role: 'user', content: opts.userPrompt });

  const startedAt = Date.now();
  let attempts = 0;
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    attempts = attempt + 1;
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
        logEvent('llm.call', {
          session_id: opts.sessionId, role: opts.role, persona_id: opts.personaId,
          model: opts.model, ok: true, attempts, duration_ms: Date.now() - startedAt, text_len: text.length,
        });
        return { text };
      } catch (innerErr: unknown) {
        clearTimeout(timer);
        lastError = innerErr instanceof Error ? innerErr.message : String(innerErr);
        if (started) {
          logEvent('llm.call', {
            session_id: opts.sessionId, role: opts.role, persona_id: opts.personaId,
            model: opts.model, ok: false, attempts, duration_ms: Date.now() - startedAt,
            text_len: text.length, error: lastError, mid_stream: true,
          });
          return { text, error: lastError };
        }
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
  logEvent('llm.call', {
    session_id: opts.sessionId, role: opts.role, persona_id: opts.personaId,
    model: opts.model, ok: false, attempts, duration_ms: Date.now() - startedAt, error: lastError,
  });
  return { text: '', error: lastError };
}
