import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { callFalSync, downloadAndRehost } from "../fal/client.js";
import { checkFalBudget, recordFalCost } from "../fal/budget.js";
import { FAL_COSTS, imageGenerateCogsMicro, megapixelsForImageSize, MAX_IMAGE_GENERATE_NUM_IMAGES } from "../fal/pricing.js";

/**
 * image_generate (Fase 13.1) — text-to-image via fal.ai FLUX models.
 * Dynamically priced from model + image_size + num_images (see
 * src/fal/pricing.ts). Returns public R2 URLs, never raw bytes.
 */

interface FluxResponse {
  images: Array<{ url: string; width: number; height: number; content_type?: string }>;
  seed?: number;
}

const HANDLED_AT_SERVER =
  "image_generate is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

async function runImageGenerate(args: Record<string, unknown>, env: Env): Promise<string> {
  if (!env.FAL_API_KEY) throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  if (!env.SCREENSHOTS_BUCKET) throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string");

  const modelKey = typeof args.model === "string" ? args.model : "flux-schnell";
  const modelCfg = (FAL_COSTS.image_generate as Record<string, { model: string; usdPerMegapixel: number }>)[
    modelKey
  ];
  if (!modelCfg) {
    throw new Error(`Unknown model "${modelKey}". Allowed: ${Object.keys(FAL_COSTS.image_generate).join(", ")}`);
  }

  let numImages = 1;
  if (args.num_images !== undefined) {
    const n = Number(args.num_images);
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_GENERATE_NUM_IMAGES) {
      throw new Error(`num_images must be an integer between 1 and ${MAX_IMAGE_GENERATE_NUM_IMAGES}`);
    }
    numImages = n;
  }

  // Validates image_size the same way the pricer does (throws on unknown size).
  megapixelsForImageSize(args.image_size);

  const cogsMicro = imageGenerateCogsMicro(args);
  await checkFalBudget(env, cogsMicro);

  const body: Record<string, unknown> = { prompt, num_images: numImages };
  if (args.image_size !== undefined) body.image_size = args.image_size;

  const result = await callFalSync<FluxResponse>(modelCfg.model, body, env);
  if (!result?.images?.length) {
    throw new Error("fal.ai image_generate returned an unexpected response (no images)");
  }

  const uploaded: Array<{ url: string; width: number; height: number }> = [];
  for (const img of result.images) {
    const ext = (img.content_type ?? "image/jpeg").includes("png") ? "png" : "jpg";
    const contentType = ext === "png" ? "image/png" : "image/jpeg";
    const { url } = await downloadAndRehost(img.url, env, "media/image_generate", ext, contentType);
    uploaded.push({ url, width: img.width, height: img.height });
  }

  await recordFalCost(env, cogsMicro);

  return JSON.stringify({
    images: uploaded,
    model: modelCfg.model,
    prompt,
    seed: result.seed,
  });
}

export const imageGenerateTool: McpTool = {
  name: "image_generate",
  description:
    'Generate an image from a text prompt via fal.ai FLUX models. Returns one or more public R2 URLs (never raw bytes, expires ~24h). Priced dynamically per call from model + image_size + num_images — from $0.02 USDC pay-per-call (flux-schnell, 1 image, default size). Paid: calling without a payment payload returns a structured 402 with the exact quoted price. No first-call-free (real COGS).',
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text description of the image to generate." },
      model: {
        type: "string",
        description: '"flux-schnell" (default, fast/cheap, $0.003/MP) or "flux-dev" (higher quality, $0.025/MP).',
        enum: ["flux-schnell", "flux-dev"],
        default: "flux-schnell",
      },
      image_size: {
        type: "string",
        description: "Output size preset. Default landscape_4_3 (~1 megapixel).",
        enum: ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"],
        default: "landscape_4_3",
      },
      num_images: {
        type: "number",
        description: `Number of images to generate in this call (1-${MAX_IMAGE_GENERATE_NUM_IMAGES}). Price scales linearly.`,
        default: 1,
        minimum: 1,
        maximum: MAX_IMAGE_GENERATE_NUM_IMAGES,
      },
    },
    required: ["prompt"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runImageGenerate(args, env as Env);
  },
};
