/**
 * Tests for CDP facilitator settlement (src/x402/cdp.ts + the pay-per-call
 * path in src/mcp/server.ts). Everything runs through the real dispatch()
 * gate with real EIP-712 signatures; only the network is mocked (global
 * fetch): the Base RPC, the CDP facilitator and the data file the paid tool
 * reads. No funds, no real keys: the relayer and CDP keys are generated here.
 *
 * Run:  npx tsx test/x402-cdp.ts
 */
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";
import { dispatch } from "../src/mcp/server.js";
import { handleX402HttpTool } from "../src/x402/http-door.js";
import { buildCdpRequest, cdpJwt, cdpEnabled } from "../src/x402/cdp.js";
import { getToolPrice, USDC_ADDRESS, USDC_EIP712_NAME, USDC_EIP712_VERSION } from "../src/x402/middleware.js";
import type { Env } from "../src/index.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Keys (generated, test-only)
// ---------------------------------------------------------------------------
const PAY_TO: Address = "0xd5F96b537A05f196091502bCde038C572f88efba";
const TOOL = "json_query_xl";
const PRICE = getToolPrice(TOOL, {}).payPerCallMicro;
const DATA_URL = "https://example.com/data.json";
const RPC_URL = "https://rpc.test.invalid/";
const CDP = "https://api.cdp.coinbase.com/platform/v2/x402";

// CDP Ed25519 secrets are base64(seed ‖ public key), 64 bytes.
const { privateKey: edPriv, publicKey: edPub } = generateKeyPairSync("ed25519");
const jwkPriv = edPriv.export({ format: "jwk" }) as { d: string; x: string };
const CDP_SECRET = Buffer.concat([Buffer.from(jwkPriv.d, "base64url"), Buffer.from(jwkPriv.x, "base64url")]).toString("base64");
const CDP_KEY_ID = "00000000-1111-2222-3333-444444444444";

// ---------------------------------------------------------------------------
// Network mock
// ---------------------------------------------------------------------------
type CdpReply = { status: number; body: unknown; headers?: Record<string, string> } | "throw";
const calls: { url: string; body: any; headers: Headers }[] = [];
let verifyReplies: CdpReply[] = [];
let settleReplies: CdpReply[] = [];
let rawTxSent = 0;

