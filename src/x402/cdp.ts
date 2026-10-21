/**
 * CDP facilitator client: verify + settle pay-per-call x402 payments through
 * Coinbase's hosted facilitator instead of our own relayer.
 *
 * Why: the CDP Bazaar (agentic.market and the CDP discovery API) only catalogs
 * a resource after CDP itself settles a payment whose PaymentPayload carries
 * the `bazaar` extension. CDP also pays the settlement gas (the relayer stops
 * spending ETH) and screens payers (OFAC/KYT). Pricing: first 1,000 on-chain
 * settlements a month free, then $0.001 each; verify is always free.
 *
 * Active only when X402_SETTLER = "cdp" AND both CDP_API_KEY_ID and
 * CDP_API_KEY_SECRET are set; otherwise every call keeps settling through the
 * relayer exactly as before. Our own verifyPayment still runs first (it is the
 * anti-replay and balance guard); CDP verify runs after it, before the tool.
 *
 * Money rules this file keeps:
 *  - It never moves funds itself; it only forwards the buyer's EIP-3009
 *    authorization, which can settle at most once on-chain (USDC tracks the
 *    nonce), so a fallback to the relayer can never charge twice.
 *  - `settlement_pending` is not a failure: the identical request is resent
 *    once (CDP then checks the transaction it already broadcast) and a still
 *    pending answer is reported as submitted, never retried with new data.
 *
 * API: https://docs.cdp.coinbase.com/x402/core-concepts/facilitator
 * Auth (JWT): https://docs.cdp.coinbase.com/api-reference/v2/authentication
 * Pending: https://docs.cdp.coinbase.com/x402/seller/settlement-pending
 */

import { NETWORK, USDC_ADDRESS, USDC_EIP712_NAME, USDC_EIP712_VERSION } from "./middleware.js";

export const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
export const CDP_FACILITATOR_BASE_PATH = "/platform/v2/x402";
const CDP_TIMEOUT_MS = 30_000;

export interface CdpEnv {
  X402_SETTLER?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  X402_PAY_TO_ADDRESS: string;
}

/** True when pay-per-call settlement should go through CDP. */
export function cdpEnabled(env: CdpEnv): boolean {
  return env.X402_SETTLER === "cdp" && Boolean(env.CDP_API_KEY_ID) && Boolean(env.CDP_API_KEY_SECRET);
}

// ---------------------------------------------------------------------------
// JWT (EdDSA / Ed25519), same claims as @coinbase/cdp-sdk generateJwt
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function importEd25519(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("CDP_API_KEY_SECRET is not base64 (create the key with the Ed25519 algorithm)");
  }
  if (raw.length !== 64) {
    throw new Error("CDP_API_KEY_SECRET must be a base64 Ed25519 key (64 bytes: seed + public key)");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) },
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  cachedKey = { secret, key };
  return key;
}

