/**
 * Tests for opt-in Ed25519 delivery receipts on the x402 HTTP door
 * (src/x402/http-door.ts + /.well-known/x402-keys.json in src/index.ts).
 *
 * Verifies:
 *   1. Unconfigured PAXIOM_PRIVATE_KEY_PEM is a strict no-op (no receipt headers,
 *      /.well-known/x402-keys.json returns 404).
 *   2. Configured PAXIOM_PRIVATE_KEY_PEM publishes /.well-known/x402-keys.json and
 *      signs settled 200 responses with Payment-Receipt + X-Paxiom-Receipt headers
 *      verifiable offline via @paxiom/receipts/web (pure WebCrypto, zero Buffer).
 *   3. Tampered output or wrong signer key fails verification deterministically.
 *   4. A malformed PAXIOM_PRIVATE_KEY_PEM degrades gracefully without failing an
 *      already-settled tool call.
 *
 * Run:  npx tsx test/x402-paxiom-receipts.ts
 */
import "./_support/text-modules.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress, type Address } from "viem";
import {
  generateReceiptKeyPair,
  discoverIssuerKeys,
  verifyResponseReceipt,
} from "@paxiom/receipts/web";
import type { Env } from "../src/index.js";
import {
  handleX402HttpTool,
  buildWellKnownX402Keys,
  X402_EXPOSE_HEADERS,
} from "../src/x402/http-door.js";

const { default: workerHandler } = await import("../src/index.js");
import {
  getToolPrice,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
} from "../src/x402/middleware.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

const PAY_TO: Address = "0xd5F96b537A05f196091502bCde038C572f88efba";
const RELAYER_PK = generatePrivateKey();
const TOOL = "csv_query_xl";
const DATA_URL = "https://example.com/sample.csv";
const RPC_URL = "https://rpc.test.invalid/";
const TX_HASH = ("0x" + "cd".repeat(32)).toLowerCase();

function rpcResult(method: string): unknown {
  switch (method) {
    case "eth_call":
      return "0x" + (10n ** 12n).toString(16).padStart(64, "0");
    case "eth_chainId":
      return "0x2105";
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_estimateGas":
      return "0x186a0";
    case "eth_maxPriorityFeePerGas":
      return "0x1";
    case "eth_gasPrice":
      return "0x2";
    case "eth_getBlockByNumber":
      return {
        number: "0x1",
        baseFeePerGas: "0x1",
        hash: "0x" + "11".repeat(32),
        timestamp: "0x1",
      };
    case "eth_sendRawTransaction":
      return TX_HASH;
    default:
      throw new Error(`unmocked RPC ${method}`);
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as RequestInfo, init);
  if (req.url === RPC_URL) {
    const body = JSON.parse(await req.text());
    const one = (m: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: m.id,
      result: rpcResult(m.method),
    });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), {
      headers: { "content-type": "application/json" },
    });
  }
  if (req.url === DATA_URL) {
    return new Response("name,score\nalice,10\nbob,20\n", {
      headers: { "content-type": "text/csv" },
    });
  }
  throw new Error(`unmocked fetch ${req.url}`);
}) as typeof fetch;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
    X402_PAY_TO_ADDRESS: PAY_TO,
    RELAYER_PRIVATE_KEY: RELAYER_PK,
    X402_SETTLER: "relayer",
    X402_NETWORK: "eip155:8453",
    X402_PRICE_USDC: "0.02",
    X402_PREPAID_PRICE_USDC: "0.01",
    X402_MIN_DEPOSIT_USDC: "0.50",
    BASE_RPC_URL: RPC_URL,
    R2_PUBLIC_URL: "https://cdn.test.invalid",
    X402_NONCES: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    },
    ABUSE_RL: { limit: async () => ({ success: true }) },
    FREE_FETCH_RL: { limit: async () => ({ success: true }) },
    PREPAID_DB: {
      prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }),
    },
    ...overrides,
  } as unknown as Env;
}

const ctx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function buildSignedPaymentHeader(nonceByte: string): Promise<{ header: string; payer: Address }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const value = getToolPrice(TOOL, {}).payPerCallMicro;
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(PAY_TO),
    value,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 300),
    nonce: `0x${nonceByte.repeat(32)}` as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: 8453,
      verifyingContract: USDC_ADDRESS,
    },
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
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: value.toString(),
      asset: USDC_ADDRESS,
      payTo: PAY_TO,
    },
    payload: {
      signature,
      authorization: Object.fromEntries(
        Object.entries(authorization).map(([k, v]) => [k, String(v)])
      ),
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { header: btoa(bin), payer: account.address };
}

console.log("CORS header exposure");
{
  assert(
    X402_EXPOSE_HEADERS.includes("Payment-Receipt") &&
      X402_EXPOSE_HEADERS.includes("X-Paxiom-Receipt"),
    "X402_EXPOSE_HEADERS exposes Payment-Receipt and X-Paxiom-Receipt"
  );
}

