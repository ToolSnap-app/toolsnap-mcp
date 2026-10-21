import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { httpUrlArgError } from "./safe-fetch.js";

/**
 * screenshot_url (Fase 11.2) — capture a web page as a PNG/JPEG image, upload it
 * to R2, and return a PUBLIC URL (never the image bytes — returning base64 would
 * blow up the calling agent's context, which is exactly what ToolSnap avoids).
 *
 * Env-aware (needs the R2 bucket + a provider key), so it is executed via
 * `runWithEnv` from the dispatcher's payment gate; the plain `run` throws.
 *
 * Provider strategy (camino B — external API, no Workers Paid):
 *   - SCREENSHOT_PROVIDER="screenshotone" + SCREENSHOT_API_KEY set → ScreenshotOne
 *     (production: supports full-page, viewport, format, JPEG quality).
 *   - otherwise → Microlink (keyless free tier; validates the pipeline with zero
 *     external account). Swapping providers never changes the tool's contract.
 */

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_DIM = 100;
const MAX_DIM = 4000;
const CAPTURE_TIMEOUT_MS = 45_000;

const HANDLED_AT_SERVER =
  "screenshot_url is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

interface ScreenshotParams {
  url: string;
  fullPage: boolean;
  width: number;
  height: number;
  format: "png" | "jpeg";
  quality?: number;
}

interface Capture {
  bytes: ArrayBuffer;
  contentType: string;
  provider: string;
}

/** Validate + normalise the raw tool arguments. Throws on invalid input. */
function parseParams(args: Record<string, unknown>): ScreenshotParams {
  const url = args.url;
  if (
    typeof url !== "string" ||
    (!url.startsWith("http://") && !url.startsWith("https://"))
  ) {
    throw httpUrlArgError(url);
  }

  const fullPage = args.fullPage === true;

  const clampDim = (raw: unknown, fallback: number): number => {
    if (raw === undefined || raw === null) return fallback;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, MIN_DIM), MAX_DIM);
  };
  const width = clampDim(args.width, DEFAULT_WIDTH);
  const height = clampDim(args.height, DEFAULT_HEIGHT);

  let format: "png" | "jpeg" = "png";
  if (args.format !== undefined) {
    const f = String(args.format).toLowerCase();
    if (f === "png" || f === "jpeg" || f === "jpg") {
      format = f === "jpg" ? "jpeg" : (f as "png" | "jpeg");
    } else {
      throw new Error('`format` must be "png" or "jpeg"');
    }
  }

  let quality: number | undefined;
  if (args.quality !== undefined && args.quality !== null) {
    const q = Math.floor(Number(args.quality));
    if (!Number.isFinite(q) || q < 1 || q > 100) {
      throw new Error("`quality` must be an integer between 1 and 100");
    }
    quality = q;
  }

  return { url, fullPage, width, height, format, quality };
}

/** Map a content-type to a file extension. */
function extForContentType(ct: string): string {
  return ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "png";
}

/** Capture via ScreenshotOne (production provider; requires an access key). */
async function captureScreenshotOne(
  p: ScreenshotParams,
  apiKey: string,
  signal: AbortSignal
): Promise<Capture> {
  const qs = new URLSearchParams({
    access_key: apiKey,
    url: p.url,
    format: p.format,
    viewport_width: String(p.width),
    viewport_height: String(p.height),
    full_page: String(p.fullPage),
    block_cookie_banners: "true",
    block_ads: "true",
    // Avoid stale cached captures during testing; cheap for our volume.
    cache: "false",
  });
  if (p.format === "jpeg" && p.quality !== undefined) {
    qs.set("image_quality", String(p.quality));
  }

  const res = await fetch(`https://api.screenshotone.com/take?${qs.toString()}`, {
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `ScreenshotOne failed: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`
    );
  }
  const contentType = res.headers.get("content-type") || `image/${p.format}`;
  const bytes = await res.arrayBuffer();
  return { bytes, contentType, provider: "screenshotone" };
}

