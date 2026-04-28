import http from 'http';
import { randomBytes } from 'crypto';

const COOKIE_NAME = 'luffy_uid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

export function getOrIssueUserToken(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): string {
  const existing = parseCookies(req)[COOKIE_NAME];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const token = randomBytes(16).toString('hex');
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
  );
  return token;
}

export function getUserToken(req: http.IncomingMessage): string | undefined {
  const t = parseCookies(req)[COOKIE_NAME];
  return t && /^[a-f0-9]{32}$/.test(t) ? t : undefined;
}

// X-Forwarded-For is only consulted when LUFFY_TRUST_PROXY is explicitly enabled.
// Without a trusted reverse proxy, anyone can spoof XFF to bypass per-IP limits.
const TRUST_PROXY = process.env.LUFFY_TRUST_PROXY === '1';

export function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}
