import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, httpUrlArgError } from "./safe-fetch.js";

/**
 * html_table_extract (Fase 18.1) — <table> → JSON/CSV.
 *
 * Worker-only regex parser (no DOMParser in Workers), same style as
 * html-to-markdown.ts / page-links.ts. Depth-tracks <table> tags so nested
 * tables are extracted as their own separate entries instead of corrupting
 * the parent's rows. Handles colspan (repeats the cell across the spanned
 * columns); does NOT expand rowspan (documented limitation).
 */

const FETCH_TIMEOUT_MS = 10_000;
const READ_LIMIT = 3 * 1024 * 1024; // 3 MB
const DEFAULT_MAX_ROWS = 500;
const HARD_MAX_ROWS = 5_000;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
}

function stripTagsToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function getAttr(attrsStr: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?([^"'\\s>]+)`, "i").exec(attrsStr);
  return m ? m[1] : null;
}

function escapeCSVCell(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Depth-balanced scan for complete <table>...</table> blocks (handles nesting). */
function findTopLevelTables(html: string): string[] {
  const tagRe = /<table\b[^>]*>|<\/table\s*>/gi;
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[0].startsWith("</");
    if (!isClose) {
      if (depth === 0) start = m.index;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(html.slice(start, m.index + m[0].length));
        start = -1;
      }
    }
  }
  return blocks;
}

/** Remove nested <table> blocks from a table's inner content so row extraction
 * only picks up this table's own direct rows (nested tables come out as their
 * own separate top-level entries from findTopLevelTables). */
function stripNestedTables(inner: string): string {
  const nested = findTopLevelTables(inner);
  let result = inner;
  for (const n of nested) result = result.replace(n, "");
  return result;
}

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

function parseTableBlock(tableHtml: string): ParsedTable {
  const innerMatch = /^<table\b[^>]*>([\s\S]*)<\/table\s*>$/i.exec(tableHtml.trim());
  const inner = innerMatch ? innerMatch[1] : tableHtml;
  const cleaned = stripNestedTables(inner);

  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  const cellRe = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

  const rawRows: { cells: string[]; isHeaderRow: boolean }[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(cleaned)) !== null) {
    const rowContent = rm[1];
    const cells: string[] = [];
    let hasTh = false;
    cellRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowContent)) !== null) {
      const tagName = cm[1].toLowerCase();
      const attrsStr = cm[2];
      const text = stripTagsToText(cm[3]);
      if (tagName === "th") hasTh = true;
      const span = Math.max(1, parseInt(getAttr(attrsStr, "colspan") ?? "1", 10) || 1);
      for (let i = 0; i < span; i++) cells.push(text);
    }
    if (cells.length > 0) rawRows.push({ cells, isHeaderRow: hasTh });
  }

  if (rawRows.length === 0) return { headers: [], rows: [] };

  let headers: string[];
  let dataRows: string[][];
  if (rawRows[0].isHeaderRow) {
    headers = rawRows[0].cells;
    dataRows = rawRows.slice(1).map((r) => r.cells);
  } else {
    const width = Math.max(...rawRows.map((r) => r.cells.length));
    headers = Array.from({ length: width }, (_, i) => `col_${i + 1}`);
    dataRows = rawRows.map((r) => r.cells);
  }

  return { headers: dedupeHeaders(headers), rows: dataRows };
}

/** Guarantee unique, non-empty header names — colspan often repeats a label
 * across columns (e.g. "Score", "Score"), and a blank <th></th> is common.
 * Downstream JSON row objects are keyed by header name, so duplicates would
 * silently collapse into one key and drop data. */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const base = h || "col";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