function rpcResult(method: string): unknown {
  switch (method) {
    case "eth_call": return "0x" + (10n ** 12n).toString(16).padStart(64, "0"); // balanceOf: 1,000,000 USDC
    case "eth_chainId": return "0x2105";
    case "eth_getTransactionCount": return "0x0";
    case "eth_estimateGas": return "0x186a0";
    case "eth_maxPriorityFeePerGas": return "0x1";
    case "eth_gasPrice": return "0x2";
    case "eth_getBlockByNumber": return { number: "0x1", baseFeePerGas: "0x1", hash: "0x" + "11".repeat(32), timestamp: "0x1" };
    case "eth_sendRawTransaction": rawTxSent++; return "0x" + "cd".repeat(32);
    default: throw new Error(`unmocked RPC ${method}`);
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as RequestInfo, init);
  const url = req.url;
  const text = req.method === "GET" ? "" : await req.text();
  const body = text ? JSON.parse(text) : null;
  calls.push({ url, body, headers: req.headers });

  if (url === RPC_URL) {
    const one = (m: { id: number; method: string }) => ({ jsonrpc: "2.0", id: m.id, result: rpcResult(m.method) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { "content-type": "application/json" } });
  }
  if (url === `${CDP}/verify` || url === `${CDP}/settle`) {
    const queue = url.endsWith("/verify") ? verifyReplies : settleReplies;
    const reply = queue.shift();
    if (!reply) throw new Error(`no CDP reply queued for ${url}`);
    if (reply === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
  }
  if (url === DATA_URL) {
    return new Response(JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }), { headers: { "content-type": "application/json" } });
  }
  throw new Error(`unmocked fetch ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const kv = new Map<string, string>();
function makeEnv(over: Partial<Record<string, unknown>> = {}): Env {
  return {
    X402_PAY_TO_ADDRESS: PAY_TO,
    X402_NETWORK: "base",
    X402_PRICE_USDC: "0.02",
    X402_PREPAID_PRICE_USDC: "0.01",
    BASE_RPC_URL: RPC_URL,
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
    ANALYTICS_HASH_SALT: "salt",
    X402_SETTLER: "cdp",
    CDP_API_KEY_ID: CDP_KEY_ID,
    CDP_API_KEY_SECRET: CDP_SECRET,
    X402_NONCES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    },
    ABUSE_RL: { limit: async () => ({ success: true }) },
    FREE_FETCH_RL: { limit: async () => ({ success: true }) },
    PREPAID_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) },
    ...over,
  } as unknown as Env;
}
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function signedPayload(value: bigint = PRICE, accepted?: Record<string, unknown>): Promise<Record<string, any>> {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const nonce = ("0x" + Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("hex")) as Hex;
  const authorization = { from: account.address, to: getAddress(PAY_TO), value, validAfter: BigInt(now - 60), validBefore: BigInt(now + 300), nonce };
  const signature = await account.signTypedData({
    domain: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION, chainId: 8453, verifyingContract: USDC_ADDRESS },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  return {
    x402Version: 2,
    accepted: accepted ?? { scheme: "exact", network: "eip155:8453", amount: PRICE.toString(), asset: USDC_ADDRESS, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION } },
    payload: { signature, authorization: Object.fromEntries(Object.entries(authorization).map(([k, v]) => [k, String(v)])) },
  };
}

async function paidCall(env: Env, payload: Record<string, unknown>): Promise<Record<string, any>> {
  return (await dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL, arguments: { url: DATA_URL, query: "$.items[*].name" }, _meta: { "x402/payment": payload } } },
    env, false, ctx, "test", "", false, null, null, "127.0.0.1"
  )) as Record<string, any>;
}

const cdpCalls = () => calls.filter((c) => c.url.startsWith(CDP));
const dataCalls = () => calls.filter((c) => c.url === DATA_URL);
function reset() {
  calls.length = 0;
  verifyReplies = [];
  settleReplies = [];
  rawTxSent = 0;
}
const VALID = { status: 200, body: { isValid: true, payer: "0xabc" } };
const TX = "0x" + "aa".repeat(32);

// ---------------------------------------------------------------------------
console.log("Config gate");
{
  assert(cdpEnabled(makeEnv()), "X402_SETTLER=cdp + both keys -> enabled");
  assert(!cdpEnabled(makeEnv({ X402_SETTLER: undefined })), "no X402_SETTLER -> relayer");
  assert(!cdpEnabled(makeEnv({ X402_SETTLER: "relayer" })), "X402_SETTLER=relayer -> relayer");
  assert(!cdpEnabled(makeEnv({ CDP_API_KEY_SECRET: undefined })), "missing secret -> relayer");
  assert(!cdpEnabled(makeEnv({ CDP_API_KEY_ID: "" })), "empty key id -> relayer");
}

console.log("JWT");
{
  const path = "/platform/v2/x402/settle";
  const jwt = await cdpJwt(CDP_KEY_ID, CDP_SECRET, "POST", path);
  const [h, c, sig] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert(header.alg === "EdDSA" && header.kid === CDP_KEY_ID && header.typ === "JWT" && /^[0-9a-f]{32}$/.test(header.nonce), "header: EdDSA, kid, typ, hex nonce");
  assert(claims.sub === CDP_KEY_ID && claims.iss === "cdp" && claims.uris?.[0] === `POST api.cdp.coinbase.com${path}`, "claims: sub, iss=cdp, uris bound to method+host+path");
  assert(claims.exp - claims.nbf === 120 && claims.iat === claims.nbf, "claims: 120 s lifetime");
  const pub = await webcrypto.subtle.importKey("jwk", edPub.export({ format: "jwk" }) as JsonWebKey, { name: "Ed25519" }, false, ["verify"]);
  const ok = await webcrypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${h}.${c}`));
  assert(ok, "signature verifies with the key's public half");
  let threw = false;
  try {
    await cdpJwt(CDP_KEY_ID, "-----BEGIN EC PRIVATE KEY-----", "POST", path);
  } catch {
    threw = true;
  }
  assert(threw, "non-Ed25519 secret throws (caller treats it as CDP unavailable)");
}

