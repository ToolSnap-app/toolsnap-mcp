import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { resolveSourceAsDataUri, callFalSync, downloadAndRehost, DEFAULT_MAX_SOURCE_BYTES } from "../fal/client.js";
import { checkFalBudget, recordFalCost } from "../fal/budget.js";
import { FAL_COSTS, imageUpscaleCogsMicro } from "../fal/pricing.js";

/**
 * image_upscale (Fase 13.1) — 2x/4x super-resolution via fal.ai ESRGAN.
 *
 * Pricing note: ESRGAN bills fal by compute-second, not a fixed per-image
 * rate, so the price is a conservative flat estimate per scale factor (see
 * FAL_COSTS.image_upscale in src/fal/pricing.ts) rather than an exact COGS.
 * A source-size cap (enforced by resolveSourceAsDataUri's maxBytes option,
 * shared with video_generate's kling-pro image_url — Fase 13.1c) keeps real
 * runtime within that assumption; the daily budget breaker is the backstop
 * if a call ever runs hotter.
 */

interface EsrganResponse {
  image: { url: string; content_type?: string; width?: number; height?: number };
}

const HANDLED_AT_SERVER =
  "image_upscale is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

async function runImageUpscale(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.FAL_API_KEY) throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  if (!env.SCREENSHOTS_BUCKET) throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");

  const imageUrl = typeof args.image_url === "string" ? args.image_url.trim() : "";
  if (!imageUrl) throw new Error("`image_url` is required and must be a non-empty string URL");

  const scale = args.scale !== undefined ? String(args.scale) : "2";
  if (!(scale in FAL_COSTS.image_upscale.assumedComputeSeconds)) {
    throw new Error(
      `Unsupported scale "${scale}". Allowed: ${Object.keys(FAL_COSTS.image_upscale.assumedComputeSeconds).join(", ")}`
    );
  }

  const cogsMicro = imageUpscaleCogsMicro(args);
  await checkFalBudget(env, cogsMicro);

  const sourceDataUri = await resolveSourceAsDataUri(imageUrl, env, {
    defaultMimeType: "image/jpeg",
    maxBytes: DEFAULT_MAX_SOURCE_BYTES,
  });

  const result = await callFalSync<EsrganResponse>(
    FAL_COSTS.image_upscale.model,
    { image_url: sourceDataUri, scale: Number(scale) },
    env
  );
  if (!result?.image?.url) {
    throw new Error("fal.ai esrgan returned an unexpected response (no image URL)");
  }

  const ext = (result.image.content_type ?? "image/png").includes("jpeg") ? "jpg" : "png";
  const contentType = ext === "jpg" ? "image/jpeg" : "image/png";
  const { url, bytes } = await downloadAndRehost(result.image.url, env, "media/image_upscale", ext, contentType);

  await recordFalCost(env, cogsMicro);

  return JSON.stringify({
    url,
    scale: Number(scale),
    width: result.image.width,
    height: result.image.height,
    file_size_bytes: bytes,
    model: FAL_COSTS.image_upscale.model,
    source_url: imageUrl,
  });
}

export const imageUpscaleTool: McpTool = {
  name: "image_upscale",
  description:
    "Upscale an image 2x or 4x via fal.ai ESRGAN (RealESRGAN_x4plus). Returns a public R2 URL (never raw bytes, expires ~24h). To pass a local image, upload it first with upload_file. $0.02 USDC pay-per-call (scale=2) or $0.03 (scale=4); exact quote in the 402. No first-call-free (real COGS). Source image capped at 6 MB.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "Public image URL (or a /files/ URL from upload_file)." },
      scale: {
        type: "number",
        description: "Upscale factor — 2 or 4 (no other values are supported).",
        default: 2,
      },
    },
    required: ["image_url"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runImageUpscale(args, env as Env);
  },
};
