/**
 * x402 payment middleware for toolsnap-mcp.
 *
 * Implements real off-chain verification (EIP-712 / EIP-3009) and on-chain
 * settlement via viem on Base mainnet. Payment payload transport follows the
 * x402 v2 spec MCP transport: the PaymentPayload object is placed as-is in
 * _meta["x402/payment"] (no base64 wrapping for MCP).
 *
 * Spec reference: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 * EIP-3009 EVM scheme: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  recoverTypedDataAddress,
  getAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { usdcToMicro } from "./prepaid.js";
import { FAL_DYNAMIC_PRICERS } from "../fal/pricing.js";

// ---------------------------------------------------------------------------
// Constants – Base mainnet
// ---------------------------------------------------------------------------

/** CAIP-2 network identifier for Base mainnet. */
export const NETWORK = "eip155:8453" as const;

/** USDC contract on Base mainnet. */
export const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** USDC EIP-712 domain parameters (name + version required by EIP-3009). */
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";

/** Price: $0.02 USDC = 20 000 micro-USDC (6 decimals). */
export const PRICE_MICRO_USDC = 20_000n;
export const PRICE_MICRO_USDC_STR = "20000";

/** EIP-3009 typed-data types (from x402 EVM constants). */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Minimal ABI covering:
 *  - transferWithAuthorization (v,r,s form — safest for Base USDC)
 *  - balanceOf
 *  - authorizationState (nonce used check)
 */
const EIP3009_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    name: "authorizationState",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bindings relevant to x402 (subset of full Env). */
export interface X402Env {
  X402_PAY_TO_ADDRESS: string;
  X402_NETWORK: string;
  X402_PRICE_USDC: string;
  BASE_RPC_URL: string;
  RELAYER_PRIVATE_KEY: string;
  X402_NONCES: KVNamespace;
}

/**
 * EIP-3009 authorization parameters carried inside the x402 PaymentPayload.
 * All numeric fields are decimal strings (as per spec).
 */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // 0x-prefixed bytes32
}

/**
 * The scheme-specific payload inside PaymentPayload.payload for the EIP-3009
 * asset transfer method.
 */
export interface Eip3009Payload {
  signature: string; // 65-byte 0x-prefixed hex
  authorization: Eip3009Authorization;
}

/**
 * x402 v2 PaymentPayload as placed in _meta["x402/payment"] by the client.
 * MCP transport: plain JSON object (no base64 wrapping).
 */
export interface X402PaymentPayload {
  x402Version: number;
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
  };
  accepted: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  };
  payload: Eip3009Payload;
  extensions?: Record<string, unknown>;
}

/** Structured result from verifyPayment. */
export interface VerifyResult {
  ok: boolean;
  reason?: string;
  authorization?: Eip3009Authorization;
  signature?: string;
  payer?: string;
}

/**
 * Legacy PaymentConfig kept for buildPaymentRequiredResponse signature compat.
 * (resource is the tool name)
 */
