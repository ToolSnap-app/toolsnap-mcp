/**
 * X API v2 client. Two accounts ("product" = @ToolSnapMCP, "personal" =
 * @icosaedro_one), each with its own OAuth1.0a access token/secret sharing
 * one app (consumer key/secret).
 *
 * A16 (2026-10-30): only the PRODUCT tokens live in this Worker. The personal
 * account's tokens live in the separate `toolsnap-x-personal` Worker
 * (workers/x-personal), reached through the X_PERSONAL service binding, which
 * exposes exactly three operations (publish, upload media, repost). So
 * whoever reads or redeploys toolsnap-mcp can queue posts for @icosaedro_one
 * but never walks away with the account's credentials, and cannot use them
 * for anything else (DMs, follows, deletes, profile).
 *
 * The *As functions below take explicit credentials and are shared with that
 * Worker; the account-routing wrappers are what the rest of src/ calls.
 */

import { signOAuth1, type OAuth1Credentials } from "./oauth1.js";

export type XAccount = "product" | "personal";

/**
 * What the X_PERSONAL service binding answers. Errors come back as values,
 * not throws: Workers RPC does not carry an XApiError's status/retryable
 * across the boundary, and the publisher's retry logic needs both.
 */
export type XPersonalResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; status: number; retryable: boolean; code?: XPersonalErrorCode };

/**
 * Typed refusals toolsnap-x-personal can give besides relaying an X error.
 * `limite-diario`: the Worker's own cap of daily publications was reached
 * (workers/x-personal/src/limiter.ts); it clears at 00:00 UTC.
 */
export type XPersonalErrorCode = "limite-diario";

/** The RPC surface of toolsnap-x-personal (workers/x-personal/src/index.ts). */
export interface XPersonalService {
  publish(params: Omit<PublishParams, "account">): Promise<XPersonalResult<PublishResult>>;
  uploadMedia(bytes: Uint8Array, mimeType: string): Promise<XPersonalResult<string>>;
  repost(targetTweetId: string): Promise<XPersonalResult<PublishResult>>;
}

export interface XAgentEnv {
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN_PRODUCT?: string;
  X_ACCESS_TOKEN_SECRET_PRODUCT?: string;
  // Numeric X user id, captured once from scripts/x-authorize.mts' PIN-flow
  // output — needed for POST /2/users/:id/retweets (native repost, kind='repost').
  X_USER_ID_PRODUCT?: string;
  // A16 — service binding to toolsnap-x-personal (the personal account).
  X_PERSONAL?: XPersonalService;
  X_DRY_RUN?: string; // "1" -> log instead of calling the real API (local/e2e testing)
}

function productCreds(env: XAgentEnv): OAuth1Credentials {
  const consumerKey = env.X_API_KEY;
  const consumerSecret = env.X_API_SECRET;
  const accessToken = env.X_ACCESS_TOKEN_PRODUCT;
  const accessTokenSecret = env.X_ACCESS_TOKEN_SECRET_PRODUCT;
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error(`X credentials not configured for account "product"`);
  }
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

function personalService(env: XAgentEnv): XPersonalService {
  if (!env.X_PERSONAL) {
    throw new Error(`X account "personal" not configured (X_PERSONAL service binding to toolsnap-x-personal missing)`);
  }
  return env.X_PERSONAL;
}

/** Turn a binding result back into a value or the XApiError the publisher expects. */
function unwrap<T>(r: XPersonalResult<T>): T {
  if (r.ok) return r.value;
  // The daily cap never clears within the queue's retry window (the next
  // cron tick is minutes away, the cap resets at 00:00 UTC): fail the post for
  // good instead of burning its attempts, whatever `retryable` the Worker says.
  if (r.code === "limite-diario") throw new XApiError(r.message, r.status, false);
  throw new XApiError(r.message, r.status, r.retryable);
}

export interface PublishParams {
  account: XAccount;
  text?: string;
  quoteTweetId?: string;
  replyToTweetId?: string;
  mediaIds?: string[];
}

export interface PublishResult {
  tweetId: string;
}

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/**
 * Publish one post via POST /2/tweets. Throws XApiError; `retryable` is true
 * for 429/5xx/network failures, false for 4xx content errors (duplicate,
 * length, invalid quote/reply target) that a retry can never fix.
 */
