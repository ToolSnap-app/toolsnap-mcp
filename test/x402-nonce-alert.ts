/**
 * Unit tests for src/x402/nonce-alert.ts (A5b of the security plan).
 *
 * When settlePayment cannot record the used nonce in KV (quota exhausted),
 * the payment still succeeded and the pager must:
 *  - send ONE Telegram message, with the tx hash;
 *  - stay quiet for the next hour, however many settlements trip it;
 *  - never throw and never block the response (the send goes to waitUntil),
 *    even when Telegram itself is down or unconfigured.
 *
 * Pure logic — captured fetch, fake ExecutionContext. No network.
 *
 * Run: npx tsx test/x402-nonce-alert.ts
 */
import { alertNonceNotRecorded, resetNonceAlertThrottle } from "../src/x402/nonce-alert.js";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const sent: string[] = [];
const realFetch = globalThis.fetch;
let telegramDown = false;
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  if (telegramDown) throw new Error("ECONNRESET");
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
  sent.push(body.text ?? "");
  return new Response("{}", { status: 200 });
}) as typeof fetch;

function makeCtx(): { ctx: Pick<ExecutionContext, "waitUntil">; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, pending };
}

// Fake clock: start well past the one-hour window so a reset throttle (0) does not swallow the first page.
const T0 = 10 * 60 * 60 * 1000;
const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };
const info = {
  kind: "deposit" as const,
  payer: "0x1111111111111111111111111111111111111111",
  txHash: "0xdeadbeef",
  nonce: `0x${"ab".repeat(32)}`,
};

async function run(): Promise<void> {
  console.log("\n=== x402 nonce alert ===\n");

  // 1. First trip pages, with the tx hash in the message.
  resetNonceAlertThrottle();
  {
    const { ctx, pending } = makeCtx();
    const paged = alertNonceNotRecorded(env, ctx, info, T0);
    await Promise.all(pending);
    assert("first failure pages", paged === true && sent.length === 1, `sent=${sent.length}`);
    assert("message carries the tx hash", sent[0]?.includes("0xdeadbeef") === true, sent[0]);
    assert("send went through waitUntil, not awaited inline", pending.length === 1);
  }

  // 2. Within the hour: silent, whatever the count.
  {
    const { ctx, pending } = makeCtx();
    let pagedAgain = false;
    for (let i = 0; i < 50; i++) {
      pagedAgain = alertNonceNotRecorded(env, ctx, { ...info, txHash: `0x${i}` }, T0 + 59 * 60 * 1000) || pagedAgain;
    }
    await Promise.all(pending);
    assert("50 more failures inside the hour → no new page", pagedAgain === false && sent.length === 1, `sent=${sent.length}`);
  }

  // 3. After the hour: pages once more.
  {
    const { ctx, pending } = makeCtx();
    const paged = alertNonceNotRecorded(env, ctx, info, T0 + 61 * 60 * 1000);
    await Promise.all(pending);
    assert("next failure after an hour pages again", paged === true && sent.length === 2, `sent=${sent.length}`);
  }

  // 4. Telegram down: no throw, waitUntil promise resolves.
  resetNonceAlertThrottle();
  telegramDown = true;
  {
    const { ctx, pending } = makeCtx();
    let threw = "";
    try {
      alertNonceNotRecorded(env, ctx, info);
      await Promise.all(pending);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("Telegram down → no throw, waitUntil settles", threw === "", threw);
  }
  telegramDown = false;

  // 5. Unconfigured bot: still no throw.
  resetNonceAlertThrottle();
  {
    const { ctx, pending } = makeCtx();
    let threw = "";
    try {
      alertNonceNotRecorded({}, ctx, info);
      await Promise.all(pending);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert("no TELEGRAM_* configured → no throw", threw === "", threw);
  }

  globalThis.fetch = realFetch;
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
