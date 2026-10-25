import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { getFalQueueStatus, getFalQueueResult, FalQueueHttpError } from "../fal/queue.js";
import { downloadAndRehost } from "../fal/client.js";
import {
  getMediaJob,
  markMediaJobDone,
  markMediaJobRunning,
  markMediaJobFailed,
  markMediaJobRefunded,
  type MediaJobRow,
} from "../fal/media-jobs.js";
import { refundDebit, microToUsdc } from "../x402/prepaid.js";

/**
 * media_job (Fase 13.1b) — free polling tool for video_generate's async
 * jobs. Idempotent: once a job is "done" it just returns the cached R2 URL
 * without touching fal again.
 *
 * Access control: job_id is a randomly-generated v4 UUID (122 bits of
 * entropy) — this server treats knowledge of the job_id itself as
 * sufficient authorization to poll it (the same model Stripe Checkout
 * sessions and most async job APIs use), rather than binding it to the
 * original caller's identity. Documented deliberate choice (see the plan)
 * — anyone who received the job_id from a video_generate response, or to
 * whom it was forwarded, can poll and read the result.
 *
 * REFUND ON FAILURE: if fal reports the render failed (or the job's status
 * URL/response is unusable), and the job's payment_type is refundable
 * (prepaid/api_key/oauth — both use the same debitBalance/refundDebit D1
 * ledger under the hood), this credits the exact original price_micro back
 * to refund_address and marks the job "refunded". Pay-per-call (x402) jobs
 * have no refund_address (settled on-chain at submit) — see video-generate.ts.
 *
 * TRANSIENT VS DEFINITIVE FAILURES (Fase 13.1c): a blip talking to fal (a
 * status-check timeout, a network error, a 5xx, or a failed mp4
 * download/rehost) must NOT kill a job that may still be rendering fine on
 * fal's side — that would refund the customer while fal keeps our COGS and
 * the eventual result is discarded. Only fail+refund on: an HTTP 4xx from
 * fal's queue API (the request/job itself is invalid or expired), a
 * COMPLETED result with no video URL, or the job exceeding
 * MEDIA_JOB_MAX_AGE_SECONDS while still queued/running (catches orphaned
 * jobs too — fal never got back to us at all). Everything else is reported
 * back as a transient_error without touching the job's status, so the next
 * poll tries again.
 *
 * DOUBLE-REFUND GUARD: markMediaJobFailed only transitions a job that is
 * still 'queued'/'running' and reports whether it won that transition
 * (D1's meta.changes). Two concurrent polls both discovering the same
 * failure will only have ONE of them return true — only that caller
 * refunds; the loser re-reads and reports the job's already-resolved state.
 */

const REFUNDABLE_PAYMENT_TYPES = new Set(["prepaid", "api_key", "oauth"]);

/** Jobs stuck queued/running past this age are presumed dead (orphaned or
 *  fal never completing them) and get force-failed + refunded on next poll. */
const MEDIA_JOB_MAX_AGE_SECONDS = 3600;

interface FalVideoResult {
  video?: { url: string; content_type?: string };
}

async function refundIfApplicable(
  env: Env,
  jobId: string,
  job: { payment_type: string; refund_address: string | null; refund_nonce: string | null; price_micro: number; tool: string }
): Promise<{ refunded: boolean; balanceUsdc?: string }> {
  if (
    !REFUNDABLE_PAYMENT_TYPES.has(job.payment_type) ||
    !job.refund_address ||
    !job.refund_nonce ||
    job.price_micro <= 0
  ) {
    return { refunded: false };
  }
  try {
    const balanceAfter = await refundDebit(
      env.PREPAID_DB,
      job.refund_address,
      BigInt(job.price_micro),
      job.tool,
      job.refund_nonce
    );
    await markMediaJobRefunded(env.PREPAID_DB, jobId);
    return { refunded: true, balanceUsdc: microToUsdc(balanceAfter) };
  } catch {
    // Refund failure must never crash the status response — the job stays
    // "failed" (not "refunded"), visible for manual reconciliation.
    return { refunded: false };
  }
}

/**
 * Definitively fail a job and refund if applicable — but ONLY for whichever
 * caller actually wins the queued/running -> failed transition
 * (markMediaJobFailed's guarded UPDATE, Fase 13.1c). If another concurrent
 * poll already resolved this job (won the race, or it finished normally in
 * between), re-read the current row and report that instead of refunding a
 * second time.
 */
async function failJobOnce(env: Env, jobId: string, job: MediaJobRow, message: string): Promise<string> {
  const won = await markMediaJobFailed(env.PREPAID_DB, jobId, message);
  if (!won) {
    const fresh = await getMediaJob(env.PREPAID_DB, jobId);
    if (!fresh) {
      return JSON.stringify({ job_id: jobId, status: "failed", error: message });
    }
    if (fresh.status === "done") {
      return JSON.stringify({ job_id: jobId, status: "done", result_url: fresh.result_url });
    }
    return JSON.stringify({ job_id: jobId, status: fresh.status, error: fresh.error });
  }
  const refund = await refundIfApplicable(env, jobId, job);
  return JSON.stringify({ job_id: jobId, status: refund.refunded ? "refunded" : "failed", error: message, ...refund });
}

