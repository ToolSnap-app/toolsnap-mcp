import type { McpTool } from "../mcp/types.js";
import { getToolPrice } from "../x402/middleware.js";

/** Representative (default-args) quote for a dynamically-priced fal.ai tool. */
function dynamicQuote(name: string): { price_usdc: number; prepaid_price_usdc: number } {
  const p = getToolPrice(name, {});
  return { price_usdc: Number(p.payPerCallStr), prepaid_price_usdc: Number(p.prepaidStr) };
}

const FREE_TOOLS = [
  "pricing",
  "account_balance",
  "account_deposit",
  "wallet_setup",
  "tool_catalog",
  "use_tool",
  "memory_snippet",
  "uuid_generate",
  "hash_text",
  "base64_encode",
  "base64_decode",
  "url_encode",
  "url_decode",
  "json_format",
  "timestamp_convert",
  "text_stats",
  "html_to_markdown",
  "fetch_structured",
  "diff_text",
  "csv_query",
  "json_query",
  "pdf_text_extract",
  "regex_extract",
  "fetch_metadata",
  "count_tokens",
  "rss_parse",
  "sitemap_parse",
  "page_assets",
  "page_links",
  "upload_file",
  "task_recipes",
  "fetch_extract",
  "fetch_html",
  "media_job",
];