export async function publishTweet(env: XAgentEnv, params: PublishParams): Promise<PublishResult> {
  if (env.X_DRY_RUN === "1") {
    const fakeId = `dryrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[x-agent DRY_RUN] would POST /2/tweets as ${params.account}:`, JSON.stringify(tweetBody(params)));
    return { tweetId: fakeId };
  }
  if (params.account === "personal") {
    const { account: _account, ...rest } = params;
    return unwrap(await personalService(env).publish(rest));
  }
  return publishTweetAs(productCreds(env), params);
}

function tweetBody(params: Omit<PublishParams, "account">): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.text) body.text = params.text;
  if (params.quoteTweetId) body.quote_tweet_id = params.quoteTweetId;
  if (params.replyToTweetId) body.reply = { in_reply_to_tweet_id: params.replyToTweetId };
  if (params.mediaIds?.length) body.media = { media_ids: params.mediaIds };
  return body;
}

/** POST /2/tweets with explicit credentials (shared with toolsnap-x-personal). */
export async function publishTweetAs(
  creds: OAuth1Credentials,
  params: Omit<PublishParams, "account">
): Promise<PublishResult> {
  const url = "https://api.x.com/2/tweets";
  const body = tweetBody(params);
  const authHeader = await signOAuth1("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new XApiError(`X API error (${res.status}): ${text.slice(0, 500)}`, res.status, retryable);
  }

  let parsed: { data?: { id?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new XApiError(`X API returned non-JSON success body: ${text.slice(0, 200)}`, res.status, false);
  }
  const tweetId = parsed.data?.id;
  if (!tweetId) {
    throw new XApiError(`X API success response missing data.id: ${text.slice(0, 200)}`, res.status, false);
  }
  return { tweetId };
}

/**
 * Upload one image (INIT/APPEND/FINALIZE against POST /2/media/upload,
 * media_category=tweet_image) and return the resulting media id for
 * PublishParams.mediaIds. Images are capped at 5MB (panel/queue.ts
 * enforce this on ingest) so a single APPEND chunk always suffices —
 * no need for the multi-segment loop chunked video uploads require.
 *
 * X's public docs for this endpoint only show OAuth2 Bearer / a generic
 * "UserToken" HTTP-OAuth scheme, not OAuth1.0a explicitly — but every other
 * v2 write endpoint this codebase calls (POST /2/tweets, POST
 * /2/users/:id/retweets) accepts the same OAuth1.0a User Context signing
 * and works in production, so this reuses signOAuth1 rather than adding a
 * second auth path. If this ever 401s in practice (verify on first real
 * image post), that's the first thing to check.
 */
export async function uploadMedia(env: XAgentEnv, account: XAccount, bytes: Uint8Array, mimeType: string): Promise<string> {
  if (env.X_DRY_RUN === "1") {
    const fakeId = `dryrun_media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[x-agent DRY_RUN] would upload media (${bytes.length} bytes, ${mimeType}) as ${account}`);
    return fakeId;
  }
  if (account === "personal") return unwrap(await personalService(env).uploadMedia(bytes, mimeType));
  return uploadMediaAs(productCreds(env), bytes, mimeType);
}

