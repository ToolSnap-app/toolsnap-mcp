/**
 * Round-trip test for x402 verifyPayment.
 *
 * Creates a real EIP-712 / EIP-3009 signature with a viem test account,
 * builds the _meta["x402/payment"] payload exactly as a real x402 client
 * would, then calls verifyPayment with:
 *   - mocked KV (nonce unused)
 *   - mocked balance (via a publicClient override)
 *
 * Settlement is NOT tested (requires real funds + RPC access) but the
 * settlePayment function typechecks successfully via the main typecheck run.
 *
 * Run with:  npx tsx test/x402-roundtrip.ts
 */

import {
  privateKeyToAccount,
  generatePrivateKey,
} from "viem/accounts";
import {
  getAddress,
  type Hex,
  type Address,
} from "viem";

import {
  verifyPayment,
  recordSettledNonce,
  getToolPrice,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  NETWORK,
  type X402Env,
  type X402PaymentPayload,
} from "../src/x402/middleware.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAY_TO: Address = "0xd5F96b537A05f196091502bCde038C572f88efba";
const CHAIN_ID = 8453;

// screenshot_url: $0.04 pay-per-call (40 000 micro-USDC) per TOOL_PRICE_OVERRIDES.
const PAID_TOOL = "screenshot_url";
const TOOL_PRICE = getToolPrice(PAID_TOOL, {});

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Mock KV (nonce not used)
// ---------------------------------------------------------------------------

