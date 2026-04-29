interface Bucket {
  windowMs: number;
  max: number;
  hits: Map<string, number[]>;
}

function makeBucket(windowMs: number, max: number): Bucket {
  return { windowMs, max, hits: new Map() };
}

function check(bucket: Bucket, key: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - bucket.windowMs;
  const arr = bucket.hits.get(key) ?? [];
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= bucket.max) {
    const retryAfterSec = Math.max(1, Math.ceil((fresh[0] + bucket.windowMs - now) / 1000));
    bucket.hits.set(key, fresh);
    return { ok: false, retryAfterSec };
  }
  fresh.push(now);
  bucket.hits.set(key, fresh);
  return { ok: true, retryAfterSec: 0 };
}

const HOUR = 60 * 60 * 1000;

const createSessionBucket = makeBucket(
  HOUR,
  Number(process.env.LUFFY_LIMIT_CREATE_PER_HOUR ?? 5),
);
const llmBucket = makeBucket(
  HOUR,
  Number(process.env.LUFFY_LIMIT_LLM_PER_HOUR ?? 60),
);

export function checkCreateSession(ip: string) {
  return check(createSessionBucket, ip);
}

export function checkLlmCall(ip: string) {
  return check(llmBucket, ip);
}

setInterval(() => {
  const cutoff = Date.now() - HOUR;
  for (const bucket of [createSessionBucket, llmBucket]) {
    for (const [k, v] of bucket.hits) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) bucket.hits.delete(k);
      else bucket.hits.set(k, fresh);
    }
  }
}, 10 * 60 * 1000).unref();
