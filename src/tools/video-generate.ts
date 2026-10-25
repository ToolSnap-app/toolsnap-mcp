import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { resolveSourceAsDataUri, DEFAULT_MAX_SOURCE_BYTES } from "../fal/client.js";
import { checkFalBudget, recordFalCost } from "../fal/budget.js";
import { FAL_COSTS, videoGenerateCogsMicro, MAX_VIDEO_SECONDS } from "../fal/pricing.js";
import { submitFalQueue } from "../fal/queue.js";
import { createMediaJob } from "../fal/media-jobs.js";

/**
 * video_generate (Fase 13.1b) — async text/image-to-video via fal.ai's queue
 * API (rendering takes 1-6 minutes, too long for a synchronous MCP call).
 *
 * Submits the job, charges the quoted price UPFRONT (see PAYMENT RAILS
 * below), and returns { job_id, status: "queued", poll_tool: "media_job" }
 * immediately. Poll with media_job(job_id) — free — until status is "done"
 * (or "failed").
 *
 * PAYMENT RAILS & REFUNDS: prepaid / api_key / oauth calls that fail AFTER
 * the job was already queued (discovered later, during polling) get
 * refunded automatically — see media-job.ts. Pay-per-call (x402/crypto)
 * settles on-chain right after this submit call succeeds, same as every
 * other paid tool; if the render itself later fails there is NO on-chain
 * refund path (a payout would need a new relayer transaction, which this
 * server does not implement) — use prepaid or an API key/OAuth account if
 * you want a refundable video render.
 *
 * VIDEO_PAYMENT_CONTEXT_KEY: server.ts's payment gate injects payer/rail
 * info under this reserved arg key right before calling this tool (for
 * every rail, so every job's row always has a payment_type) — it is
 * stripped from the returned job metadata and never forwarded to fal.
 */
export const VIDEO_PAYMENT_CONTEXT_KEY = "__payment_context";

export interface VideoPaymentContext {
  paymentType: string; // 'prepaid' | 'api_key' | 'oauth' | 'x402' | 'admin' | 'whitelisted'
  payer: string;
  refundAddress: string | null;
  refundNonce: string | null;
  /** The EXACT amount actually charged for this call (payPerCallMicro or prepaidMicro,
   *  whichever rail applies) — the tool must persist this verbatim, not recompute it
   *  from cogsMicro, so a later refund credits back exactly what was debited. */
  priceMicro: bigint;
}

interface KlingResponse {
  video: { url: string; content_type?: string; file_size?: number };
}

const HANDLED_AT_SERVER =
  "video_generate is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