/** INIT/APPEND/FINALIZE with explicit credentials (shared with toolsnap-x-personal). */
export async function uploadMediaAs(creds: OAuth1Credentials, bytes: Uint8Array, mimeType: string): Promise<string> {
  const url = "https://api.x.com/2/media/upload";

  async function call(form: FormData): Promise<{ ok: boolean; status: number; text: string }> {
    const authHeader = await signOAuth1("POST", url, creds);
    const res = await fetch(url, { method: "POST", headers: { Authorization: authHeader }, body: form });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  const initForm = new FormData();
  initForm.set("command", "INIT");
  initForm.set("media_type", mimeType);
  initForm.set("total_bytes", String(bytes.length));
  initForm.set("media_category", "tweet_image");
  const initRes = await call(initForm);
  if (!initRes.ok) {
    const retryable = initRes.status === 429 || initRes.status >= 500;
    throw new XApiError(`media INIT failed (${initRes.status}): ${initRes.text.slice(0, 500)}`, initRes.status, retryable);
  }
  let mediaId: string | undefined;
  try {
    mediaId = (JSON.parse(initRes.text) as { data?: { id?: string } }).data?.id;
  } catch {
    // fall through to the missing-id check below
  }
  if (!mediaId) {
    throw new XApiError(`media INIT response missing data.id: ${initRes.text.slice(0, 200)}`, initRes.status, false);
  }

  const appendForm = new FormData();
  appendForm.set("command", "APPEND");
  appendForm.set("media_id", mediaId);
  appendForm.set("segment_index", "0");
  appendForm.set("media", new Blob([bytes as unknown as BlobPart], { type: mimeType }));
  const appendRes = await call(appendForm);
  if (!appendRes.ok) {
    const retryable = appendRes.status === 429 || appendRes.status >= 500;
    throw new XApiError(`media APPEND failed (${appendRes.status}): ${appendRes.text.slice(0, 500)}`, appendRes.status, retryable);
  }

  const finalizeForm = new FormData();
  finalizeForm.set("command", "FINALIZE");
  finalizeForm.set("media_id", mediaId);
  const finalizeRes = await call(finalizeForm);
  if (!finalizeRes.ok) {
    const retryable = finalizeRes.status === 429 || finalizeRes.status >= 500;
    throw new XApiError(`media FINALIZE failed (${finalizeRes.status}): ${finalizeRes.text.slice(0, 500)}`, finalizeRes.status, retryable);
  }

  return mediaId;
}

export interface TweetMetrics {
  tweetId: string;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  bookmarks: number | null;
}

/**
 * Fetch public_metrics for up to 100 tweet ids in one call (GET /2/tweets),
 * feeding x_metrics (Fase 22.3). Always uses the "product" account's
 * credentials — this reads metrics for tweets from BOTH accounts (they're
 * our own public tweets, any authenticated app context can read them), so
 * one credential set is enough rather than splitting the call per account.
 */
export async function fetchTweetMetrics(env: XAgentEnv, ids: string[]): Promise<TweetMetrics[]> {
  if (ids.length === 0) return [];
  if (ids.length > 100) throw new Error("fetchTweetMetrics: max 100 ids per call (X API limit)");

  if (env.X_DRY_RUN === "1") {
    console.log(`[x-agent DRY_RUN] would GET /2/tweets public_metrics for ${ids.length} id(s)`);
    return ids.map((id) => ({ tweetId: id, impressions: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0 }));
  }

  const baseUrl = "https://api.x.com/2/tweets";
  const queryParams = { ids: ids.join(","), "tweet.fields": "public_metrics" };
  const url = `${baseUrl}?${new URLSearchParams(queryParams).toString()}`;

  const creds = productCreds(env);
  const authHeader = await signOAuth1("GET", baseUrl, creds, {}, queryParams);

  const res = await fetch(url, { method: "GET", headers: { Authorization: authHeader } });
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new XApiError(`X API metrics error (${res.status}): ${text.slice(0, 500)}`, res.status, retryable);
  }

  let parsed: { data?: Array<{ id: string; public_metrics?: Record<string, number> }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new XApiError(`X API metrics returned non-JSON body: ${text.slice(0, 200)}`, res.status, false);
  }

  return (parsed.data ?? []).map((t) => ({
    tweetId: t.id,
    impressions: t.public_metrics?.impression_count ?? null,
    likes: t.public_metrics?.like_count ?? null,
    replies: t.public_metrics?.reply_count ?? null,
    reposts: t.public_metrics?.retweet_count ?? null,
    quotes: t.public_metrics?.quote_count ?? null,
    bookmarks: t.public_metrics?.bookmark_count ?? null,
  }));
}

/**
 * Native repost (retweet) via POST /2/users/:id/retweets — no text, distinct
 * from a quote-post. Returns the ORIGINAL tweet id (X's retweet response has
 * no id of its own for the retweet action itself).
 */
export async function repostTweet(env: XAgentEnv, account: XAccount, targetTweetId: string): Promise<PublishResult> {
  if (env.X_DRY_RUN === "1") {
    console.log(`[x-agent DRY_RUN] would POST /2/users/:id/retweets as ${account}: retweet ${targetTweetId}`);
    return { tweetId: targetTweetId };
  }
  if (account === "personal") return unwrap(await personalService(env).repost(targetTweetId));
  if (!env.X_USER_ID_PRODUCT) throw new Error(`X user id not configured for account "product" (X_USER_ID_PRODUCT)`);
  return repostTweetAs(productCreds(env), env.X_USER_ID_PRODUCT, targetTweetId);
}

/** POST /2/users/:id/retweets with explicit credentials (shared with toolsnap-x-personal). */
export async function repostTweetAs(
  creds: OAuth1Credentials,
  userId: string,
  targetTweetId: string
): Promise<PublishResult> {
  const url = `https://api.x.com/2/users/${userId}/retweets`;
  const authHeader = await signOAuth1("POST", url, creds);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: targetTweetId }),
  });
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new XApiError(`X API retweet error (${res.status}): ${text.slice(0, 500)}`, res.status, retryable);
  }
  return { tweetId: targetTweetId };
}
