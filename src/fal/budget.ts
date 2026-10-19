/**
 * Daily fal.ai spend circuit breaker (Fase 13.1).
 *
 * Protects our fal.ai balance from a pricing bug or abuse: every media tool
 * call must pass checkFalBudget(estimatedCogsMicro) BEFORE the fal.ai HTTP
 * call is made, and record its real (or estimated, if fal doesn't return an
 * exact cost) COGS via recordFalCost after a successful call.
 *
 * Storage: a single KV counter per UTC day (`fal-cogs:<YYYY-MM-DD>`), TTL
 * 48h. Not perfectly atomic (KV has no atomic increment) — this is a soft
 * breaker bounding worst-case daily loss, not a hard financial guarantee.
 * That's an accepted tradeoff for a same-day-abuse backstop, not the primary
 * defense (correct per-call pricing is).
 */

import { sendTelegram, type TelegramEnv } from "../alerts/telegram.js";

export interface FalBudgetEnv extends TelegramEnv {
  X402_NONCES: KVNamespace;
  FAL_DAILY_BUDGET_USD?: string;
}

function todayKey(): string {
  return `fal-cogs:${new Date().toISOString().slice(0, 10)}`;
}

function budgetMicro(env: FalBudgetEnv): bigint {
  const usd = Number(env.FAL_DAILY_BUDGET_USD ?? "5");
  const safeUsd = Number.isFinite(usd) && usd > 0 ? usd : 5;
  return BigInt(Math.round(safeUsd * 1_000_000));
}

/**
 * Throws a clear, uncharged error if today's accumulated COGS plus this
 * call's estimated COGS would exceed FAL_DAILY_BUDGET_USD (default $5/day).
 * Must be called BEFORE any fal.ai HTTP request — thrown before the gate
 * settles/debits payment, so the caller is never charged for a rejected call.
 */
export async function checkFalBudget(env: FalBudgetEnv, estimatedCogsMicro: bigint): Promise<void> {
  const raw = await env.X402_NONCES.get(todayKey());
  const current = raw ? BigInt(raw) : 0n;
  const limit = budgetMicro(env);
  if (current + estimatedCogsMicro > limit) {
    throw new Error(
      "fal.ai media tools are temporarily at capacity for today (daily budget reached). Try again after 00:00 UTC."
    );
  }
}

/**
 * Adds `actualCogsMicro` to today's counter after a successful fal.ai call.
 * Fires a Telegram alert (once per day, best-effort) the first time the
 * running total crosses 80% of the daily budget.
 */
export async function recordFalCost(env: FalBudgetEnv, actualCogsMicro: bigint): Promise<void> {
  const key = todayKey();
  const raw = await env.X402_NONCES.get(key);
  const current = raw ? BigInt(raw) : 0n;
  const next = current + actualCogsMicro;
  // Best-effort (Fase 25.14): fal.ai already spent the money; a KV failure
  // undercounts today's soft budget, it must not fail the caller's result.
  await env.X402_NONCES.put(key, next.toString(), { expirationTtl: 172_800 }).catch((err: unknown) => {
    console.warn("fal budget KV write failed:", err instanceof Error ? err.message : String(err));
  });

  const limit = budgetMicro(env);
  if (limit <= 0n) return;
  const pctBefore = Number((current * 100n) / limit);
  const pctAfter = Number((next * 100n) / limit);
  if (pctBefore < 80 && pctAfter >= 80) {
    const alertKey = `fal-budget-alert:${key}`;
    const alreadyAlerted = await env.X402_NONCES.get(alertKey);
    if (!alreadyAlerted) {
      await env.X402_NONCES.put(alertKey, "1", { expirationTtl: 172_800 }).catch((err: unknown) => {
        console.warn("fal budget alert KV write failed:", err instanceof Error ? err.message : String(err));
      });
      const usedUsd = (Number(next) / 1_000_000).toFixed(3);
      const limitUsd = (Number(limit) / 1_000_000).toFixed(2);
      try {
        await sendTelegram(
          env,
          `🟠 fal.ai daily budget at ${pctAfter}% ($${usedUsd} / $${limitUsd}) — media tools may soon start rejecting calls.`
        );
      } catch {
        // Alerts must never break the caller.
      }
    }
  }
}
