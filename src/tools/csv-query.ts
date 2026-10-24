import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, type FilesEnv } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CSV_BYTES = 5_000_000; // 5 MB — free tier

const XL_FETCH_TIMEOUT_MS = 60_000;
const XL_MAX_CSV_BYTES = 100_000_000; // 100 MB — paid tier, streamed (never buffered whole)
const XL_DEFAULT_LIMIT = 100;
const XL_HARD_MAX_LIMIT = 1_000;

// ---------------------------------------------------------------------------
// Streaming CSV tokenizer — quote-aware, fed chunk by chunk so a large fetch
// never has to sit fully in memory as one buffer. Same field/quote semantics
// as a plain per-line parser (a '"' toggles quote state; a comma or newline
// outside quotes ends a field/row), just spread across push() calls instead
// of splitting the whole text into lines up front.
// ---------------------------------------------------------------------------

export class StreamingCSVParser {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private pendingQuoteDecision = false;
  private skipLFAfterCR = false;
  // Tracks whether the current row has seen a real delimiter/quote/content
  // character, so a truly blank (or whitespace-only) line can be dropped —
  // same as the old line-based parser skipping `line.trim() === ""` — without
  // also dropping a legitimate single-column row whose one field is an
  // explicitly quoted empty string (`""`), which LOOKS blank once collapsed
  // to `[""]` but isn't.
  private sawContentThisRow = false;
  /** True once the current field has opened a quote — see finishField(). */
  private fieldQuoted = false;
  /** True once the current field's closing quote has been consumed. */
  private afterClosingQuote = false;

  /**
   * Fase 25.6 — closes a field, trimming surrounding whitespace ONLY when the
   * field was never quoted (the `skipinitialspace` behaviour every real CSV
   * reader implements). A quoted field keeps its spaces verbatim, because
   * there they are deliberate.
   *
   * Why this matters: `name, city, n` (a space after each comma, which is how
   * a huge share of real CSVs are written) produced header ` city`, so
   * `select`/`filter`/`sort_by` on `city` could never match. `select` failed
   * with "Column(s) not found: city. Available: name,  city, n" — naming the
   * column it claimed was missing — and `filter`/`sort_by` were WORSE: they
   * silently returned 0 rows / skipped the sort, a wrong answer rather than an
   * error. Passing the untrimmed " city" didn't help either, since the
   * requested names were already trimmed on the other side. Hit by a real
   * caller on 2026-07-26 (AirPassengers dataset).
   */
  private finishField(): void {
    this.row.push(this.fieldQuoted ? this.field : this.field.trim());
    this.field = "";
    this.fieldQuoted = false;
    this.afterClosingQuote = false;
  }