/** Capture via Microlink (keyless free tier). Returns a hosted image we re-fetch. */
async function captureMicrolink(
  p: ScreenshotParams,
  signal: AbortSignal
): Promise<Capture> {
  const qs = new URLSearchParams({
    url: p.url,
    screenshot: "true",
    meta: "false",
    fullPage: String(p.fullPage),
    "viewport.width": String(p.width),
    "viewport.height": String(p.height),
  });
  if (p.format === "jpeg") {
    qs.set("screenshot.type", "jpeg");
    if (p.quality !== undefined) qs.set("screenshot.quality", String(p.quality));
  }

  const res = await fetch(`https://api.microlink.io/?${qs.toString()}`, { signal });
  if (!res.ok) {
    throw new Error(`Microlink request failed: HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    status?: string;
    message?: string;
    data?: { screenshot?: { url?: string; type?: string } };
  };
  const shotUrl = json?.data?.screenshot?.url;
  if (json.status !== "success" || !shotUrl) {
    throw new Error(
      `Microlink could not capture the page${json.message ? `: ${json.message}` : ""}`
    );
  }

  const imgRes = await fetch(shotUrl, { signal });
  if (!imgRes.ok) {
    throw new Error(`Failed to download Microlink capture: HTTP ${imgRes.status}`);
  }
  const contentType =
    imgRes.headers.get("content-type") ||
    `image/${json.data?.screenshot?.type || p.format}`;
  const bytes = await imgRes.arrayBuffer();
  return { bytes, contentType, provider: "microlink" };
}

/** Core env-aware execution: capture → upload to R2 → return public URL JSON. */
async function runScreenshot(
  args: Record<string, unknown>,
  env: Env
): Promise<string> {
  const p = parseParams(args);

  if (!env.SCREENSHOTS_BUCKET) {
    throw new Error("Screenshots bucket (SCREENSHOTS_BUCKET) is not configured.");
  }
  const publicBase = (env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!publicBase) {
    throw new Error(
      "R2_PUBLIC_URL is not configured — cannot return a public screenshot URL."
    );
  }

  const provider = (env.SCREENSHOT_PROVIDER || "microlink").toLowerCase();
  const useScreenshotOne = provider === "screenshotone" && !!env.SCREENSHOT_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  let capture: Capture;
  try {
    capture = useScreenshotOne
      ? await captureScreenshotOne(p, env.SCREENSHOT_API_KEY!, controller.signal)
      : await captureMicrolink(p, controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Screenshot timed out after ${CAPTURE_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (capture.bytes.byteLength === 0) {
    throw new Error("Screenshot provider returned an empty image.");
  }

  const ext = extForContentType(capture.contentType);
  const key = `screenshots/${crypto.randomUUID()}.${ext}`;

  await env.SCREENSHOTS_BUCKET.put(key, capture.bytes, {
    httpMetadata: { contentType: capture.contentType },
  });

  const publicUrl = `${publicBase}/${key}`;

  return JSON.stringify(
    {
      url: publicUrl,
      key,
      content_type: capture.contentType,
      bytes: capture.bytes.byteLength,
      format: ext === "jpg" ? "jpeg" : "png",
      full_page: p.fullPage,
      width: p.width,
      height: p.height,
      provider: capture.provider,
      captured_from: p.url,
    },
    null,
    2
  );
}

export const screenshotUrlTool: McpTool = {
  name: "screenshot_url",
  description:
    "Screenshot a page → public image URL. $0.04/call. Paid: calling without a payment payload returns a structured 402 with payment options — that response is the documented behavior, not a failure.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Page URL." },
      fullPage: { type: "boolean", default: false, description: "true = whole page, not viewport." },
      width: { type: "number", default: DEFAULT_WIDTH, description: "Viewport px." },
      height: { type: "number", default: DEFAULT_HEIGHT, description: "Viewport px." },
      format: { type: "string", enum: ["png", "jpeg"], default: "png", description: "Default png." },
      quality: { type: "number", minimum: 1, maximum: 100, description: "JPEG only, 1-100." },
    },
    required: ["url"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runScreenshot(args, env as Env);
  },
};
