import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, httpUrlArgError } from "./safe-fetch.js";

const DEFAULT_MAX_CHARS = 8_000;
const HARD_MAX_CHARS = 32_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Strip block-level elements (and their content) that are typically noise:
 * <script>, <style>, <nav>, <header>, <footer>, <aside>.
 */
function stripBlockElements(html: string): string {
  const tags = ["script", "style", "nav", "header", "footer", "aside"];
  let result = html;
  for (const tag of tags) {
    // Non-greedy match, case-insensitive, including multiline content.
    result = result.replace(
      new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
      " "
    );
  }
  return result;
}

/** Strip all remaining HTML tags. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#160;/g, " ");
}

/** Collapse runs of whitespace while preserving single newlines. */
function collapseWhitespace(text: string): string {
  // Normalise line endings
  let result = text.replace(/\r\n?/g, "\n");
  // Collapse horizontal whitespace (spaces/tabs) runs to a single space
  result = result.replace(/[^\S\n]+/g, " ");
  // Collapse runs of blank lines to a single newline
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

export function extractText(html: string): string {
  let text = stripBlockElements(html);
  text = stripTags(text);
  text = decodeEntities(text);
  text = collapseWhitespace(text);
  return text;
}

/**
 * Markers that a page is a client-side-rendered SPA whose real content only
 * exists after JavaScript runs. fetch_extract does a plain fetch (no JS engine),
 * so for these pages it would return an almost-empty shell.
 */
const SPA_MARKERS = [
  /<div[^>]+id=["'](root|app|__next|__nuxt|app-root)["']/i,
  /__NEXT_DATA__/,
  /window\.__NUXT__/,
  /data-reactroot/i,
  /<app-root/i,
  /id=["']svelte["']/i,
];

/**
 * Detect a JS-rendered/empty response so the server does NOT charge for a
 * useless extraction. Returns a reason string if the page looks unusable, else
 * null. Conservative: only fires when the extracted text is very thin AND the
 * HTML was non-trivial (so genuinely short static pages are not flagged).
 */
function detectUnusable(html: string, text: string): string | null {
  if (text.length >= 300) return null; // got real content — fine
  if (html.length < 2_000) return null; // genuinely tiny page — let it through
  const isSpa = SPA_MARKERS.some((re) => re.test(html));
  if (isSpa) {
    return "This page is client-side rendered (SPA): its content only appears after JavaScript runs, which fetch_extract does not execute. Use fetch_rendered (paid, runs a server-side browser) to get its text, or screenshot_url to see it.";
  }
  // Large HTML but almost no text and no SPA markers → likely a bot wall,
  // login gate, or an asset/redirect page.
  return "This URL returned very little extractable text despite a sizeable response (likely a bot wall, login gate, or non-article page). If it needs auth, retry with `headers` (Authorization/Cookie). Otherwise try fetch_rendered or fetch_html.";
}

export const fetchExtractTool: McpTool = {
  name: "fetch_extract",
  description:
    "Free, read-only. Fetch a public http(s) URL and return its body as plain text: script, style, nav, header, footer and aside removed, tags stripped, entities decoded, whitespace collapsed. Median 98% fewer tokens than raw HTML. Follows up to 5 redirects, 10 s timeout; private and local hosts are rejected and non-2xx responses error with the HTTP status. Text past maxChars is cut and ends with '[Truncated at N chars]': raise maxChars (max 32000) or use fetch_html for everything. Runs no JavaScript: a client-side-rendered SPA or a bot/login wall yields almost no text, so the call errors instead of returning an empty shell and names the fix (fetch_rendered, paid, runs a browser; screenshot_url; or headers for auth). For title/OG/JSON-LD only use fetch_metadata; for Markdown with links use html_to_markdown.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http:// or https:// URL. Local and private hosts are rejected." },
      maxChars: {
        type: "number",
        description: `Characters of text to return. Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS} (higher values are clamped). Truncated output ends with a '[Truncated at N chars]' marker.`,
      },
      headers: {
        ...HEADERS_SCHEMA_PROPERTY,
        description: "Headers to forward for pages behind login: Authorization, Cookie, X-API-Key only. Dropped if a redirect leaves the original host.",
      },
    },
    required: ["url"],
  },
  async run(args) {
    const url = args.url;
    if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      throw httpUrlArgError(url);
    }

    const rawMax = args.maxChars !== undefined ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
    const maxChars = Math.min(Math.max(1, Math.floor(rawMax)), HARD_MAX_CHARS);
    const forwardHeaders = parseForwardHeaders(args.headers);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await safeFetch(
        url,
        {
          signal: controller.signal,
          headers: {
            "User-Agent": "toolsnap-mcp/1.0 (fetch_extract; +https://toolsnap.app)",
          },
        },
        { forwardHeaders }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch URL: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Sin la URL a proposito — ver la nota en fetch-html.ts.
      throw httpStatusError(response);
    }

    let html: string;
    try {
      html = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read response body: ${message}`);
    }

    let text = extractText(html);

    // Throwing here means the payment gate does NOT settle (it only charges on
    // success), so the caller is not billed for an unusable extraction.
    const unusable = detectUnusable(html, text);
    if (unusable) {
      throw new Error(unusable);
    }

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
    }

    return text;
  },
};