export interface PaymentConfig {
  payToAddress: string;
  network: string;
  priceUSDC: string;
  resource: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tools that require payment before execution.
 *
 * fetch_extract and fetch_html were liberated to free in Fase 18 (2026-07-03,
 * approved decision) — they are the free flagship tools now. Only real-COGS
 * tools remain paid, PLUS the two "_xl" file-size tiers (csv_query_xl,
 * json_query_xl): near-zero marginal cost, but deliberately paid — see the
 * TOOL_PRICE_OVERRIDES comment below for why they're excluded from
 * first-call-free despite having no real COGS.
 */
const PAID_TOOLS = new Set([
  "screenshot_url",
  "fetch_rendered",
  "keyword_research",
  "remove_background",
  "csv_query_xl",
  "json_query_xl",
  // Fase 13.1 — fal.ai media resale, priced dynamically per call (see
  // DYNAMIC_PRICERS below). media_job (the free polling tool) is
  // deliberately NOT in this set.
  "image_generate",
  "image_upscale",
  "audio_transcribe",
  "text_to_speech",
  "video_generate",
]);

/** Returns true if the tool requires a payment. */
export function requiresPayment(toolName: string): boolean {
  return PAID_TOOLS.has(toolName);
}

/**
 * Per-tool price overrides (USDC decimal strings). Tools not listed use the
 * global flat price (X402_PRICE_USDC / X402_PREPAID_PRICE_USDC).
 *
 * Pure-compute tools (fetch_extract, fetch_html) have ~zero marginal cost, so
 * the flat $0.02 / $0.01 clears trivially. Tools with real COGS price ABOVE the
 * flat rate (vault rule: every paid tool must be tariffed over its resource
 * cost). screenshot_url calls an external/headless capture (~$0.003–0.009/shot)
 * + R2 storage, so each call must clear that.
 */
const TOOL_PRICE_OVERRIDES: Record<string, { payPerCall: string; prepaid: string }> = {
  screenshot_url: { payPerCall: "0.04", prepaid: "0.025" },
  // Cloudflare Browser Rendering COGS: free tier caps at 10 browser-minutes/day;
  // overage on Workers Paid runs ~$0.0001-0.0002/call (browser seconds), so the
  // flagship $0.04 price clears with wide margin. Priced same as screenshot_url
  // (also a real headless-render cost).
  fetch_rendered: { payPerCall: "0.04", prepaid: "0.025" },
  keyword_research: { payPerCall: "0.04", prepaid: "0.025" },
  remove_background: { payPerCall: "0.03", prepaid: "0.02" },
  // csv_query_xl / json_query_xl: this override matches the global flat rate
  // exactly ($0.02 / $0.01) — it exists ONLY to opt these two tools out of
  // first-call-free (see firstCallFreeEligible below), not to change their
  // price. Decision: the free csv_query/json_query already let an agent try
  // the product; a free first call on the "_xl" paid tier would hand out up
  // to 100 MB of streamed compute per throwaway wallet for nothing, which is
  // a real (if small) COGS and an abuse vector, not pure marketing.
  csv_query_xl: { payPerCall: "0.02", prepaid: "0.01" },
  json_query_xl: { payPerCall: "0.02", prepaid: "0.01" },
};

export interface ToolPrice {
  payPerCallStr: string;
  prepaidStr: string;
  payPerCallMicro: bigint;
  prepaidMicro: bigint;
}

/**
 * Registry of per-tool dynamic pricing functions (Fase 13.1) — computes a
 * ToolPrice from the tool's OWN call args instead of a fixed override. Takes
 * priority over TOOL_PRICE_OVERRIDES/the flat rate. Populated by the fal.ai
 * media tools (src/fal/pricing.ts); merge additional entries there, not here.
 *
 * Contract: called with `args: undefined` must return a representative quote
 * (never throw — used by discovery endpoints with no real call to price).
 * Called with a real args object (even {}) from the payment gate, it MUST
 * throw a clear Error if the args don't carry enough to price the call
 * safely — the gate catches that and returns an error WITHOUT charging.
 */
export const DYNAMIC_PRICERS: Record<string, (args?: Record<string, unknown>) => ToolPrice> = {
  ...FAL_DYNAMIC_PRICERS,
};

/**
 * Whether a tool is eligible for the per-wallet first-call-free hook.
 *
 * Zero-COGS tools (fetch_extract, fetch_html…) ARE eligible: a free first call
 * is pure marketing, costs us nothing. COGS tools (those with a price override,
 * e.g. screenshot_url, or a dynamic per-call pricer, e.g. image_generate) are
 * NOT: a free call is a direct loss AND an abuse vector (mint throwaway
 * wallets → drain the provider's free quota). Such tools always settle from
 * the first call.
 */
export function firstCallFreeEligible(toolName: string): boolean {
  return !(toolName in TOOL_PRICE_OVERRIDES) && !(toolName in DYNAMIC_PRICERS);
}

/**
 * Best-effort estimated COGS (USD) for a dynamically-priced tool call, for
 * analytics/margin auditing only (never used to charge). Approximated as
 * payPerCall / 2 — exact per the pricing formula (payPerCall = max(2×COGS,
 * floor)) except when the $0.02 floor overrode a smaller real COGS, in which
 * case this slightly OVERSTATES cogsUsdc (bounded by the floor/2) — the safe
 * direction for a margin audit. Returns undefined for flat-priced tools.
 */
export function estimateCogsUsdc(toolName: string, price: ToolPrice): number | undefined {
  if (!(toolName in DYNAMIC_PRICERS)) return undefined;
  return Number(price.payPerCallMicro) / 2 / 1_000_000;
}

/**
 * Resolve the effective price for a tool.
 *
 * Priority: dynamic pricer (per-call args) > static override > global flat
 * default. `args` should be the real tools/call arguments when pricing an
 * actual call (even {} if none were given) so a dynamic pricer can validate
 * them; omit it (or pass undefined) for a representative/default quote (e.g.
 * discovery endpoints listing every tool's price with no call to price).
 */
export function getToolPrice(
  toolName: string,
  env: { X402_PRICE_USDC?: string; X402_PREPAID_PRICE_USDC?: string },
  args?: Record<string, unknown>
): ToolPrice {
  const dynamicPricer = DYNAMIC_PRICERS[toolName];
  if (dynamicPricer) {
    return dynamicPricer(args);
  }
  const o = TOOL_PRICE_OVERRIDES[toolName];
  const payPerCallStr = o?.payPerCall ?? env.X402_PRICE_USDC ?? "0.02";
  const prepaidStr = o?.prepaid ?? env.X402_PREPAID_PRICE_USDC ?? "0.01";
  return {
    payPerCallStr,
    prepaidStr,
    payPerCallMicro: usdcToMicro(payPerCallStr),
    prepaidMicro: usdcToMicro(prepaidStr),
  };
}

/**
 * Check if an x402 payment payload was signed by a whitelisted wallet.
 * Only verifies the EIP-712 signature — no balance check, no settlement.
 * Returns the verified payer address (lowercase) if whitelisted, or null.
 */
export async function isWhitelistedPayer(
  paymentPayload: unknown,
  whitelistedAddresses: string[]
): Promise<string | null> {
  if (!whitelistedAddresses.length) return null;
  if (!paymentPayload || typeof paymentPayload !== "object") return null;

  const p = paymentPayload as Record<string, unknown>;
  const inner = p["payload"] as Record<string, unknown> | undefined;
  if (!inner) return null;

  const signature = inner["signature"] as string | undefined;
  const auth = inner["authorization"] as Record<string, unknown> | undefined;
  if (!signature || !auth) return null;

  const from = String(auth["from"] ?? "");
  const to = String(auth["to"] ?? "");
  const value = String(auth["value"] ?? "0");
  const validAfter = String(auth["validAfter"] ?? "0");
  const validBefore = String(auth["validBefore"] ?? "0");
  const nonce = String(auth["nonce"] ?? "");

  try {
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        chainId: 8453,
        verifyingContract: USDC_ADDRESS,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(from) as Address,
        to: getAddress(to) as Address,
        value: BigInt(value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce as Hex,
      },
      signature: signature as Hex,
    });

