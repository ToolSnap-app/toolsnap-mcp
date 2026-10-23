/**
 * x402 discovery: makes the paid tools findable by the x402 indexes (CDP
 * Bazaar / agentic.market, x402scan, x402-list).
 *
 * Three pieces, all derived from the same PAID_TOOLS registry the MCP gate
 * bills by, so nothing here can advertise a price the gate won't charge:
 *
 *  1. `extensions.bazaar` declarations — the MCP flavour goes into every MCP
 *     402 (error.data), the HTTP flavour into every HTTP 402 below. Shapes
 *     mirror @x402/extensions/bazaar (createMcpDiscoveryExtension /
 *     createBodyDiscoveryExtension) byte for byte.
 *  2. POST /x402/tools/<name> (src/x402/http-door.ts) — an HTTP door onto
 *     the SAME payment gate. The
 *     indexes only probe HTTP routes and need a real `402` status with a
 *     `PAYMENT-REQUIRED` header; the MCP 402 lives inside JSON-RPC and is
 *     invisible to them. With a `PAYMENT-SIGNATURE` header the request is
 *     re-dispatched as an MCP tools/call carrying that payload in
 *     _meta["x402/payment"], so verify/settle/first-call-free/refund logic is
 *     exactly the MCP one — this file holds no money logic of its own.
 *  3. GET /.well-known/x402 and GET /openapi.json — fan-out documents listing
 *     those HTTP resources (x402scan DISCOVERY.md: OpenAPI first, well-known
 *     as compatibility).
 *
 * Specs: https://github.com/coinbase/x402/blob/main/docs/extensions/bazaar.mdx
 *        https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md
 *        https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
 */

import { listTools } from "../tools/index.js";
import type { McpToolDefinition } from "../mcp/types.js";
import type { Env } from "../index.js";
import {
  requiresPayment,
  getToolPrice,
  DYNAMIC_PRICERS,
  NETWORK,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
} from "./middleware.js";
import { usdcToMicro } from "./prepaid.js";

export const PUBLIC_ORIGIN = "https://mcp.toolsnap.app";
export const HTTP_TOOL_PREFIX = "/x402/tools/";

/** Service metadata on the 402 `resource` object (bazaar.mdx "Service Metadata"). */
export const SERVICE_METADATA = {
  serviceName: "ToolSnap",
  iconUrl: `${PUBLIC_ORIGIN}/img/favicon-512.png`,
} as const;

/**
 * Per-tool listing copy. Kept separate from the MCP tool descriptions on
 * purpose: those talk TO the agent ("call wallet_setup…", "that response is
 * the documented behavior"), which the Bazaar's prompt-injection screening
 * rejects. These only describe what the tool does. `example` must be args the
 * gate can price — the Bazaar crawler calls the tool with them and expects a
 * 402 back, never a pricing error. ≤5 printable-ASCII tags of ≤32 chars.
 */
const LISTING: Record<string, { summary: string; tags: string[]; example: Record<string, unknown> }> = {
  screenshot_url: {
    summary: "Screenshot a web page (viewport or full page) and return a public PNG or JPEG URL.",
    tags: ["screenshot", "web", "browser", "image"],
    example: { url: "https://example.com", fullPage: false },
  },
  fetch_rendered: {
    summary: "Render a JavaScript-heavy page in a headless browser and return its clean visible text.",
    tags: ["scraping", "web", "browser", "extraction"],
    example: { url: "https://example.com", maxChars: 8000 },
  },
  keyword_research: {
    summary: "Google Ads search volume, CPC and competition for 1-20 keywords, with optional related suggestions.",
    tags: ["seo", "keywords", "marketing", "search"],
    example: { keywords: ["mcp server"], language_code: "en", location_code: 2840 },
  },
  remove_background: {
    summary: "Remove the background from an image and return a transparent PNG URL.",
    tags: ["image", "background-removal", "media"],
    example: { image_url: "https://mcp.toolsnap.app/img/og-default.png" },
  },
  image_generate: {
    summary: "Generate images from a text prompt with FLUX (schnell or dev); returns public image URLs.",
    tags: ["image", "generation", "ai", "media"],
    example: { prompt: "A lighthouse at dusk, watercolor", model: "flux-schnell", num_images: 1 },
  },
  image_upscale: {
    summary: "Upscale an image 2x or 4x with RealESRGAN; returns a public image URL.",
    tags: ["image", "upscale", "media"],
    example: { image_url: "https://mcp.toolsnap.app/img/og-default.png", scale: 2 },
  },
  audio_transcribe: {
    summary: "Transcribe audio to plain text or SRT subtitles with Whisper v3; priced by declared duration.",
    tags: ["audio", "transcription", "speech-to-text", "media"],
    example: { audio_url: "https://example.com/clip.mp3", duration_seconds: 60, language: "en" },
  },
  text_to_speech: {
    summary: "Convert text to speech (20 English voices, Kokoro); returns a public WAV URL.",
    tags: ["audio", "tts", "speech", "media"],
    example: { text: "Hello from ToolSnap.", voice: "af_heart" },
  },
  video_generate: {
    summary: "Generate a short video from a text prompt or source image; async job polled with the free media_job tool.",
    tags: ["video", "generation", "ai", "media"],
    example: { prompt: "Waves rolling onto a beach at sunrise", model: "ltx-fast" },
  },
  csv_query_xl: {
    summary: "Select, filter, sort and limit rows of a URL-hosted CSV up to 100 MB, streamed server-side.",
    tags: ["csv", "data", "query"],
    example: { url: "https://example.com/data.csv", limit: 10 },
  },
  json_query_xl: {
    summary: "Run a JSONPath-style query over a URL-hosted JSON document up to 25 MB.",
    tags: ["json", "data", "query"],
    example: { url: "https://example.com/data.json", query: "$.items[*].name", limit: 10 },
  },
};

