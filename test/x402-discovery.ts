/**
 * Tests for x402 discovery (src/x402/discovery.ts, src/x402/http-door.ts):
 * bazaar declarations, the HTTP door onto the payment gate, and the
 * /.well-known/x402 + /openapi.json fan-out documents.
 * No live server, no RPC: every payment case here is rejected by
 * verifyPayment before it would touch the chain.
 *
 * Run:  npx tsx test/x402-discovery.ts
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress, type Address } from "viem";
import {
  bazaarMcpExtension,
  bazaarHttpExtension,
  buildWellKnownX402,
  buildOpenApi,
  paidToolDefinitions,
  resourceDescription,
  resourceMetadata,
  httpResourceUrl,
  SERVICE_METADATA,
} from "../src/x402/discovery.js";
import { handleX402HttpTool } from "../src/x402/http-door.js";
import { dispatch } from "../src/mcp/server.js";
import {
  getToolPrice,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
} from "../src/x402/middleware.js";
import type { Env } from "../src/index.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

const KNOWN_PAID = [
  "screenshot_url", "fetch_rendered", "keyword_research", "remove_background",
  "csv_query_xl", "json_query_xl", "image_generate", "image_upscale",
  "audio_transcribe", "text_to_speech", "video_generate",
];
const PAY_TO: Address = "0xd5F96b537A05f196091502bCde038C572f88efba";
const printableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

const env = {
  X402_PAY_TO_ADDRESS: PAY_TO,
  X402_NETWORK: "eip155:8453",
  X402_PRICE_USDC: "0.02",
  X402_PREPAID_PRICE_USDC: "0.01",
  BASE_RPC_URL: "http://127.0.0.1:1", // never reached: every payment below fails before the RPC
  ANALYTICS_HASH_SALT: "test-salt",
  X402_NONCES: {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  },
  ABUSE_RL: { limit: async () => ({ success: true }) },
  FREE_FETCH_RL: { limit: async () => ({ success: true }) },
  PREPAID_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) },
} as unknown as Env;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException() {} } as unknown as ExecutionContext;

function decodeHeader(v: string | null): unknown {
  return v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : null;
}

// ---------------------------------------------------------------------------
console.log("Listing metadata");
{
  const names = paidToolDefinitions().map((d) => d.name).sort();
  assert(JSON.stringify(names) === JSON.stringify([...KNOWN_PAID].sort()), "paidToolDefinitions() == the 11 known paid tools");
  assert(SERVICE_METADATA.serviceName.length <= 32 && printableAscii(SERVICE_METADATA.serviceName), "serviceName <= 32 printable ASCII");
  assert(SERVICE_METADATA.iconUrl.startsWith("https://"), "iconUrl is absolute https");
  for (const name of KNOWN_PAID) {
    const meta = resourceMetadata(name) as { tags?: string[] };
    const tags = meta.tags ?? [];
    assert(tags.length >= 1 && tags.length <= 5 && tags.every((t) => t.length <= 32 && printableAscii(t)), `${name}: 1-5 valid tags`);
    const desc = resourceDescription(name, getToolPrice(name, env).payPerCallStr);
    assert(desc.length <= 500, `${name}: description <= 500 chars`);
    // The listing copy must describe, not instruct: the Bazaar screens it.
    assert(!/\b(call|you must|ignore|instruction)/i.test(desc.replace(/per call/g, "")), `${name}: description has no agent-directed wording`);
  }
}

console.log("Bazaar declarations");
for (const def of paidToolDefinitions()) {
  const name = def.name;
  const mcp = bazaarMcpExtension(name) as {
    info: { input: Record<string, unknown> };
    schema: { properties: { input: { properties: Record<string, unknown>; required: string[] } } };
  };
  const input = mcp.info.input;
  const allowed = Object.keys(mcp.schema.properties.input.properties);
  assert(input.type === "mcp" && input.toolName === name, `${name}: MCP input type/toolName`);
  assert(Object.keys(input).every((k) => allowed.includes(k)), `${name}: MCP info.input has no keys outside the schema (additionalProperties:false)`);
  assert(mcp.schema.properties.input.required.every((k) => k in input), `${name}: MCP required keys present`);

  const example = input.example as Record<string, unknown>;
  const required = (def.inputSchema as { required?: string[] }).required ?? [];
  assert(required.every((k) => k in example), `${name}: example carries every required arg`);
  // The Bazaar crawler calls the tool with this example and must get a 402,
  // so the gate has to be able to price it (dynamic pricers throw otherwise).
  let priced = true;
  try {
    getToolPrice(name, env, example);
  } catch {
    priced = false;
  }
  assert(priced, `${name}: example args are priceable by the gate`);

  const http = bazaarHttpExtension(name) as { info: { input: Record<string, unknown> }; schema: { properties: { input: { properties: { body: unknown } } } } };
  assert(
    http.info.input.type === "http" && http.info.input.method === "POST" && http.info.input.bodyType === "json",
    `${name}: HTTP input is POST/json`
  );
  assert(http.schema.properties.input.properties.body === def.inputSchema, `${name}: HTTP body schema is the tool's inputSchema`);
  assert(!JSON.stringify(def.inputSchema).includes('"$ref"'), `${name}: inputSchema has no $ref (Bazaar rejects external refs)`);
}

// ---------------------------------------------------------------------------
console.log("HTTP door: challenge");
function req(name: string, opts: { method?: string; body?: string; payment?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.payment) headers["payment-signature"] = opts.payment;
  const method = opts.method ?? "POST";
  return new Request(`https://mcp.toolsnap.app/x402/tools/${name}`, {
    method,
    headers,
    body: method === "GET" ? undefined : opts.body ?? "",
  });
}
{
  for (const name of KNOWN_PAID) {
    const r = await handleX402HttpTool(req(name), env, ctx);
    const body = (await r.json()) as Record<string, any>;
    const header = decodeHeader(r.headers.get("PAYMENT-REQUIRED"));
    assert(r.status === 402, `${name}: empty POST -> 402 (probe reaches the challenge before validation)`);
    assert(JSON.stringify(header) === JSON.stringify(body), `${name}: PAYMENT-REQUIRED header == body`);
    assert(body.x402Version === 2 && body.resource?.url === httpResourceUrl(name), `${name}: v2 with absolute https resource.url`);
    assert(body.accepts?.[0]?.amount === getToolPrice(name, env).payPerCallMicro.toString(), `${name}: amount in atomic units`);
    assert(body.accepts?.[0]?.payTo === PAY_TO && body.accepts?.[0]?.asset === USDC_ADDRESS, `${name}: payTo/asset`);
    assert(body.extensions?.bazaar?.info?.input?.type === "http", `${name}: bazaar extension present`);
  }

  let r = await handleX402HttpTool(req("screenshot_url", { method: "GET" }), env, ctx);
  assert(r.status === 402 && r.headers.has("PAYMENT-REQUIRED"), "GET probe -> 402 with header");

  // Dynamic pricing: a long text quotes above the $0.02 floor.
  const long = JSON.stringify({ text: "x".repeat(5000) });
  r = await handleX402HttpTool(req("text_to_speech", { body: long }), env, ctx);
  const tts = (await r.json()) as Record<string, any>;
  assert(
    r.status === 402 && tts.accepts[0].amount === getToolPrice("text_to_speech", env, { text: "x".repeat(5000) }).payPerCallMicro.toString(),
    "text_to_speech quotes from the body's args"
  );

  for (const n of ["fetch_extract", "account_balance", "does_not_exist", "use_tool"]) {
    r = await handleX402HttpTool(req(n), env, ctx);
    assert(r.status === 404, `${n} -> 404 (free / unknown tools are not served here)`);
  }
  r = await handleX402HttpTool(req("screenshot_url", { method: "PUT", body: "{}" }), env, ctx);
  assert(r.status === 405, "PUT -> 405");
  r = await handleX402HttpTool(req("screenshot_url", { method: "GET", payment: "e30=" }), env, ctx);
  assert(r.status === 405, "GET with a payment header -> 405 (paid calls are POST)");
  r = await handleX402HttpTool(req("screenshot_url", { body: "[1,2]", payment: "e30=" }), env, ctx);
  assert(r.status === 400, "paid call with a non-object body -> 400");
  r = await handleX402HttpTool(req("screenshot_url", { body: "{}", payment: "%%%not-base64" }), env, ctx);
  assert(r.status === 402, "undecodable PAYMENT-SIGNATURE -> 402");
}

// ---------------------------------------------------------------------------
console.log("HTTP door: payment goes through the MCP gate");
async function signedPayment(to: Address, value: bigint): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(to),
    value,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 300),
    nonce: `0x${"ab".repeat(32)}` as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION, chainId: 8453, verifyingContract: USDC_ADDRESS },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const payload = {
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:8453", amount: value.toString(), asset: USDC_ADDRESS, payTo: to },
    payload: {
      signature,
      authorization: Object.fromEntries(Object.entries(authorization).map(([k, v]) => [k, String(v)])),
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
{
  const price = getToolPrice("screenshot_url", env).payPerCallMicro;
  const wrongTo = await signedPayment("0x000000000000000000000000000000000000dEaD", price);
  let r = await handleX402HttpTool(req("screenshot_url", { body: '{"url":"https://example.com"}', payment: wrongTo }), env, ctx);
  let body = (await r.json()) as Record<string, any>;
  assert(r.status === 402 && /Wrong recipient/.test(body.error), "wrong recipient -> 402 carrying the gate's reason");
  assert(!r.headers.has("PAYMENT-RESPONSE"), "rejected payment -> no PAYMENT-RESPONSE");

  const short = await signedPayment(PAY_TO, price - 1n);
  r = await handleX402HttpTool(req("screenshot_url", { body: '{"url":"https://example.com"}', payment: short }), env, ctx);
  body = (await r.json()) as Record<string, any>;
  assert(r.status === 402 && /Insufficient payment/.test(body.error), "underpayment -> 402 Insufficient payment");
  assert(body.accepts[0].amount === price.toString(), "re-issued challenge asks for the gate's amount");
}

// ---------------------------------------------------------------------------
console.log("MCP 402 carries the bazaar declaration");
{
  const call = (meta?: Record<string, unknown>) =>
    dispatch(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "screenshot_url", arguments: { url: "https://example.com" }, ...(meta ? { _meta: meta } : {}) } },
      env, false, ctx, "test", "", false, null, null, "127.0.0.1"
    ) as Promise<Record<string, any>>;

  let r = await call();
  assert(r.error?.code === 402, "no payment -> JSON-RPC 402 (unchanged transport)");
  assert(r.error.data.extensions.bazaar?.info?.input?.type === "mcp", "no-payment 402 has extensions.bazaar (mcp)");
  assert(r.error.data.extensions.no_payment_method === true && r.error.data.extensions.next_tool === "wallet_setup", "wallet_setup hints still present");
  assert(r.error.data.resource.url === "mcp://tool/screenshot_url" && r.error.data.resource.serviceName === "ToolSnap", "resource keeps mcp:// url, gains service metadata");

  const wrongTo = JSON.parse(Buffer.from(await signedPayment("0x000000000000000000000000000000000000dEaD", 40_000n), "base64").toString());
  r = await call({ "x402/payment": wrongTo });
  assert(r.error?.code === 402 && r.error.data.extensions.bazaar?.info?.input?.toolName === "screenshot_url", "rejected-payment 402 has extensions.bazaar too");
}

// ---------------------------------------------------------------------------
console.log("Fan-out documents");
{
  const wk = buildWellKnownX402() as { version: number; resources: string[] };
  assert(wk.version === 1 && wk.resources.length === KNOWN_PAID.length, "/.well-known/x402 lists every paid tool");
  assert(wk.resources.every((u) => u.startsWith("https://mcp.toolsnap.app/x402/tools/")), "well-known resources are absolute HTTP door URLs");

  const oa = buildOpenApi(env) as Record<string, any>;
  assert(typeof oa.openapi === "string" && oa.info?.title && oa.info?.version, "OpenAPI top-level fields");
  const paths = Object.keys(oa.paths);
  assert(paths.length === KNOWN_PAID.length, "OpenAPI has one path per paid tool");
  for (const p of paths) {
    const op = oa.paths[p].post;
    const info = op["x-payment-info"];
    assert(info.protocols.includes("x402") && op.responses["402"], `${p}: x-payment-info + 402 response`);
    if (info.price.mode === "fixed") {
      assert(/^\d+(\.\d+)?$/.test(info.price.amount), `${p}: fixed price is a decimal string`);
    } else {
      assert(Number(info.price.min) > 0 && Number(info.price.max) >= Number(info.price.min), `${p}: dynamic min <= max`);
    }
  }
  assert(oa.paths["/x402/tools/video_generate"].post["x-payment-info"].price.mode === "dynamic", "fal tools are dynamic");
  assert(oa.paths["/x402/tools/screenshot_url"].post["x-payment-info"].price.amount === "0.04", "screenshot_url fixed at 0.04");
}

console.log("Routing");
{
  // Once run_worker_first is a list, unlisted paths never reach the Worker.
  const wr = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert(wr.includes('"/x402/*"') && wr.includes('"/openapi.json"') && wr.includes('"/.well-known/*"'), "run_worker_first lists /x402/*, /openapi.json, /.well-known/*");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll x402 discovery tests passed.");
