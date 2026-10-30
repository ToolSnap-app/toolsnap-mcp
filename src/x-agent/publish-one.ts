/**
 * The actual "call the X API for one row" logic, extracted out of the cron
 * publisher (publisher.ts) so it can also be called directly and
 * immediately — used by reply-guy (Fase 22.4): unlike scheduled posts,
 * approving a reply should publish it right away rather than wait for the
 * next 5-minute cron tick, because timing is the whole point of a reply
 * (nota 14 §1/§5). Kept in its own module (not exported from publisher.ts)
 * to avoid a circular import with telegram-approval.ts, which both this
 * module's caller and publisher.ts depend on.
 */
import { publishTweet, repostTweet, uploadMedia, XApiError, type XAgentEnv } from "./client.js";
import { claimForPublishing, deferToNextUtcDay, getQueueRow, markFailedOrRetry, markPublished, type XQueueRow } from "./queue.js";

export interface PublishOneEnv extends XAgentEnv {
  PREPAID_DB: D1Database;
  SCREENSHOTS_BUCKET: R2Bucket;
}

/**
 * Resolve the target tweet id for internal quote/reply chaining (if any)
 * and call the right X API endpoint. Assumes any `depends_on` parent is
 * already published (guaranteed by getDueRows for the cron path; reply-guy
 * rows never set depends_on, so this branch simply doesn't apply to them).
 */
export async function resolveTargetAndPublish(
  env: PublishOneEnv,
  row: XQueueRow,
  db: D1Database
): Promise<{ tweetId: string }> {
  let quoteTweetId = row.quote_tweet_id ?? undefined;
  let replyToTweetId = row.reply_to_tweet_id ?? undefined;
  let parentTweetId: string | undefined;

  if (row.depends_on) {
    const parent = await getQueueRow(db, row.depends_on);
    if (!parent?.tweet_id) {
      throw new XApiError(`parent #${row.depends_on} has no tweet_id yet (should not happen — getDueRows guards this)`, 0, false);
    }
    parentTweetId = parent.tweet_id;
    if (!quoteTweetId && !replyToTweetId) {
      if (row.kind === "quote") quoteTweetId = parentTweetId;
      else if (row.kind === "reply" || row.kind === "thread_part") replyToTweetId = parentTweetId;
    }
  }

  if (row.kind === "repost") {
    const targetId = row.quote_tweet_id ?? parentTweetId;
    if (!targetId) throw new XApiError(`repost row #${row.id} has no target tweet id (quote_tweet_id or depends_on)`, 0, false);
    return repostTweet(env, row.account, targetId);
  }

  const mediaIds = row.media_keys ? await resolveMediaIds(env, row) : undefined;

  return publishTweet(env, {
    account: row.account,
    text: row.text ?? undefined,
    quoteTweetId,
    replyToTweetId,
    mediaIds,
  });
}

/** Same media-resolution behavior as before Fase 22.4 — see publisher.ts history for the "why not at upload time" note. */
export async function resolveMediaIds(env: PublishOneEnv, row: XQueueRow): Promise<string[]> {
  let keys: unknown;
  try {
    keys = JSON.parse(row.media_keys ?? "[]");
  } catch {
    throw new XApiError(`row #${row.id} has malformed media_keys JSON`, 0, false);
  }
  if (!Array.isArray(keys) || keys.length === 0) return [];

  const mediaIds: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const obj = await env.SCREENSHOTS_BUCKET.get(key);
    if (!obj) throw new XApiError(`row #${row.id} media key "${key}" not found in R2`, 0, false);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";
    mediaIds.push(await uploadMedia(env, row.account, bytes, mimeType));
  }
  return mediaIds;
}

export type PublishNowResult =
  | { status: "published"; tweetId: string }
  | { status: "already_claimed" }
  | { status: "retry" | "failed"; error: string }
  // The personal account's daily cap was hit: the row waits for 00:00 UTC.
  | { status: "deferred"; error: string; until: number };

/**
 * Claim + publish exactly one row right now (not gated on scheduled_at/veto
 * windows — the caller has already decided this row should go out
 * immediately). Used by the cron loop's per-row attempt (publisher.ts) and
 * by "approve a reply -> publish now" (telegram-approval.ts).
 */
export async function attemptPublishNow(env: PublishOneEnv, row: XQueueRow): Promise<PublishNowResult> {
  const db = env.PREPAID_DB;
  const claimed = await claimForPublishing(db, row.id);
  if (!claimed) return { status: "already_claimed" };

  try {
    const result = await resolveTargetAndPublish(env, row, db);
    await markPublished(db, row.id, result.tweetId);
    return { status: "published", tweetId: result.tweetId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Daily cap of toolsnap-x-personal: not a failure. Marking the row
    // `failed` would also block the rest of a thread, so a capped thread
    // resumes by itself the next UTC day (each part waits on its parent).
    // Replies are the exception: they are only worth posting right away, so
    // a capped reply fails like any other refusal and is answered by hand.
    if (err instanceof XApiError && err.code === "limite-diario" && row.kind !== "reply") {
      return { status: "deferred", error: message, until: await deferToNextUtcDay(db, row.id, message) };
    }
    const retryable = err instanceof XApiError ? err.retryable : true;
    const { willRetry } = await markFailedOrRetry(db, row.id, message, retryable);
    return { status: willRetry ? "retry" : "failed", error: message };
  }
}
