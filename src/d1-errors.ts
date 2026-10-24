/**
 * Detection and edge responses for "D1 is unavailable" (Fase E).
 *
 * Incident 2026-10-19 23:40 UTC: the free-tier daily read quota ran out and D1
 * answered every query with `D1_ERROR: ... SQLITE_ERROR (code 7500)` / "too many
 * requests"; the uncaught exception surfaced as Cloudflare `error code: 1101`.
 * Only wrap errors at the edge and say what is going on; never change auth,
 * payment or pricing logic.
 */

const D1_UNAVAILABLE_PATTERNS = [
  /\b7500\b/,
  /too many requests/i,
  /D1_ERROR/i,
  /D1 DB (storage )?operation exceeded/i,
  /D1 (database|DB) (is )?(overloaded|reset|unavailable)/i,
  /Network connection lost/i,
  /Cannot resolve D1 DB/i,
  /daily .*(quota|limit)/i,
];

/** True when `err` has the shape of a D1 outage / quota failure. */
export function isD1Unavailable(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const parts: string[] = [];
  if (typeof err === "string") parts.push(err);
  else if (typeof err === "object") {
    const e = err as { message?: unknown; cause?: unknown; code?: unknown };
    if (typeof e.message === "string") parts.push(e.message);
    if (e.code !== undefined) parts.push(String(e.code));
    if (e.cause) parts.push(e.cause instanceof Error ? e.cause.message : String(e.cause));
  }
  const text = parts.join(" ");
  return D1_UNAVAILABLE_PATTERNS.some((re) => re.test(text));
}

/** ISO timestamp of the next 00:00 UTC (when the D1 free quota resets). */
export function nextUtcMidnight(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export const D1_UNAVAILABLE_MESSAGE =
  "temporarily unavailable: database quota exhausted; retry after 00:00 UTC";

/** HTTP 503 JSON for plain routes. */
export function d1UnavailableResponse(headers: Record<string, string> = {}, now: Date = new Date()): Response {
  const retryAt = nextUtcMidnight(now);
  const retryAfter = Math.max(1, Math.ceil((Date.parse(retryAt) - now.getTime()) / 1000));
  return new Response(
    JSON.stringify({ error: "temporarily_unavailable", reason: "database quota", retry_after_utc: retryAt }),
    {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter), ...headers },
    }
  );
}

/** JSON-RPC -32000 error body. */
export function d1UnavailableRpc(id: string | number | null, now: Date = new Date()) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code: -32000,
      message: D1_UNAVAILABLE_MESSAGE,
      data: { retry_after_utc: nextUtcMidnight(now) },
    },
  };
}
