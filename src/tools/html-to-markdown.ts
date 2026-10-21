import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, type FilesEnv } from "./safe-fetch.js";

const DEFAULT_MAX_CHARS = 12_000;
const HARD_MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 10_000;

const NOISE_TAGS = ["script", "style", "nav", "header", "footer", "aside", "noscript", "iframe"];

function stripNoiseBlocks(html: string): string {
  let result = html;
  for (const tag of NOISE_TAGS) {
    result = result.replace(
      new RegExp(`<${tag}[\\s][^>]*>[\\s\\S]*?<\\/${tag}>|<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi"),
      ""
    );
  }
  return result;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#160;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCharCode(parseInt(num, 10)));
}

function convertToMarkdown(html: string): string {
  let md = html;

  md = stripNoiseBlocks(md);

  // Pre/code blocks — handle before inline code
  md = md.replace(
    /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi,
    (_, code: string) => `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n`
  );
  md = md.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, code: string) => `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n`
  );

  // Headings
  for (let i = 6; i >= 1; i--) {
    const prefix = "#".repeat(i);
    md = md.replace(
      new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi"),
      (_, content: string) => `\n${prefix} ${stripTags(content)}\n`
    );
  }

  // Blockquote
  md = md.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, content: string) =>
      content
        .trim()
        .split("\n")
        .map((l: string) => `> ${l.trim()}`)
        .filter((l: string) => l !== "> ")
        .join("\n") + "\n"
  );

  // Strong / bold
  md = md.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");

  // Em / italic
  md = md.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Inline code (not inside pre — already replaced above)
  md = md.replace(/<code[^>]*>([^<]*?)<\/code>/gi, "`$1`");

  // Links
  md = md.replace(
    /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, text: string) => {
      const clean = stripTags(text);
      return clean ? `[${clean}](${href})` : href;
    }
  );
  // Links with single quotes
  md = md.replace(
    /<a[^>]+href='([^']*)'[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, text: string) => {
      const clean = stripTags(text);
      return clean ? `[${clean}](${href})` : href;
    }
  );

  // Images
  md = md.replace(/<img[^>]+alt="([^"]*)"[^>]*>/gi, "![$1]");
  md = md.replace(/<img[^>]*>/gi, "");

  // Unordered lists
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, items: string) => {
    return (
      items.replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (__, item: string) => `- ${stripTags(item)}\n`
      ) + "\n"
    );
  });

  // Ordered lists
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, items: string) => {
    let counter = 0;
    return (
      items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item: string) => {
        counter++;
        return `${counter}. ${stripTags(item)}\n`;
      }) + "\n"
    );
  });

  // Horizontal rule
  md = md.replace(/<hr[^>]*>/gi, "\n---\n");

  // Line break
  md = md.replace(/<br[^>]*>/gi, "\n");

  // Paragraphs
  md = md.replace(
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
    (_, content: string) => `\n${content.trim()}\n`
  );

  // Divs / structural elements
  md = md.replace(/<\/(?:div|section|article|main|li|td|th)>/gi, "\n");
  md = md.replace(/<(?:div|section|article|main|table|tr)[^>]*>/gi, "\n");

  // Strip all remaining tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode entities
  md = decodeEntities(md);

  // Normalise whitespace
  md = md.replace(/\r\n?/g, "\n");
  md = md.replace(/[^\S\n]+/g, " ");
  md = md.replace(/ \n/g, "\n");
  md = md.replace(/\n /g, "\n");
  md = md.replace(/\n{3,}/g, "\n\n");

  return md.trim();
}

async function fetchHtml(
  url: string,
  forwardHeaders: Record<string, string> | undefined,
  filesEnv: FilesEnv | undefined
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await safeFetch(
      url,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "toolsnap-mcp/1.0 (html_to_markdown; +https://toolsnap.app)",
        },
      },
      { forwardHeaders, env: filesEnv }
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
  return response.text();
}

export const htmlToMarkdownTool: McpTool = {
  name: "html_to_markdown",
  description: "Convert a URL or raw HTML to Markdown. One of url or html. Not for JS SPAs.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Page URL (alt. to html)." },
      html: { type: "string", description: "Raw HTML (alt. to url)." },
      maxChars: { type: "number", description: `Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}.` },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
  },
  run() {
    throw new Error("html_to_markdown is env-aware and must be called via runWithEnv");
  },
  async runWithEnv(args, env) {
    const hasUrl = typeof args.url === "string" && args.url.length > 0;
    const hasHtml = typeof args.html === "string" && args.html.length > 0;

    if (!hasUrl && !hasHtml) {
      throw new Error("Provide either `url` or `html`.");
    }
    if (hasUrl && hasHtml) {
      throw new Error("Provide either `url` or `html`, not both.");
    }

    let rawHtml: string;
    if (hasUrl) {
      const url = args.url as string;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("`url` must start with http:// or https://");
      }
      rawHtml = await fetchHtml(url, parseForwardHeaders(args.headers), env as Env);
    } else {
      rawHtml = args.html as string;
    }

    const rawMax =
      args.maxChars !== undefined ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
    const maxChars = Math.min(Math.max(1, Math.floor(rawMax)), HARD_MAX_CHARS);

    let markdown = convertToMarkdown(rawHtml);

    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
    }

    return markdown;
  },
};
