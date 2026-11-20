import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, httpUrlArgError } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 12_000;
const READ_LIMIT = 2 * 1024 * 1024; // 2 MB of HTML is plenty for asset discovery

interface AssetResult {
  url: string;
  counts: Record<string, number>;
  images: string[];
  stylesheets: string[];
  scripts: string[];
  fonts: string[];
  icons: string[];
  media: string[];
  other: string[];
}

/** Decode the HTML entities that commonly appear inside URL attribute values. */
function decodeUrlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&");
}

/** Resolve a possibly-relative URL against the page base; null if unusable. */
function resolve(raw: string, base: string): string | null {
  const v = decodeUrlEntities(raw.trim());
  if (!v || v.startsWith("data:") || v.startsWith("javascript:") || v.startsWith("#")) return null;
  try {
    return new URL(v, base).href;
  } catch {
    return null;
  }
}

/** Get an attribute value from a tag's inner attribute string. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return m ? m[1] : null;
}

/** Parse a srcset attribute into its candidate URLs. */
function parseSrcset(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const FONT_RE = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;

function extractAssets(html: string, base: string): AssetResult {
  const images = new Set<string>();
  const stylesheets = new Set<string>();
  const scripts = new Set<string>();
  const fonts = new Set<string>();
  const icons = new Set<string>();
  const media = new Set<string>();
  const other = new Set<string>();

  const add = (set: Set<string>, raw: string | null) => {
    if (!raw) return;
    const abs = resolve(raw, base);
    if (abs) set.add(abs);
  };

  // <img src / srcset / data-src>
  let m: RegExpExecArray | null;
  const imgRe = /<img\b([^>]*)>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    add(images, attr(m[1], "src"));
    add(images, attr(m[1], "data-src"));
    const srcset = attr(m[1], "srcset") ?? attr(m[1], "data-srcset");
    if (srcset) for (const u of parseSrcset(srcset)) add(images, u);
  }

  // <source src / srcset> (picture / video / audio)
  const sourceRe = /<source\b([^>]*)>/gi;
  while ((m = sourceRe.exec(html)) !== null) {
    add(images, attr(m[1], "src"));
    const srcset = attr(m[1], "srcset");
    if (srcset) for (const u of parseSrcset(srcset)) add(images, u);
  }

  // <link rel="..." href="...">
  const linkRe = /<link\b([^>]*)>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const rel = (attr(m[1], "rel") ?? "").toLowerCase();
    const href = attr(m[1], "href");
    const asAttr = (attr(m[1], "as") ?? "").toLowerCase();
    if (!href) continue;
    if (rel.includes("stylesheet")) add(stylesheets, href);
    else if (rel.includes("icon") || rel.includes("apple-touch") || rel.includes("mask-icon")) add(icons, href);
    else if (asAttr === "font" || FONT_RE.test(href)) add(fonts, href);
    else if (asAttr === "style") add(stylesheets, href);
    else if (asAttr === "image") add(images, href);
  }

  // <script src>
  const scriptRe = /<script\b([^>]*)>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    add(scripts, attr(m[1], "src"));
  }

  // <video src/poster>, <audio src>
  const videoRe = /<(?:video|audio)\b([^>]*)>/gi;
  while ((m = videoRe.exec(html)) !== null) {
    add(media, attr(m[1], "src"));
    add(images, attr(m[1], "poster"));
  }

  // url(...) references inside inline styles and <style> blocks → images/fonts
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = urlRe.exec(html)) !== null) {
    const raw = m[1];
    if (FONT_RE.test(raw)) add(fonts, raw);
    else add(images, raw);
  }

  const result: AssetResult = {
    url: base,
    counts: {},
    images: [...images],
    stylesheets: [...stylesheets],
    scripts: [...scripts],
    fonts: [...fonts],
    icons: [...icons],
    media: [...media],
    other: [...other],
  };
  result.counts = {
    images: result.images.length,
    stylesheets: result.stylesheets.length,
    scripts: result.scripts.length,
    fonts: result.fonts.length,
    icons: result.icons.length,
    media: result.media.length,
    other: result.other.length,
  };
  return result;
}

export const pageAssetsTool: McpTool = {
  name: "page_assets",
  description:
    "Fetch a URL and return a JSON inventory of every asset it references — images (incl. srcset), stylesheets, scripts, fonts, icons/favicons and media — all resolved to absolute URLs and deduplicated. Returns an error if the URL is unreachable. Has no side effects. Free. Ideal for auditing or migrating a site: get the full asset manifest in one cheap call instead of loading the page into context. Do NOT use to list hyperlinks — use page_links instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch (http:// or https://).",
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
            "User-Agent": "toolsnap-mcp/1.0 (page_assets; +https://toolsnap.app)",
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

    const assets = extractAssets(html, response.url ?? url);
    return JSON.stringify(assets, null, 2);
  },
};