console.log("Unconfigured PAXIOM_PRIVATE_KEY_PEM (strict no-op)");
{
  const env = makeEnv();
  assert((await buildWellKnownX402Keys(env)) === null, "buildWellKnownX402Keys returns null when unset");

  const wkResp = await workerHandler.fetch(
    new Request("https://mcp.toolsnap.app/.well-known/x402-keys.json"),
    env,
    ctx
  );
  assert(wkResp.status === 404, "GET /.well-known/x402-keys.json -> 404 when unset");

  const { header } = await buildSignedPaymentHeader("11");
  const paidResp = await handleX402HttpTool(
    new Request(`https://mcp.toolsnap.app/x402/tools/${TOOL}`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": header },
      body: JSON.stringify({ url: DATA_URL, limit: 2 }),
    }),
    env,
    ctx
  );
  assert(paidResp.status === 200, "settled call -> 200 without receipt secret");
  assert(!paidResp.headers.has("Payment-Receipt"), "no Payment-Receipt header when unset");
}

console.log("Configured PAXIOM_PRIVATE_KEY_PEM: discovery + signed Payment-Receipt");
{
  const kp = await generateReceiptKeyPair({ keyId: "toolsnap-test-k1" });
  const otherKp = await generateReceiptKeyPair({ keyId: "other-k1" });
  const env = makeEnv({
    PAXIOM_PRIVATE_KEY_PEM: kp.privateKeyPem,
    PAXIOM_KEY_ID: kp.keyId,
  });

  const disc = await discoverIssuerKeys(`https://mcp.toolsnap.app/x402/tools/${TOOL}`, {
    fetch: (input, init) => workerHandler.fetch(new Request(input as RequestInfo, init), env, ctx),
  });
  assert(disc.ok && disc.publicKeys[0] === kp.publicKey, "/.well-known/x402-keys.json publishes Ed25519 key");
  assert(disc.payTo === PAY_TO, "/.well-known/x402-keys.json binds X402_PAY_TO_ADDRESS");

  const { header, payer } = await buildSignedPaymentHeader("22");
  const paidResp = await workerHandler.fetch(
    new Request(`https://mcp.toolsnap.app/x402/tools/${TOOL}`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": header },
      body: JSON.stringify({ url: DATA_URL, limit: 2 }),
    }),
    env,
    ctx
  );
  assert(paidResp.status === 200, "settled call -> 200 with receipt secret");
  assert(paidResp.headers.has("PAYMENT-RESPONSE"), "PAYMENT-RESPONSE header preserved");
  assert(
    Boolean(paidResp.headers.get("Payment-Receipt")) &&
      paidResp.headers.get("Payment-Receipt") === paidResp.headers.get("X-Paxiom-Receipt"),
    "emits matching Payment-Receipt and X-Paxiom-Receipt headers"
  );

  const delivered = (await paidResp.clone().json()) as Record<string, unknown>;
  const verified = await verifyResponseReceipt(paidResp, {
    output: delivered,
    expectedIssuerPublicKeys: disc.publicKeys,
    expectedPayTo: PAY_TO,
  });
  assert(
    verified.present &&
      verified.trustState === "settlement_claimed_not_checked" &&
      verified.checks?.signature === "pass" &&
      verified.checks?.issuerAuthorization === "pass" &&
      verified.checks?.outputHash === "pass",
    "receipt verifies offline (signature, key pinning, payTo, and JCS output hash)"
  );
  assert(
    verified.receipt?.payload.payment.settlement.transactionHash === TX_HASH &&
      verified.receipt?.payload.payment.payer === payer &&
      verified.receipt?.payload.payment.amountAtomic === "20000",
    "receipt binds settlement txHash, payer, and atomic USDC amount"
  );

  const tampered = await verifyResponseReceipt(paidResp, {
    output: { ...delivered, tampered: true },
    expectedIssuerPublicKeys: disc.publicKeys,
  });
  assert(tampered.trustState === "output_hash_mismatch", "tampered output -> output_hash_mismatch");

  const wrongSigner = await verifyResponseReceipt(paidResp, {
    output: delivered,
    expectedIssuerPublicKeys: [otherKp.publicKey],
  });
  assert(wrongSigner.trustState === "unauthorized_issuer", "unpinned signer -> unauthorized_issuer");
}

console.log("Malformed PAXIOM_PRIVATE_KEY_PEM degrades gracefully");
{
  const env = makeEnv({ PAXIOM_PRIVATE_KEY_PEM: "not-a-valid-pem" });
  const { header } = await buildSignedPaymentHeader("33");
  const paidResp = await handleX402HttpTool(
    new Request(`https://mcp.toolsnap.app/x402/tools/${TOOL}`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": header },
      body: JSON.stringify({ url: DATA_URL, limit: 1 }),
    }),
    env,
    ctx
  );
  assert(paidResp.status === 200, "malformed receipt key never breaks an already-settled tool call");
  assert(!paidResp.headers.has("Payment-Receipt"), "malformed receipt key omits receipt header cleanly");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll x402 Paxiom receipt tests passed.");
