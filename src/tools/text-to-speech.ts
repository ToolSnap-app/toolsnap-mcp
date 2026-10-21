import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { callFalSync, downloadAndRehost } from "../fal/client.js";
import { checkFalBudget, recordFalCost } from "../fal/budget.js";
import { FAL_COSTS, textToSpeechCogsMicro, MAX_TTS_CHARS } from "../fal/pricing.js";

/**
 * text_to_speech (Fase 13.1) — text-to-speech via fal.ai Kokoro TTS.
 * Dynamically priced from text length (see src/fal/pricing.ts).
 */

const KOKORO_VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova",
  "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa",
];

interface KokoroResponse {
  audio: { url: string; content_type?: string; file_size?: number };
}

const HANDLED_AT_SERVER =
  "text_to_speech is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

async function runTextToSpeech(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.FAL_API_KEY) throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  if (!env.SCREENSHOTS_BUCKET) throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");

  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) throw new Error("`text` is required and must be a non-empty string");
  if (text.length > MAX_TTS_CHARS) throw new Error(`text too long — max ${MAX_TTS_CHARS} characters per call`);

  const voice = typeof args.voice === "string" && KOKORO_VOICES.includes(args.voice) ? args.voice : "af_heart";
  const speed = args.speed !== undefined ? Number(args.speed) : 1;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error("`speed` must be a number between 0.5 and 2");
  }

  const cogsMicro = textToSpeechCogsMicro(args);
  await checkFalBudget(env, cogsMicro);

  const result = await callFalSync<KokoroResponse>(
    FAL_COSTS.text_to_speech.model,
    { prompt: text, voice, speed },
    env
  );
  if (!result?.audio?.url) {
    throw new Error("fal.ai kokoro returned an unexpected response (no audio URL)");
  }

  const { url, bytes } = await downloadAndRehost(result.audio.url, env, "media/text_to_speech", "wav", "audio/wav");

  await recordFalCost(env, cogsMicro);

  return JSON.stringify({
    url,
    voice,
    chars: text.length,
    file_size_bytes: bytes,
    model: FAL_COSTS.text_to_speech.model,
  });
}

export const textToSpeechTool: McpTool = {
  name: "text_to_speech",
  description:
    `Convert text to speech via fal.ai Kokoro TTS (20 English voices). Returns a public R2 URL to a WAV file (never raw bytes, expires ~24h). Priced dynamically per call from text length: $0.02 USDC pay-per-call floor for up to ~500 characters, scales linearly beyond that. Max ${MAX_TTS_CHARS} characters per call. No first-call-free (real COGS).`,
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: `Text to synthesize (max ${MAX_TTS_CHARS} characters).` },
      voice: {
        type: "string",
        description: 'Kokoro voice id. Default "af_heart".',
        enum: KOKORO_VOICES,
        default: "af_heart",
      },
      speed: {
        type: "number",
        description: "Playback speed multiplier (0.5-2). Default 1.",
        default: 1,
        minimum: 0.5,
        maximum: 2,
      },
    },
    required: ["text"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runTextToSpeech(args, env as Env);
  },
};