/**
 * Upper-bound args per dynamically priced tool, for the OpenAPI `max` price.
 * Each one sits at the limits the tool itself enforces (src/fal/pricing.ts).
 */
const MAX_PRICE_ARGS: Record<string, Record<string, unknown>> = {
  image_generate: { prompt: "x", model: "flux-dev", image_size: "landscape_16_9", num_images: 4 },
  image_upscale: { image_url: "https://example.com/x.png", scale: 4 },
  audio_transcribe: { audio_url: "https://example.com/x.mp3", duration_seconds: 3600 },
  text_to_speech: { text: "x".repeat(5000) },
  video_generate: { prompt: "x", model: "kling-pro", duration: "10" },
};

/** Paid tool definitions, in registry order. */
export function paidToolDefinitions(): McpToolDefinition[] {
  return listTools("full").filter(({ name }) => requiresPayment(name));
}

function listingFor(def: McpToolDefinition) {
  const l = LISTING[def.name];
  return {
    summary: l?.summary ?? def.description.split(". ")[0].slice(0, 200),
    tags: l?.tags ?? [],
    example: l?.example ?? {},
  };
}

export function httpResourceUrl(toolName: string): string {
  return `${PUBLIC_ORIGIN}${HTTP_TOOL_PREFIX}${toolName}`;
}

// ---------------------------------------------------------------------------
// Bazaar extension declarations
// ---------------------------------------------------------------------------

/** MCP-flavoured `bazaar` declaration (createMcpDiscoveryExtension shape). */
export function bazaarMcpExtension(toolName: string): Record<string, unknown> | null {
  const def = paidToolDefinitions().find((d) => d.name === toolName);
  if (!def) return null;
  const { summary, example } = listingFor(def);
  return {
    info: {
      input: {
        type: "mcp",
        toolName,
        description: summary,
        transport: "streamable-http",
        inputSchema: def.inputSchema,
        example,
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "mcp" },
            toolName: { type: "string" },
            description: { type: "string" },
            transport: { type: "string", enum: ["streamable-http"] },
            inputSchema: { type: "object" },
            example: { type: "object" },
          },
          required: ["type", "toolName", "inputSchema"],
          additionalProperties: false,
        },
      },
      required: ["input"],
    },
  };
}

/** HTTP-flavoured `bazaar` declaration for POST + JSON body (createBodyDiscoveryExtension shape). */
export function bazaarHttpExtension(toolName: string): Record<string, unknown> | null {
  const def = paidToolDefinitions().find((d) => d.name === toolName);
  if (!def) return null;
  const { example } = listingFor(def);
  return {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: example },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
            bodyType: { type: "string", enum: ["json", "form-data", "text"] },
            body: def.inputSchema,
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
      },
      required: ["input"],
    },
  };
}

/** Listing description for the 402 `resource` object (CDP caps it at 500 chars). */
export function resourceDescription(toolName: string, priceUSDC: string): string {
  const def = paidToolDefinitions().find((d) => d.name === toolName);
  const summary = def ? listingFor(def).summary : toolName;
  return `${summary} $${Number(priceUSDC)} USDC on Base per call.`.slice(0, 500);
}

