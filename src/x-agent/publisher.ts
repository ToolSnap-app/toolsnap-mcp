/**
 * Publisher cron (Fase 22.1) — runs every 5 minutes, picks up due `scheduled`
 * rows (respecting depends_on/min_gap_s ordering for quotes/replies/threads),
 * claims each atomically, and publishes it via the X API.
 */

import type { XAgentEnv } from "./client.js";
import type { XTelegramEnv } from "./telegram.js";
import { sendXAgentMessage } from "./telegram.js";
import { formatCard, sendManualQuoteCard } from "./telegram-approval.js";
import { attemptPublishNow, type PublishOneEnv } from "./publish-one.js";
import {
  getDueRows,
  getVetoRowsNeedingNotice,
  markVetoNotified,
  moveToManualPending,
  resolveQuoteTargetUrl,
  type XQueueRow,
} from "./queue.js";
import { runReplyDiscoverySweep, expireStaleReplyCandidates, type XDiscoveryEnv } from "./discovery.js";

export interface XPublisherEnv extends XAgentEnv, XTelegramEnv, PublishOneEnv, XDiscoveryEnv {
  PREPAID_DB: D1Database;
  // Fase 22.3 — panel-uploaded images live here under x-media/ (same bucket
  // as screenshot_url and /upload); the publisher reads the bytes back and
  // uploads them to X right before posting (see resolveMediaIds below).
  SCREENSHOTS_BUCKET: R2Bucket;
  // Fase 22.2 — L2 veto window. Defaults chosen with Unai 2026-07-10: 4h
  // notice, 30min minimum gap between notice and publish.
  X_VETO_NOTICE_S?: string;
  X_VETO_MIN_S?: string;
}

const DEFAULT_VETO_NOTICE_S = 4 * 3600;
const DEFAULT_VETO_MIN_S = 30 * 60;

/**
 * True during Unai's requested quiet hours (00:00-12:00 Europe/Madrid) — the
 * publisher defers sending new veto notices during this window so he never
 * wakes up to a cancel-window Telegram card. Rows already past their notice
 * are unaffected; this only gates *sending new notices*, never publishing
 * (a row notified before quiet hours started still publishes on schedule).
 */
function isMadridQuietHours(date: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "numeric", hourCycle: "h23" }).format(date)
  );
  return hour >= 0 && hour < 12;
}

/**
 * Send cancel-window notices for any `veto` row entering its notice window,
 * unless we're inside Madrid quiet hours (00:00-12:00) — those are retried
 * on every subsequent tick until quiet hours end.
 */
async function sendVetoNotices(env: XPublisherEnv, db: D1Database): Promise<void> {
  // Quiet hours are a real-wall-clock concern; skip the gate under
  // X_DRY_RUN (local/e2e testing, scripts/x-agent-test.mts) so tests are
  // deterministic regardless of what time they happen to run.
  if (env.X_DRY_RUN !== "1" && isMadridQuietHours(new Date())) return;
  const noticeS = Number(env.X_VETO_NOTICE_S) || DEFAULT_VETO_NOTICE_S;
  const rows = await getVetoRowsNeedingNotice(db, noticeS);
  for (const row of rows) {
    const when = row.scheduled_at ? new Date(row.scheduled_at * 1000).toISOString() : "sin hora";
    const text = `${formatCard(row)}\n\n⏳ *Se publicará solo a las ${when} salvo veto.*`;
    const messageId = await sendXAgentMessage(env, text, {
      inlineKeyboard: [[{ text: "🚫 Cancelar", callback_data: `xq:${row.id}:cancel` }]],
    });
    await markVetoNotified(db, row.id, messageId);
  }
}

/**
 * X's API rejects automated quote-posts with a 403 ("not mentioned or part
 * of the conversation") whenever the quoted post isn't one the API
 * considers "yours to engage with" — a platform restriction, not fixable
 * via account settings (verified 2026-07-14: "who can reply" was already
 * set to "Everyone"). Every kind='quote' row therefore skips the API
 * entirely and goes to a manual-publish Telegram card instead (texto
 * copy-paste + link to the post being quoted + "published by hand" button),
 * same pattern as reply-guy's manual path. Returns true if a card was sent
 * (or the row was already moved out of 'scheduled' by an overlapping tick).
 */
async function divertQuoteToManual(env: XPublisherEnv, db: D1Database, row: XQueueRow): Promise<boolean> {
  const moved = await moveToManualPending(db, row.id);
  if (!moved) return false; // another tick already claimed/moved this row
  const quoteUrl = await resolveQuoteTargetUrl(db, row);
  await sendManualQuoteCard(env, db, row, quoteUrl);
  return true;
}

/**
 * Run one publisher tick: send due veto notices, attempt every
 * currently-eligible row once, then (Fase 22.4) run a reply-guy discovery
 * sweep if the gate says it's time, and expire any reply candidates that
 * aged past their TTL without a decision.
 */
export async function runXPublisher(env: XPublisherEnv): Promise<{ attempted: number; published: number; failed: number }> {
  const db = env.PREPAID_DB;
  await sendVetoNotices(env, db);
  const vetoMinS = Number(env.X_VETO_MIN_S) || DEFAULT_VETO_MIN_S;
  const due = await getDueRows(db, 10, vetoMinS);
  let published = 0;
  let failed = 0;

  for (const row of due) {
    if (row.kind === "quote") {
      await divertQuoteToManual(env, db, row);
      continue;
    }

    const result = await attemptPublishNow(env, row);
    if (result.status === "already_claimed") continue; // another cron tick (or overlap) already took it
    if (result.status === "published") {
      published++;
    } else if (result.status === "deferred") {
      await sendXAgentMessage(
        env,
        `⏸️ *Tope diario de la cuenta personal* (15 publicaciones): #${row.id} pospuesto a las 00:00 UTC. Sus hijos esperan a que se publique.`
      );
    } else if (result.status === "failed" || result.status === "retry") {
      failed++;
      if (result.status === "failed") {
        await sendXAgentMessage(
          env,
          `⚠️ *Fallo publicando #${row.id}* (${row.account})\n\n${result.error.slice(0, 300)}\n\nEstado: failed. Hijos dependientes bloqueados.`
        );
      }
    }
  }

  // Fase 22.4 — reply-guy: cheap no-op most ticks (the gate in discovery.ts
  // checks window/calendar/pause/budget/cap before ever calling xAI).
  await runReplyDiscoverySweep(env).catch((err) =>
    console.error("x-agent reply discovery sweep failed:", err instanceof Error ? err.message : err)
  );
  await expireStaleReplyCandidates(db).catch((err) =>
    console.error("x-agent reply candidate expiry failed:", err instanceof Error ? err.message : err)
  );

  return { attempted: due.length, published, failed };
}
