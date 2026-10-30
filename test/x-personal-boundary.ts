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
 * Only the network is mocked (global fetch). Run: npx tsx test/x-personal-boundary.ts
 */
import "./_support/cloudflare-workers.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  publishTweet,
  repostTweet,
  uploadMedia,
  XApiError,
  type XAgentEnv,
  type XPersonalService,
} from "../src/x-agent/client.js";

const { XPersonal, default: xPersonalWorker, ...otherExports } = await import("../workers/x-personal/src/index.js");

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
assert(!("services" in xpCfg), "x-personal binds to nothing else");

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

assert(Object.keys(otherExports).length === 0, "the module exports only XPersonal and the default handler");

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
const xp = new XPersonal(ctx, personalEnv);

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

console.log(failures === 0 ? "\nAll x-personal boundary checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
