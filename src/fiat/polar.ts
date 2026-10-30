/**
 * Polar integration for the fiat rail (Fase 17).
 *
 * Money is credited ONLY from the `order.paid` webhook (source of truth for
 * the exact amount paid). The /welcome page never credits — it mints/reveals
 * the API key (idempotent via checkout_claims) and shows the best-effort
 * current balance, refreshing if the webhook hasn't landed yet. This avoids
 * any dual-write race between webhook and page load.
 */

import { creditDeposit } from "../x402/prepaid.js";
import { accountAddress } from "./keys.js";

export interface PolarEnv {
  PREPAID_DB: D1Database;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_PRODUCT_ID?: string;
  POLAR_ENV?: string; // "sandbox" | "production" (default production)
}

// ---------------------------------------------------------------------------
// Standard Webhooks signature verification (HMAC-SHA256, WebCrypto)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Polar webhook (Standard Webhooks headers/format, Polar's key
 * derivation): headers `webhook-id` / `webhook-timestamp` /
 * `webhook-signature`, signed content = `${id}.${timestamp}.${rawBody}`,
 * HMAC-SHA256 base64. 5-minute timestamp tolerance.
 *
 * KEY DERIVATION — Polar deviates from the Standard Webhooks spec here.
 * The spec says the secret is `whsec_<base64-encoded key bytes>`; Polar's
 * dashboard secret is `whsec_<random token>` where the HMAC key is the raw
 * UTF-8 bytes of the WHOLE string, prefix included. Their server signs with
 * `StandardWebhook(base64encode(secret))` (server/polar/webhook/tasks.py)
 * and their JS SDK verifies the same way, so we must too. We also accept the
 * spec-compliant interpretation as a fallback in case Polar ever fixes this.
 */
export async function verifyPolarSignature(
  rawBody: string,
  headers: Headers,
  secret: string
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !timestamp || !sigHeader || !secret) return false;

  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;

  // Primary key (what Polar actually signs with): raw UTF-8 bytes of the
  // full secret string. Fallback: spec-compliant base64 decode of the part
  // after `whsec_`.
  const keyVariants: Uint8Array[] = [new TextEncoder().encode(secret)];
  try {
    const secretB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
    keyVariants.push(base64ToBytes(secretB64));
  } catch {
    // Secret isn't valid base64 (expected for Polar tokens) — raw-bytes only.
  }

  // Header may carry multiple space-separated "v1,<sig>" candidates.
  const candidates = sigHeader
    .split(" ")
    .map((s) => s.split(",")[1])
    .filter((s): s is string => Boolean(s));

  const signedContent = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
  for (const keyBytes of keyVariants) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, signedContent);
    const expected = bytesToBase64(new Uint8Array(sigBuf));
    if (candidates.some((c) => timingSafeEqual(c, expected))) return true;
  }
  return false;
}

/**
 * TEMPORARY (2026-07-09) — Fase 26 webhook incident diagnostic. Every real
 * delivery from Polar (production and sandbox, both freshly re-copied
 * secrets) has failed verification, even ones under 1 second old — ruling
 * out both a copy/paste error and timestamp staleness as the cause. This
 * mirrors verifyPolarSignature but surfaces every intermediate value (none
 * of them secret — header names, the received signature, our own computed
 * one) so the actual discrepancy can be read from analytics_events instead
 * of guessed at. Delete alongside verifyPolarSignature's caller once the
 * incident is closed.
 */
