import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 10_000;

interface MetaResult {
  url: string;
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  author: string | null;
  keywords: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  jsonLd: unknown[] | null;
  charset: string | null;
  lang: string | null;
  httpEquiv: Record<string, string>;
}

function attr(tag: string, attrName: string): string | null {
  const re = new RegExp(`${attrName}=["']([^"']*?)["']`, "i");
  const m = re.exec(tag);
  return m ? decodeEntities(m[1].trim()) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
}

function extractMeta(html: string, resolvedUrl: string): MetaResult {
  const result: MetaResult = {
    url: resolvedUrl,
    title: null,
    description: null,
    canonical: null,
    robots: null,
    author: null,
    keywords: null,
    og: {},
    twitter: {},
    jsonLd: null,
    charset: null,
    lang: null,
    httpEquiv: {},
  };

  // <html lang="...">
  const htmlTag = /<html([^>]*)>/i.exec(html);
  if (htmlTag) result.lang = attr(htmlTag[1], "lang");

  // <title>
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleM) result.title = decodeEntities(titleM[1].replace(/<[^>]+>/g, "").trim());

  // <meta> tags
  const metaRe = /<meta\s([^>]+?)\/?>(?:\s*<\/meta>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[1];

    // charset
    const charsetM = /charset=["']?([^"'\s>]+)/i.exec(tag);
    if (charsetM) { result.charset = charsetM[1]; continue; }

    const name = attr(tag, "name") ?? attr(tag, "property") ?? attr(tag, "http-equiv");
    const content = attr(tag, "content");
    if (!name || content === null) continue;
    const lname = name.toLowerCase();

    if (lname === "description") result.description = content;
    else if (lname === "robots") result.robots = content;
    else if (lname === "author") result.author = content;
    else if (lname === "keywords") result.keywords = content;
    else if (lname.startsWith("og:")) result.og[lname.slice(3)] = content;
    else if (lname.startsWith("twitter:")) result.twitter[lname.slice(8)] = content;
    else if (attr(tag, "http-equiv")) result.httpEquiv[lname] = content;
  }

  // <link rel="canonical">
  const canonRe = /<link\s([^>]+?)\/?>(?:\s*<\/link>)?/gi;
  while ((m = canonRe.exec(html)) !== null) {
    const tag = m[1];
    const rel = attr(tag, "rel");
    if (rel?.toLowerCase() === "canonical") {
      result.canonical = attr(tag, "href");
    }
  }

  // JSON-LD
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const ldBlocks: unknown[] = [];
  while ((m = ldRe.exec(html)) !== null) {
    try {
      ldBlocks.push(JSON.parse(m[1].trim()));
    } catch {
      // ignore malformed
    }
  }
  if (ldBlocks.length > 0) result.jsonLd = ldBlocks;

  return result;
}

export const webpageMetadataTool: McpTool = {
  name: "fetch_metadata",
  description: "Fetch a URL, extract title/description/OG/Twitter/canonical/JSON-LD. Not for body text.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Page URL." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["url"],
  },
  async run(args) {
    const url = args.url as string;
    if (!url) throw new Error("`url` is required.");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("`url` must start with http:// or https://");
    }
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
            "User-Agent": "toolsnap-mcp/1.0 (fetch_metadata; +https://toolsnap.app)",
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

    // Only read up to 512 KB — metadata is always in <head>
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const LIMIT = 512 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
      if (total >= LIMIT) { reader.cancel(); break; }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const meta = extractMeta(html, response.url ?? url);
    return JSON.stringify(meta, null, 2);
  },
};
