/**
 * A16 — the boundary between toolsnap-mcp and toolsnap-x-personal.
 *
 *  1. toolsnap-mcp's code never names the personal account's secrets, and
 *     even if they were still set on it, publishing as "personal" goes only
 *     through the X_PERSONAL binding: without it, nothing reaches the X API.
 *  2. Through the binding, results and XApiError status/retryable survive.
 *  3. toolsnap-x-personal answers 404 to every HTTP request (the only door is
 *     the XPersonal RPC entrypoint), has no public route in its wrangler
 *     config, validates what it is asked to do, and signs with the personal
 *     token.
 *
 *  4. The daily cap of 15 publications (publish + repost; uploadMedia does not
 *     count) lives in a Durable Object with SQLite: the 16th is refused with
 *     the typed error `limite-diario`, which toolsnap-mcp turns into a
 *     non-retryable XApiError; it opens again the next UTC day; the DO has no
 *     fetch and the RPC surface is pinned.
 *
 * Only the network is mocked (global fetch). Run: npx tsx test/x-personal-boundary.ts
 */
import "./_support/cloudflare-workers.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  publishTweet,
  repostTweet,
  uploadMedia,
  XApiError,
  type XAgentEnv,
  type XPersonalService,
} from "../src/x-agent/client.js";
import type { LimiterNamespace } from "../workers/x-personal/src/ops.js";

const { XPersonal, PublicationLimiter, default: xPersonalWorker, ...otherExports } = await import(
  "../workers/x-personal/src/index.js"
);
const { publish: opsPublish, repost: opsRepost, TOPE_DIARIO } = await import("../workers/x-personal/src/ops.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

const ROOT = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// fetch mock: records every call, answers like the X API.
// ---------------------------------------------------------------------------
interface Call {
  url: string;
  method: string;
  auth: string;
}
let calls: Call[] = [];
let nextStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  calls.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization") ?? "" });
  const status = nextStatus;
  const body = status === 200 ? JSON.stringify({ data: { id: "1850000000000000001" } }) : '{"title":"nope"}';
  return new Response(body, { status });
}) as typeof fetch;

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err as Error;
  }
}

// ---------------------------------------------------------------------------
// 1. Static: no personal secret in toolsnap-mcp's source; config wiring.
// ---------------------------------------------------------------------------
console.log("\n1. toolsnap-mcp source and config");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const PERSONAL_SECRETS = ["X_ACCESS_TOKEN_PERSONAL", "X_ACCESS_TOKEN_SECRET_PERSONAL", "X_USER_ID_PERSONAL"];
const offenders = walk(join(ROOT, "src")).filter((f) => {
  const text = readFileSync(f, "utf8");
  return PERSONAL_SECRETS.some((s) => text.includes(s));
});
assert(offenders.length === 0, `no file under src/ names ${PERSONAL_SECRETS.join(" / ")} (${offenders.join(", ") || "none"})`);

