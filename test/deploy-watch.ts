/**
 * Unit tests for src/alerts/deploy-watch.ts (A14 of the security plan).
 *
 * The comparator decides when the watcher stays silent and when it pages:
 *  - no previous state → only saves the latest deployment, never alerts;
 *  - new deployment whose version is registered as expected → silence;
 *  - new deployment NOT registered → one Telegram alert with Worker, version,
 *    date, author, source and message;
 *  - a deploy so fresh the workflow may still be registering it waits a pass;
 *  - registration is per DEPLOYMENT id, and a rollback always alerts even to an
 *    already registered version (review of PR #144);
 *  - the alert text must parse under Telegram's legacy Markdown (the fake
 *    Telegram rejects stray `_`, `*`, `[` outside code spans, like the real one);
 *  - a failed Telegram send is retried (and warned about), and after 1 h it
 *    throws so the cron pager hears about it;
 *  - past 5 unexpected deployments the last alert says "y N más";
 *  - no VIGIA_CF_TOKEN → does nothing; no secret value is ever logged.
 *
 * Pure logic — fake KV, captured fetch. No network.
 *
 * Run: npx tsx test/deploy-watch.ts
 */
import {
  checkDeployWatch,
  expectedKey,
  failingSinceKey,
  formatAlert,
  judgeDeployment,
  newerThan,
  seenKey,
  type Deployment,
} from "../src/alerts/deploy-watch.js";
import type { Env } from "../src/index.js";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const NOW = Date.parse("2026-10-30T12:00:00Z");
const OLD = "2026-10-30T10:00:00.000Z";
const FRESH = "2026-10-30T11:59:00.000Z";
/** Past the 3 min grace, under the 1 h undeliverable limit. */
const MID = "2026-10-30T11:30:00.000Z";

function dep(id: string, version: string, createdOn = OLD, extra: Partial<Deployment> = {}): Deployment {
  return { id, created_on: createdOn, versions: [{ version_id: version, percentage: 100 }], ...extra };
}

/**
 * Telegram's legacy Markdown: outside code spans a lone `_`, `*` or `[` is a
 * parse error (400). Code spans (backticks) may hold anything.
 */