/** True if an error carries a definitive (non-retryable) fal.ai HTTP status — a 4xx
 *  means the request/job itself is invalid or expired, not a transient upstream blip. */
export function isDefinitiveHttpError(err: unknown): boolean {
  return err instanceof FalQueueHttpError && err.httpStatus >= 400 && err.httpStatus < 500;
}

function transientResponse(jobId: string, status: string, message: string): string {
  return JSON.stringify({
    job_id: jobId,
    status,
    transient_error: message,
    note: "temporary upstream error — poll again in ~30s",
  });
}

async function runMediaJob(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.PREPAID_DB) throw new Error("D1 database is not configured (PREPAID_DB).");
  if (!env.SCREENSHOTS_BUCKET) throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");

  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) throw new Error("`job_id` is required and must be a non-empty string");

  const job = await getMediaJob(env.PREPAID_DB, jobId);
  if (!job) throw new Error(`No job found for job_id "${jobId}"`);

  if (job.status === "done") {
    return JSON.stringify({ job_id: jobId, status: "done", result_url: job.result_url });
  }
  if (job.status === "failed" || job.status === "refunded") {
    return JSON.stringify({ job_id: jobId, status: job.status, error: job.error });
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - job.created_at;
  const isExpired = ageSeconds > MEDIA_JOB_MAX_AGE_SECONDS;

  // status is "queued" or "running" — check fal.
  let falStatus: Awaited<ReturnType<typeof getFalQueueStatus>>;
  try {
    falStatus = await getFalQueueStatus(job.fal_status_url, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitiveHttpError(err) || isExpired) {
      const failMessage = isExpired
        ? `render did not complete within ${MEDIA_JOB_MAX_AGE_SECONDS / 3600}h (last error: ${message})`
        : message;
      return await failJobOnce(env, jobId, job, failMessage);
    }
    // Transient: a status-check timeout, network error, or fal 5xx. The
    // render may still be in progress — do NOT fail/refund on a blip.
    return transientResponse(jobId, job.status, message);
  }

  if (falStatus.status === "IN_QUEUE" || falStatus.status === "IN_PROGRESS") {
    if (isExpired) {
      return await failJobOnce(
        env,
        jobId,
        job,
        `render did not complete within ${MEDIA_JOB_MAX_AGE_SECONDS / 3600}h (fal still reports ${falStatus.status})`
      );
    }
    if (falStatus.status === "IN_PROGRESS" && job.status === "queued") {
      await markMediaJobRunning(env.PREPAID_DB, jobId);
    }
    return JSON.stringify({
      job_id: jobId,
      status: falStatus.status === "IN_QUEUE" ? "queued" : "running",
      queue_position: falStatus.queue_position,
    });
  }

  // COMPLETED — fetch the result and re-host it.
  let result: FalVideoResult;
  try {
    result = await getFalQueueResult<FalVideoResult>(job.fal_response_url, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitiveHttpError(err) || isExpired) {
      return await failJobOnce(env, jobId, job, message);
    }
    // Transient: network error or fal 5xx fetching the result — try again later.
    return transientResponse(jobId, job.status, message);
  }

  if (!result?.video?.url) {
    // fal genuinely says COMPLETED with nothing to show for it — definitive.
    return await failJobOnce(env, jobId, job, "fal.ai queue result had no video URL");
  }

  let url: string;
  try {
    ({ url } = await downloadAndRehost(result.video.url, env, "media/video_generate", "mp4", "video/mp4"));
  } catch (err) {
    // The render succeeded on fal's side; a failure here is us failing to
    // download/rehost the CDN mp4 — always transient (network/R2 blip), and
    // failing the job here would refund a customer for a video that exists.
    const message = err instanceof Error ? err.message : String(err);
    if (isExpired) {
      return await failJobOnce(
        env,
        jobId,
        job,
        `render completed on fal but could not be retrieved within ${MEDIA_JOB_MAX_AGE_SECONDS / 3600}h (last error: ${message})`
      );
    }
    return transientResponse(jobId, job.status, message);
  }

  await markMediaJobDone(env.PREPAID_DB, jobId, url);
  return JSON.stringify({ job_id: jobId, status: "done", result_url: url });
}

export const mediaJobTool: McpTool = {
  name: "media_job",
  description:
    'Poll the status/result of an async media job (currently video_generate). Free. Returns {status: "queued"|"running"|"done"|"failed"|"refunded", result_url?, error?}. Idempotent — once "done", repeated calls return the cached URL without contacting fal.ai again. If the render fails after a prepaid/API-key/OAuth charge, this automatically refunds the exact amount charged (pay-per-call/crypto has no refund path — see video_generate).',
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The job_id returned by video_generate." },
    },
    required: ["job_id"],
  },
  run() {
    throw new Error("media_job is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.");
  },
  async runWithEnv(args, env) {
    return runMediaJob(args, env as Env);
  },
};
