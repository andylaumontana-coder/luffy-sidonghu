import { randomBytes } from 'crypto';
import { db } from './db.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Semantic status names for the numeric `step` column.
// DB stays numeric for migration safety; the API surfaces both.
//   2 → clarifying:  facilitator round (gathering tension)
//   4 → speaking:    topic locked, personas in flight
//   7 → completed:   secretary summary written
export type SessionStatus = 'clarifying' | 'speaking' | 'completed';

export function statusForStep(step: number): SessionStatus {
  if (step >= 7) return 'completed';
  if (step >= 4) return 'speaking';
  return 'clarifying';
}

export interface Session {
  id: string;
  question: string;
  step: 2 | 4 | 7;
  facilitatorHistory: ChatMessage[];
  definedTopic: string | null;
  personaOutputs: Record<string, string>;
  personaFollowups: Record<string, ChatMessage[]>;
  selectedPersonas: string[] | null;
  summary: string | null;
  createdAt: Date;
}

interface SessionRow {
  id: string;
  question: string;
  step: number;
  defined_topic: string | null;
  summary: string | null;
  owner_token: string | null;
  selected_personas: string | null;
  created_at: number;
}

const insertSession = db.prepare(
  `INSERT INTO sessions (id, question, step, defined_topic, summary, owner_token, created_at)
   VALUES (?, ?, 2, NULL, NULL, ?, ?)`,
);
const selectSession = db.prepare(
  `SELECT id, question, step, defined_topic, summary, owner_token, selected_personas, created_at
   FROM sessions WHERE id = ?`,
);
const selectOwner = db.prepare(`SELECT owner_token FROM sessions WHERE id = ?`);
const selectMessages = db.prepare(
  `SELECT role, content FROM facilitator_messages WHERE session_id = ? ORDER BY idx`,
);
const selectPersonas = db.prepare(
  `SELECT persona_id, content FROM persona_outputs WHERE session_id = ?`,
);
const countMessages = db.prepare(
  `SELECT COUNT(*) AS n FROM facilitator_messages WHERE session_id = ?`,
);
const insertMessage = db.prepare(
  `INSERT INTO facilitator_messages (session_id, idx, role, content) VALUES (?, ?, ?, ?)`,
);
const upsertPersonaOutput = db.prepare(
  `INSERT INTO persona_outputs (session_id, persona_id, content) VALUES (?, ?, ?)
   ON CONFLICT(session_id, persona_id) DO UPDATE SET content = excluded.content`,
);
const selectFollowups = db.prepare(
  `SELECT persona_id, role, content FROM persona_followups
   WHERE session_id = ? ORDER BY persona_id, idx`,
);
const countFollowups = db.prepare(
  `SELECT COUNT(*) AS n FROM persona_followups WHERE session_id = ? AND persona_id = ?`,
);
const insertFollowup = db.prepare(
  `INSERT INTO persona_followups (session_id, persona_id, idx, role, content) VALUES (?, ?, ?, ?, ?)`,
);

export function createSession(question: string, ownerToken: string): Session {
  const id = randomBytes(8).toString('hex');
  const createdAt = Date.now();
  insertSession.run(id, question, ownerToken, createdAt);
  return {
    id,
    question,
    step: 2,
    facilitatorHistory: [],
    definedTopic: null,
    personaOutputs: {},
    personaFollowups: {},
    selectedPersonas: null,
    summary: null,
    createdAt: new Date(createdAt),
  };
}

export function getSessionOwner(id: string): string | null | undefined {
  const row = selectOwner.get(id) as { owner_token: string | null } | undefined;
  return row ? row.owner_token : undefined;
}