async function fetchHtmlLimited(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "toolsnap-mcp/1.0 (html_table_extract; +https://toolsnap.app)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (err) {
    throw new Error(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw httpStatusError(response);
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength > READ_LIMIT) {
    throw new Error(`Page too large: ${buf.byteLength} bytes (max ${READ_LIMIT}).`);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export const htmlTableExtractTool: McpTool = {
  name: "html_table_extract",
  description:
    "Fetch a URL (or take raw HTML) and extract its <table> elements as structured data: headers + rows, ready for csv_query/json_query. Handles colspan (repeats the cell across spanned columns) and nested tables (returned as separate entries, not merged). Does NOT expand rowspan. Provide exactly one of url or html. By default returns all tables found; pass table_index to get just one, or format=csv (requires table_index when the page has more than one table). Free, Worker-only, deterministic, zero COGS. Complements sitemap_parse/page_links for site audits.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (http:// or https://)." },
      html: { type: "string", description: "Alt. to url: raw HTML to parse." },
      table_index: {
        type: "number",
        description: "0-based index of the table to return (default: return all tables found).",
      },
      format: {
        type: "string",
        enum: ["json", "csv"],
        description: "Default json. csv requires table_index when the page has more than one table.",
      },
      maxRows: {
        type: "number",
        description: `Max rows per table (default ${DEFAULT_MAX_ROWS}, max ${HARD_MAX_ROWS}).`,
      },
    },
  },
  async run(args) {
    const hasUrl = typeof args.url === "string" && (args.url as string).length > 0;
    const hasHtml = typeof args.html === "string" && (args.html as string).length > 0;
    if (!hasUrl && !hasHtml) throw new Error("Provide either `url` or `html`.");
    if (hasUrl && hasHtml) throw new Error("Provide either `url` or `html`, not both.");

    let rawHtml: string;
    if (hasUrl) {
      const url = args.url as string;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw httpUrlArgError(url);
      }
      rawHtml = await fetchHtmlLimited(url);
    } else {
      rawHtml = args.html as string;
    }

    const tableBlocks = findTopLevelTables(rawHtml);
    if (tableBlocks.length === 0) {
      throw new Error("No <table> elements found.");
    }

    const rawMaxRows = args.maxRows !== undefined ? Number(args.maxRows) : DEFAULT_MAX_ROWS;
    const maxRows = Math.min(Math.max(1, Math.floor(rawMaxRows)), HARD_MAX_ROWS);

    const parsed = tableBlocks.map((block) => parseTableBlock(block));

    let selected: ParsedTable[];
    let indices: number[];
    if (args.table_index !== undefined) {
      const idx = Math.floor(Number(args.table_index));
      if (!Number.isFinite(idx) || idx < 0 || idx >= parsed.length) {
        throw new Error(
          `table_index out of range: got ${args.table_index}, page has ${parsed.length} table(s) (0-${parsed.length - 1}).`
        );
      }
      selected = [parsed[idx]];
      indices = [idx];
    } else {
      selected = parsed;
      indices = parsed.map((_, i) => i);
    }

    const format = args.format === "csv" ? "csv" : "json";
    if (format === "csv" && selected.length > 1) {
      throw new Error(
        `format=csv requires table_index (page has ${parsed.length} tables). Pass table_index to select one.`
      );
    }

    const tables = selected.map((t, i) => {
      const totalRows = t.rows.length;
      const rows = t.rows.slice(0, maxRows);
      return {
        table_index: indices[i],
        headers: t.headers,
        total_rows: totalRows,
        returned_rows: rows.length,
        truncated: totalRows > maxRows,
        rows,
      };
    });

    if (format === "csv") {
      const t = tables[0];
      const lines = [t.headers.map(escapeCSVCell).join(",")];
      for (const row of t.rows) lines.push(row.map(escapeCSVCell).join(","));
      const csv = lines.join("\n");
      return t.truncated ? `${csv}\n# [Showing ${t.returned_rows} of ${t.total_rows} rows]` : csv;
    }

    return JSON.stringify(
      {
        total_tables: parsed.length,
        tables: tables.map(({ table_index, headers, total_rows, returned_rows, truncated, rows }) => ({
          table_index,
          headers,
          total_rows,
          returned_rows,
          ...(truncated ? { truncated: true } : {}),
          rows: rows.map((cells) =>
            Object.fromEntries(headers.map((h, i) => [h || `col_${i + 1}`, cells[i] ?? ""]))
          ),
        })),
      },
      null,
      2
    );
  },
};
