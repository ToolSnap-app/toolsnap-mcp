import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { resolveSourceAsDataUri, callFalSync, downloadAndRehost } from "../fal/client.js";

/**
 * remove_background (Fase 13.0) — removes the background from an image via
 * fal.ai imageutils/rembg (U²-Net model). Returns a transparent PNG uploaded
 * to R2; never returns raw bytes so context stays clean.
 *
 * Env-aware (needs FAL_API_KEY + SCREENSHOTS_BUCKET + R2_PUBLIC_URL).
 * Pricing: $0.03 pay-per-call / $0.02 prepaid. No first-call-free (COGS).
 *
 * Fase 13.1: refactored onto the shared src/fal/client.ts helpers (same
 * fal → R2 → URL pattern every media tool now uses) — behavior unchanged.
 */

const FAL_REMBG_MODEL = "fal-ai/imageutils/rembg";

const HANDLED_AT_SERVER =
  "remove_background is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

interface FalRembgResponse {
  image: {
    url: string;
    content_type: string;
    file_name?: string;
    file_size?: number;
  };
}

async function runRemoveBackground(
  args: Record<string, unknown>,
  env: Env
): Promise<string> {
  const imageUrl = typeof args.image_url === "string" ? args.image_url.trim() : "";
  if (!imageUrl) throw new Error("`image_url` is required and must be a non-empty string URL");

  if (!env.FAL_API_KEY) {
    throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  }
  if (!env.SCREENSHOTS_BUCKET) {
    throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");
  }

  const sourceDataUri = await resolveSourceAsDataUri(imageUrl, env, { defaultMimeType: "image/jpeg" });

  const falResult = await callFalSync<FalRembgResponse>(FAL_REMBG_MODEL, { image_url: sourceDataUri }, env);

  if (!falResult?.image?.url) {
    throw new Error("fal.ai rembg returned an unexpected response (no image URL)");
  }

  const { url: publicUrl, bytes } = await downloadAndRehost(falResult.image.url, env, "rembg", "png", "image/png");

  return JSON.stringify({
    url: publicUrl,
    format: "png",
    source_url: imageUrl,
    model: FAL_REMBG_MODEL,
    file_size_bytes: bytes,
  });
}

export const removeBackgroundTool: McpTool = {
  name: "remove_background",
  description:
    "Remove an image's background, return a transparent PNG URL. $0.03 USDC/call. Paid: calling without a payment payload returns a structured 402 with payment options — that response is the documented behavior, not a failure.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "Public image URL." },
    },
    required: ["image_url"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runRemoveBackground(args, env as Env);
  },
};