console.log("buildCdpRequest");
{
  const disc = { resource: { url: "mcp://tool/x" }, bazaar: { info: { input: { type: "mcp" } } } };
  const p = await signedPayload();
  let r = buildCdpRequest(p, PAY_TO, PRICE, disc);
  assert(r.paymentRequirements.amount === PRICE.toString() && r.paymentRequirements.payTo === PAY_TO, "requirements: our amount + payTo");
  assert((r.paymentPayload.extensions as any).bazaar === disc.bazaar && (r.paymentPayload.resource as any).url === "mcp://tool/x", "injects resource + bazaar when the buyer didn't echo them");
  assert(r.paymentPayload.payload === p.payload, "signed payload forwarded untouched");

  const evil = await signedPayload(PRICE, { scheme: "exact", network: "eip155:8453", amount: "1", asset: USDC_ADDRESS, payTo: "0x000000000000000000000000000000000000dEaD" });
  r = buildCdpRequest(evil, PAY_TO, PRICE, disc);
  assert(r.paymentRequirements.payTo === PAY_TO && r.paymentRequirements.amount === PRICE.toString(), "a mismatched `accepted` echo is replaced by our requirements");
  assert((r.paymentPayload.accepted as any).payTo === PAY_TO, "payload.accepted aligned with the requirements sent");

  const echoed = { ...p, resource: { url: "https://mcp.toolsnap.app/x402/tools/x" }, extensions: { bazaar: { mine: true } } };
  r = buildCdpRequest(echoed, PAY_TO, PRICE, disc);
  assert((r.paymentPayload.extensions as any).bazaar.mine === true && (r.paymentPayload.resource as any).url.startsWith("https://"), "keeps the buyer's echoed resource + bazaar");
}

// ---------------------------------------------------------------------------
console.log("Settle via CDP");
{
  reset();
  verifyReplies = [VALID];
  settleReplies = [{ status: 200, body: { success: true, transaction: TX, network: "eip155:8453", payer: "0xabc" }, headers: { "EXTENSION-RESPONSES": Buffer.from(JSON.stringify({ bazaar: { status: "processing" } })).toString("base64") } }];
  const p = await signedPayload();
  const r = await paidCall(makeEnv(), p);
  const meta = r.result?._meta?.["x402/payment-response"];
  assert(!r.result?.isError && /"a"/.test(r.result?.content?.[0]?.text ?? ""), "tool result returned");
  assert(meta?.success === true && meta.transaction === TX && !meta.pending, "payment-response carries CDP's tx");
  const [v, s] = cdpCalls();
  assert(v?.url.endsWith("/verify") && s?.url.endsWith("/settle") && cdpCalls().length === 2, "verify then settle, once each");
  assert(dataCalls().length === 1 && calls.indexOf(v) < calls.indexOf(dataCalls()[0]) && calls.indexOf(dataCalls()[0]) < calls.indexOf(s), "order: CDP verify -> tool -> CDP settle");
  const auth = s.headers.get("authorization") ?? "";
  const claims = JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1], "base64url").toString());
  assert(claims.uris[0] === "POST api.cdp.coinbase.com/platform/v2/x402/settle", "settle JWT bound to the settle path");
  assert(s.body.x402Version === 2 && s.body.paymentRequirements.amount === PRICE.toString() && s.body.paymentRequirements.payTo === PAY_TO, "settle body: v2 + our requirements");
  assert(s.body.paymentPayload.extensions?.bazaar?.info?.input?.toolName === TOOL, "settle payload carries extensions.bazaar (what CDP catalogs)");
  assert(s.body.paymentPayload.resource?.url === `mcp://tool/${TOOL}` && s.body.paymentPayload.resource?.serviceName === "ToolSnap", "settle payload carries the resource + service metadata");
  assert(JSON.stringify(v.body) === JSON.stringify(s.body), "verify and settle send the same body");
  assert(kv.get(p.payload.authorization.nonce.toLowerCase()) === TX, "nonce recorded in KV (anti-replay)");
  assert(rawTxSent === 0, "relayer not used");

  // Replay of the same authorization is refused before reaching CDP.
  reset();
  const replay = await paidCall(makeEnv(), p);
  assert(replay.result?.isError && /Nonce already used/.test(replay.result.structuredContent?.error ?? "") && cdpCalls().length === 0, "replay refused locally, CDP not called");
}

console.log("settlement_pending");
{
  reset();
  const pending = { status: 500, body: { success: false, errorReason: "settlement_pending", transaction: "0x" + "bb".repeat(32), network: "eip155:8453" } };
  verifyReplies = [VALID];
  settleReplies = [pending, pending];
  let r = await paidCall(makeEnv(), await signedPayload());
  let meta = r.result?._meta?.["x402/payment-response"];
  const settles = cdpCalls().filter((c) => c.url.endsWith("/settle"));
  assert(settles.length === 2 && JSON.stringify(settles[0].body) === JSON.stringify(settles[1].body), "pending -> the identical request is resent exactly once");
  assert(meta?.success === true && meta.pending === true && meta.transaction === pending.body.transaction, "still pending -> reported as submitted (pending: true), not failed");
  assert(rawTxSent === 0, "pending never falls back to the relayer");

  reset();
  verifyReplies = [VALID];
  settleReplies = [pending, { status: 200, body: { success: true, transaction: TX, network: "eip155:8453" } }];
  r = await paidCall(makeEnv(), await signedPayload());
  meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === true && meta.transaction === TX && !meta.pending, "pending then success -> settled");

  reset();
  verifyReplies = [VALID];
  settleReplies = [pending, "throw"];
  r = await paidCall(makeEnv(), await signedPayload());
  meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === false && rawTxSent === 0, "pending then unreachable -> settle_failed, no relayer (a tx is in flight)");
}