    const recoveredLower = recovered.toLowerCase();
    if (whitelistedAddresses.some((a) => a.toLowerCase() === recoveredLower)) {
      return recoveredLower;
    }
  } catch {
    // Invalid signature or payload — not a whitelisted payer
  }

  return null;
}

/** Split a 65-byte hex signature into { v, r, s } components. */
function splitSignature(sig: string): { v: number; r: Hex; s: Hex } {
  const clean = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (clean.length !== 130) {
    throw new Error(`Invalid signature length: expected 130 hex chars, got ${clean.length}`);
  }
  const r = `0x${clean.slice(0, 64)}` as Hex;
  const s = `0x${clean.slice(64, 128)}` as Hex;
  let v = parseInt(clean.slice(128, 130), 16);
  // Normalise Ethereum legacy v: 0 → 27, 1 → 28
  if (v < 27) v += 27;
  return { v, r, s };
}

// ---------------------------------------------------------------------------
// buildPaymentRequiredResponse
// ---------------------------------------------------------------------------

/**
 * Build a JSON-RPC error response (code 402) signalling payment is required.
 * Follows x402 v2 spec MCP transport: error.data = PaymentRequired object.
 * network is CAIP-2 "eip155:8453".
 */
export function buildPaymentRequiredResponse(
  config: PaymentConfig,
  requestId: string | number | null,
  reason?: string,
  discovery?: { description: string; resource: Record<string, unknown>; extensions: Record<string, unknown> }
): object {
  // Amount comes from the per-tool price carried in config.priceUSDC (set by the
  // dispatcher via getToolPrice), not a hardcoded flat rate.
  const amountMicro = usdcToMicro(config.priceUSDC || "0.02");
  const paymentRequired = {
    x402Version: 2,
    error: reason ?? "Payment required to use this tool",
    resource: {
      url: `mcp://tool/${config.resource}`,
      description:
        discovery?.description ?? `Pay $${config.priceUSDC} USDC on Base to call the ${config.resource} tool`,
      mimeType: "application/json",
      // x402 Bazaar service metadata (serviceName/tags/iconUrl), see discovery.ts.
      ...(discovery?.resource ?? {}),
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: amountMicro.toString(),
        asset: USDC_ADDRESS,
        payTo: config.payToAddress,
        maxTimeoutSeconds: 300,
        extra: {
          name: USDC_EIP712_NAME,
          version: USDC_EIP712_VERSION,
          assetTransferMethod: "eip3009",
        },
      },
    ],
    fiat: {
      checkout: "https://mcp.toolsnap.app/checkout",
      how: "No crypto? Buy credits with a card and get an API key — send it as an Authorization: Bearer header, or embed it in the URL as /mcp/<key> if your client can't send custom headers.",
    },
    oauth: {
      connect_url: "https://mcp.toolsnap.app/mcp/oauth",
      hint: "Prefer signing in over copying a key? Reconnect using this URL as your MCP server — your client will walk you through sign-in, no key to copy. Your credits balance is shared across OAuth and API-key connections, so switching doesn't lose anything.",
    },
    extensions: { ...(discovery?.extensions ?? {}) },
  };

  // Most MCP clients only surface error.message to the calling agent/LLM —
  // the rich hints above (fiat.how, oauth.hint, extensions.hint) live in
  // error.data, which many clients drop. Absent a specific verification
  // failure (`reason`), fold the actionable next steps into the message
  // itself so an agent doesn't have to parse error.data to find them.
  const message =
    reason ??
    `Payment required: $${config.priceUSDC} USDC on Base per call to ${config.resource}. No x402 wallet? Call the free wallet_setup tool. Prefer a card? Buy credits at https://mcp.toolsnap.app/checkout and send the API key as Authorization: Bearer. Most other tools in this catalog are free.`;

  return {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: 402,
      message,
      data: paymentRequired,
    },
  };
}

