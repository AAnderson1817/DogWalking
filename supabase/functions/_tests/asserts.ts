// Minimal assertion helpers (std/assert-compatible subset) — kept local so
// the suite runs in environments where jsr.io is unreachable.

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertFalse(cond: unknown, msg = "expected falsy"): void {
  if (cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));
  if (a !== b) {
    throw new Error(msg ?? `assertEquals failed:\n  actual:   ${a}\n  expected: ${b}`);
  }
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  msg = "expected promise to reject",
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error(msg);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
