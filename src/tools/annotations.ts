import type { McpToolAnnotations } from "../mcp/types.js";

/**
 * Single source of truth for every tool's display title and MCP annotations.
 *
 * Directories score these (Glama TDQS, Smithery, Anthropic Software Directory
 * Policy 5E): each tool needs a human `title` and an explicit read-only /
 * destructive hint. Keeping them in one table, instead of 47 inline literals,
 * lets test/tool-annotations.ts fail the build when a new tool ships without
 * them.
 *
 * Hint semantics follow the MCP spec: `destructiveHint` and `idempotentHint`
 * only matter when `readOnlyHint` is false, so non-read-only tools state
 * `destructiveHint: false` explicitly (the spec default is true). Nothing in
 * this server deletes or overwrites user data, so no tool is destructive.
 * `openWorldHint` defaults to true in the spec (the tool reaches outside the
 * server: fetches a URL, calls a provider, settles on-chain), so only the
 * closed-world tools state it, as false. Keys that equal the spec default are
 * omitted on purpose to protect the first-connection token budget.
 */

type Spec = { title: string; annotations: McpToolAnnotations };

/** Pure or server-local read: no network beyond the server, no side effects. */
const local = (title: string): Spec => ({
  title,
  annotations: { readOnlyHint: true, openWorldHint: false },
});

/** Read-only, but fetches an external URL or calls an upstream provider (openWorldHint defaults to true). */
const web = (title: string): Spec => ({
  title,
  annotations: { readOnlyHint: true },
});

/** Creates something (a render, a stored file, a ledger entry) but never deletes or overwrites. */
const create = (title: string, openWorldHint = true): Spec => ({
  title,
  annotations: { readOnlyHint: false, destructiveHint: false, ...(openWorldHint ? {} : { openWorldHint }) },
});

export const TOOL_SPECS: Record<string, Spec> = {
  // Account and discovery
  pricing: local("Pricing and payment options"),
  account_balance: local("Check prepaid balance"),
  account_deposit: create("Deposit USDC prepaid balance"),
  wallet_setup: local("Agent wallet setup guide"),
  tool_catalog: local("Browse tool catalog"),
  // Dispatcher: worst case over the catalog. Some inner tools create (render,
  // stored file, ledger entry) so it is not read-only; none deletes or
  // overwrites, so never destructive. The description says exactly this.
  use_tool: create("Run any catalog tool"),
  memory_snippet: local("Memory snippet for agents"),
  task_recipes: local("Task recipes"),

  // Web fetch and extraction
  fetch_extract: web("Fetch page as clean text"),
  fetch_html: web("Fetch raw HTML"),
  fetch_rendered: web("Fetch JavaScript-rendered page"),
  fetch_structured: web("Extract structured data from page"),
  fetch_metadata: web("Fetch page metadata"),
  html_to_markdown: web("Convert HTML to Markdown"),
  html_table_extract: web("Extract HTML tables"),
  page_links: web("List page links"),
  page_assets: web("List page assets"),
  link_check: web("Check links and redirects"),
  sitemap_parse: web("Parse sitemap"),
  rss_parse: web("Parse RSS or Atom feed"),
  keyword_research: web("Keyword research"),
  screenshot_url: create("Screenshot a URL"),

  // Documents and data
  pdf_text_extract: web("Extract PDF text"),
  csv_query: web("Query CSV"),
  csv_query_xl: web("Query large CSV"),
  json_query: web("Query JSON"),
  json_query_xl: web("Query large JSON"),

  // Media (fal.ai)
  remove_background: create("Remove image background"),
  image_generate: create("Generate image"),
  image_upscale: create("Upscale image"),
  audio_transcribe: create("Transcribe audio"),
  text_to_speech: create("Text to speech"),
  video_generate: create("Generate video"),
  // Polling is idempotent: a finished job returns its cached URL, a failed one refunds once.
  media_job: {
    title: "Check media job status",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  upload_file: create("Upload temporary file", false),

  // Local utilities
  uuid_generate: local("Generate UUID"),
  hash_text: local("Hash text"),
  base64_encode: local("Base64 encode"),
  base64_decode: local("Base64 decode"),
  url_encode: local("URL encode"),
  url_decode: local("URL decode"),
  json_format: local("Format JSON"),
  timestamp_convert: local("Convert timestamp"),
  text_stats: local("Text statistics"),
  diff_text: local("Diff two texts"),
  regex_extract: local("Regex extract"),
  count_tokens: local("Count tokens"),
};

/** The annotations object advertised for a tool: its hints plus the title. */
export function annotationsFor(name: string): McpToolAnnotations | undefined {
  const spec = TOOL_SPECS[name];
  return spec ? { title: spec.title, ...spec.annotations } : undefined;
}

export function titleFor(name: string): string | undefined {
  return TOOL_SPECS[name]?.title;
}