async function runVideoGenerate(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.FAL_API_KEY) throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  if (!env.PREPAID_DB) throw new Error("D1 database is not configured (PREPAID_DB).");

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string");

  const modelKey = typeof args.model === "string" ? args.model : "ltx-fast";
  if (modelKey !== "ltx-fast" && modelKey !== "kling-pro") {
    throw new Error(`Unknown model "${modelKey}". Allowed: ltx-fast, kling-pro`);
  }

  const cogsMicro = videoGenerateCogsMicro(args);
  await checkFalBudget(env, cogsMicro);

  let falModel: string;
  const body: Record<string, unknown> = { prompt };

  if (modelKey === "ltx-fast") {
    // Params locked to keep the flat $0.04/video price valid — see
    // src/fal/pricing.ts FAL_COSTS.video_generate["ltx-fast"].
    falModel = FAL_COSTS.video_generate["ltx-fast"].model;
    body.resolution = "480p";
    body.num_frames = 121; // ~5s @ 24fps
  } else {
    const durationStr = args.duration !== undefined ? String(args.duration) : "5";
    if (durationStr !== "5" && durationStr !== "10") {
      throw new Error(`duration must be "5" or "10" (seconds), got "${durationStr}"`);
    }
    if (Number(durationStr) > MAX_VIDEO_SECONDS) {
      throw new Error(`duration too large — max ${MAX_VIDEO_SECONDS}s per call`);
    }
    body.duration = durationStr;
    body.aspect_ratio = typeof args.aspect_ratio === "string" ? args.aspect_ratio : "16:9";
    // Forced off: audio-on doubles fal's per-second rate ($0.14 vs $0.07),
    // which this integration doesn't price for — keep the quote honest.
    body.generate_audio = false;

    const imageUrl = typeof args.image_url === "string" ? args.image_url.trim() : "";
    if (imageUrl) {
      body.image_url = await resolveSourceAsDataUri(imageUrl, env, {
        defaultMimeType: "image/jpeg",
        maxBytes: DEFAULT_MAX_SOURCE_BYTES,
      });
      falModel = FAL_COSTS.video_generate["kling-pro"].modelImageToVideo;
    } else {
      falModel = FAL_COSTS.video_generate["kling-pro"].modelTextToVideo;
    }
  }

  const submitted = await submitFalQueue(falModel, body, env);

  // The submit call is the point of commitment with fal (they start billing
  // as soon as the job is queued), so the daily breaker must count it here —
  // not after the render completes, which could be minutes away or never
  // happen. Same pattern as image-generate.ts's recordFalCost call.
  await recordFalCost(env, cogsMicro);

  const rawCtx = args[VIDEO_PAYMENT_CONTEXT_KEY];
  const paymentCtx: VideoPaymentContext =
    rawCtx && typeof rawCtx === "object" && "priceMicro" in (rawCtx as object)
      ? (rawCtx as VideoPaymentContext)
      : { paymentType: "unknown", payer: "anon", refundAddress: null, refundNonce: null, priceMicro: 0n };

  const jobId = crypto.randomUUID();
  await createMediaJob(env.PREPAID_DB, {
    jobId,
    payer: paymentCtx.payer,
    paymentType: paymentCtx.paymentType,
    refundAddress: paymentCtx.refundAddress,
    refundNonce: paymentCtx.refundNonce,
    tool: "video_generate",
    model: falModel,
    priceMicro: paymentCtx.priceMicro,
    falRequestId: submitted.request_id,
    falStatusUrl: submitted.status_url,
    falResponseUrl: submitted.response_url,
  });

  return JSON.stringify({
    job_id: jobId,
    status: "queued",
    model: falModel,
    estimated_seconds: modelKey === "ltx-fast" ? 60 : 180,
    poll_tool: "media_job",
    poll_args: { job_id: jobId },
  });
}

export const videoGenerateTool: McpTool = {
  name: "video_generate",
  description:
    `Generate a short video from a text prompt (and optionally a source image) via fal.ai — ASYNC: returns a job_id immediately, poll with the free media_job(job_id) tool until status is "done". Two models: "ltx-fast" (default, ~5s, $0.08 pay-per-call flat) or "kling-pro" (higher quality, 5 or 10s, $0.07/s — from $0.70). Max ${MAX_VIDEO_SECONDS}s. Prepaid/API-key/OAuth calls are refunded automatically if the render later fails; pay-per-call (crypto) settles at submit and is NOT refundable if the render fails afterward — use prepaid for refundable video. No first-call-free (real COGS).`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text description of the video to generate." },
      model: {
        type: "string",
        description: '"ltx-fast" (default, ~5s clip, flat $0.08) or "kling-pro" (5 or 10s, $0.07/s, higher quality).',
        enum: ["ltx-fast", "kling-pro"],
        default: "ltx-fast",
      },
      duration: {
        type: "string",
        description: 'kling-pro only: "5" or "10" (seconds). Ignored for ltx-fast (fixed ~5s).',
        enum: ["5", "10"],
        default: "5",
      },
      image_url: {
        type: "string",
        description: "kling-pro only: optional source image URL for image-to-video (otherwise text-to-video).",
      },
      aspect_ratio: {
        type: "string",
        description: 'kling-pro only: "16:9" (default), "9:16", or "1:1".',
        enum: ["16:9", "9:16", "1:1"],
        default: "16:9",
      },
    },
    required: ["prompt"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runVideoGenerate(args, env as Env);
  },
};
