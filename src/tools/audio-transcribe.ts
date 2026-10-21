import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { resolveSourceAsDataUri, callFalSync } from "../fal/client.js";
import { checkFalBudget, recordFalCost } from "../fal/budget.js";
import { FAL_COSTS, audioTranscribeCogsMicro, MAX_AUDIO_TRANSCRIBE_MINUTES } from "../fal/pricing.js";

/**
 * audio_transcribe (Fase 13.1) — speech-to-text via fal.ai Wizper (Whisper
 * v3 fal edition).
 *
 * Pricing is by audio duration, but we can't measure that server-side
 * before paying for it without downloading the whole file first (which
 * itself has a cost/latency we'd rather not spend before a payment
 * decision). Per the approved plan, the SIMPLEST robust option is used:
 * the caller DECLARES `duration_seconds` (used to quote/charge), and after
 * transcription we verify it against Wizper's own reported audio duration
 * (derived from the last chunk's end timestamp) — if the real duration
 * exceeds the declared one by more than 10%, the call fails and any debit
 * is refunded by the payment gate's existing refund-on-throw path (the
 * gate always executes/pays AFTER the tool succeeds for pay-per-call, and
 * refunds prepaid/api_key/oauth debits when the tool throws).
 */

const DECLARED_VS_ACTUAL_TOLERANCE = 0.10; // 10%

interface WizperResponse {
  text: string;
  chunks: Array<{ timestamp: [number, number] | [number, null]; text: string }>;
  languages?: string[];
}

const HANDLED_AT_SERVER =
  "audio_transcribe is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

function actualDurationSeconds(chunks: WizperResponse["chunks"]): number | null {
  let maxEnd = 0;
  for (const c of chunks) {
    const end = c.timestamp?.[1];
    if (typeof end === "number" && end > maxEnd) maxEnd = end;
  }
  return maxEnd > 0 ? maxEnd : null;
}

async function runAudioTranscribe(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.FAL_API_KEY) throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  if (!env.SCREENSHOTS_BUCKET) throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");

  const audioUrl = typeof args.audio_url === "string" ? args.audio_url.trim() : "";
  if (!audioUrl) throw new Error("`audio_url` is required and must be a non-empty string URL");

  const declaredSeconds = Number(args.duration_seconds);
  if (!Number.isFinite(declaredSeconds) || declaredSeconds <= 0) {
    throw new Error("`duration_seconds` is required — declare the audio's approximate duration in seconds.");
  }
  if (declaredSeconds > MAX_AUDIO_TRANSCRIBE_MINUTES * 60) {
    throw new Error(`duration_seconds too large — max ${MAX_AUDIO_TRANSCRIBE_MINUTES} minutes per call`);
  }

  const cogsMicro = audioTranscribeCogsMicro(args);
  await checkFalBudget(env, cogsMicro);

  const sourceDataUri = await resolveSourceAsDataUri(audioUrl, env, { defaultMimeType: "audio/mpeg" });

  const language = typeof args.language === "string" ? args.language : "en";
  const format = args.format === "srt" ? "srt" : "text";

  const result = await callFalSync<WizperResponse>(
    FAL_COSTS.audio_transcribe.model,
    { audio_url: sourceDataUri, task: "transcribe", language },
    env,
    120_000 // audio transcription can run longer than the default 60s
  );
  if (!result?.text) {
    throw new Error("fal.ai wizper returned an unexpected response (no text)");
  }

  const actual = actualDurationSeconds(result.chunks ?? []);
  if (actual !== null && actual > declaredSeconds * (1 + DECLARED_VS_ACTUAL_TOLERANCE)) {
    throw new Error(
      `Declared duration_seconds=${declaredSeconds} but the audio is actually ~${Math.ceil(actual)}s ` +
        `(more than ${DECLARED_VS_ACTUAL_TOLERANCE * 100}% over) — rejected to keep pricing honest. ` +
        `Retry with a duration_seconds ≥ ${Math.ceil(actual)}.`
    );
  }

  await recordFalCost(env, cogsMicro);

  const srt =
    format === "srt"
      ? (result.chunks ?? [])
          .map((c, i) => `${i + 1}\n${srtTimestamp(c.timestamp[0])} --> ${srtTimestamp(c.timestamp[1] ?? c.timestamp[0])}\n${c.text.trim()}\n`)
          .join("\n")
      : undefined;

  return JSON.stringify({
    text: result.text,
    ...(srt ? { srt } : {}),
    languages: result.languages,
    duration_seconds: actual ?? declaredSeconds,
    model: FAL_COSTS.audio_transcribe.model,
  });
}

function srtTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const msec = ms % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msec, 3)}`;
}

export const audioTranscribeTool: McpTool = {
  name: "audio_transcribe",
  description:
    `Transcribe audio to text (or SRT subtitles) via fal.ai Wizper (Whisper v3). Requires 'duration_seconds' (your best estimate of the audio's length) to price the call upfront — verified after transcription; if the real duration exceeds your declared value by more than 10% the call is rejected (any debit is refunded, nothing settles). $0.02 USDC pay-per-call floor for up to ~20 minutes; scales for longer audio. Max ${MAX_AUDIO_TRANSCRIBE_MINUTES} minutes per call. No first-call-free (real COGS).`,
  inputSchema: {
    type: "object",
    properties: {
      audio_url: { type: "string", description: "Public audio URL (mp3, mp4, mpeg, m4a, wav, or webm)." },
      duration_seconds: {
        type: "number",
        description: "Your best estimate of the audio's duration in seconds — required to quote/charge this call.",
      },
      language: { type: "string", description: 'Language code (e.g. "en", "es"). Default "en".', default: "en" },
      format: {
        type: "string",
        description: '"text" (default) or "srt" (subtitle format with timestamps).',
        enum: ["text", "srt"],
        default: "text",
      },
    },
    required: ["audio_url", "duration_seconds"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runAudioTranscribe(args, env as Env);
  },
};