  /** Feed a chunk of decoded text; returns any rows completed by it. */
  push(chunk: string): string[][] {
    const rows: string[][] = [];

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (this.skipLFAfterCR) {
        this.skipLFAfterCR = false;
        if (ch === "\n") continue;
      }

      if (this.inQuotes) {
        if (this.pendingQuoteDecision) {
          this.pendingQuoteDecision = false;
          if (ch === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
          this.afterClosingQuote = true;
          // fall through: `ch` is processed below as a normal (non-quoted) character
        } else if (ch === '"') {
          this.pendingQuoteDecision = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }

      if (ch === '"') {
        this.inQuotes = true;
        // Whitespace BEFORE the opening quote is padding around the delimiter,
        // not content: `a, "b, c"` must yield `b, c`, exactly as `a, b` yields
        // `b`. Without this the commonest quoted case (a field containing a
        // comma) kept the leading space and stayed unmatchable — the very bug
        // this trimming was added to fix.
        if (!this.fieldQuoted && this.field.trim() === "") this.field = "";
        this.fieldQuoted = true;
        this.sawContentThisRow = true;
      } else if (ch === ",") {
        this.finishField();
        this.sawContentThisRow = true;
      } else if (ch === "\r" || ch === "\n") {
        this.finishField();
        const row = this.row;
        this.row = [];
        this.field = "";
        if (this.sawContentThisRow || !(row.length === 1 && row[0].trim() === "")) rows.push(row);
        this.sawContentThisRow = false;
        if (ch === "\r") this.skipLFAfterCR = true;
      } else {
        // Whitespace AFTER the closing quote is padding too (`"a" , "b"`), but
        // only the padding immediately touching the quote — the first
        // non-blank character (even in malformed CSV like `"a" b c`) ends the
        // padding window, so the rest of the field is kept verbatim instead of
        // having its interior spaces silently eaten.
        if (ch.trim() !== "") {
          this.sawContentThisRow = true;
          this.afterClosingQuote = false;
        }
        if (this.afterClosingQuote && ch.trim() === "") continue;
        this.field += ch;
      }
    }

    return rows;
  }

  /** Flush the final (unterminated) row, if any. Call once after the last push(). */
  end(): string[][] {
    if (this.pendingQuoteDecision) {
      this.pendingQuoteDecision = false;
      this.inQuotes = false;
    }
    if (this.field.length === 0 && this.row.length === 0 && !this.sawContentThisRow) return [];
    this.finishField();
    const row = this.row;
    this.row = [];
    const sawContent = this.sawContentThisRow;
    this.sawContentThisRow = false;
    if (!sawContent && row.length === 1 && row[0].trim() === "") return [];
    return [row];
  }
}

// ---------------------------------------------------------------------------
// Filter: "column op value"  →  compiled to a per-row predicate so it can run
// against rows one at a time as they stream in, or in bulk over an array.
// Operators: = != > >= < <= contains startswith endswith
// ---------------------------------------------------------------------------

function compileFilter(filter: string): (row: Record<string, string>) => boolean {
  const m = filter.match(/^(.+?)\s*(=|!=|>=|<=|>|<|contains|startswith|endswith)\s*(.+)$/i);
  if (!m) {
    // Fase 25.4 — agents reach for SQL/OData word operators here ("Pclass eq
    // 3" showed up twice in the 2026-07-25 review). The old message listed the
    // valid operators but never showed a working filter, so the retry was a
    // guess. Lead with an example built from the caller's own input.
    const guess = filter.match(/^(.+?)\s+(eq|ne|gt|ge|lt|le)\s+(.+)$/i);
    const wordOps: Record<string, string> = { eq: "=", ne: "!=", gt: ">", ge: ">=", lt: "<", le: "<=" };
    const suggestion = guess
      ? ` Did you mean "${guess[1].trim()} ${wordOps[guess[2].toLowerCase()]} ${guess[3].trim()}"? Operators are symbols, not SQL/OData words.`
      : ` Example: "age >= 30".`;
    throw new Error(
      `Invalid filter: "${filter}". Expected: column op value  (op: = != > >= < <= contains startswith endswith).${suggestion}`
    );
  }

  const col = m[1].trim();
  const op = m[2].toLowerCase();
  const val = m[3].trim().replace(/^["']|["']$/g, "");
  const v = val.toLowerCase();

  return (row: Record<string, string>): boolean => {
    const cellRaw = row[col] ?? "";
    const cell = cellRaw.toLowerCase();

    switch (op) {
      case "=":
        return cell === v;
      case "!=":
        return cell !== v;
      case "contains":
        return cell.includes(v);
      case "startswith":
        return cell.startsWith(v);
      case "endswith":
        return cell.endsWith(v);
      case ">":
        return parseFloat(cellRaw) > parseFloat(val);
      case ">=":
        return parseFloat(cellRaw) >= parseFloat(val);
      case "<":
        return parseFloat(cellRaw) < parseFloat(val);
      case "<=":
        return parseFloat(cellRaw) <= parseFloat(val);
      default:
        return true;
    }
  };
}

function compileComparator(sortBy: string, dir: 1 | -1): (a: Record<string, string>, b: Record<string, string>) => number {
  return (a, b) => {
    const av = a[sortBy] ?? "";
    const bv = b[sortBy] ?? "";
    const an = parseFloat(av);
    const bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
    return av.localeCompare(bv) * dir;
  };
}

/** Insert `row` into `buffer` (kept sorted by `cmp`), dropping the worst entry once over `cap`. */
function insertBounded(
  buffer: Record<string, string>[],
  row: Record<string, string>,
  cmp: (a: Record<string, string>, b: Record<string, string>) => number,
  cap: number
): void {
  let lo = 0;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(buffer[mid], row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  buffer.splice(lo, 0, row);
  if (buffer.length > cap) buffer.pop();
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function escapeCSVCell(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCSV(rows: Record<string, string>[], headers: string[]): string {
  const lines = [headers.map(escapeCSVCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCSVCell(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Query engine — shared by csv_query (inline text or streamed fetch, 5 MB
// cap) and csv_query_xl (streamed fetch only, 100 MB cap). Rows are consumed
// one at a time as they arrive: without sort_by, reading stops as soon as
// `limit` matches are found (the rest of the response can't change the
// output, so there's no reason to keep downloading it); with sort_by, the
// whole capped stream is read but only a `limit`-sized top-k buffer is ever
// held in memory.
// ---------------------------------------------------------------------------

interface CsvQueryArgs {
  select?: unknown;
  filter?: unknown;
  sort_by?: unknown;
  sort_dir?: unknown;
  limit?: unknown;
  format?: unknown;
  headers?: unknown;
}

interface RowSink {
  headers: string[] | null;
  predicate: ((row: Record<string, string>) => boolean) | null;
  comparator: ((a: Record<string, string>, b: Record<string, string>) => number) | null;
  limit: number;
  matched: number;
  rows: Record<string, string>[]; // final/top-k rows, bounded to `limit` when no comparator
  done: boolean; // true once no further row can affect the output (early-exit eligible)
}

function makeSink(limit: number, filter: string | undefined, sortBy: string | undefined, sortDir: string | undefined): RowSink {
  return {
    headers: null,
    predicate: filter ? compileFilter(filter) : null,
    comparator: sortBy ? compileComparator(sortBy, sortDir === "desc" ? -1 : 1) : null,
    limit,
    matched: 0,
    rows: [],
    done: false,
  };
}

function feedRow(sink: RowSink, fields: string[]): void {
  if (!sink.headers) {
    sink.headers = fields;
    return;
  }
  const row: Record<string, string> = {};
  for (let j = 0; j < sink.headers.length; j++) row[sink.headers[j]] = fields[j] ?? "";

  if (sink.predicate && !sink.predicate(row)) return;
  sink.matched++;

  if (sink.comparator) {
    insertBounded(sink.rows, row, sink.comparator, sink.limit);
  } else if (sink.rows.length < sink.limit) {
    sink.rows.push(row);
    if (sink.rows.length === sink.limit) sink.done = true; // no comparator → order is stream order, further rows can't matter
  }
}

function finalizeCsvOutput(
  sink: RowSink,
  args: CsvQueryArgs,
  matchedIsExact: boolean
): string {
  const headers = sink.headers ?? [];
  if (headers.length === 0) throw new Error("CSV is empty or has no header row.");

  let outHeaders = headers;
  let rows = sink.rows;

  if (typeof args.select === "string" && args.select.trim()) {
    const wanted = args.select.split(",").map((c) => c.trim());
    const missing = wanted.filter((c) => !headers.includes(c));
    if (missing.length > 0) {
      throw new Error(`Column(s) not found: ${missing.join(", ")}. Available: ${headers.join(", ")}`);
    }
    outHeaders = wanted;
    rows = rows.map((row) => {
      const r: Record<string, string> = {};
      for (const h of wanted) r[h] = row[h] ?? "";
      return r;
    });
  }

  const truncated = matchedIsExact ? sink.matched > rows.length : true;

  if (args.format === "csv") {
    const csvOut = rowsToCSV(rows, outHeaders);
    if (!truncated) return csvOut;
    const note = matchedIsExact
      ? `# [Showing ${rows.length} of ${sink.matched} matching rows]`
      : `# [Showing first ${rows.length} matching rows; stopped reading early once the limit was reached]`;
    return `${csvOut}\n${note}`;
  }

  const meta: Record<string, unknown> = {
    returned_rows: rows.length,
    columns: outHeaders,
  };
  if (matchedIsExact) {
    meta.total_rows = sink.matched;
    meta.total_rows_is_exact = true;
    if (truncated) {
      meta.truncated = true;
      meta.limit = sink.limit;
    }
  } else {
    meta.total_rows_is_exact = false;
    meta.truncated = true;
    meta.limit = sink.limit;
    meta.note = "Reading stopped once `limit` matching rows were found — total_rows is unknown beyond that.";
  }
  return JSON.stringify({ meta, rows }, null, 2);
}

function detectNotCSV(headerFields: string[]): string | null {
  if (headerFields.length === 1 && /^\s*<(!doctype|html|\?xml)/i.test(headerFields[0])) {
    return `Response does not look like CSV (first line: "${headerFields[0].slice(0, 120)}").`;
  }
  return null;
}

interface CsvQueryEngineOptions {
  toolName: string;
  allowInline: boolean;
  maxBytes: number;
  fetchTimeoutMs: number;
  defaultLimit: number;
  hardMaxLimit: number;
  tooLargeHint: string;
}

async function runCsvQuery(
  args: CsvQueryArgs & { url?: unknown; csv?: unknown },
  opts: CsvQueryEngineOptions,
  filesEnv?: FilesEnv
): Promise<string> {
  const hasUrl = typeof args.url === "string" && (args.url as string).length > 0;
  const hasCSV = opts.allowInline && typeof args.csv === "string" && (args.csv as string).length > 0;

  if (!hasUrl && !hasCSV) {
    throw new Error(opts.allowInline ? "Provide either `url` or `csv`." : "`url` is required.");
  }
  if (hasUrl && hasCSV) throw new Error("Provide either `url` or `csv`, not both.");

  const rawLimit = args.limit !== undefined ? Number(args.limit) : opts.defaultLimit;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), opts.hardMaxLimit);
  const filter = typeof args.filter === "string" && args.filter.trim() ? args.filter.trim() : undefined;
  const sortBy = typeof args.sort_by === "string" && args.sort_by.trim() ? args.sort_by.trim() : undefined;
  const sortDir = typeof args.sort_dir === "string" ? args.sort_dir : undefined;

  const sink = makeSink(limit, filter, sortBy, sortDir);
  const parser = new StreamingCSVParser();
  let matchedIsExact = true;

  const feedOne = (fields: string[]): void => {
    if (sink.headers === null) {
      const notCsv = detectNotCSV(fields);
      if (notCsv) throw new Error(notCsv);
    }
    feedRow(sink, fields);
  };

  // Inline `csv` text is already fully in memory (no bandwidth to save), so
  // every row is scanned regardless of sink.done — otherwise total_rows would
  // undercount rows past the limit that were never actually re-read from a
  // stream. Early exit is a fetch-path-only optimization (see below).
  const consumeAll = (rows: string[][]): void => {
    for (const fields of rows) feedOne(fields);
  };

  // Fetch path: returns true once no further row can change the output, so
  // the caller can stop reading and cancel the response body.
  const consumeWithEarlyExit = (rows: string[][]): boolean => {
    for (const fields of rows) {
      feedOne(fields);
      if (sink.done) return true;
    }
    return false;
  };

  if (hasCSV) {
    const raw = args.csv as string;
    consumeAll(parser.push(raw));
    consumeAll(parser.end());
  } else {
    const url = args.url as string;
    const forwardHeaders = parseForwardHeaders(args.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs);
    let response: Response;
    try {
      response = await safeFetch(
        url,
        {
          signal: controller.signal,
          headers: { "User-Agent": `toolsnap-mcp/1.0 (${opts.toolName}; +https://toolsnap.app)` },
        },
        { forwardHeaders, env: filesEnv }
      );
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw httpStatusError(response);
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new Error("Response had no readable body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let stoppedEarly = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > opts.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `CSV too large for ${opts.toolName}: exceeded ${opts.maxBytes} bytes while streaming. ${opts.tooLargeHint}`
          );
        }
        const text = decoder.decode(value, { stream: true });
        if (consumeWithEarlyExit(parser.push(text))) {
          stoppedEarly = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (!stoppedEarly) {
        consumeAll(parser.push(decoder.decode()));
        consumeAll(parser.end());
      }
    } finally {
      clearTimeout(timer);
    }

    matchedIsExact = !stoppedEarly;
  }

  return finalizeCsvOutput(sink, args, matchedIsExact);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const csvQueryTool: McpTool = {
  name: "csv_query",
  description:
    "Free, read-only. Query a comma-separated CSV with a header row, from a URL (max 5 MB, streamed) or inline text, one of the two: select columns, filter rows, sort, limit. Returns {meta:{returned_rows,columns,total_rows,truncated},rows:[{column:value}]}, all values strings, or CSV text with format='csv'. One filter condition, no joins or aggregates. Unknown select columns and bad filters error with the valid names or operators. Over 5 MB: csv_query_xl (paid, 100 MB).",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "CSV URL, max 5 MB. Not with csv." },
      csv: { type: "string", description: "Inline CSV text. Not with url." },
      select: { type: "string", description: "Columns to keep, comma-separated, exact header names. Omit for all." },
      filter: { type: "string", description: "'column op value'. Ops: = != contains startswith endswith (text, case-insensitive), > >= < <= (numeric). E.g. 'age >= 30'." },
      sort_by: { type: "string", description: "Column to sort by; numeric when values parse as numbers, else text." },
      sort_dir: { type: "string", enum: ["asc", "desc"], description: "asc (default) or desc." },
      limit: { type: "number", description: "Rows to return. Default 500, max 5000; over it meta.truncated=true." },
      format: { type: "string", enum: ["json", "csv"], description: "json (default): {meta,rows}. csv: text with header row." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
  },
  run() {
    throw new Error("csv_query is env-aware and must be called via runWithEnv");
  },
  runWithEnv(args, env) {
    return runCsvQuery(
      args,
      {
        toolName: "csv_query",
        allowInline: true,
        maxBytes: MAX_CSV_BYTES,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
        defaultLimit: 500,
        hardMaxLimit: 5000,
        tooLargeHint:
          "Use `csv_query_xl` (paid: $0.02/call or $0.01 prepaid, up to 100 MB) with the same arguments. If you have no balance yet, csv_query_xl will return funding instructions (card or USDC).",
      },
      env as Env
    );
  },
};

export const csvQueryXlTool: McpTool = {
  name: "csv_query_xl",
  description:
    "Paid sibling of csv_query for larger URL-hosted CSVs (up to 100 MB, vs 5 MB free), streamed server-side so the file never touches your context. Same select/filter/sort/limit query language. URL-only (no inline csv — a 100 MB payload would blow out your context anyway). $0.02/call pay-per-call or $0.01 prepaid; no first-call-free (a paid file-size tier, not a marketing freebie). You pay for the query, not the row count — a 0-row match still settles. Below 5 MB, use the free csv_query instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "CSV URL." },
      select: { type: "string", description: "Columns, comma-separated." },
      filter: { type: "string", description: "'col op value'." },
      sort_by: { type: "string", description: "Sort column." },
      sort_dir: { type: "string", enum: ["asc", "desc"], description: "Default asc." },
      limit: { type: "number", description: `Default ${XL_DEFAULT_LIMIT}, max ${XL_HARD_MAX_LIMIT}.` },
      format: { type: "string", enum: ["json", "csv"], description: "Default json." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["url"],
  },
  run() {
    throw new Error("csv_query_xl is env-aware and must be called via runWithEnv");
  },
  runWithEnv(args, env) {
    return runCsvQuery(
      args,
      {
        toolName: "csv_query_xl",
        allowInline: false,
        maxBytes: XL_MAX_CSV_BYTES,
        fetchTimeoutMs: XL_FETCH_TIMEOUT_MS,
        defaultLimit: XL_DEFAULT_LIMIT,
        hardMaxLimit: XL_HARD_MAX_LIMIT,
        tooLargeHint: "This file exceeds even csv_query_xl's 100 MB cap.",
      },
      env as Env
    );
  },
};