/** Bazaar service metadata for one tool's 402 `resource` object. */
export function resourceMetadata(toolName: string): Record<string, unknown> {
  const def = paidToolDefinitions().find((d) => d.name === toolName);
  const tags = def ? listingFor(def).tags.slice(0, 5) : [];
  return { ...SERVICE_METADATA, ...(tags.length ? { tags } : {}) };
}

/** Discovery fields folded into the MCP 402 (buildPaymentRequiredResponse). */
export function mcpDiscoveryFields(toolName: string, priceUSDC: string) {
  const bazaar = bazaarMcpExtension(toolName);
  return {
    description: resourceDescription(toolName, priceUSDC),
    resource: resourceMetadata(toolName),
    extensions: bazaar ? { bazaar } : {},
  };
}

/** x402 v2 PaymentRequired for the HTTP door. */
export function buildHttpPaymentRequired(
  toolName: string,
  priceUSDC: string,
  payTo: string,
  error = "Payment required"
): Record<string, unknown> {
  return {
    x402Version: 2,
    error,
    resource: {
      url: httpResourceUrl(toolName),
      description: resourceDescription(toolName, priceUSDC),
      mimeType: "application/json",
      ...resourceMetadata(toolName),
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: usdcToMicro(priceUSDC).toString(),
        asset: USDC_ADDRESS,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: USDC_EIP712_NAME, version: USDC_EIP712_VERSION, assetTransferMethod: "eip3009" },
      },
    ],
    extensions: { bazaar: bazaarHttpExtension(toolName) },
  };
}

// ---------------------------------------------------------------------------
// Fan-out documents
// ---------------------------------------------------------------------------

/** GET /.well-known/x402 (x402scan DISCOVERY.md §B). */
export function buildWellKnownX402(): Record<string, unknown> {
  return {
    version: 1,
    resources: paidToolDefinitions().map(({ name }) => httpResourceUrl(name)),
    instructions:
      "Each resource is a paid ToolSnap tool: POST a JSON body with the tool arguments. The same tools are also served over MCP at https://mcp.toolsnap.app/mcp (x402 in _meta).",
  };
}

function priceInfo(toolName: string, env: Env): Record<string, unknown> {
  const p = getToolPrice(toolName, env);
  if (!(toolName in DYNAMIC_PRICERS)) {
    return { mode: "fixed", currency: "USD", amount: String(Number(p.payPerCallStr)) };
  }
  let max = p.payPerCallStr;
  try {
    max = DYNAMIC_PRICERS[toolName](MAX_PRICE_ARGS[toolName]).payPerCallStr;
  } catch {
    // keep the representative quote as the max if the bound args drift
  }
  return { mode: "dynamic", currency: "USD", min: String(Number(p.payPerCallStr)), max: String(Number(max)) };
}

/** GET /openapi.json (x402scan DISCOVERY.md §A). */
export function buildOpenApi(env: Env): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const def of paidToolDefinitions()) {
    const { summary, example } = listingFor(def);
    paths[`${HTTP_TOOL_PREFIX}${def.name}`] = {
      post: {
        operationId: def.name,
        summary,
        description: summary,
        tags: ["paid"],
        "x-payment-info": {
          protocols: ["x402"],
          price: priceInfo(def.name, env),
          network: NETWORK,
          asset: USDC_ADDRESS,
          payTo: env.X402_PAY_TO_ADDRESS,
        },
        requestBody: {
          required: true,
          content: { "application/json": { schema: def.inputSchema, example } },
        },
        responses: {
          "200": {
            description: "Tool result (JSON). Settlement details in the PAYMENT-RESPONSE header.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": { description: "Body is not a JSON object." },
          "402": {
            description: "Payment required: x402 v2 PaymentRequired in the PAYMENT-REQUIRED header and the body.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "422": { description: "The arguments could not be priced or the tool failed; nothing was charged." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ToolSnap paid tools (x402)",
      version: "1.0.0",
      description:
        "Paid ToolSnap tools over plain HTTP with x402 v2 (USDC on Base). The full catalog, free tools included, is served over MCP at https://mcp.toolsnap.app/mcp.",
      contact: { url: PUBLIC_ORIGIN },
    },
    servers: [{ url: PUBLIC_ORIGIN }],
    paths,
  };
}
