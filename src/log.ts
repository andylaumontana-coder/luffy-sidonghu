type Field = string | number | boolean | null | undefined;

export function logEvent(event: string, fields: Record<string, Field> = {}): void {
  const line: Record<string, Field> = { ts: new Date().toISOString(), event };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) line[k] = v;
  }
  // single-line JSON: easy to grep, easy to ship to a log aggregator
  process.stdout.write(JSON.stringify(line) + '\n');
}