export interface PolarSignatureDebug {
  headerNames: string[];
  hasId: boolean;
  hasTimestamp: boolean;
  hasSignatureHeader: boolean;
  timestamp: string | null;
  tsDeltaSeconds: number | null;
  sigHeaderRaw: string | null;
  computedSignatureB64: string | null;
  /** Same computation but concatenating raw BYTES instead of round-tripping
   * through a JS string — rules out any UTF-8 decode/re-encode fidelity
   * issue (the order.paid payload contains accented names). If this differs
   * from computedSignatureB64, that's the bug; if it matches, string
   * round-tripping was never the problem. */
  computedSignatureB64BytesMode: string | null;
  secretLooksLikeWhsec: boolean;
  secretDecodeError: boolean;
  bodyLength: number;
  contentLengthHeader: string | null;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export async function debugPolarSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  rawBodyBytes?: Uint8Array
): Promise<PolarSignatureDebug> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  const now = Math.floor(Date.now() / 1000);
  const ts = timestamp ? parseInt(timestamp, 10) : NaN;

  const headerNames: string[] = [];
  headers.forEach((_value, key) => headerNames.push(key));

  const debug: PolarSignatureDebug = {
    headerNames,
    hasId: Boolean(id),
    hasTimestamp: Boolean(timestamp),
    hasSignatureHeader: Boolean(sigHeader),
    timestamp,
    tsDeltaSeconds: Number.isFinite(ts) ? now - ts : null,
    sigHeaderRaw: sigHeader,
    computedSignatureB64: null,
    computedSignatureB64BytesMode: null,
    secretLooksLikeWhsec: secret.startsWith("whsec_"),
    secretDecodeError: false,
    bodyLength: rawBody.length,
    contentLengthHeader: headers.get("content-length"),
  };

  if (!id || !timestamp || !secret) return debug;

  const secretB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secretB64);
  } catch {
    debug.secretDecodeError = true;
    return debug;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  debug.computedSignatureB64 = bytesToBase64(new Uint8Array(sigBuf));

  if (rawBodyBytes) {
    const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
    const bytesModeContent = concatBytes(prefix, rawBodyBytes);
    const sigBufBytes = await crypto.subtle.sign("HMAC", key, bytesModeContent as BufferSource);
    debug.computedSignatureB64BytesMode = bytesToBase64(new Uint8Array(sigBufBytes));
  }

  return debug;
}

// Checkout sessions (POST/GET /v1/checkouts) moved to toolsnap-portal in
// F21.2 and were removed from here in A16 (2026-10-30), together with
// POLAR_ACCESS_TOKEN: this Worker never calls the Polar API, it only verifies
// the webhook signature (POLAR_WEBHOOK_SECRET).

// ---------------------------------------------------------------------------
// Account resolution + idempotent crediting (webhook only)
// ---------------------------------------------------------------------------

/** Find or create an account by email. Email is lowercased for uniqueness. */
export async function getOrCreateAccountByEmail(
  db: D1Database,
  email: string,
  polarCustomerId?: string
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .prepare("SELECT account_id FROM accounts WHERE email = ?")
    .bind(normalized)
    .first<{ account_id: string }>();
  if (existing) return existing.account_id;

  const accountId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await db
      .prepare(
        "INSERT INTO accounts (account_id, email, polar_customer_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(accountId, normalized, polarCustomerId ?? null, now)
      .run();
    return accountId;
  } catch {
    // Concurrent insert won the race — read back the winner.
    const row = await db
      .prepare("SELECT account_id FROM accounts WHERE email = ?")
      .bind(normalized)
      .first<{ account_id: string }>();
    if (!row) throw new Error(`Failed to resolve account for ${normalized}`);
    return row.account_id;
  }
}

export interface PolarOrderPaid {
  orderId: string;
  amountMicro: bigint; // gross amount paid, credited 1:1
  accountId: string; // resolved by caller (metadata.account_id or by email)
}

/**
 * Idempotently credit a paid order to an account's prepaid balance.
 * Returns { credited: false } if this order_id was already processed
 * (webhook replay) — never double-credits.
 */
export async function creditOrder(
  db: D1Database,
  order: PolarOrderPaid
): Promise<{ credited: boolean; balanceAfter?: bigint }> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db
      .prepare(
        "INSERT INTO polar_orders (order_id, account_id, amount_micro, credited_at) VALUES (?, ?, ?, ?)"
      )
      .bind(order.orderId, order.accountId, Number(order.amountMicro), now)
      .run();
  } catch {
    // Already credited (PK conflict on order_id) — no-op.
    return { credited: false };
  }

  const balanceAfter = await creditDeposit(
    db,
    accountAddress(order.accountId),
    order.amountMicro,
    `polar:${order.orderId}`,
    order.orderId
  );
  return { credited: true, balanceAfter };
}
