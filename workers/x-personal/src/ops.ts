/**
 * A16 — the three operations toolsnap-x-personal performs for toolsnap-mcp
 * with the personal account's (@icosaedro_one) tokens. Plain functions, no
 * `cloudflare:workers` import, so test/x-personal-boundary.ts can drive them
 * under Node; src/index.ts is the thin RPC entrypoint around them.
 *
 * Inputs are validated here even though the only caller is our own Worker:
 * the point of this Worker is that a compromised toolsnap-mcp gets these
 * three narrow verbs and nothing more.
 */
import {
  publishTweetAs,
  repostTweetAs,
  uploadMediaAs,
  XApiError,
  type PublishParams,
  type PublishResult,
  type XPersonalResult,
} from "../../../src/x-agent/client.js";
import type { OAuth1Credentials } from "../../../src/x-agent/oauth1.js";

export interface XPersonalEnv {
  // Consumer key/secret of the shared X app (same values as in toolsnap-mcp:
  // OAuth1.0a signing needs them next to the access token).
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN_PERSONAL?: string;
  X_ACCESS_TOKEN_SECRET_PERSONAL?: string;
  X_USER_ID_PERSONAL?: string;
  // Durable Object del tope diario (limiter.ts); una sola instancia, LIMITER_NAME.
  LIMITE_PUBLICACIONES?: LimiterNamespace;
}

/** Lo que ops.ts usa del DO (DurableObjectNamespace<PublicationLimiter> lo cumple). */
export interface LimiterStub {
  reservar(dia: string, tope: number): Promise<{ ok: boolean; usadas: number }> | { ok: boolean; usadas: number };
  liberar(dia: string): Promise<void> | void;
}
export interface LimiterNamespace {
  idFromName(name: string): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(id: any): LimiterStub;
}

/** Decision de Unai (2026-10-30): como mucho 15 publicaciones al dia UTC (publish + repost). */
export const TOPE_DIARIO = 15;
const LIMITER_NAME = "global";

/** Same ceiling the panel enforces on upload (src/x-agent/panel-api.ts). */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
// Same list the panel accepts on upload (src/x-agent/panel-api.ts).
const MEDIA_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const TWEET_ID = /^\d{1,20}$/;
const MEDIA_ID = /^\d{1,24}$/;

function invalid(message: string): XPersonalResult<never> {
  return { ok: false, message: `x-personal: ${message}`, status: 400, retryable: false };
}

function creds(env: XPersonalEnv): OAuth1Credentials | null {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN_PERSONAL, X_ACCESS_TOKEN_SECRET_PERSONAL } = env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN_PERSONAL || !X_ACCESS_TOKEN_SECRET_PERSONAL) return null;
  return {
    consumerKey: X_API_KEY,
    consumerSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN_PERSONAL,
    accessTokenSecret: X_ACCESS_TOKEN_SECRET_PERSONAL,
  };
}

const NOT_CONFIGURED: XPersonalResult<never> = {
  ok: false,
  message: 'X credentials not configured for account "personal" (toolsnap-x-personal secrets missing)',
  status: 0,
  retryable: true,
};

const dayUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const LIMIT_REACHED: XPersonalResult<never> = {
  ok: false,
  message: `x-personal: limite-diario: ${TOPE_DIARIO} publicaciones al dia (UTC) alcanzado; vuelve a abrirse a las 00:00 UTC`,
  status: 429,
  retryable: false,
  code: "limite-diario",
};

/**
 * Cuenta una publicacion en el DO, de forma atomica, ANTES de llamar a X; si X
 * la rechaza (status >= 400: no se publico nada) la devuelve. Un error de red
 * (status 0) no se devuelve: puede haberse publicado igualmente. Sin DO
 * enlazado o si falla, no se publica nada (falla cerrado, reintentable).
 */