/** JSONC -> JSON: drops // and /* *\/ comments outside strings, then trailing commas. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const mainCfg = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
const services = (mainCfg.services ?? []) as Array<Record<string, string>>;
const binding = services.find((s) => s.binding === "X_PERSONAL");
assert(binding?.service === "toolsnap-x-personal", "toolsnap-mcp binds X_PERSONAL to toolsnap-x-personal");
assert(binding?.entrypoint === "XPersonal", "the binding targets the XPersonal RPC entrypoint, not the default fetch");

const xpCfg = parseJsonc(readFileSync(join(ROOT, "workers/x-personal/wrangler.jsonc"), "utf8"));
assert(xpCfg.name === "toolsnap-x-personal", "x-personal wrangler name is toolsnap-x-personal");
assert(xpCfg.workers_dev === false, "x-personal has no workers.dev URL");
assert(xpCfg.preview_urls === false, "x-personal has no preview URLs");
assert(!("routes" in xpCfg) && !("route" in xpCfg), "x-personal has no routes");
assert(!("services" in xpCfg), "x-personal binds to no other Worker");
const doBindings = ((xpCfg.durable_objects as { bindings?: Array<Record<string, string>> } | undefined)?.bindings ?? []);
assert(
  doBindings.length === 1 && doBindings[0].name === "LIMITE_PUBLICACIONES" && doBindings[0].class_name === "PublicationLimiter" && !("script_name" in doBindings[0]),
  "x-personal's only binding is its own PublicationLimiter Durable Object"
);
const migrations = (xpCfg.migrations ?? []) as Array<{ tag?: string; new_sqlite_classes?: string[] }>;
assert(migrations.length === 1 && migrations[0].new_sqlite_classes?.join() === "PublicationLimiter", "the DO is created with a SQLite migration");
assert(!("kv_namespaces" in xpCfg) && !("d1_databases" in xpCfg) && !("r2_buckets" in xpCfg), "x-personal has no other storage");

// ---------------------------------------------------------------------------
// 2. toolsnap-mcp's client: personal goes through the binding or nowhere.
// ---------------------------------------------------------------------------
console.log("\n2. toolsnap-mcp client");

const productEnv: XAgentEnv = {
  X_API_KEY: "consumerkey",
  X_API_SECRET: "consumersecret",
  X_ACCESS_TOKEN_PRODUCT: "producttoken",
  X_ACCESS_TOKEN_SECRET_PRODUCT: "productsecret",
  X_USER_ID_PRODUCT: "111",
};
// Leftover secrets on the main Worker (e.g. before `wrangler secret delete`):
// the client must not pick them up.
const leakyEnv = {
  ...productEnv,
  X_ACCESS_TOKEN_PERSONAL: "leakedtoken",
  X_ACCESS_TOKEN_SECRET_PERSONAL: "leakedsecret",
  X_USER_ID_PERSONAL: "222",
} as XAgentEnv;

calls = [];
let err = await rejects(publishTweet(leakyEnv, { account: "personal", text: "hola" }));
assert(/X_PERSONAL service binding/.test(err?.message ?? ""), "personal publish without binding fails with a clear error");
err = await rejects(uploadMedia(leakyEnv, "personal", new Uint8Array([1, 2, 3]), "image/png"));
assert(/X_PERSONAL service binding/.test(err?.message ?? ""), "personal media upload without binding fails");
err = await rejects(repostTweet(leakyEnv, "personal", "1849999999999999999"));
assert(/X_PERSONAL service binding/.test(err?.message ?? ""), "personal repost without binding fails");
assert(calls.length === 0, "...and none of them reached the X API with leftover personal secrets");

const seen: Array<{ op: string; args: unknown[] }> = [];
let stubAnswer: { ok: true; value: unknown } | { ok: false; message: string; status: number; retryable: boolean } = {
  ok: true,
  value: { tweetId: "1850000000000000099" },
};
const stub: XPersonalService = {
  async publish(params) {
    seen.push({ op: "publish", args: [params] });
    return stubAnswer as never;
  },
  async uploadMedia(bytes, mimeType) {
    seen.push({ op: "uploadMedia", args: [bytes, mimeType] });
    return (stubAnswer.ok ? { ok: true, value: "1860000000000000001" } : stubAnswer) as never;
  },
  async repost(target) {
    seen.push({ op: "repost", args: [target] });
    return stubAnswer as never;
  },
};
const boundEnv: XAgentEnv = { ...leakyEnv, X_PERSONAL: stub };

calls = [];
const pub = await publishTweet(boundEnv, { account: "personal", text: "hola", replyToTweetId: "1849999999999999999" });
assert(pub.tweetId === "1850000000000000099", "personal publish returns the binding's tweet id");
const sentParams = seen[0]?.args[0] as Record<string, unknown>;
assert(seen[0]?.op === "publish" && !("account" in sentParams) && sentParams.text === "hola", "binding gets the params without `account`");
const media = await uploadMedia(boundEnv, "personal", new Uint8Array([1, 2, 3]), "image/png");
assert(media === "1860000000000000001" && seen[1]?.op === "uploadMedia", "personal media upload goes through the binding");
const rp = await repostTweet(boundEnv, "personal", "1849999999999999999");
assert(rp.tweetId === "1850000000000000099" && seen[2]?.op === "repost", "personal repost goes through the binding");
assert(calls.length === 0, "toolsnap-mcp itself made no X API call for the personal account");

stubAnswer = { ok: false, message: "X API error (403): duplicate", status: 403, retryable: false };
err = await rejects(publishTweet(boundEnv, { account: "personal", text: "hola" }));
assert(err instanceof XApiError && err.status === 403 && err.retryable === false, "binding error becomes XApiError(403, not retryable)");
stubAnswer = { ok: false, message: "X API error (503)", status: 503, retryable: true };
err = await rejects(repostTweet(boundEnv, "personal", "1849999999999999999"));
assert(err instanceof XApiError && err.retryable === true, "a retryable binding error stays retryable");

calls = [];
const prod = await publishTweet(boundEnv, { account: "product", text: "hola" });
assert(prod.tweetId === "1850000000000000001" && calls.length === 1, "product publish still calls X directly");
assert(calls[0]?.auth.includes('oauth_token="producttoken"'), "...signed with the product token");
assert(!calls[0]?.auth.includes("leaked"), "...and never with a leftover personal token");

calls = [];
const dry = await publishTweet({ X_DRY_RUN: "1" }, { account: "personal", text: "hola" });
assert(dry.tweetId.startsWith("dryrun_") && calls.length === 0, "X_DRY_RUN still short-circuits personal without a binding");

// ---------------------------------------------------------------------------
// 3. toolsnap-x-personal.
// ---------------------------------------------------------------------------
console.log("\n3. toolsnap-x-personal Worker");

assert(Object.keys(otherExports).length === 0, "the module exports only XPersonal, PublicationLimiter and the default handler");

for (const req of [
  new Request("https://toolsnap-x-personal.example/"),
  new Request("https://toolsnap-x-personal.example/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer anything" },
    body: JSON.stringify({ text: "hola" }),
  }),
  new Request("https://mcp.toolsnap.app/x-api/queue", { method: "POST", headers: { "x-admin-key": "guess" } }),
]) {
  calls = [];
  const res = await xPersonalWorker.fetch(req, {}, {} as ExecutionContext);
  assert(res.status === 404 && calls.length === 0, `HTTP ${req.method} ${new URL(req.url).pathname} -> 404, no X call`);
}

const personalEnv = {
  X_API_KEY: "consumerkey",
  X_API_SECRET: "consumersecret",
  X_ACCESS_TOKEN_PERSONAL: "personaltoken",
  X_ACCESS_TOKEN_SECRET_PERSONAL: "personalsecret",
  X_USER_ID_PERSONAL: "222",
};
const ctx = {} as ExecutionContext;

// ---- the daily-cap Durable Object, on a real SQLite (node:sqlite) --------
// Same SQL the runtime runs; the namespace stub mimics idFromName/get.
function newLimiterNamespace(): { ns: LimiterNamespace; ids: string[] } {
  const db = new DatabaseSync(":memory:");
  const doCtx = {
    storage: {
      sql: {
        exec: (q: string, ...b: Array<string | number>) => {
          const rows = db.prepare(q).all(...b);
          return { toArray: () => rows as Array<Record<string, unknown>> };
        },
      },
      transactionSync: <T>(fn: () => T): T => {
        db.exec("BEGIN");
        try {
          const out = fn();
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
  const instance = new PublicationLimiter(doCtx as never, {});
  const ids: string[] = [];
  return {
    ids,
    ns: {
      idFromName: (name: string) => {
        ids.push(name);
        return name;
      },
      get: () => instance,
    },
  };
}
const limiter = newLimiterNamespace();
const xp = new XPersonal(ctx, { ...personalEnv, LIMITE_PUBLICACIONES: limiter.ns });

nextStatus = 200;
calls = [];
let r = await xp.publish({ text: "hola", quoteTweetId: "1849999999999999999" });
assert(r.ok && r.value.tweetId === "1850000000000000001", "publish returns the new tweet id");
assert(calls[0]?.url === "https://api.x.com/2/tweets" && calls[0].auth.includes('oauth_token="personaltoken"'), "...signed with the personal token");

calls = [];
r = await xp.repost("1849999999999999999");
assert(r.ok && calls[0]?.url === "https://api.x.com/2/users/222/retweets", "repost uses the personal user id");

calls = [];
const up = await xp.uploadMedia(new Uint8Array([1, 2, 3]), "image/png");
assert(up.ok && up.value === "1850000000000000001" && calls.length === 3, "uploadMedia runs INIT/APPEND/FINALIZE");

calls = [];
const bad = [
  await xp.publish({}),
  await xp.publish({ text: "hola", replyToTweetId: "../../2/users/1/following" }),
  await xp.publish({ text: "hola", mediaIds: ["1", "2", "3", "4", "5"] }),
  await xp.repost("1; DROP"),
  await xp.uploadMedia(new Uint8Array(5 * 1024 * 1024 + 1), "image/png"),
  await xp.uploadMedia(new Uint8Array([1]), "text/html"),
];
assert(bad.every((b) => !b.ok && b.status === 400 && !b.retryable), "invalid inputs are refused with 400, not retryable");
assert(calls.length === 0, "...before any X API call");

nextStatus = 403;
r = await xp.publish({ text: "hola" });
assert(!r.ok && r.status === 403 && !r.retryable, "X 403 comes back as a value: status 403, not retryable");
nextStatus = 503;
r = await xp.publish({ text: "hola" });
assert(!r.ok && r.status === 503 && r.retryable, "X 503 comes back retryable");
nextStatus = 200;

calls = [];
const unconfigured = new XPersonal(ctx, {});
r = await unconfigured.publish({ text: "hola" });
const r2 = await unconfigured.repost("1849999999999999999");
assert(!r.ok && !r2.ok && /not configured/.test(r.ok ? "" : r.message) && calls.length === 0, "without its secrets it refuses and calls nothing");

// ---------------------------------------------------------------------------
// 4. Daily cap: 15 publications per UTC day, counted in the Durable Object.
// ---------------------------------------------------------------------------
console.log("\n4. daily cap (PublicationLimiter)");

assert(TOPE_DIARIO === 15, "the cap is 15 publications a day");
{
  const lim = newLimiterNamespace();
  const env = { ...personalEnv, LIMITE_PUBLICACIONES: lim.ns };
  let clock = Date.parse("2026-11-03T10:00:00Z");
  const now = () => clock;
  const results = [];
  calls = [];
  for (let i = 0; i < 15; i++) results.push(await opsPublish(env, { text: `post ${i}` }, now));
  assert(results.every((x) => x.ok), "15 publications in a day all go through");
  assert(calls.length === 15, "...each one reaching X");

  calls = [];
  const sixteenth = await opsPublish(env, { text: "post 16" }, now);
  assert(!sixteenth.ok && sixteenth.code === "limite-diario" && sixteenth.status === 429 && !sixteenth.retryable, "the 16th fails with the typed error limite-diario, not retryable");
  assert(calls.length === 0, "...without calling X");
  const refused = await opsRepost(env, "1849999999999999999", now);
  assert(!refused.ok && refused.code === "limite-diario" && calls.length === 0, "a repost counts against the same cap");
  const mediaAtCap = await xpUploadAt(env);
  assert(mediaAtCap.ok, "uploadMedia is not counted and still works at the cap");

  clock = Date.parse("2026-11-03T23:59:59Z");
  assert(!(await opsPublish(env, { text: "late" }, now)).ok, "still capped at 23:59:59 UTC");
  clock = Date.parse("2026-11-04T00:00:00Z");
  const nextDay = await opsPublish(env, { text: "new day" }, now);
  assert(nextDay.ok, "the next UTC day publishes again");
  assert(lim.ids.every((id) => id === "global"), "every call hits the single fixed-name instance");

  // A post X refuses with a 4xx is given back (by nonce); one whose outcome is
  // unknown (network error) or that got a 5xx (a 502/504 can arrive with the
  // tweet already created) stays counted.
  const lim2 = newLimiterNamespace();
  const env2 = { ...personalEnv, LIMITE_PUBLICACIONES: lim2.ns };
  nextStatus = 403;
  for (let i = 0; i < 20; i++) await opsPublish(env2, { text: "dup" }, now);
  nextStatus = 200;
  let okCount = 0;
  for (let i = 0; i < 16; i++) if ((await opsPublish(env2, { text: `ok ${i}` }, now)).ok) okCount++;
  assert(okCount === 15, "X 4xx refusals do not eat the cap (20 refused, then 15 of 16 go through)");
  const lim2b = newLimiterNamespace();
  const env2b = { ...personalEnv, LIMITE_PUBLICACIONES: lim2b.ns };
  nextStatus = 503;
  for (let i = 0; i < 15; i++) await opsPublish(env2b, { text: "5xx" }, now);
  nextStatus = 200;
  const after5xx = await opsPublish(env2b, { text: "after 5xx" }, now);
  assert(!after5xx.ok && after5xx.code === "limite-diario", "X 5xx answers stay counted (the tweet may exist)");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const lim3 = newLimiterNamespace();
  const env3 = { ...personalEnv, LIMITE_PUBLICACIONES: lim3.ns };
  for (let i = 0; i < 15; i++) await opsPublish(env3, { text: "net" }, now);
  globalThis.fetch = realFetch;
  const afterNet = await opsPublish(env3, { text: "after" }, now);
  assert(!afterNet.ok && afterNet.code === "limite-diario", "network failures (outcome unknown) stay counted");

  // Fails closed without the binding; nothing is published.
  calls = [];
  const noDo = await opsPublish(personalEnv, { text: "x" }, now);
  assert(!noDo.ok && /daily cap/.test(noDo.ok ? "" : noDo.message) && noDo.retryable && calls.length === 0, "without the DO binding it refuses, retryable, and calls nothing");

  // 15 of 40 in a row. This does NOT test concurrency: the stub hands back the
  // instance and `reservar` is synchronous, so the calls serialise here
  // whatever the caller does. Atomicity is the DO runtime's guarantee (one call
  // at a time on a synchronous method, plus transactionSync), not this test's.
  const lim4 = newLimiterNamespace();
  const env4 = { ...personalEnv, LIMITE_PUBLICACIONES: lim4.ns };
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => opsPublish(env4, { text: `p${i}` }, now)));
  assert(burst.filter((x) => x.ok).length === 15, "15 of 40 publishes go through, in sequence");
}

async function xpUploadAt(env: typeof personalEnv) {
  const { uploadMedia: upload } = await import("../workers/x-personal/src/ops.js");
  return upload(env, new Uint8Array([1, 2, 3]), "image/png");
}

// toolsnap-mcp: the typed refusal is a non-retryable XApiError even if the
// Worker had said retryable.
stubAnswer = { ok: false, message: "x-personal: limite-diario: 15", status: 429, retryable: true, code: "limite-diario" } as never;
err = await rejects(publishTweet(boundEnv, { account: "personal", text: "hola" }));
assert(err instanceof XApiError && err.retryable === false && err.status === 429, "toolsnap-mcp turns limite-diario into a non-retryable XApiError");
stubAnswer = { ok: false, message: "X API error (429)", status: 429, retryable: true };
err = await rejects(publishTweet(boundEnv, { account: "personal", text: "hola" }));
assert(err instanceof XApiError && err.retryable === true, "a plain X 429 stays retryable");

// The DO exposes nothing by HTTP and the RPC surface is pinned.
const protoNames = (c: { prototype: object }) => Object.getOwnPropertyNames(c.prototype).sort().join();
assert(!("fetch" in PublicationLimiter.prototype) && !("alarm" in PublicationLimiter.prototype) && !("webSocketMessage" in PublicationLimiter.prototype), "PublicationLimiter has no fetch, alarm or websocket handlers");
assert(protoNames(PublicationLimiter) === "constructor,liberar,reservar", "PublicationLimiter exposes only reservar and liberar");
assert(protoNames(XPersonal) === "constructor,publish,repost,uploadMedia", "XPersonal RPC surface is exactly publish, uploadMedia, repost");
{
  const lim5 = newLimiterNamespace();
  const stub5 = lim5.ns.get(null) as unknown as { reservar(d: string, t: number): unknown };
  let bad = 0;
  for (const [d, t] of [["hoy", 15], ["2026-11-03", 0], ["2026-11-03", 1e9]] as const) {
    try {
      stub5.reservar(d, t);
    } catch {
      bad++;
    }
  }
  assert(bad === 3, "the DO rejects a malformed day or an out-of-range cap");
}

// Any Worker of the account can bind this class (script_name), so the DO is
// built to survive its two methods being called by a third party: `reservar`
// only spends quota, and `liberar` only returns a reservation by its own
// single-use nonce.
{
  const lim6 = newLimiterNamespace();
  const stub6 = lim6.ns.get(null) as unknown as {
    reservar(d: string, t: number): { ok: boolean; usadas: number; nonce?: string };
    liberar(n: string): void;
  };
  const rs = Array.from({ length: 15 }, () => stub6.reservar("2026-11-03", 15));
  assert(rs.every((x) => x.ok && x.nonce) && new Set(rs.map((x) => x.nonce)).size === 15, "each reservation gets its own nonce");
  for (let i = 0; i < 50; i++) stub6.liberar(`guess-${i}`);
  assert(!stub6.reservar("2026-11-03", 15).ok, "calling liberar with nonces it never got changes nothing");
  stub6.liberar(rs[0].nonce as string);
  stub6.liberar(rs[0].nonce as string);
  assert(stub6.reservar("2026-11-03", 15).ok && !stub6.reservar("2026-11-03", 15).ok, "a nonce gives back exactly one slot, once");
  const spam = newLimiterNamespace().ns.get(null) as unknown as typeof stub6;
  for (let i = 0; i < 15; i++) spam.reservar("2026-11-03", 15);
  assert(!spam.reservar("2026-11-03", 15).ok, "a third party calling reservar can only spend quota (and publishes nothing)");
}

console.log(failures === 0 ? "\nAll x-personal boundary checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