console.log("CDP verify rejects");
{
  reset();
  verifyReplies = [{ status: 400, body: { isValid: false, invalidReason: "invalid_payer", invalidMessage: "payer is sanctioned" } }];
  const r = await paidCall(makeEnv(), await signedPayload());
  assert(r.result?.isError && r.result.structuredContent?.x402Version === 2, "-> payment-required result");
  assert(/CDP verify: invalid_payer/.test(r.result.structuredContent.error), "-> carries CDP's reason");
  assert(dataCalls().length === 0, "tool NOT executed");
  assert(cdpCalls().filter((c) => c.url.endsWith("/settle")).length === 0 && rawTxSent === 0, "nothing settled");
}

console.log("Terminal settle failure");
{
  reset();
  verifyReplies = [VALID];
  settleReplies = [{ status: 400, body: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453" } }];
  const r = await paidCall(makeEnv(), await signedPayload());
  const meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === false && /insufficient_funds/.test(meta.errorReason ?? ""), "-> existing settle_failed shape with CDP's reason");
  assert(rawTxSent === 0, "terminal CDP failure does NOT fall back to the relayer");
}

console.log("CDP unreachable -> relayer");
{
  reset();
  verifyReplies = ["throw"];
  let r = await paidCall(makeEnv(), await signedPayload());
  let meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === true && rawTxSent === 1 && cdpCalls().filter((c) => c.url.endsWith("/settle")).length === 0, "verify unreachable -> relayer settles, CDP settle never called");

  reset();
  verifyReplies = [{ status: 401, body: { errorType: "unauthorized", errorMessage: "bad jwt" } }];
  r = await paidCall(makeEnv(), await signedPayload());
  meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === true && rawTxSent === 1, "verify auth error (no isValid) -> relayer");

  reset();
  verifyReplies = [VALID];
  settleReplies = ["throw"];
  r = await paidCall(makeEnv(), await signedPayload());
  meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === true && rawTxSent === 1, "settle unreachable -> relayer settles");

  reset();
  r = await paidCall(makeEnv({ CDP_API_KEY_SECRET: "bm90LWEta2V5" }), await signedPayload());
  meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === true && rawTxSent === 1 && cdpCalls().length === 0, "malformed CDP secret -> relayer (payments keep working)");
}

console.log("Relayer mode untouched");
{
  reset();
  const r = await paidCall(makeEnv({ X402_SETTLER: undefined }), await signedPayload());
  const meta = r.result?._meta?.["x402/payment-response"];
  assert(meta?.success === true && rawTxSent === 1 && cdpCalls().length === 0, "no X402_SETTLER -> relayer only, CDP never called");
}

console.log("HTTP door through CDP");
{
  reset();
  verifyReplies = [VALID];
  settleReplies = [{ status: 200, body: { success: true, transaction: TX, network: "eip155:8453" } }];
  const p = await signedPayload();
  const res = await handleX402HttpTool(
    new Request(`https://mcp.toolsnap.app/x402/tools/${TOOL}`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") },
      body: JSON.stringify({ url: DATA_URL, query: "$.items[*].name" }),
    }),
    makeEnv(),
    ctx
  );
  const settleBody = cdpCalls().find((c) => c.url.endsWith("/settle"))?.body;
  const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-RESPONSE") ?? "", "base64").toString() || "{}");
  assert(res.status === 200 && pr.transaction === TX, "200 + PAYMENT-RESPONSE with CDP's tx");
  assert(settleBody?.paymentPayload.resource?.url === `https://mcp.toolsnap.app/x402/tools/${TOOL}`, "CDP sees the HTTP resource url");
  assert(settleBody?.paymentPayload.extensions?.bazaar?.info?.input?.type === "http", "CDP sees the HTTP bazaar declaration");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll CDP settlement tests passed.");
