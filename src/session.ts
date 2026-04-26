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
