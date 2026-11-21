/**
 * Unit tests for src/alerts/agent.ts (alert agent, phase 1: shadow mode).
 *
 * page() sends the Telegram alert exactly as sendTelegram() did and then hands
 * the incident to a Claude Code scheduled task through its API trigger; the
 * task answers on POST /alerts/agent/verdict, which posts a plain-text reply
 * under the alert. What must hold:
 *
 *  - the pager never depends on the agent: off, throttled, failing or throwing,
 *    the alert still goes out and page() still reports it;
 *  - nothing is fired unless both the URL and the token are set, and never to a
 *    host other than api.anthropic.com;
 *  - one fire per fingerprint per 6 h, 4 per hour, 12 per day, also when KV is
 *    missing or refuses writes;
 *  - the payload is bounded and keeps caller-written strings under `untrusted`;
 *  - the context query is one bounded statement and its failure is not fatal;
 *  - the verdict endpoint is 404 unconfigured, 401 without the bearer, rejects
 *    malformed verdicts, and what it posts is plain text with links defanged.
 *
 * Pure logic — captured fetch, fake KV, fake D1. No network.
 *
 * Run: npx tsx test/alert-agent.ts
 */
import { readFileSync } from "node:fs";
import {
  page,
  fireAgent,
  fireAllowed,
  buildFirePayload,
  loadIncidentContext,
  handleAgentVerdict,
  parseVerdict,
  formatVerdict,
  resetAgentState,
  MAX_FIRES_PER_HOUR,
  MAX_FIRES_PER_DAY,
  FINGERPRINT_WINDOW_MS,
  type AgentEnv,
  type Incident,
  type FirePayload,
} from "../src/alerts/agent.js";

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

const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire";
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;

/** Fake Telegram + fake /fire. `fire` = HTTP status of the fire, or "throw". */
function fakeNet(opts: { telegram?: number; fire?: number | "throw"; messageId?: number } = {}): { tg: Call[]; fires: Call[] } {
  const tg: Call[] = [];
  const fires: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    if (url.startsWith("https://api.telegram.org/")) {
      tg.push(call);
      const status = opts.telegram ?? 200;
      return new Response(JSON.stringify({ ok: status === 200, result: { message_id: opts.messageId ?? 777 } }), { status });
    }
    fires.push(call);
    if (opts.fire === "throw") throw new Error("network down");
    return new Response('{"type":"routine_fire"}', { status: opts.fire ?? 200 });
  }) as typeof fetch;
  return { tg, fires };
}

function fakeKv(opts: { failPut?: boolean } = {}): KVNamespace & { puts: number } {
  const store = new Map<string, string>();
  const kv = {
    puts: 0,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      kv.puts++;
      if (opts.failPut) throw new Error("KV put() limit exceeded for the day");
      store.set(key, value);
    },
  };
  return kv as unknown as KVNamespace & { puts: number };
}

