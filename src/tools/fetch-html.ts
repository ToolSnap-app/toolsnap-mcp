import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, httpUrlArgError } from "./safe-fetch.js";

const DEFAULT_MAX_CHARS = 16_000;
const HARD_MAX_CHARS = 64_000;
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Remove an element and all of its content (open tag → close tag), case-insensitive.
 * Used for elements whose content is pure noise for reconstruction (scripts, styles…).
 */
function dropElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
}

/**
 * Clean HTML while PRESERVING structure (tags, classes, ids, semantic layout).
 * Strips scripts, styles, comments, SVG/iframe blobs, and inline JS handlers —
 * leaving a skeleton suitable for reconstructing the page as static HTML.
 */
function cleanHtml(html: string): string {
  let out = html;

  // HTML comments (incl. conditional comments)
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // Elements whose content is noise for reconstruction
  for (const tag of ["script", "style", "noscript", "template", "svg", "iframe"]) {
    out = dropElement(out, tag);
  }

  // Self-closing / orphan script and link-preload-as-script tags
  out = out.replace(/<script\b[^>]*\/?>/gi, "");

  // Inline event handlers: on*="..." or on*='...'
  out = out.replace(/\son[a-z]+\s*=\s*"(?:[^"]*)"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'(?:[^']*)'/gi, "");

  // Collapse whitespace between tags and runs of blank space
  out = out.replace(/>\s+</g, ">\n<");
  out = out.replace(/[^\S\n]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

export const fetchHtmlTool: McpTool = {
  name: "fetch_html",
  description:
    "Free, read-only. Fetch a page and return its HTML minus scripts, styles, svg, iframes, comments and inline handlers; tags and attributes stay, so structure is readable. For inspecting or rebuilding markup, not plain text (fetch_extract gives that). Runs no JavaScript: SPAs return an empty shell. Cut at maxChars with a marker.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) page URL. Private addresses are refused." },
      maxChars: { type: "number", description: `Output cap, chars. Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}.` },
      headers: HEADERS_SCHEMA_PROPERTY,
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
            "User-Agent": "toolsnap-mcp/1.0 (fetch_html; +https://toolsnap.app)",
            Accept: "text/html,application/xhtml+xml",
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
      // Sin la URL a proposito (2026-09-18): `detail` se persiste en
      // analytics_events durante 730 dias, y la URL de destino es dato del
      // llamante, no metadato nuestro. No aporta nada al diagnostico — ni el
      // clasificador ni el monitor la leen (se apoyan en este prefijo y en
      // tool_name) — y el agente ya sabe que URL paso. Las otras ~14 tools
      // que hacen fetch nunca la incluyeron.
      throw httpStatusError(response);
    }

    let html: string;
    try {
      html = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read response body: ${message}`);
    }

    let cleaned = cleanHtml(html);

    if (cleaned.length > maxChars) {
      cleaned = cleaned.slice(0, maxChars) + `\n<!-- [Truncated at ${maxChars} chars] -->`;
    }

    return cleaned;
  },
};
