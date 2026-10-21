import type { McpTool, McpToolDefinition } from "../mcp/types.js";
import type { Env } from "../index.js";
import { uuidTool } from "./uuid.js";
import { hashTool } from "./hash.js";
import { base64EncodeTool, base64DecodeTool } from "./base64.js";
import { urlEncodeTool, urlDecodeTool } from "./url.js";
import { jsonFormatTool } from "./json.js";
import { timestampConvertTool } from "./timestamp.js";
import { textStatsTool } from "./text-stats.js";
import { fetchExtractTool } from "./fetch-extract.js";
import { htmlToMarkdownTool } from "./html-to-markdown.js";
import { extractStructuredTool } from "./extract-structured.js";
import { diffTextTool } from "./diff-text.js";
import { csvQueryTool, csvQueryXlTool } from "./csv-query.js";
import { jsonQueryTool, jsonQueryXlTool } from "./json-query.js";
import { pdfTextExtractTool } from "./pdf-text-extract.js";
import { regexExtractTool } from "./regex-extract.js";
import { webpageMetadataTool } from "./webpage-metadata.js";
import { countTokensTool } from "./count-tokens.js";
import { rssParseTool } from "./rss-parse.js";
import { sitemapParseTool } from "./sitemap-parse.js";
import { fetchHtmlTool } from "./fetch-html.js";
import { pageAssetsTool } from "./page-assets.js";
import { pageLinksTool } from "./page-links.js";
import { linkCheckTool } from "./link-check.js";
import { htmlTableExtractTool } from "./html-table-extract.js";
import { screenshotUrlTool } from "./screenshot-url.js";
import { fetchRenderedTool } from "./fetch-rendered.js";
import { taskRecipesTool } from "./task-recipes.js";
import { keywordResearchTool } from "./keyword-research.js";
import { removeBackgroundTool } from "./remove-background.js";
import { imageGenerateTool } from "./image-generate.js";
import { imageUpscaleTool } from "./image-upscale.js";
import { audioTranscribeTool } from "./audio-transcribe.js";
import { textToSpeechTool } from "./text-to-speech.js";
import { videoGenerateTool } from "./video-generate.js";
import { mediaJobTool } from "./media-job.js";
import { uploadFileTool } from "./upload-file.js";
import { pricingTool } from "./pricing.js";
import { accountBalanceTool, accountDepositTool } from "./account.js";
import { walletSetupTool } from "./wallet-setup.js";
import { toolCatalogTool } from "./tool-catalog.js";
import { useToolTool } from "./use-tool.js";
import { memorySnippetTool } from "./memory-snippet.js";
import { CORE_TOOLS } from "./catalog.js";
import { annotationsFor, titleFor } from "./annotations.js";

const registry: McpTool[] = [
  pricingTool,
  accountBalanceTool,
  accountDepositTool,
  walletSetupTool,
  toolCatalogTool,
  useToolTool,
  memorySnippetTool,
  fetchExtractTool,
  fetchHtmlTool,
  pageAssetsTool,
  pageLinksTool,
  screenshotUrlTool,
  fetchRenderedTool,
  keywordResearchTool,
  removeBackgroundTool,
  imageGenerateTool,
  imageUpscaleTool,
  audioTranscribeTool,
  textToSpeechTool,
  videoGenerateTool,
  mediaJobTool,
  uploadFileTool,
  taskRecipesTool,
  uuidTool,
  hashTool,
  base64EncodeTool,
  base64DecodeTool,
  urlEncodeTool,
  urlDecodeTool,
  jsonFormatTool,
  timestampConvertTool,
  textStatsTool,
  htmlToMarkdownTool,
  extractStructuredTool,
  diffTextTool,
  csvQueryTool,
  csvQueryXlTool,
  jsonQueryTool,
  jsonQueryXlTool,
  pdfTextExtractTool,
  regexExtractTool,
  webpageMetadataTool,
  countTokensTool,
  rssParseTool,
  sitemapParseTool,
  linkCheckTool,
  htmlTableExtractTool,
];

/**
 * The public registry. Titles and annotations are attached here from
 * annotations.ts so every tool carries them, whichever file defines it.
 */
export const tools: McpTool[] = registry.map((t) => ({
  ...t,
  title: titleFor(t.name),
  annotations: annotationsFor(t.name),
}));

/**
 * Returns the tool list for tools/list responses (no run function).
 *
 * scope "core" (default for the live tools/list handler) returns only
 * CORE_TOOLS, in CORE_TOOLS order — this is what keeps the 1st-connection
 * payload small. scope "full" returns every registered tool, in registry
 * order — used by /.well-known/mcp.json and pricing.json, which must stay
 * complete for registries/directories that crawl the whole catalog.
 */
export function listTools(scope: "core" | "full" = "full"): McpToolDefinition[] {
  const defs = ({ name, title, description, inputSchema, annotations }: McpTool): McpToolDefinition => ({
    name,
    ...(title ? { title } : {}),
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  });

  if (scope === "core") {
    const byName = new Map(tools.map((t) => [t.name, t]));
    return CORE_TOOLS.map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`CORE_TOOLS references unregistered tool "${name}"`);
      return defs(tool);
    });
  }

  return tools.map(defs);
}

/**
 * Find and run a tool by name.
 * Returns the string result.
 * Throws if tool not found or run throws.
 *
 * Env-aware tools (those exposing `runWithEnv`, e.g. screenshot_url which needs
 * the R2 bucket + provider key) receive `env`. Pure tools use `run`.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env?: Env
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  if (tool.runWithEnv) {
    if (!env) {
      throw new Error(`Tool ${name} requires env but none was provided.`);
    }
    return await tool.runWithEnv(args, env);
  }
  return await tool.run(args);
}