function fakeDb(rows: unknown[] | "throw"): { db: D1Database; sql: string[]; binds: unknown[][] } {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind(...args: unknown[]) {
          binds.push(args);
          return {
            async all() {
              if (rows === "throw") throw new Error("D1_ERROR: quota exceeded");
              return { results: rows };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, sql, binds };
}

function env(extra: Partial<AgentEnv> = {}): AgentEnv {
  return {
    TELEGRAM_BOT_TOKEN: "bot",
    TELEGRAM_CHAT_ID: "42",
    ALERT_AGENT_FIRE_URL: FIRE_URL,
    ALERT_AGENT_FIRE_TOKEN: "fire-token",
    ALERT_AGENT_TOKEN: "verdict-token",
    ...extra,
  };
}

const INCIDENT: Incident = {
  kind: "tool_error",
  fingerprint: "alert:err:tool_error:fetch_extract",
  facts: { tool: "fetch_extract", payment_type: "tool_error", provider: null },
  untrusted: { detail: "HTTP 500 from upstream", payer: "0xabc", client: null, client_name: "claude-code" },
  tool: "fetch_extract",
  payer: "0xabc",
};

function payloadOf(call: Call | undefined): FirePayload {
  return JSON.parse(String(call?.body.text)) as FirePayload;
}

function verdictRequest(body: unknown, token: string | null = "verdict-token"): Request {
  return new Request("https://mcp.toolsnap.app/alerts/agent/verdict", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const log = console.log;
const warn = console.warn;
const quiet = (): void => {
  console.warn = () => {};
};
quiet();

try {
  console.log("\npage()");
  {
    resetAgentState();
    const net = fakeNet({ messageId: 9001 });
    const ok = await page(env({ X402_NONCES: fakeKv() }), "🔴 *tool_error* · `fetch_extract`", INCIDENT);
    assert("the alert goes to Telegram, as Markdown, untouched", ok && net.tg.length === 1 && net.tg[0]?.body.text === "🔴 *tool_error* · `fetch_extract`" && net.tg[0]?.body.parse_mode === "Markdown", JSON.stringify(net.tg));
    assert("…and the incident is fired once at the task's endpoint", net.fires.length === 1 && net.fires[0]?.url === FIRE_URL, JSON.stringify(net.fires.map((f) => f.url)));
    const h = net.fires[0]?.headers ?? {};
    assert("…with the bearer and the routine beta header", h.authorization === "Bearer fire-token" && h["anthropic-beta"] === "experimental-cc-routine-2026-04-01" && h["anthropic-version"] === "2023-06-01", JSON.stringify(h));
    const p = payloadOf(net.fires[0]);
    assert("the payload is shadow mode and names the incident", p.v === 1 && p.mode === "shadow" && p.kind === "tool_error" && p.fingerprint === INCIDENT.fingerprint, JSON.stringify(p));
    assert("…carries the alert's Telegram message id to reply to", p.reply_to === 9001, String(p.reply_to));
    assert("…keeps caller-written strings under untrusted, nulls dropped", p.untrusted.detail === "HTTP 500 from upstream" && !("client" in p.untrusted) && p.facts.provider === null, JSON.stringify(p));
  }
  {
    resetAgentState();
    const net = fakeNet();
    const ok = await page(env({ ALERT_AGENT_FIRE_TOKEN: undefined }), "alerta", INCIDENT);
    assert("without the fire token: alert sent, nothing fired", ok && net.tg.length === 1 && net.fires.length === 0);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const ok = await page(env({ ALERT_AGENT_FIRE_URL: undefined }), "alerta", INCIDENT);
    assert("without the fire URL: alert sent, nothing fired", ok && net.tg.length === 1 && net.fires.length === 0);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const ok = await page(env({ ALERT_AGENT_FIRE_URL: "https://example.com/v1/claude_code/routines/x/fire" }), "alerta", INCIDENT);
    assert("a fire URL outside api.anthropic.com is never called", ok && net.fires.length === 0);
  }
  for (const fire of [401, 429, 500, "throw"] as const) {
    resetAgentState();
    const net = fakeNet({ fire });
    let threw = false;
    let ok = false;
    try {
      ok = await page(env(), "alerta", INCIDENT);
    } catch {
      threw = true;
    }
    assert(`a fire answering ${fire} does not touch the alert`, !threw && ok && net.tg.length === 1);
  }
  {
    resetAgentState();
    const net = fakeNet({ telegram: 500 });
    const ok = await page(env(), "alerta", INCIDENT);
    assert("an alert Telegram refused is not handed to the agent", !ok && net.fires.length === 0);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const ok = await page({ ALERT_AGENT_FIRE_URL: FIRE_URL, ALERT_AGENT_FIRE_TOKEN: "t" }, "alerta", INCIDENT);
    assert("without Telegram configured: no alert, no fire", !ok && net.tg.length === 0 && net.fires.length === 0);
  }

  console.log("\nthrottle");
  {
    resetAgentState();
    const net = fakeNet();
    const e = env({ X402_NONCES: fakeKv() });
    const a = await fireAgent(e, INCIDENT, "alerta", 1, T0);
    const b = await fireAgent(e, INCIDENT, "alerta", 1, T0 + HOUR);
    const c = await fireAgent(e, INCIDENT, "alerta", 1, T0 + FINGERPRINT_WINDOW_MS);
    assert("the same fingerprint fires once per 6 h", a === "fired" && b === "throttled" && c === "fired" && net.fires.length === 2, `${a} ${b} ${c}`);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const e = env({ X402_NONCES: fakeKv() });
    const out: string[] = [];
    for (let i = 0; i < MAX_FIRES_PER_HOUR + 2; i++) {
      out.push(await fireAgent(e, { ...INCIDENT, fingerprint: `fp:${i}` }, "alerta", 1, T0 + i * 1000));
    }
    assert(`at most ${MAX_FIRES_PER_HOUR} fires in an hour`, net.fires.length === MAX_FIRES_PER_HOUR && out.slice(MAX_FIRES_PER_HOUR).every((o) => o === "throttled"), out.join(","));
    const later = await fireAgent(e, { ...INCIDENT, fingerprint: "fp:later" }, "alerta", 1, T0 + HOUR + 5000);
    assert("…and the next hour opens again", later === "fired", later);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const e = env({ X402_NONCES: fakeKv() });
    let fired = 0;
    for (let i = 0; i < 30; i++) {
      // One every 20 minutes: under the hourly cap, over the daily one.
      if ((await fireAgent(e, { ...INCIDENT, fingerprint: `day:${i}` }, "alerta", 1, T0 + i * 20 * 60 * 1000)) === "fired") fired++;
    }
    assert(`at most ${MAX_FIRES_PER_DAY} fires in a day`, fired === MAX_FIRES_PER_DAY && net.fires.length === MAX_FIRES_PER_DAY, String(fired));
  }
  {
    resetAgentState();
    const net = fakeNet();
    const a = await fireAgent(env(), INCIDENT, "alerta", 1, T0);
    const b = await fireAgent(env(), INCIDENT, "alerta", 1, T0 + 1000);
    assert("without KV the isolate still dedupes", a === "fired" && b === "throttled" && net.fires.length === 1, `${a} ${b}`);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const kv = fakeKv({ failPut: true });
    const e = env({ X402_NONCES: kv });
    const a = await fireAgent(e, INCIDENT, "alerta", 1, T0);
    const b = await fireAgent(e, INCIDENT, "alerta", 1, T0 + 1000);
    assert("a KV that refuses writes neither blocks the fire nor lifts the cap", a === "fired" && b === "throttled" && net.fires.length === 1, `${a} ${b}`);
  }
  {
    resetAgentState();
    const net = fakeNet({ fire: 500 });
    const e = env({ X402_NONCES: fakeKv() });
    const a = await fireAgent(e, INCIDENT, "alerta", 1, T0);
    const b = await fireAgent(e, INCIDENT, "alerta", 1, T0 + 1000);
    assert("a failed fire is not retried inside the window", a === "failed" && b === "throttled" && net.fires.length === 1, `${a} ${b}`);
  }
  {
    const marks = [{ fp: "x", ts: T0 }];
    assert("fireAllowed: another fingerprint is free", fireAllowed(marks, "y", T0 + 1) && !fireAllowed(marks, "x", T0 + 1));
  }

  console.log("\npayload");
  {
    const long = "A".repeat(5000);
    const text = buildFirePayload(
      { kind: "tool_error", fingerprint: "fp", facts: { n: 3, ok: true, skip: undefined }, untrusted: { detail: long, empty: "", none: null } },
      long,
      null,
      null,
      T0
    );
    const p = JSON.parse(text) as FirePayload;
    assert("untrusted strings are truncated", (p.untrusted.detail ?? "").length <= 301, String((p.untrusted.detail ?? "").length));
    assert("…empty and null ones dropped, undefined facts dropped", !("empty" in p.untrusted) && !("none" in p.untrusted) && !("skip" in p.facts) && p.facts.n === 3 && p.facts.ok === true);
    assert("the alert text is truncated", p.alert_text.length <= 1501, String(p.alert_text.length));
    assert("fired_at is the incident time, reply_to null when unknown", p.fired_at === new Date(T0).toISOString() && p.reply_to === null);
  }
  {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ts: T0 - i,
      tool_name: "fetch_extract",
      payment_type: "tool_error",
      detail: "x".repeat(2000),
      client_name: "c",
      client: null,
      payer: "p",
    }));
    const text = buildFirePayload(INCIDENT, "alerta", 1, rows, T0);
    const p = JSON.parse(text) as FirePayload;
    assert("an oversized context is cut down, newest rows kept", text.length <= 14_000 && (p.context?.length ?? 0) < 40 && (p.context?.[0]?.ts ?? 0) === T0, `${text.length} chars, ${p.context?.length} rows`);
  }

  console.log("\ncontext");
  {
    const rows = [{ ts: T0, tool_name: "fetch_extract", payment_type: "tool_error", detail: "d".repeat(500), client_name: null, client: null, payer: "0xabc" }];
    const { db, sql, binds } = fakeDb(rows);
    const ctx = await loadIncidentContext(db, { tool: "fetch_extract", payer: "0xabc" }, T0);
    assert("one statement, bounded by a LIMIT and a time window", sql.length === 1 && /LIMIT 40/.test(sql[0] ?? "") && /ts >= \?/.test(sql[0] ?? ""), sql.join(" | "));
    assert("…over the last 2 h, for that tool and that payer", binds[0]?.[0] === T0 - 2 * HOUR && binds[0]?.[1] === "fetch_extract" && binds[0]?.[2] === "0xabc", JSON.stringify(binds));
    assert("…never connects nor internal traffic", /payment_type <> 'connect'/.test(sql[0] ?? "") && /internal = 0/.test(sql[0] ?? ""));
    assert("row details are truncated", (ctx?.[0]?.detail ?? "").length <= 141, String(ctx?.[0]?.detail?.length));
  }
  {
    const { db, binds } = fakeDb([]);
    await loadIncidentContext(db, { tool: "fetch_extract", payer: "anon" }, T0);
    assert("the shared 'anon' payer is not looked up", binds[0]?.[2] === "", JSON.stringify(binds));
    const none = fakeDb([]);
    const ctx = await loadIncidentContext(none.db, {}, T0);
    assert("no tool and no payer: no query", ctx === null && none.sql.length === 0);
    assert("no database: no context", (await loadIncidentContext(undefined, { tool: "t" }, T0)) === null);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const out = await fireAgent(env({ PREPAID_DB: fakeDb("throw").db }), INCIDENT, "alerta", 5, T0);
    assert("D1 failing leaves the context null and still fires", out === "fired" && payloadOf(net.fires[0]).context === null, out);
  }
  {
    resetAgentState();
    const net = fakeNet();
    const rows = [{ ts: T0, tool_name: "fetch_extract", payment_type: "tool_error", detail: "boom", client_name: null, client: null, payer: "0xabc" }];
    await fireAgent(env({ PREPAID_DB: fakeDb(rows).db }), INCIDENT, "alerta", 5, T0);
    assert("the context rides in the payload", payloadOf(net.fires[0]).context?.[0]?.detail === "boom");
  }

  console.log("\nverdict");
  const GOOD = { reply_to: 9001, verdict: "ruido", confidence: "alta", summary: "Barrido de catálogo de un escáner.", proposed_action: "Nada.", session_url: "https://claude.ai/code/session_01ABC" };
  {
    resetAgentState();
    const net = fakeNet();
    const res = await handleAgentVerdict(verdictRequest(GOOD), env({ ALERT_AGENT_TOKEN: undefined }));
    assert("404 when the verdict token is not configured", res.status === 404 && net.tg.length === 0, String(res.status));
  }
  for (const [label, token] of [["no bearer", null], ["a wrong bearer", "nope"], ["a prefix of the bearer", "verdict-toke"], ["the bearer plus a suffix", "verdict-tokenX"]] as const) {
    resetAgentState();
    const net = fakeNet();
    const res = await handleAgentVerdict(verdictRequest(GOOD, token), env());
    assert(`401 with ${label}`, res.status === 401 && net.tg.length === 0, String(res.status));
  }
  {
    resetAgentState();
    const net = fakeNet();
    const res = await handleAgentVerdict(verdictRequest(GOOD), env());
    const sent = net.tg[0]?.body;
    assert("a valid verdict is posted", res.status === 200 && net.tg.length === 1, String(res.status));
    assert("…as plain text, never Markdown", sent !== undefined && !("parse_mode" in sent), JSON.stringify(sent));
    assert("…threaded under the alert, sent even if the alert is gone", JSON.stringify(sent?.reply_parameters) === JSON.stringify({ message_id: 9001, allow_sending_without_reply: true }), JSON.stringify(sent?.reply_parameters));
    assert("…saying it is shadow triage, the verdict and the confidence", String(sent?.text).startsWith("🤖 Triaje en sombra: RUIDO (confianza alta)\n"), String(sent?.text));
    assert("…with the summary, the proposed action and the session link", String(sent?.text).includes("Barrido de catálogo") && String(sent?.text).includes("Haría: Nada.") && String(sent?.text).endsWith("https://claude.ai/code/session_01ABC"), String(sent?.text));
  }
  {
    const v = parseVerdict({ verdict: "real", summary: "Mira https://evil.example/x y http://otro.example *ya*\n\n[clic](tg://resolve)", session_url: "https://claude.ai.evil.example/code/x" });
    const text = typeof v === "string" ? v : formatVerdict(v);
    assert("links in the agent's words are defanged", !/https?:\/\//.test(text) && !/tg:\/\//.test(text) && text.includes("https[:]//evil.example"), text);
    assert("a session URL that is not claude.ai/code is dropped", typeof v !== "string" && v.session_url === null, text);
    assert("the summary is flattened to one line", text.split("\n").length === 2, text);
  }
  {
    const v = parseVerdict({ verdict: "dudoso", summary: "s".repeat(5000), proposed_action: "p".repeat(5000) });
    const text = typeof v === "string" ? v : formatVerdict(v);
    assert("long fields are truncated", text.length < 1600, String(text.length));
  }
  for (const [label, body] of [
    ["an unknown verdict", { ...GOOD, verdict: "arreglado" }],
    ["no summary", { ...GOOD, summary: "  " }],
    ["a reply_to that is not a message id", { ...GOOD, reply_to: "9001" }],
    ["a negative reply_to", { ...GOOD, reply_to: -1 }],
    ["an array", [GOOD]],
    ["a string that is not JSON", "not json"],
  ] as const) {
    resetAgentState();
    const net = fakeNet();
    const res = await handleAgentVerdict(verdictRequest(body), env());
    assert(`400 for ${label}`, res.status === 400 && net.tg.length === 0, String(res.status));
  }
  {
    resetAgentState();
    const net = fakeNet();
    const res = await handleAgentVerdict(verdictRequest({ ...GOOD, summary: "x".repeat(9000) }), env());
    assert("413 for an oversized body", res.status === 413 && net.tg.length === 0, String(res.status));
  }
  {
    resetAgentState();
    const net = fakeNet();
    const res = await handleAgentVerdict(verdictRequest({ verdict: "humano", summary: "Saldo del relayer." }), env());
    assert("reply_to, confidence, action and link are optional", res.status === 200 && net.tg[0]?.body.text === "🤖 Triaje en sombra: DECISIÓN TUYA\nSaldo del relayer." && !("reply_parameters" in (net.tg[0]?.body ?? {})), JSON.stringify(net.tg[0]?.body));
  }
  {
    resetAgentState();
    fakeNet({ telegram: 500 });
    const res = await handleAgentVerdict(verdictRequest(GOOD), env());
    assert("502 when Telegram refuses the verdict", res.status === 502, String(res.status));
  }
  {
    resetAgentState();
    const net = fakeNet();
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await handleAgentVerdict(verdictRequest(GOOD), env(), T0 + i)).status;
    assert("at most 20 verdicts per hour reach the pager", last === 429 && net.tg.length === 20, `${last}, ${net.tg.length} sent`);
    const next = await handleAgentVerdict(verdictRequest(GOOD), env(), T0 + HOUR + 100);
    assert("…and the cap lifts the next hour", next.status === 200, String(next.status));
  }

  console.log("\nrouting");
  {
    // run_worker_first is a list: a path it does not cover is answered by the
    // asset router (405 for a POST) and never reaches the Worker. The first
    // deploy of the agent shipped exactly that.
    const wr = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const list = /"run_worker_first":\s*\[([\s\S]*?)\]/.exec(wr)?.[1] ?? "";
    assert("run_worker_first covers /alerts/* (the verdict endpoint)", list.includes('"/alerts/*"'));
  }
} finally {
  globalThis.fetch = realFetch;
  console.warn = warn;
  console.log = log;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
