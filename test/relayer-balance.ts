/**
 * A16 — relayer balance check (src/alerts/relayer-balance.ts): reads ETH
 * balance + Chainlink ETH/USD through the RPC, pages Telegram below $5 or
 * above $50, once per status per 24h, and the opportunistic variant never
 * throws and runs at most hourly. Only the network is mocked (global fetch).
 *
 * Run: npx tsx test/relayer-balance.ts
 */
import { USDC_ADDRESS } from "../src/x402/middleware.js";
import {
  checkRelayerBalance,
  classifyRelayer,
  maybeCheckRelayerBalance,
  readRelayerBalance,
  resetRelayerBalanceThrottle,
  CHAINLINK_ETH_USD_BASE,
} from "../src/alerts/relayer-balance.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

const RPC = "https://rpc.test.invalid/";
const RELAYER = "0xd5F96b537A05f196091502bCde038C572f88efba";
let balanceWei = 0n;
let ethUsd = 2500;
let usdcMicro = 0n;
let rpcDown = false;
const telegram: string[] = [];
const rpcMethods: string[] = [];

const word = (n: bigint) => n.toString(16).padStart(64, "0");

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.telegram.org/")) {
    telegram.push(JSON.parse(String(init?.body)).text);
    return new Response('{"ok":true}');
  }
  if (url !== RPC) throw new Error(`unexpected fetch ${url}`);
  if (rpcDown) return new Response("bad gateway", { status: 502 });
  const body = JSON.parse(String(init?.body));
  const reqs = Array.isArray(body) ? body : [body];
  const answers = reqs.map((r: { id: number; method: string; params: Array<{ to?: string }> }) => {
    rpcMethods.push(r.method);
    if (r.method === "eth_getBalance") return { jsonrpc: "2.0", id: r.id, result: "0x" + balanceWei.toString(16) };
    if (r.method === "eth_call" && r.params[0].to?.toLowerCase() === CHAINLINK_ETH_USD_BASE.toLowerCase()) {
      const answer = BigInt(Math.round(ethUsd * 1e8));
      return { jsonrpc: "2.0", id: r.id, result: "0x" + [1n, answer, 0n, 0n, 1n].map(word).join("") };
    }
    if (r.method === "eth_call" && r.params[0].to?.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
      return { jsonrpc: "2.0", id: r.id, result: "0x" + word(usdcMicro) };
    }
    return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unmocked ${r.method}` } };
  });
  return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const env = { BASE_RPC_URL: RPC, RELAYER_ADDRESS: RELAYER, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };
const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

console.log("\nclassification");
assert(classifyRelayer(4.99, 30) === "low", "$4.99 of gas is low, whatever the USDC");
assert(classifyRelayer(5, 5) === "ok" && classifyRelayer(50, 50) === "ok", "$5 and $50 are inside the range");
assert(classifyRelayer(30, 50.01) === "above_cap", "$30 ETH + $20.01 USDC is above the cap");

console.log("\nread");
balanceWei = eth(0.01);
usdcMicro = 480_000n;
const b = await readRelayerBalance(env);
assert(Math.abs(b.usd - 25) < 1e-9 && b.eth === "0.01" && b.status === "ok", "0.01 ETH at $2500 reads as $25, ok");
assert(b.usdc === 0.48 && Math.abs(b.totalUsd - 25.48) < 1e-9, "USDC counts toward the exposure total");
assert(rpcMethods.includes("eth_getBalance") && rpcMethods.includes("eth_call"), "reads the balance and the Chainlink feed");
assert(!rpcMethods.some((m) => m.startsWith("eth_send") || m === "eth_sign"), "never sends or signs anything");

console.log("\nalerts");
resetRelayerBalanceThrottle();
const t0 = Date.parse("2026-10-30T10:00:00Z");
let r = await checkRelayerBalance(env, t0);
assert(!r.alerted && telegram.length === 0, "inside the range: no page");

balanceWei = eth(0.001); // $2.50
r = await checkRelayerBalance(env, t0);
assert(r.status === "low" && r.alerted && telegram.length === 1, "below $5: one page");
assert(/poco gas/.test(telegram[0]) && telegram[0].includes(RELAYER) && telegram[0].includes("$2.50"), "page names the wallet and the amount");
r = await checkRelayerBalance(env, t0 + 60 * 60 * 1000);
assert(r.status === "low" && !r.alerted && telegram.length === 1, "same status an hour later: no second page");
r = await checkRelayerBalance(env, t0 + 25 * 60 * 60 * 1000);
assert(r.alerted && telegram.length === 2, "still low 25h later: pages again");

balanceWei = eth(0.012); // $30 of gas + $25 USDC
usdcMicro = 25_000_000n;
r = await checkRelayerBalance(env, t0 + 25 * 60 * 60 * 1000);
assert(r.status === "above_cap" && r.alerted && /tope/.test(telegram[2] ?? ""), "ETH + USDC above $50: its own page");
usdcMicro = 0n;

console.log("\nopportunistic check");
resetRelayerBalanceThrottle();
telegram.length = 0;
balanceWei = eth(0.001);
rpcMethods.length = 0;
await maybeCheckRelayerBalance(env, t0);
assert(telegram.length === 1, "first call after a settlement checks and pages");
rpcMethods.length = 0;
await maybeCheckRelayerBalance(env, t0 + 10 * 60 * 1000);
assert(rpcMethods.length === 0, "a second settlement within the hour does not even read");

resetRelayerBalanceThrottle();
rpcDown = true;
let threw = false;
try {
  await maybeCheckRelayerBalance(env, t0);
  await maybeCheckRelayerBalance({ ...env, RELAYER_ADDRESS: undefined }, t0 + 2 * 60 * 60 * 1000);
} catch {
  threw = true;
}
assert(!threw, "RPC down or address missing: the opportunistic check never throws");
let err: Error | null = null;
try {
  await checkRelayerBalance(env, t0);
} catch (e) {
  err = e as Error;
}
assert(err !== null, "...while the explicit check (the /reports route) does surface the error");

console.log(failures === 0 ? "\nAll relayer balance checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