function parsesAsLegacyMarkdown(text: string): boolean {
  const ticks = (text.match(/`/g) ?? []).length;
  if (ticks % 2 !== 0) return false;
  const outside = text.replace(/`[^`]*`/g, "");
  if (/[_\[]/.test(outside)) return false;
  return (outside.match(/\*/g) ?? []).length % 2 === 0;
}

class FakeKv {
  store = new Map<string, string>();
  puts: string[] = [];
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.puts.push(key);
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const SECRET = "vigia-secret-token-value";
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

/** Runs one pass against a fake API (deployments per worker) and a fake Telegram. */
async function pass(opts: {
  kv: FakeKv;
  deployments: Record<string, Deployment[]>;
  telegramOk?: boolean;
  workers?: string;
  token?: string | undefined;
  /** Status codes the deployments API answers with, one per call, before the real list. */
  apiErrors?: number[];
  now?: number;
}): Promise<{ alerts: string[]; apiAuth: string[] }> {
  const alerts: string[] = [];
  const apiAuth: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const text = JSON.parse(String(init?.body)).text as string;
      if (!parsesAsLegacyMarkdown(text)) return new Response('{"description":"can\'t parse entities"}', { status: 400 });
      alerts.push(text);
      return new Response("{}", { status: opts.telegramOk === false ? 500 : 200 });
    }
    const m = url.match(/\/workers\/scripts\/([^/]+)\/deployments$/);
    if (m) {
      apiAuth.push(String((init?.headers as Record<string, string>)?.Authorization));
      const status = opts.apiErrors?.shift();
      if (status !== undefined) return new Response("{}", { status });
      const list = opts.deployments[decodeURIComponent(m[1]!)];
      if (!list) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ success: true, result: { deployments: list } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const env = {
    X402_NONCES: opts.kv as unknown as KVNamespace,
    VIGIA_CF_TOKEN: "token" in opts ? opts.token : SECRET,
    VIGIA_ACCOUNT_ID: "acc123",
    VIGIA_WORKERS: opts.workers ?? "toolsnap-mcp",
    TELEGRAM_BOT_TOKEN: "tg-token",
    TELEGRAM_CHAT_ID: "42",
  } as unknown as Env;
  await checkDeployWatch(env, opts.now ?? NOW);
  return { alerts, apiAuth };
}

async function run(): Promise<void> {
  // Never leak the secret into logs, whatever the pass does.
  const logged: string[] = [];
  const capture = (...a: unknown[]): void => void logged.push(a.map(String).join(" "));
  console.warn = capture;
  console.error = capture;

  // ── judgeDeployment (pure comparator) ──
  const d = dep("d2", "v2");
  assert("no previous state → baseline", judgeDeployment(d, null, false, NOW) === "baseline");
  assert("same deployment as last seen → unchanged", judgeDeployment(d, "d2", false, NOW) === "unchanged");
  assert("new + registered → expected (silence)", judgeDeployment(d, "d1", true, NOW) === "expected");
  assert("new + not registered → unexpected (alert)", judgeDeployment(d, "d1", false, NOW) === "unexpected");
  assert(
    "new + not registered but seconds old → pending",
    judgeDeployment(dep("d2", "v2", FRESH), "d1", false, NOW) === "pending"
  );
  assert("registered beats freshness", judgeDeployment(dep("d2", "v2", FRESH), "d1", true, NOW) === "expected");

  // ── newerThan ──
  const list = [dep("d3", "v3"), dep("d2", "v2"), dep("d1", "v1")];
  assert("newerThan without state → none", newerThan(list, null).length === 0);
  assert(
    "newerThan returns oldest first, stops at the seen one",
    newerThan(list, "d1").map((x) => x.id).join() === "d2,d3"
  );
  assert("newerThan with the seen one missing → all returned", newerThan(list, "gone").length === 3);

  // ── formatAlert ──
  const text = formatAlert(
    "toolsnap-mcp",
    dep("d2", "v2", OLD, {
      author_email: "someone_x@example.com",
      source: "wrangler",
      annotations: { "workers/message": "fix `thing`", "workers/triggered_by": "upload" },
    })
  );
  for (const part of ["toolsnap-mcp", "d2", "v2", OLD, "someone_x@example.com", "wrangler", "upload", "disparado por", "fix 'thing'"]) {
    assert(`alert carries "${part}"`, text.includes(part), text);
  }

  // ── checkDeployWatch: first run without state only saves ──
  {
    const kv = new FakeKv();
    const { alerts } = await pass({ kv, deployments: { "toolsnap-mcp": [dep("d1", "v1")] } });
    assert("first run: saves the latest deployment", kv.store.get(seenKey("toolsnap-mcp")) === "d1");
    assert("first run: no alert", alerts.length === 0);
  }

  // ── new version registered as expected → silence, seen updated ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    kv.store.set(expectedKey("toolsnap-mcp", "d2"), "ci");
    const { alerts } = await pass({ kv, deployments: { "toolsnap-mcp": [dep("d2", "v2"), dep("d1", "v1")] } });
    assert("registered new version: silence", alerts.length === 0);
    assert("registered new version: seen updated", kv.store.get(seenKey("toolsnap-mcp")) === "d2");
  }

  // ── new version NOT registered → alert, seen updated ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    const { alerts, apiAuth } = await pass({
      kv,
      deployments: {
        "toolsnap-mcp": [
          dep("d2", "v2", OLD, { author_email: "nakin@example.com", source: "dash" }),
          dep("d1", "v1"),
        ],
      },
    });
    assert("unregistered new version: one alert", alerts.length === 1, String(alerts.length));
    assert(
      "alert names Worker, version and author",
      !!alerts[0] && alerts[0].includes("toolsnap-mcp") && alerts[0].includes("v2") && alerts[0].includes("nakin@example.com")
    );
    assert("unregistered new version: seen updated", kv.store.get(seenKey("toolsnap-mcp")) === "d2");
    assert("API called with the read-only token", apiAuth[0] === `Bearer ${SECRET}`);
    // Next pass with nothing new: silence and no puts.
    const before = kv.puts.length;
    const again = await pass({ kv, deployments: { "toolsnap-mcp": [dep("d2", "v2"), dep("d1", "v1")] } });
    assert("unchanged afterwards: silence", again.alerts.length === 0);
    assert("unchanged afterwards: no KV puts", kv.puts.length === before);
  }

  // ── two deploys in one window: the unexpected one in the middle is caught ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    kv.store.set(expectedKey("toolsnap-mcp", "d3"), "ci");
    const { alerts } = await pass({
      kv,
      deployments: { "toolsnap-mcp": [dep("d3", "v3"), dep("d2", "v2"), dep("d1", "v1")] },
    });
    assert("unexpected deploy followed by an expected one still alerts", alerts.length === 1 && alerts[0]!.includes("v2"));
    assert("seen jumps to the latest", kv.store.get(seenKey("toolsnap-mcp")) === "d3");
  }

  // ── very fresh and unregistered: waits, then alerts once old enough ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    const { alerts } = await pass({
      kv,
      deployments: { "toolsnap-mcp": [dep("d2", "v2", FRESH), dep("d1", "v1")] },
    });
    assert("fresh unregistered deploy: no alert yet", alerts.length === 0);
    assert("fresh unregistered deploy: not marked as seen", kv.store.get(seenKey("toolsnap-mcp")) === "d1");
  }

  // ── Telegram down: the alert is retried, not swallowed ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    const deployments = { "toolsnap-mcp": [dep("d2", "v2", MID), dep("d1", "v1")] };
    await pass({ kv, deployments, telegramOk: false });
    assert("failed send: not marked as seen", kv.store.get(seenKey("toolsnap-mcp")) === "d1");
    const retry = await pass({ kv, deployments });
    assert("retry: alert goes out", retry.alerts.length === 1);
    assert("retry: marked as seen", kv.store.get(seenKey("toolsnap-mcp")) === "d2");
  }

  // ── 1 (review): a real alert body must parse under Telegram's Markdown ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    const { alerts } = await pass({
      kv,
      deployments: {
        "toolsnap-mcp": [
          dep("d2", "v2", OLD, {
            author_email: "some_one*x[1]@example.com",
            source: "wrangler",
            annotations: { "workers/triggered_by": "secret_put", "workers/message": "a_b *c* [d]" },
          }),
          dep("d1", "v1"),
        ],
      },
    });
    assert("alert with _ * [ in third-party fields still gets through the Telegram parser", alerts.length === 1, String(alerts.length));
    assert("…and marks the deployment as seen", kv.store.get(seenKey("toolsnap-mcp")) === "d2");
  }
  assert("the fake Telegram rejects a stray underscore", !parsesAsLegacyMarkdown("triggered_by: `x`"));
  assert("the fake Telegram accepts underscores inside code spans", parsesAsLegacyMarkdown("*a* `x_y`"));

  // ── 2 (review): rollback to an already-registered version still alerts ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d2");
    // v1 was deployed by the workflow long ago (deployment d1 registered)...
    kv.store.set(expectedKey("toolsnap-mcp", "d1"), "ci");
    // ...and now someone rolls back to it: NEW deployment d3, same version v1.
    const { alerts } = await pass({
      kv,
      deployments: {
        "toolsnap-mcp": [
          dep("d3", "v1", OLD, { annotations: { "workers/triggered_by": "rollback" } }),
          dep("d2", "v2"),
          dep("d1", "v1"),
        ],
      },
    });
    assert("rollback to a registered version alerts", alerts.length === 1 && alerts[0]!.includes("Rollback"), alerts.join("|"));
    assert("rollback alert names the new deployment", alerts[0]?.includes("d3") === true);
    assert("rollback: seen updated", kv.store.get(seenKey("toolsnap-mcp")) === "d3");
  }
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    kv.store.set(expectedKey("toolsnap-mcp", "d3"), "registered-by-hand");
    const { alerts } = await pass({
      kv,
      deployments: {
        "toolsnap-mcp": [
          dep("d3", "v1", FRESH, { annotations: { "workers/triggered_by": "rollback" } }),
          dep("d1", "v1"),
        ],
      },
    });
    assert("rollback alerts even when the deployment itself is registered and fresh", alerts.length === 1);
  }
  assert(
    "a deployment on an old registered VERSION but unregistered deployment id → unexpected",
    judgeDeployment(dep("d9", "v1"), "d1", false, NOW) === "unexpected"
  );

  // ── 5 (review): more than 5 unexpected deployments → last alert says "y N más" ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d0");
    const many = [8, 7, 6, 5, 4, 3, 2, 1].map((n) => dep(`d${n}`, `v${n}`));
    many.push(dep("d0", "v0"));
    const { alerts } = await pass({ kv, deployments: { "toolsnap-mcp": many } });
    assert("8 unexpected deployments → 5 alerts", alerts.length === 5, String(alerts.length));
    assert("last alert says 'y 3 más'", alerts[4]?.includes("y 3 más") === true && !alerts[3]!.includes("más"));
    assert("seen jumps to the latest", kv.store.get(seenKey("toolsnap-mcp")) === "d8");
  }

  // ── 1 (review): undeliverable alert is warned about, then throws after 1 h ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    logged.length = 0;
    await pass({ kv, telegramOk: false, deployments: { "toolsnap-mcp": [dep("d2", "v2", MID), dep("d1", "v1")] } });
    assert("failed send under 1 h: console.warn, no throw", logged.some((l) => l.includes("no se pudo enviar")));
    let threw = "";
    try {
      await pass({
        kv,
        telegramOk: false,
        deployments: { "toolsnap-mcp": [dep("d2", "v2", "2026-10-30T09:00:00.000Z"), dep("d1", "v1")] },
      });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("failed send for over 1 h: throws so runTask pages it", threw.includes("sin poder enviarse"), threw);
    assert("…and it is still not marked as seen", kv.store.get(seenKey("toolsnap-mcp")) === "d1");
  }

  // ── several Workers, one API failure does not hide the other ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-portal"), "p1");
    let threw = "";
    let alerts: string[] = [];
    try {
      ({ alerts } = await pass({
        kv,
        workers: "missing-worker,toolsnap-portal",
        deployments: { "toolsnap-portal": [dep("p2", "pv2"), dep("p1", "pv1")] },
      }));
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("API failure on one Worker is reported by throwing", threw.includes("missing-worker"), threw);
    assert("the failure message carries no secret", !threw.includes(SECRET));
    assert("seen of the healthy Worker still updated", kv.store.get(seenKey("toolsnap-portal")) === "p2");
  }

  // ── Cloudflare API 5xx: retried, and only pages if it lasts (alert of 2026-10-31) ──
  {
    const kv = new FakeKv();
    kv.store.set(seenKey("toolsnap-mcp"), "d1");
    const list = { "toolsnap-mcp": [dep("d2", "v2"), dep("d1", "v1")] };
    const one = await pass({ kv, apiErrors: [500], deployments: list });
    assert("a single 500 is retried within the pass", one.apiAuth.length === 2);
    assert("…and the retry still alerts on the unexpected deployment", one.alerts.length === 1);
    assert("…without opening a 5xx incident", !kv.store.has(failingSinceKey("toolsnap-mcp")));

    const kv2 = new FakeKv();
    kv2.store.set(seenKey("toolsnap-mcp"), "d1");
    let threw = "";
    try {
      await pass({ kv: kv2, apiErrors: [500, 502], deployments: list });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("5xx after the retry does not page at first", threw === "", threw);
    assert("…but opens an incident with its start time", kv2.store.get(failingSinceKey("toolsnap-mcp")) === String(NOW));
    assert("…and leaves seen untouched", kv2.store.get(seenKey("toolsnap-mcp")) === "d1");

    threw = "";
    try {
      await pass({ kv: kv2, apiErrors: [500, 500], deployments: list, now: NOW + 20 * 60 * 1000 });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("5xx for 20 min: still silent", threw === "", threw);

    threw = "";
    try {
      await pass({ kv: kv2, apiErrors: [503, 503], deployments: list, now: NOW + 31 * 60 * 1000 });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("5xx for over 30 min: throws so runTask pages it", threw.includes("HTTP 503"), threw);

    const back = await pass({ kv: kv2, deployments: list, now: NOW + 35 * 60 * 1000 });
    assert("API back: incident closed", !kv2.store.has(failingSinceKey("toolsnap-mcp")));
    assert("…and the missed deployment is caught up", back.alerts.length === 1);

    const kv3 = new FakeKv();
    kv3.store.set(seenKey("toolsnap-mcp"), "d1");
    threw = "";
    try {
      await pass({ kv: kv3, apiErrors: [401], deployments: list });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("401 (revoked token) pages at once", threw.includes("HTTP 401"), threw);
  }

  // ── no token → no-op ──
  {
    const kv = new FakeKv();
    const { apiAuth } = await pass({ kv, token: undefined, deployments: { "toolsnap-mcp": [dep("d1", "v1")] } });
    assert("no VIGIA_CF_TOKEN: no API calls, no state", apiAuth.length === 0 && kv.puts.length === 0);
  }

  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  assert("the secret never reached the logs", !logged.some((l) => l.includes(SECRET)));
  realLog(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  globalThis.fetch = realFetch;
  console.error = realError;
  console.error("Test runner error:", err);
  process.exit(1);
});
