import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS = 200;

interface FeedItem {
  title: string | null;
  link: string | null;
  pubDate: string | null;
  guid: string | null;
  description: string | null;
  author: string | null;
  categories: string[];
  enclosure: { url: string; type: string; length: string } | null;
}

interface FeedResult {
  type: "rss" | "atom" | "unknown";
  title: string | null;
  link: string | null;
  description: string | null;
  language: string | null;
  lastBuildDate: string | null;
  generator: string | null;
  itemCount: number;
  truncated: boolean;
  items: FeedItem[];
}

function textOf(tag: string, xml: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))<\\/${tag}>`, "i").exec(xml);
  if (!m) return null;
  const val = (m[1] ?? m[2] ?? "").trim();
  return val || null;
}

function attrOf(tag: string, attr: string, xml: string): string | null {
  const re = new RegExp(`<${tag}[^>]+${attr}=["']([^"']*?)["']`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() || null : null;
}

function allTags(tag: string, xml: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
  return xml.match(re) ?? [];
}

function allSelfClosing(tag: string, xml: string): string[] {
  const re = new RegExp(`<${tag}[^>]*\\/?>`, "gi");
  return xml.match(re) ?? [];
}

function categories(xml: string): string[] {
  const re = /<category[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/category>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v) out.push(v);
  }
  // Atom: <category term="...">
  const termRe = /<category[^>]+term=["']([^"']*?)["'][^>]*\/?>/gi;
  while ((m = termRe.exec(xml)) !== null) {
    const v = m[1].trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function enclosure(xml: string): FeedItem["enclosure"] {
  const m = /<enclosure[^>]+>/i.exec(xml);
  if (!m) return null;
  const tag = m[0];
  const url = attrOf("enclosure", "url", tag) ?? attrOf("enclosure", "url", xml);
  const type = attrOf("enclosure", "type", tag) ?? "";
  const length = attrOf("enclosure", "length", tag) ?? "";
  return url ? { url, type, length } : null;
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

function clean(s: string | null): string | null {
  return s ? decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || null : null;
}

function parseRss(xml: string, maxItems: number): FeedResult {
  const channelM = /<channel[^>]*>([\s\S]*?)<\/channel>/i.exec(xml);
  const channel = channelM ? channelM[1] : xml;

  // Strip <item> blocks before reading channel-level fields
  const channelMeta = channel.replace(/<item[\s>][\s\S]*?<\/item>/gi, "");

  const result: FeedResult = {
    type: "rss",
    title: clean(textOf("title", channelMeta)),
    link: clean(textOf("link", channelMeta)),
    description: clean(textOf("description", channelMeta)),
    language: textOf("language", channelMeta),
    lastBuildDate: textOf("lastBuildDate", channelMeta),
    generator: textOf("generator", channelMeta),
    itemCount: 0,
    truncated: false,
    items: [],
  };

  const itemBlocks = allTags("item", channel);
  result.itemCount = itemBlocks.length;
  result.truncated = itemBlocks.length > maxItems;

  for (const block of itemBlocks.slice(0, maxItems)) {
    result.items.push({
      title: clean(textOf("title", block)),
      link: clean(textOf("link", block)),
      pubDate: textOf("pubDate", block),
      guid: clean(textOf("guid", block)),
      description: clean(textOf("description", block)),
      author: clean(textOf("author", block)) ?? clean(textOf("dc:creator", block)),
      categories: categories(block),
      enclosure: enclosure(block),
    });
  }

  return result;
}

function parseAtom(xml: string, maxItems: number): FeedResult {
  const result: FeedResult = {
    type: "atom",
    title: clean(textOf("title", xml.split("<entry")[0])),
    link: attrOf("link", "href", xml.split("<entry")[0]),
    description: clean(textOf("subtitle", xml.split("<entry")[0])),
    language: attrOf("feed", "xml:lang", xml) ?? attrOf("feed", "lang", xml),
    lastBuildDate: textOf("updated", xml.split("<entry")[0]),
    generator: clean(textOf("generator", xml.split("<entry")[0])),
    itemCount: 0,
    truncated: false,
    items: [],
  };

  const entryBlocks = allTags("entry", xml);
  result.itemCount = entryBlocks.length;
  result.truncated = entryBlocks.length > maxItems;

  for (const block of entryBlocks.slice(0, maxItems)) {
    // <link href="..."> in Atom
    const linkHref = attrOf("link", "href", block);
    result.items.push({
      title: clean(textOf("title", block)),
      link: linkHref ?? clean(textOf("link", block)),
      pubDate: textOf("published", block) ?? textOf("updated", block),
      guid: clean(textOf("id", block)),
      description: clean(textOf("summary", block)) ?? clean(textOf("content", block)),
      author: clean(textOf("name", block)) ?? clean(textOf("author", block)),
      categories: categories(block),
      enclosure: null,
    });
  }

  return result;
}

async function fetchFeed(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "toolsnap-mcp/1.0 (rss_parse; +https://toolsnap.app)",
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch feed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw httpStatusError(response);
  }
  return response.text();
}

export const rssParseTool: McpTool = {
  name: "rss_parse",
  description: "Fetch/parse an RSS or Atom feed into JSON. Saves 90%+ tokens vs raw XML.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Feed URL." },
      maxItems: { type: "number", description: `Max ${MAX_ITEMS}.` },
    },
    required: ["url"],
  },
  async run(args) {
    const url = args.url as string;
    if (!url) throw new Error("`url` is required.");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("`url` must start with http:// or https://");
    }

    const rawMax = args.maxItems !== undefined ? Number(args.maxItems) : 20;
    const maxItems = Math.min(Math.max(1, Math.floor(rawMax)), MAX_ITEMS);

    const xml = await fetchFeed(url);

    let result: FeedResult;
    if (/<feed\b/i.test(xml)) {
      result = parseAtom(xml, maxItems);
    } else if (/<rss\b/i.test(xml) || /<channel\b/i.test(xml)) {
      result = parseRss(xml, maxItems);
    } else {
      result = parseRss(xml, maxItems);
      result.type = "unknown";
    }

    return JSON.stringify(result, null, 2);
  },
};