/** Bearer JWT for one CDP REST call (valid 120 s, bound to method + host + path). */
export async function cdpJwt(keyId: string, secret: string, method: string, path: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const claims = {
    sub: keyId,
    iss: "cdp",
    uris: [`${method} ${CDP_FACILITATOR_HOST}${path}`],
    iat: now,
    nbf: now,
    exp: now + 120,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const key = await importEd25519(secret);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface CdpRequest {
  x402Version: 2;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>;
}

/**
 * Build the verify/settle body. Requirements are the ones we advertised for
 * this call (the gate's price); the buyer's `accepted` echo is used only when
 * it agrees with them on every field the facilitator compares. Our resource
 * and bazaar declaration are added to the payload when the buyer didn't echo
 * them: they are the resource server's own declarations, outside the signed
 * authorization, and CDP only catalogs a settlement that carries them.
 */
export function buildCdpRequest(
  paymentPayload: Record<string, unknown>,
  payTo: string,
  priceMicro: bigint,
  discovery: { resource: Record<string, unknown>; bazaar: Record<string, unknown> | null }
): CdpRequest {
  const ours: Record<string, unknown> = {
    scheme: "exact",
    network: NETWORK,
    amount: priceMicro.toString(),
    asset: USDC_ADDRESS,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION, assetTransferMethod: "eip3009" },
  };
  const echo = paymentPayload.accepted as Record<string, unknown> | undefined;
  const echoMatches =
    !!echo &&
    echo.scheme === ours.scheme &&
    echo.network === ours.network &&
    echo.amount === ours.amount &&
    String(echo.asset).toLowerCase() === USDC_ADDRESS.toLowerCase() &&
    String(echo.payTo).toLowerCase() === payTo.toLowerCase();
  const requirements = echoMatches ? { ...ours, ...echo } : ours;

  const extensions = { ...((paymentPayload.extensions as Record<string, unknown> | undefined) ?? {}) };
  if (!extensions.bazaar && discovery.bazaar) extensions.bazaar = discovery.bazaar;

  return {
    x402Version: 2,
    paymentPayload: {
      ...paymentPayload,
      accepted: requirements,
      resource: paymentPayload.resource ?? discovery.resource,
      extensions,
    },
    paymentRequirements: requirements,
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

type CdpCall =
  | { ok: true; status: number; data: Record<string, unknown>; extensionResponses: Record<string, unknown> | null }
  | { ok: false; reason: string };

function decodeExtensionResponses(h: string | null): Record<string, unknown> | null {
  if (!h) return null;
  try {
    const bin = atob(h.trim());
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * POST to the facilitator. `ok: false` means CDP could not be reached or did
 * not answer with a JSON body we understand (transport-level); a JSON body is
 * returned as-is with its status, even on 4xx/5xx, for the caller to read.
 */
async function postCdp(env: CdpEnv, op: "verify" | "settle", body: CdpRequest): Promise<CdpCall> {
  const path = `${CDP_FACILITATOR_BASE_PATH}/${op}`;
  try {
    const jwt = await cdpJwt(env.CDP_API_KEY_ID!, env.CDP_API_KEY_SECRET!, "POST", path);
    const res = await fetch(`https://${CDP_FACILITATOR_HOST}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: `CDP ${op} HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, reason: `CDP ${op} HTTP ${res.status}: unexpected body` };
    }
    return {
      ok: true,
      status: res.status,
      data: data as Record<string, unknown>,
      extensionResponses: decodeExtensionResponses(res.headers.get("EXTENSION-RESPONSES")),
    };
  } catch (err) {
    return { ok: false, reason: `CDP ${op} unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function bazaarStatus(r: CdpCall): string | undefined {
  if (!r.ok) return undefined;
  const b = r.extensionResponses?.bazaar as { status?: string; rejectedReason?: string } | undefined;
  if (!b?.status) return undefined;
  return b.rejectedReason ? `${b.status} (${b.rejectedReason})` : b.status;
}

export type CdpVerifyResult =
  | { kind: "valid"; payer?: string; bazaar?: string }
  | { kind: "invalid"; reason: string }
  | { kind: "unavailable"; reason: string };

export async function cdpVerify(env: CdpEnv, req: CdpRequest): Promise<CdpVerifyResult> {
  const r = await postCdp(env, "verify", req);
  if (!r.ok) return { kind: "unavailable", reason: r.reason };
  if (typeof r.data.isValid !== "boolean") {
    // Auth errors, rate limits and outages come back without isValid.
    return { kind: "unavailable", reason: `CDP verify HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
  }
  if (!r.data.isValid) {
    const reason = [r.data.invalidReason, r.data.invalidMessage].filter(Boolean).join(": ") || "rejected by CDP facilitator";
    return { kind: "invalid", reason: `CDP verify: ${reason}` };
  }
  return { kind: "valid", payer: r.data.payer as string | undefined, bazaar: bazaarStatus(r) };
}

export type CdpSettleResult =
  | { kind: "settled"; txHash: string; pending: boolean; bazaar?: string }
  | { kind: "failed"; reason: string }
  | { kind: "unavailable"; reason: string };

export async function cdpSettle(env: CdpEnv, req: CdpRequest): Promise<CdpSettleResult> {
  let r = await postCdp(env, "settle", req);
  for (let attempt = 0; ; attempt++) {
    if (!r.ok) {
      return attempt === 0
        ? { kind: "unavailable", reason: r.reason }
        // The first answer said pending: a tx is in flight, so this is not
        // "unavailable" (that would trigger the relayer fallback).
        : { kind: "failed", reason: r.reason };
    }
    const d = r.data;
    if (d.success === true && typeof d.transaction === "string" && d.transaction) {
      return { kind: "settled", txHash: d.transaction, pending: false, bazaar: bazaarStatus(r) };
    }
    if (d.errorReason === "settlement_pending" && typeof d.transaction === "string" && d.transaction) {
      if (attempt === 0) {
        r = await postCdp(env, "settle", req); // identical body, once
        continue;
      }
      return { kind: "settled", txHash: d.transaction, pending: true, bazaar: bazaarStatus(r) };
    }
    if (typeof d.success !== "boolean") {
      return attempt === 0
        ? { kind: "unavailable", reason: `CDP settle HTTP ${r.status}: ${JSON.stringify(d).slice(0, 200)}` }
        : { kind: "failed", reason: `CDP settle HTTP ${r.status}: ${JSON.stringify(d).slice(0, 200)}` };
    }
    const reason = [d.errorReason, d.errorMessage].filter(Boolean).join(": ") || "settlement failed";
    return { kind: "failed", reason: `CDP settle: ${reason}` };
  }
}