const PRICING_DATA = {
  server: "toolsnap-mcp",
  version: "0.1.0",
  endpoint: "https://mcp.toolsnap.app/mcp",
  docs: "https://toolsnap.app/agents",
  payment: {
    method: "x402 v2 — EIP-3009 USDC transfer authorisation",
    network: "eip155:8453 (Base mainnet)",
    asset: "USDC — 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Pay-per-call: one on-chain settlement per call.
    pay_per_call: {
      how: 'Include a signed PaymentPayload in _meta["x402/payment"]. Server verifies off-chain, settles on-chain after successful execution. Price varies per tool — see each tool entry below (payPerCall).',
      first_call_free: false,
      first_call_free_note:
        "The first-call-free mechanism exists in code (per payer wallet) but every currently paid tool has real per-call COGS and is excluded from it, so in practice all paid calls settle from the first one. It will apply automatically to any future flat-rate (non-COGS) paid tool.",
    },
    // Prepaid: deposit once, then debit off-chain per call at a discount.
    prepaid: {
      discount_vs_pay_per_call: "~33-38% — price varies per tool, see each tool entry below (prepaid_price_usdc)",
      min_deposit_usdc: 0.5,
      non_refundable: true,
      how_to_deposit:
        'Call account_deposit with a signed x402 PaymentPayload in _meta["x402/payment"] for any amount >= the minimum. One on-chain settlement; the full amount is credited to the paying address.',
      how_to_spend:
        'Call a paid tool with a signed SpendAuthorization in _meta["x402/prepaid-spend"]. Debited off-chain from your balance — no per-call 402, no per-call gas. Insufficient balance returns a 402 recharge.',
      check_balance: "account_balance (free) returns remaining balance and calls covered.",
      spend_authorization: {
        eip712_domain: { name: "ToolSnap Prepaid", version: "1", chainId: 8453 },
        primary_type: "SpendAuthorization",
        fields:
          "address (payer), tool (the tool name), maxAmount (micro-USDC you authorise for this call, >= price), nonce (bytes32, single-use), validBefore (unix seconds, <= now + 600)",
        safety_note:
          "This signature is NOT a token transfer authorisation (no verifyingContract, ToolSnap-specific domain). Signing it cannot move on-chain funds — it only authorises debiting your own prepaid balance on this server.",
      },
    },
  },
  tools: [
    {
      name: "fetch_extract",
      tier: "free",
      value: {
        benchmark_token_savings_median_pct: 98.1,
        benchmark_input_tokens_median: 53820,
        benchmark_output_tokens_median: 2001,
        benchmark_savings_at_sonnet_usd_per_call: 0.1555,
        break_even_page_size_kb: 26,
        best_case_savings_pct: 99.3,
        best_case_source: "Cloudflare Workers docs (372 KB → 2.5 KB)",
        note: "Free flagship tool. Median 98.1% token reduction vs loading raw HTML — saves ~$0.156/call at Sonnet pricing.",
      },
    },
    {
      name: "fetch_html",
      tier: "free",
      value: {
        note: "Free. Clean HTML with structure preserved (tags/classes/ids, no scripts/styles/tracking) for site migration and reconstruction.",
      },
    },
    {
      name: "screenshot_url",
      tier: "paid",
      price_usdc: 0.04,
      prepaid_price_usdc: 0.025,
      first_call_free: false,
      value: {
        note: "Captures a page (full-page or viewport, PNG/JPEG), uploads to R2 and returns a public URL — never the bytes, so it does not bloat context. For visual reference during site migration and visual QA. Priced above the flat rate because each call drives a real headless/render cost. No first-call-free (real per-call cost). Costs $0.04 pay-per-call or $0.025 prepaid.",
      },
    },
    {
      name: "fetch_rendered",
      tier: "paid",
      price_usdc: 0.04,
      prepaid_price_usdc: 0.025,
      first_call_free: false,
      value: {
        note: "Renders a JS-executed page (SPA) in a server-side headless browser (Cloudflare Browser Rendering) and returns clean text — same pipeline as the free fetch_extract, but after JavaScript runs. Use when fetch_extract reports a client-side rendered page, or pair with `headers` to read an authenticated dashboard. Priced above the flat rate due to per-call browser render cost. No first-call-free. Costs $0.04 pay-per-call or $0.025 prepaid.",
      },
    },
    {
      name: "keyword_research",
      tier: "paid",
      price_usdc: 0.04,
      prepaid_price_usdc: 0.025,
      first_call_free: false,
      value: {
        note: "Queries Google Ads data via DataForSEO for 1–20 keywords per call. Returns monthly search volume, CPC (USD), competition score (0–1), 12-month trend, and top-5 related suggestions per keyword. Default location: Spain (2724). Priced above the flat rate due to DataForSEO COGS per batch. No first-call-free. Costs $0.04 pay-per-call or $0.025 prepaid.",
      },
    },
    {
      name: "remove_background",
      tier: "paid",
      price_usdc: 0.03,
      prepaid_price_usdc: 0.02,
      first_call_free: false,
      value: {
        note: "Removes the background from any public image URL (JPEG/PNG/WEBP) using the U²-Net model. Returns a transparent PNG hosted on a public URL (expires ~24h) — never raw bytes. Priced above the flat rate due to generative AI inference COGS. No first-call-free. Costs $0.03 pay-per-call or $0.02 prepaid.",
      },
    },
    {
      name: "image_generate",
      tier: "paid",
      ...dynamicQuote("image_generate"),
      first_call_free: false,
      value: {
        note: "Text-to-image via fal.ai FLUX (flux-schnell default, flux-dev for higher quality). Priced dynamically per call from model + image_size + num_images — the price_usdc/prepaid_price_usdc shown here are a representative quote (flux-schnell, 1 image, default size); the real 402/charge reflects your actual args. Returns public R2 URLs, never raw bytes. No first-call-free (real COGS).",
      },
    },
    {
      name: "image_upscale",
      tier: "paid",
      ...dynamicQuote("image_upscale"),
      first_call_free: false,
      value: {
        note: "2x/4x super-resolution via fal.ai ESRGAN. Flat price per scale factor shown here (scale=2); scale=4 costs more — see tool_catalog(tool=\"image_upscale\"). Source image capped at 6 MB. No first-call-free (real COGS).",
      },
    },
    {
      name: "audio_transcribe",
      tier: "paid",
      ...dynamicQuote("audio_transcribe"),
      first_call_free: false,
      value: {
        note: "Speech-to-text via fal.ai Wizper. Priced dynamically from your declared duration_seconds — the price shown here is a representative 1-minute quote; longer audio costs more (floor holds up to ~20 minutes). Max 60 minutes/call. No first-call-free (real COGS).",
      },
    },
    {
      name: "text_to_speech",
      tier: "paid",
      ...dynamicQuote("text_to_speech"),
      first_call_free: false,
      value: {
        note: "Text-to-speech via fal.ai Kokoro (20 English voices). Priced dynamically from text length — the price shown here is a representative 500-character quote (floor holds up to ~1000 characters). Max 5,000 characters/call. No first-call-free (real COGS).",
      },
    },
    {
      name: "video_generate",
      tier: "paid",
      ...dynamicQuote("video_generate"),
      first_call_free: false,
      value: {
        note: "Async text/image-to-video via fal.ai (ltx-fast default: flat, ltx-fast quote shown here; kling-pro: $0.07/s, higher quality). Returns a job_id — poll the free media_job tool. Charged upfront at submit; prepaid/API-key/OAuth jobs are auto-refunded if the render later fails, pay-per-call is not. No first-call-free (real COGS).",
      },
    },
    {
      name: "csv_query_xl",
      tier: "paid",
      price_usdc: 0.02,
      prepaid_price_usdc: 0.01,
      first_call_free: false,
      value: {
        note: "Paid sibling of the free csv_query, for URL-hosted CSVs from 5 MB up to 100 MB. Streamed server-side (never buffered whole), so the file never touches your context. Flat rate despite the large size cap — the marginal cost is CPU time, not storage or a third-party API. No first-call-free: it's a paid file-size tier (csv_query already gives you a free first taste), not a marketing freebie. You pay for the query, not the row count.",
      },
    },
    {
      name: "json_query_xl",
      tier: "paid",
      price_usdc: 0.02,
      prepaid_price_usdc: 0.01,
      first_call_free: false,
      value: {
        note: "Paid sibling of the free json_query, for URL-hosted JSON from 5 MB up to 25 MB. Buffered (JSON needs the whole document to parse), bounded by Worker memory. Flat rate; no first-call-free (same reasoning as csv_query_xl).",
      },
    },
    // fetch_extract and fetch_html have detailed entries above; exclude them
    // here to avoid duplicates.
    ...FREE_TOOLS.filter((name) => name !== "fetch_extract" && name !== "fetch_html").map(
      (name) => ({ name, tier: "free" as const })
    ),
  ],
};

export const pricingTool: McpTool = {
  name: "pricing",
  description: "Free. Machine-readable pricing menu: free vs paid tools, pricing, deposit/spend flow.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  run() {
    return JSON.stringify(PRICING_DATA, null, 2);
  },
};

export { PRICING_DATA };
