import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, httpUrlArgError } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 12_000;
const READ_LIMIT = 2 * 1024 * 1024;
const HARD_MAX_LINKS = 2_000;

interface LinkItem {
  url: string;
  text: string;
}

interface LinksResult {
  url: string;
  host: string;
  counts: Record<string, number>;
  internal: LinkItem[];
  external: LinkItem[];
  other: string[]; // mailto:, tel:, and other non-http schemes
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return m ? m[1] : null;
}

function extractLinks(html: string, base: string, maxLinks: number): LinksResult {
  const baseHost = new URL(base).host;
  const internal = new Map<string, LinkItem>();
  const external = new Map<string, LinkItem>();
  const other = new Set<string>();

  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = anchorRe.exec(html)) !== null) {
    if (count >= maxLinks) break;
    const href = attr(m[1], "href");
    if (!href) continue;
    const raw = decodeEntities(href);
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) continue;

    // Non-http schemes (mailto:, tel:, ftp:, etc.)
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) {
      other.add(raw);
      count++;
      continue;
    }

    let abs: URL;
    try {
      abs = new URL(raw, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") {
      other.add(abs.href);
      count++;
      continue;
    }

    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).slice(0, 120);
    const item: LinkItem = { url: abs.href, text };
    const bucket = abs.host === baseHost ? internal : external;
    if (!bucket.has(abs.href)) {
      bucket.set(abs.href, item);
      count++;
    }
  }

  const result: LinksResult = {
    url: base,
    host: baseHost,
    counts: {
      internal: internal.size,
      external: external.size,
      other: other.size,
    },
    internal: [...internal.values()],
    external: [...external.values()],
    other: [...other],
  };
  return result;
}

export const pageLinksTool: McpTool = {
  name: "page_links",
  description:
    "Fetch a URL and return a JSON list of all its links, classified as internal (same host), external (different host) or other (mailto:, tel:, etc.), resolved to absolute URLs, deduplicated, each with its anchor text. Returns an error if the URL is unreachable. Has no side effects. Free. Ideal for systematically crawling a site for migration or for building a sitemap. Do NOT use to list page assets (images, scripts) — use page_assets instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch (http:// or https://).",
      },
      maxLinks: {
        type: "number",
        description: `Max links to return (default ${HARD_MAX_LINKS}, max ${HARD_MAX_LINKS}).`,
      },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["url"],
  },
  async run(args) {
    const url = args.url;
    if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      throw httpUrlArgError(url);
    }
    const rawMax = args.maxLinks !== undefined ? Number(args.maxLinks) : HARD_MAX_LINKS;
    const maxLinks = Math.min(Math.max(1, Math.floor(rawMax)), HARD_MAX_LINKS);
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
            "User-Agent": "toolsnap-mcp/1.0 (page_links; +https://toolsnap.app)",
            Accept: "text/html,application/xhtml+xml",
          },
        },
        { forwardHeaders }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch URL: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw httpStatusError(response);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
      if (total >= READ_LIMIT) { reader.cancel(); break; }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const links = extractLinks(html, response.url ?? url, maxLinks);
    return JSON.stringify(links, null, 2);
  },
};
