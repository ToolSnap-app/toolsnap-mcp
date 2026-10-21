import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_URLS = 1000;

interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: string | null;
  /** Only present on image sitemaps */
  images?: Array<{ loc: string; title: string | null }>;
  /** Only present on news sitemaps */
  news?: { title: string | null; publicationDate: string | null; name: string | null };
}

interface SitemapResult {
  type: "urlset" | "sitemapindex";
  urlCount: number;
  truncated: boolean;
  urls: SitemapUrl[];
  /** Only for sitemapindex — list of child sitemap URLs */
  sitemaps?: string[];
}

function textOf(tag: string, xml: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() || null : null;
}

function parseUrlset(xml: string, maxUrls: number): SitemapResult {
  const urlRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(xml)) !== null) blocks.push(m[1]);

  const urlCount = blocks.length;
  const truncated = urlCount > maxUrls;
  const urls: SitemapUrl[] = [];

  for (const block of blocks.slice(0, maxUrls)) {
    const entry: SitemapUrl = {
      loc: textOf("loc", block) ?? "",
      lastmod: textOf("lastmod", block),
      changefreq: textOf("changefreq", block),
      priority: textOf("priority", block),
    };

    // Image sitemap extension
    const imageRe = /<image:image[^>]*>([\s\S]*?)<\/image:image>/gi;
    const images: SitemapUrl["images"] = [];
    let imgM: RegExpExecArray | null;
    while ((imgM = imageRe.exec(block)) !== null) {
      const imgBlock = imgM[1];
      const loc = textOf("image:loc", imgBlock) ?? textOf("loc", imgBlock);
      if (loc) images.push({ loc, title: textOf("image:title", imgBlock) ?? textOf("title", imgBlock) });
    }
    if (images.length > 0) entry.images = images;

    // News sitemap extension
    const newsM = /<news:news[^>]*>([\s\S]*?)<\/news:news>/i.exec(block);
    if (newsM) {
      const nb = newsM[1];
      entry.news = {
        title: textOf("news:title", nb) ?? textOf("title", nb),
        publicationDate: textOf("news:publication_date", nb) ?? textOf("publication_date", nb),
        name: textOf("news:name", nb) ?? textOf("name", nb),
      };
    }

    if (entry.loc) urls.push(entry);
  }

  return { type: "urlset", urlCount, truncated, urls };
}

function parseSitemapIndex(xml: string): SitemapResult {
  const re = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  const sitemaps: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = textOf("loc", m[1]);
    if (loc) sitemaps.push(loc);
  }
  return {
    type: "sitemapindex",
    urlCount: sitemaps.length,
    truncated: false,
    urls: [],
    sitemaps,
  };
}

async function fetchSitemap(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "toolsnap-mcp/1.0 (sitemap_parse; +https://toolsnap.app)",
        Accept: "application/xml,text/xml,*/*",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch sitemap: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw httpStatusError(response);
  }
  return response.text();
}

export const sitemapParseTool: McpTool = {
  name: "sitemap_parse",
  description: "Fetch/parse an XML sitemap into JSON. Enumerate a site's pages.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Sitemap URL." },
      maxUrls: { type: "number", description: `Max ${MAX_URLS}.` },
    },
    required: ["url"],
  },
  async run(args) {
    const url = args.url as string;
    if (!url) throw new Error("`url` is required.");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("`url` must start with http:// or https://");
    }

    const rawMax = args.maxUrls !== undefined ? Number(args.maxUrls) : 100;
    const maxUrls = Math.min(Math.max(1, Math.floor(rawMax)), MAX_URLS);

    const xml = await fetchSitemap(url);

    let result: SitemapResult;
    if (/<sitemapindex\b/i.test(xml)) {
      result = parseSitemapIndex(xml);
    } else {
      result = parseUrlset(xml, maxUrls);
    }

    return JSON.stringify(result, null, 2);
  },
};