export function getSession(id: string): Session | undefined {
  const row = selectSession.get(id) as SessionRow | undefined;
  if (!row) return undefined;
  const msgs = selectMessages.all(id) as { role: 'user' | 'assistant'; content: string }[];
  const personas = selectPersonas.all(id) as { persona_id: string; content: string }[];
  const personaOutputs: Record<string, string> = {};
  for (const p of personas) personaOutputs[p.persona_id] = p.content;
  const followupRows = selectFollowups.all(id) as { persona_id: string; role: 'user' | 'assistant'; content: string }[];
  const personaFollowups: Record<string, ChatMessage[]> = {};
  for (const f of followupRows) {
    if (!personaFollowups[f.persona_id]) personaFollowups[f.persona_id] = [];
    personaFollowups[f.persona_id].push({ role: f.role, content: f.content });
  }
  let selectedPersonas: string[] | null = null;
  if (row.selected_personas) {
    try {
      const parsed = JSON.parse(row.selected_personas);
      if (Array.isArray(parsed)) selectedPersonas = parsed.filter((x) => typeof x === 'string');
    } catch { /* ignore malformed */ }
  }
  return {
    id: row.id,
    question: row.question,
    step: row.step as 2 | 4 | 7,
    facilitatorHistory: msgs,
    definedTopic: row.defined_topic,
    personaOutputs,
    personaFollowups,
    selectedPersonas,
    summary: row.summary,
    createdAt: new Date(row.created_at),
  };
}

export function updateSession(
  id: string,
  patch: Partial<Pick<Session, 'step' | 'definedTopic' | 'summary' | 'selectedPersonas'>>,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.step !== undefined) { fields.push('step = ?'); values.push(patch.step); }
  if (patch.definedTopic !== undefined) { fields.push('defined_topic = ?'); values.push(patch.definedTopic); }
  if (patch.summary !== undefined) { fields.push('summary = ?'); values.push(patch.summary); }
  if (patch.selectedPersonas !== undefined) {
    fields.push('selected_personas = ?');
    values.push(patch.selectedPersonas === null ? null : JSON.stringify(patch.selectedPersonas));
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

const appendFacilitatorTxn = db.transaction(
  (id: string, role: 'user' | 'assistant', content: string) => {
    const next = (countMessages.get(id) as { n: number }).n;
    insertMessage.run(id, next, role, content);
  },
);

export function appendFacilitatorMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  appendFacilitatorTxn(id, role, content);
}

export function setPersonaOutput(id: string, personaId: string, content: string): void {
  upsertPersonaOutput.run(id, personaId, content);
}

const appendFollowupTxn = db.transaction(
  (id: string, personaId: string, role: 'user' | 'assistant', content: string) => {
    const next = (countFollowups.get(id, personaId) as { n: number }).n;
    insertFollowup.run(id, personaId, next, role, content);
  },
);

export function appendPersonaFollowup(
  id: string,
  personaId: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  appendFollowupTxn(id, personaId, role, content);
}

export interface SessionSummary {
  id: string;
  question: string;
  step: 2 | 4 | 7;
  createdAt: Date;
  hasSummary: boolean;
}

export function listSessionsByOwner(ownerToken: string, limit = 50): SessionSummary[] {
  const rows = db.prepare(
    `SELECT id, question, step, summary, created_at FROM sessions
     WHERE owner_token = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(ownerToken, limit) as { id: string; question: string; step: number; summary: string | null; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    step: r.step as 2 | 4 | 7,
    createdAt: new Date(r.created_at),
    hasSummary: !!r.summary,
  }));
}

export function getOrCreateShareToken(id: string): string | null {
  const existing = db.prepare(`SELECT share_token FROM sessions WHERE id = ?`).get(id) as { share_token: string | null } | undefined;
  if (!existing) return null;
  if (existing.share_token) return existing.share_token;
  const token = randomBytes(12).toString('hex');
  db.prepare(`UPDATE sessions SET share_token = ? WHERE id = ?`).run(token, id);
  return token;
}

export function clearShareToken(id: string): void {
  db.prepare(`UPDATE sessions SET share_token = NULL WHERE id = ?`).run(id);
}

export function getSessionByShareToken(token: string): Session | undefined {
  const row = db.prepare(`SELECT id FROM sessions WHERE share_token = ?`).get(token) as { id: string } | undefined;
  if (!row) return undefined;
  return getSession(row.id);
}
