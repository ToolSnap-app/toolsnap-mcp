import type { Env } from "../index.js";

/**
 * Fase 25.3 — daily snapshots of ToolSnap's presence on external MCP
 * directories (Smithery, Glama), stored in `directory_stats` (migration
 * 0013). Analytics only sees usage that reaches the Worker; it can't see the
 * funnel *before* the first call — directory installs/useCount. Smithery's
 * read-only endpoint is public (SMITHERY_API_KEY only buys a friendlier rate
 * limit); Glama's API requires GLAMA_API_KEY since 2026-10 (401 without it).
 * Both keys are sent as a Bearer header only when present. GLAMA_SERVER_ID
 * survived the repo move to ToolSnap-app (only the listing's URL path changed).
 */

const SMITHERY_QUALIFIED_NAME = "icosaedro/toolsnap-mcp";
const GLAMA_SERVER_ID = "ml055kk9x3";
const FETCH_TIMEOUT_MS = 10_000;

interface DirectorySnapshot {
  source: string;
  use_count: number | null;
  listing: Record<string, unknown>;
}

async function fetchJson(url: string, apiKey: string | undefined): Promise<unknown> {
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function snapshotSmithery(env: Env): Promise<DirectorySnapshot> {
  const url = `https://registry.smithery.ai/servers?q=${encodeURIComponent(SMITHERY_QUALIFIED_NAME)}`;
  const data = (await fetchJson(url, env.SMITHERY_API_KEY)) as {
    servers?: Array<{ qualifiedName?: string; useCount?: number; description?: string; verified?: boolean; isDeployed?: boolean }>;
  };
  const entry = data.servers?.find((s) => s.qualifiedName === SMITHERY_QUALIFIED_NAME);
  if (!entry) throw new Error(`qualifiedName ${SMITHERY_QUALIFIED_NAME} not found in registry search results`);
  return {
    source: "smithery",
    use_count: entry.useCount ?? null,
    listing: {
      description: entry.description ?? null,
      verified: entry.verified ?? null,
      isDeployed: entry.isDeployed ?? null,
      useCount: entry.useCount ?? null,
    },
  };
}

async function snapshotGlama(env: Env): Promise<DirectorySnapshot> {
  const url = `https://glama.ai/api/mcp/v1/servers/${GLAMA_SERVER_ID}`;
  const data = (await fetchJson(url, env.GLAMA_API_KEY)) as {
    name?: string;
    description?: string;
    attributes?: string[];
  };
  return {
    source: "glama",
    use_count: null, // Glama's public API exposes no usage metric — listing metadata only.
    listing: {
      name: data.name ?? null,
      description: data.description ?? null,
      attributes: data.attributes ?? null,
    },
  };
}

async function alreadySnapshottedToday(db: D1Database, source: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM directory_stats
       WHERE source = ? AND date(ts / 1000, 'unixepoch') = date(? / 1000, 'unixepoch')
       LIMIT 1`
    )
    .bind(source, now)
    .first();
  return row !== null;
}

async function snapshotOne(env: Env, source: string, fetcher: (env: Env) => Promise<DirectorySnapshot>): Promise<void> {
  const db = env.PREPAID_DB;
  const now = Date.now();
  try {
    if (await alreadySnapshottedToday(db, source, now)) return;
    const snap = await fetcher(env);
    await db
      .prepare(`INSERT INTO directory_stats (ts, source, use_count, listing) VALUES (?, ?, ?, ?)`)
      .bind(now, snap.source, snap.use_count, JSON.stringify(snap.listing))
      .run();
  } catch (err) {
    console.error(`directory-stats snapshot failed (${source}):`, err instanceof Error ? err.message : err);
  }
}

/** Snapshots every configured directory source. Each source fails independently — one bad fetch never blocks the others. */
export async function snapshotDirectoryStats(env: Env): Promise<void> {
  await Promise.all([snapshotOne(env, "smithery", snapshotSmithery), snapshotOne(env, "glama", snapshotGlama)]);
}