async function withDailyCap<T>(
  env: XPersonalEnv,
  now: () => number,
  fn: () => Promise<XPersonalResult<T>>
): Promise<XPersonalResult<T>> {
  const ns = env.LIMITE_PUBLICACIONES;
  if (!ns) return { ok: false, message: "x-personal: daily cap not configured (LIMITE_PUBLICACIONES binding missing)", status: 0, retryable: true };
  const dia = dayUtc(now());
  let stub: LimiterStub;
  try {
    stub = ns.get(ns.idFromName(LIMITER_NAME));
    if (!(await stub.reservar(dia, TOPE_DIARIO)).ok) return LIMIT_REACHED;
  } catch (err) {
    return { ok: false, message: `x-personal: daily cap unavailable: ${err instanceof Error ? err.message : String(err)}`, status: 0, retryable: true };
  }
  const result = await fn();
  if (!result.ok && result.status >= 400) {
    try {
      await stub.liberar(dia);
    } catch {
      // Contar de mas es el lado seguro del tope.
    }
  }
  return result;
}

async function run<T>(fn: () => Promise<T>): Promise<XPersonalResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof XApiError) return { ok: false, message: err.message, status: err.status, retryable: err.retryable };
    // Network failures and the like: same default as attemptPublishNow (retry).
    return { ok: false, message: err instanceof Error ? err.message : String(err), status: 0, retryable: true };
  }
}

export async function publish(
  env: XPersonalEnv,
  params: Omit<PublishParams, "account">,
  now: () => number = Date.now
): Promise<XPersonalResult<PublishResult>> {
  if (!params || typeof params !== "object") return invalid("params must be an object");
  const { text, quoteTweetId, replyToTweetId, mediaIds } = params;
  if (text !== undefined && typeof text !== "string") return invalid("text must be a string");
  if (quoteTweetId !== undefined && !TWEET_ID.test(String(quoteTweetId))) return invalid("quoteTweetId must be a tweet id");
  if (replyToTweetId !== undefined && !TWEET_ID.test(String(replyToTweetId))) return invalid("replyToTweetId must be a tweet id");
  if (mediaIds !== undefined && (!Array.isArray(mediaIds) || mediaIds.length > 4 || !mediaIds.every((m) => MEDIA_ID.test(String(m))))) {
    return invalid("mediaIds must be up to 4 media ids");
  }
  if (!text && !quoteTweetId && !mediaIds?.length) return invalid("nothing to publish");
  const c = creds(env);
  if (!c) return NOT_CONFIGURED;
  return withDailyCap(env, now, () => run(() => publishTweetAs(c, { text, quoteTweetId, replyToTweetId, mediaIds })));
}

export async function uploadMedia(env: XPersonalEnv, bytes: Uint8Array, mimeType: string): Promise<XPersonalResult<string>> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return invalid("bytes must be a non-empty Uint8Array");
  if (bytes.length > MAX_MEDIA_BYTES) return invalid(`media larger than ${MAX_MEDIA_BYTES} bytes`);
  if (!MEDIA_TYPES.has(mimeType)) return invalid(`unsupported media type ${String(mimeType)}`);
  const c = creds(env);
  if (!c) return NOT_CONFIGURED;
  return run(() => uploadMediaAs(c, bytes, mimeType));
}

export async function repost(
  env: XPersonalEnv,
  targetTweetId: string,
  now: () => number = Date.now
): Promise<XPersonalResult<PublishResult>> {
  if (!TWEET_ID.test(String(targetTweetId))) return invalid("targetTweetId must be a tweet id");
  const c = creds(env);
  if (!c || !env.X_USER_ID_PERSONAL) return NOT_CONFIGURED;
  const userId = env.X_USER_ID_PERSONAL;
  return withDailyCap(env, now, () => run(() => repostTweetAs(c, userId, targetTweetId)));
}

/**
 * The Worker's default fetch handler. toolsnap-x-personal has no route and
 * no workers.dev URL, but if one were ever switched on by mistake this still
 * answers nothing: the only way in is the XPersonal RPC entrypoint, which
 * Cloudflare only exposes to Workers that hold a service binding to it.
 */
export function rejectFetch(): Response {
  return new Response("Not found", { status: 404 });
}