function makeMockKv(usedNonces: Set<string> = new Set()): KVNamespace {
  return {
    get: async (key: string) => (usedNonces.has(key.toLowerCase()) ? "0xfaketx" : null),
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock Env — points publicClient at the real Base RPC but with a mocked
// balance check. We monkey-patch createPublicClient via a local override.
// ---------------------------------------------------------------------------

// Rather than patching viem's createPublicClient (hard in ESM), we pass a
// fake BASE_RPC_URL that points to a local mock HTTP server that returns a
// preset balanceOf result.
//
// For simplicity, this test patches the env to use a dummy RPC URL and
// intercepts at the fetch level via a global fetch override.

const REAL_FETCH = globalThis.fetch;

function mockFetchWithBalance(balanceHex: string): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    // balanceOf call: eth_call with data starting with 0x70a08231
    if (body.method === "eth_call" && typeof body.params?.[0]?.data === "string" && body.params[0].data.startsWith("0x70a08231")) {
      const result = balanceHex.padStart(66, "0x" + "0".repeat(64)).slice(-64);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" + result }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    // Fallback: real fetch for everything else (not needed in this test)
    return REAL_FETCH(input, init);
  };
}

function restoreFetch(): void {
  globalThis.fetch = REAL_FETCH;
}

// ---------------------------------------------------------------------------
// Build a valid PaymentPayload
// ---------------------------------------------------------------------------

async function buildPayload(
  fromAccount: ReturnType<typeof privateKeyToAccount>,
  override?: Partial<{
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
    tamperSig: boolean;
  }>
): Promise<X402PaymentPayload> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const to: Address = override?.to ?? PAY_TO;
  const value = override?.value ?? TOOL_PRICE.payPerCallMicro;
  const validAfter = override?.validAfter ?? now - 10n;
  const validBefore = override?.validBefore ?? now + 300n;
  const nonce = override?.nonce ?? (`0x${"ab".repeat(32)}` as Hex);

  const sig = await fromAccount.signTypedData({
    domain: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: USDC_ADDRESS,
    },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: fromAccount.address,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const signature = override?.tamperSig
    ? (`0x${"ee".repeat(65)}` as Hex)
    : sig;

  return {
    x402Version: 2,
    resource: {
      url: `mcp://tool/${PAID_TOOL}`,
      description: "Test",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: NETWORK,
      amount: TOOL_PRICE.payPerCallMicro.toString(),
      asset: USDC_ADDRESS,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        assetTransferMethod: "eip3009",
      },
    },
    payload: {
      signature,
      authorization: {
        from: fromAccount.address,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail: string): void {
  results.push({ name, passed: condition, detail });
}

async function runTests(): Promise<void> {
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  const mockEnv: X402Env = {
    X402_PAY_TO_ADDRESS: PAY_TO,
    X402_NETWORK: "base",
    X402_PRICE_USDC: "0.02",
    BASE_RPC_URL: "https://mainnet.base.org",  // will be intercepted by mockFetch
    RELAYER_PRIVATE_KEY: generatePrivateKey(),  // unused during verify
    X402_NONCES: makeMockKv(),
  };

  const config = {
    payToAddress: PAY_TO,
    network: "base",
    priceUSDC: TOOL_PRICE.payPerCallStr,
    resource: PAID_TOOL,
  };

  // -------------------------------------------------------------------------
  // Test 1: valid payload → ok: true
  // -------------------------------------------------------------------------
  {
    const payload = await buildPayload(account);
    // Mock RPC: balance = 50 000 micro-USDC (enough)
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, mockEnv, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "valid payload → ok: true",
      result.ok === true,
      result.ok ? "PASS" : `FAIL: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 2: tampered signature → ok: false
  // -------------------------------------------------------------------------
  {
    const payload = await buildPayload(account, { tamperSig: true });
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, mockEnv, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "tampered signature → ok: false",
      result.ok === false,
      result.ok ? "FAIL: expected rejection" : `PASS: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 3: wrong recipient → ok: false
  // -------------------------------------------------------------------------
  {
    const wrongTo = "0x000000000000000000000000000000000000dead" as Address;
    const payload = await buildPayload(account, { to: wrongTo });
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, mockEnv, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "wrong recipient → ok: false",
      result.ok === false,
      result.ok ? "FAIL: expected rejection" : `PASS: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: value too low → ok: false
  // -------------------------------------------------------------------------
  {
    const payload = await buildPayload(account, { value: 1000n }); // < 40 000
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, mockEnv, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "value too low → ok: false",
      result.ok === false,
      result.ok ? "FAIL: expected rejection" : `PASS: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 5: expired authorization → ok: false
  // -------------------------------------------------------------------------
  {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const payload = await buildPayload(account, {
      validAfter: now - 100n,
      validBefore: now - 10n, // already expired
    });
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, mockEnv, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "expired authorization → ok: false",
      result.ok === false,
      result.ok ? "FAIL: expected rejection" : `PASS: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 6: nonce already used → ok: false
  // -------------------------------------------------------------------------
  {
    const nonce = `0x${"cc".repeat(32)}` as Hex;
    const payload = await buildPayload(account, { nonce });
    // KV already has this nonce
    const usedKv = makeMockKv(new Set([nonce.toLowerCase()]));
    const envWithUsedNonce: X402Env = { ...mockEnv, X402_NONCES: usedKv };
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, envWithUsedNonce, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "nonce already used → ok: false",
      result.ok === false,
      result.ok ? "FAIL: expected rejection" : `PASS: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 7: insufficient balance → ok: false
  // -------------------------------------------------------------------------
  {
    const payload = await buildPayload(account);
    // Balance = 1 micro-USDC (not enough)
    const balanceHex = (1n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    const result = await verifyPayment(payload, config, mockEnv, TOOL_PRICE.payPerCallMicro);
    restoreFetch();

    assert(
      "insufficient balance → ok: false",
      result.ok === false,
      result.ok ? "FAIL: expected rejection" : `PASS: reason=${result.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 8: KV nonce read throws → verify still ok (chain is the replay guard)
  // -------------------------------------------------------------------------
  {
    const payload = await buildPayload(account);
    const brokenKv = {
      ...makeMockKv(),
      get: async () => { throw new Error("KV get() limit exceeded for the day."); },
    } as unknown as KVNamespace;
    const envBrokenKv: X402Env = { ...mockEnv, X402_NONCES: brokenKv };
    const balanceHex = (50_000n).toString(16).padStart(64, "0");
    mockFetchWithBalance(balanceHex);
    let result: Awaited<ReturnType<typeof verifyPayment>> | null = null;
    let threw = "";
    try {
      result = await verifyPayment(payload, config, envBrokenKv, TOOL_PRICE.payPerCallMicro);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    restoreFetch();

    assert(
      "KV nonce read throws → ok: true (no 500)",
      result?.ok === true,
      threw ? `FAIL: threw ${threw}` : result?.ok ? "PASS" : `FAIL: reason=${result?.reason}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 9: recordSettledNonce never throws; reports whether KV took the write
  // -------------------------------------------------------------------------
  {
    const stored = new Map<string, string>();
    const okKv = {
      ...makeMockKv(),
      put: async (k: string, v: string) => { stored.set(k, v); },
    } as unknown as KVNamespace;
    const okResult = await recordSettledNonce({ X402_NONCES: okKv }, `0x${"AB".repeat(32)}`, "0xtx1");
    assert(
      "recordSettledNonce with working KV → true, lower-cased key stored",
      okResult === true && stored.get(`0x${"ab".repeat(32)}`) === "0xtx1",
      okResult ? `PASS: stored=${[...stored.keys()].join(",")}` : "FAIL: returned false"
    );

    const deadKv = {
      ...makeMockKv(),
      put: async () => { throw new Error("KV put() limit exceeded for the day."); },
    } as unknown as KVNamespace;
    let threw = "";
    let deadResult: boolean | null = null;
    try {
      deadResult = await recordSettledNonce({ X402_NONCES: deadKv }, `0x${"cd".repeat(32)}`, "0xtx2");
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert(
      "recordSettledNonce with KV quota exhausted → false, does not throw",
      deadResult === false && threw === "",
      threw ? `FAIL: threw ${threw}` : `PASS: returned ${deadResult}`
    );
  }

  // -------------------------------------------------------------------------
  // Print results
  // -------------------------------------------------------------------------
  console.log("\n=== x402 round-trip test results ===\n");
  let passed = 0;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon}  ${r.name}`);
    console.log(`       ${r.detail}`);
    if (r.passed) passed++;
  }
  console.log(`\n  ${passed}/${results.length} tests passed\n`);

  if (passed !== results.length) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