// ---------------------------------------------------------------------------
// verifyPayment — off-chain, no gas
// ---------------------------------------------------------------------------

/**
 * Verify an x402 PaymentPayload (EIP-3009 / exact scheme).
 *
 * Steps:
 *  1. Parse and validate the payload structure.
 *  2. Recover EIP-712 signer and assert it equals authorization.from.
 *  3. Assert authorization.to === env.X402_PAY_TO_ADDRESS (case-insensitive).
 *  4. Assert value >= PRICE_MICRO_USDC.
 *  5. Assert now within [validAfter, validBefore].
 *  6. Anti-replay: check nonce not already in KV.
 *  7. Balance guard: USDC balanceOf(from) >= value (via RPC).
 *
 * Does NOT write the nonce to KV (settlement does that).
 */
export async function verifyPayment(
  paymentPayload: unknown,
  config: PaymentConfig,
  env: X402Env,
  minValueMicro: bigint = PRICE_MICRO_USDC
): Promise<VerifyResult> {
  // --- 1. Parse payload ---
  if (!paymentPayload || typeof paymentPayload !== "object") {
    return { ok: false, reason: "Missing or invalid x402 payment payload" };
  }

  const p = paymentPayload as Record<string, unknown>;

  if (p["x402Version"] !== 2) {
    return { ok: false, reason: `Unsupported x402 version: ${p["x402Version"]}` };
  }

  const innerPayload = p["payload"] as Record<string, unknown> | undefined;
  if (!innerPayload || typeof innerPayload !== "object") {
    return { ok: false, reason: "Missing payload field" };
  }

  const signature = innerPayload["signature"] as string | undefined;
  if (!signature || typeof signature !== "string") {
    return { ok: false, reason: "Missing payload.signature" };
  }

  const auth = innerPayload["authorization"] as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "Missing payload.authorization" };
  }

  const authorization: Eip3009Authorization = {
    from: String(auth["from"] ?? ""),
    to: String(auth["to"] ?? ""),
    value: String(auth["value"] ?? "0"),
    validAfter: String(auth["validAfter"] ?? "0"),
    validBefore: String(auth["validBefore"] ?? "0"),
    nonce: String(auth["nonce"] ?? ""),
  };

  const { from, to, value, validAfter, validBefore, nonce } = authorization;

  if (!from || !to || !nonce) {
    return { ok: false, reason: "Incomplete authorization fields" };
  }

  // --- 2. Recover EIP-712 signer ---
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        chainId: 8453,
        verifyingContract: USDC_ADDRESS,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(from) as Address,
        to: getAddress(to) as Address,
        value: BigInt(value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce as Hex,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Signature recovery failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (recovered.toLowerCase() !== from.toLowerCase()) {
    return {
      ok: false,
      reason: `Signer mismatch: recovered ${recovered}, expected ${from}`,
    };
  }

  // --- 3. Recipient check ---
  if (to.toLowerCase() !== env.X402_PAY_TO_ADDRESS.toLowerCase()) {
    return {
      ok: false,
      reason: `Wrong recipient: got ${to}, expected ${env.X402_PAY_TO_ADDRESS}`,
    };
  }

  // --- 4. Amount check ---
  let valueBigInt: bigint;
  try {
    valueBigInt = BigInt(value);
  } catch {
    return { ok: false, reason: `Invalid authorization.value: ${value}` };
  }
  if (valueBigInt < minValueMicro) {
    return {
      ok: false,
      reason: `Insufficient payment: got ${value}, required ${minValueMicro}`,
    };
  }

  // --- 5. Time window check ---
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let validAfterBig: bigint;
  let validBeforeBig: bigint;
  try {
    validAfterBig = BigInt(validAfter);
    validBeforeBig = BigInt(validBefore);
  } catch {
    return { ok: false, reason: "Invalid validAfter/validBefore values" };
  }

  if (nowSec < validAfterBig) {
    return {
      ok: false,
      reason: `Authorization not yet valid (validAfter=${validAfter}, now=${nowSec})`,
    };
  }
  // 6-second buffer for block time (matching x402 reference impl)
  if (validBeforeBig < nowSec + 6n) {
    return {
      ok: false,
      reason: `Authorization expired or expiring too soon (validBefore=${validBefore}, now=${nowSec})`,
    };
  }

  // --- 6. Anti-replay: KV nonce check ---
  // Best-effort pre-check. The authoritative replay guard is on-chain: USDC's
  // authorizationState makes transferWithAuthorization revert for a reused
  // nonce, so a KV outage (quota exhausted, Fase 25.14 incident) must degrade
  // to "let the chain decide", never to a 500 for every paid call.
  const nonceKey = nonce.toLowerCase();
  let existingTx: string | null = null;
  try {
    existingTx = await env.X402_NONCES.get(nonceKey);
  } catch (err) {
    console.warn("x402 nonce KV read failed, relying on on-chain replay guard:", err instanceof Error ? err.message : String(err));
  }
  if (existingTx !== null) {
    return {
      ok: false,
      reason: `Nonce already used (settled in tx ${existingTx})`,
    };
  }

  // --- 7. Balance guard: RPC call ---
  try {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(env.BASE_RPC_URL),
    });

    const balance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: EIP3009_ABI,
      functionName: "balanceOf",
      args: [getAddress(from) as Address],
    });

    if ((balance as bigint) < valueBigInt) {
      return {
        ok: false,
        reason: `Insufficient USDC balance: have ${balance}, need ${valueBigInt}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Balance check RPC error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    authorization,
    signature,
    payer: from,
  };
}

// ---------------------------------------------------------------------------
// settlePayment — on-chain, uses relayer private key
// ---------------------------------------------------------------------------

/**
 * Settle an EIP-3009 payment by calling transferWithAuthorization on Base USDC.
 *
 * Uses the v,r,s form (safest/most widely supported by Base USDC).
 * Does NOT wait for the transaction receipt to keep latency low — the tx hash
 * is returned immediately after submission.
 *
 * After successful submission, the nonce is written to KV with a 7-day TTL.
 * That write is best-effort: once the tx is submitted the payer HAS paid, so
 * nothing after that point may throw (a throw here used to make the deposit
 * handler answer "not charged" and skip the credit while the USDC had moved,
 * see H11 in .claude/security-review/plan-seguridad.md). `nonceRecorded`
 * tells the caller whether the KV pre-check still covers this nonce; the
 * on-chain authorizationState covers it regardless.
 */
export interface SettlementResult {
  txHash: string;
  /** false when the KV nonce write failed (quota or outage); the payment itself succeeded. */
  nonceRecorded: boolean;
}

/**
 * Mark a settled nonce as used in KV (7-day TTL). Never throws: returns false
 * when KV refuses the write, so callers can alert instead of failing a
 * payment that already went through.
 */
export async function recordSettledNonce(
  env: Pick<X402Env, "X402_NONCES">,
  nonce: string,
  txHash: string
): Promise<boolean> {
  try {
    await env.X402_NONCES.put(nonce.toLowerCase(), txHash, {
      expirationTtl: 604_800,
    });
    return true;
  } catch (err) {
    console.warn("x402 nonce KV write failed after settlement:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function settlePayment(
  authorization: Eip3009Authorization,
  signature: string,
  env: X402Env
): Promise<SettlementResult> {
  const { from, to, value, validAfter, validBefore, nonce } = authorization;

  // Normalise the relayer key: trim whitespace and ensure 0x prefix.
  // (viem's privateKeyToAccount requires a 0x-prefixed 32-byte hex string.)
  const rawKey = env.RELAYER_PRIVATE_KEY.trim();
  const hexKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  const account = privateKeyToAccount(hexKey);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(env.BASE_RPC_URL),
  });

  const { v, r, s } = splitSignature(signature);

  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: EIP3009_ABI,
    functionName: "transferWithAuthorization",
    args: [
      getAddress(from) as Address,
      getAddress(to) as Address,
      BigInt(value),
      BigInt(validAfter),
      BigInt(validBefore),
      nonce as Hex,
      v,
      r,
      s,
    ],
  });

  // The payer has paid from here on: nothing below may throw.
  const nonceRecorded = await recordSettledNonce(env, nonce, txHash);

  return { txHash, nonceRecorded };
}
