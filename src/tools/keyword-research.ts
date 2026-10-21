import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";

/**
 * keyword_research (Fase 12) — query DataForSEO Keywords Data → Google Ads
 * Search Volume (live endpoint) for 1–20 keywords and return per-keyword:
 * monthly search volume, CPC, competition (0-1), and top-5 related suggestions.
 *
 * Env-aware (needs DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD), handled via
 * `runWithEnv` from the dispatcher's payment gate; the plain `run` throws.
 *
 * Pricing: $0.04 pay-per-call / $0.025 prepaid (real COGS ~$0.002-0.003/batch).
 * firstCallFreeEligible = false (COGS tool).
 */

const DATAFORSEO_BASE = "https://api.dataforseo.com/v3";
const MAX_KEYWORDS = 20;
const API_TIMEOUT_MS = 30_000;

const HANDLED_AT_SERVER =
  "keyword_research is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

interface KeywordResult {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  competition: number | null;
  competition_level: string | null;
  monthly_searches: Array<{ year: number; month: number; search_volume: number }> | null;
}

interface SuggestionResult {
  keyword: string;
  search_volume: number | null;
  cpc_usd: number | null;
  competition: number | null;
}

interface KeywordOutput {
  keyword: string;
  search_volume: number | null;
  cpc_usd: number | null;
  competition: number | null;
  competition_level: string | null;
  trend_last_12m: Array<{ year: number; month: number; search_volume: number }> | null;
  related_suggestions: SuggestionResult[];
}

function parseKeywords(raw: unknown): string[] {
  if (typeof raw === "string") {
    const kws = [raw.trim()].filter(Boolean);
    if (!kws.length) throw new Error("`keywords` must be a non-empty string or array");
    if (kws.length > MAX_KEYWORDS)
      throw new Error(`Maximum ${MAX_KEYWORDS} keywords per call; got ${kws.length}`);
    return kws;
  }
  if (Array.isArray(raw)) {
    if (!raw.length) throw new Error("`keywords` array must not be empty");
    if (raw.length > MAX_KEYWORDS)
      throw new Error(`Maximum ${MAX_KEYWORDS} keywords per call; got ${raw.length}`);
    const kws = raw.map((k) => String(k).trim()).filter(Boolean);
    if (!kws.length) throw new Error("`keywords` array contains no valid strings");
    return kws;
  }
  throw new Error("`keywords` must be a string or array of strings");
}

function buildAuthHeader(login: string, password: string): string {
  const encoded = btoa(`${login}:${password}`);
  return `Basic ${encoded}`;
}

/** POST to DataForSEO Google Ads Search Volume live endpoint. */
async function fetchSearchVolume(
  keywords: string[],
  languageCode: string,
  locationCode: number,
  auth: string,
  signal: AbortSignal
): Promise<KeywordResult[]> {
  const body = JSON.stringify([
    {
      keywords,
      language_code: languageCode,
      location_code: locationCode,
      search_partners: false,
      date_from: null,
      date_to: null,
      sort_by: "relevance",
      include_serp_info: false,
      include_adult_keywords: false,
    },
  ]);

  const res = await fetch(
    `${DATAFORSEO_BASE}/keywords_data/google_ads/search_volume/live`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body,
      signal,
    }
  );

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 400);
    } catch { /* ignore */ }
    throw new Error(
      `DataForSEO search_volume failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`
    );
  }

  const json = (await res.json()) as {
    status_code?: number;
    status_message?: string;
    tasks?: Array<{
      status_code?: number;
      status_message?: string;
      result?: Array<{
        keyword?: string;
        search_volume?: number | null;
        cpc?: number | null;
        competition?: number | null;
        competition_level?: string | null;
        monthly_searches?: Array<{ year: number; month: number; search_volume: number }> | null;
      }>;
    }>;
  };

  if (json.status_code !== 20000) {
    throw new Error(
      `DataForSEO API error ${json.status_code}: ${json.status_message ?? "unknown"}`
    );
  }

  const task = json.tasks?.[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(
      `DataForSEO task error ${task?.status_code}: ${task?.status_message ?? "unknown"}`
    );
  }

  return (task.result ?? []).map((r) => ({
    keyword: r.keyword ?? "",
    search_volume: r.search_volume ?? null,
    cpc: r.cpc ?? null,
    competition: r.competition ?? null,
    competition_level: r.competition_level ?? null,
    monthly_searches: r.monthly_searches ?? null,
  }));
}

/** POST to DataForSEO Keywords for Keywords live endpoint (related suggestions). */
async function fetchRelatedKeywords(
  keywords: string[],
  languageCode: string,
  locationCode: number,
  auth: string,
  signal: AbortSignal
): Promise<Map<string, SuggestionResult[]>> {
  const body = JSON.stringify([
    {
      keywords,
      language_code: languageCode,
      location_code: locationCode,
      limit: 5,
      sort_by: "relevance",
      include_adult_keywords: false,
    },
  ]);

  const res = await fetch(
    `${DATAFORSEO_BASE}/keywords_data/google_ads/keywords_for_keywords/live`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body,
      signal,
    }
  );

  // Related keywords endpoint is best-effort — don't fail the whole call.
  if (!res.ok) return new Map();

  let json: {
    status_code?: number;
    tasks?: Array<{
      status_code?: number;
      result?: Array<{
        keyword?: string;
        search_volume?: number | null;
        cpc?: number | null;
        competition?: number | null;
      }>;
    }>;
  };
  try {
    json = await res.json() as typeof json;
  } catch {
    return new Map();
  }

  if (json.status_code !== 20000) return new Map();
  const task = json.tasks?.[0];
  if (!task || task.status_code !== 20000) return new Map();

  // The keywords_for_keywords endpoint returns a flat list — we assign all
  // suggestions to every seed keyword (they are shared across seeds).
  const suggestions: SuggestionResult[] = (task.result ?? []).map((r) => ({
    keyword: r.keyword ?? "",
    search_volume: r.search_volume ?? null,
    cpc_usd: r.cpc ?? null,
    competition: (r.competition as number | null | undefined) ?? null,
  }));

  const result = new Map<string, SuggestionResult[]>();
  for (const kw of keywords) {
    result.set(kw, suggestions.slice(0, 5));
  }
  return result;
}

async function runKeywordResearch(
  args: Record<string, unknown>,
  env: Env
): Promise<string> {
  const keywords = parseKeywords(args.keywords);
  const languageCode = typeof args.language_code === "string" ? args.language_code : "es";
  const locationCode =
    typeof args.location_code === "number"
      ? Math.floor(args.location_code)
      : 2724; // Spain default
  const includeSuggestions = args.include_suggestions !== false;

  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    throw new Error(
      "DataForSEO credentials are not configured (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)."
    );
  }

  const auth = buildAuthHeader(env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let volumeResults: KeywordResult[];
  let suggestionsMap = new Map<string, SuggestionResult[]>();

  try {
    [volumeResults, suggestionsMap] = await Promise.all([
      fetchSearchVolume(keywords, languageCode, locationCode, auth, controller.signal),
      includeSuggestions
        ? fetchRelatedKeywords(keywords, languageCode, locationCode, auth, controller.signal)
        : Promise.resolve(new Map<string, SuggestionResult[]>()),
    ]);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DataForSEO request timed out after ${API_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const output: KeywordOutput[] = keywords.map((kw) => {
    const vol = volumeResults.find(
      (r) => r.keyword.toLowerCase() === kw.toLowerCase()
    );
    return {
      keyword: kw,
      search_volume: vol?.search_volume ?? null,
      cpc_usd: vol?.cpc ?? null,
      competition: vol?.competition ?? null,
      competition_level: vol?.competition_level ?? null,
      trend_last_12m: vol?.monthly_searches
        ? vol.monthly_searches
            .sort((a, b) => a.year !== b.year ? b.year - a.year : b.month - a.month)
            .slice(0, 12)
        : null,
      related_suggestions: suggestionsMap.get(kw) ?? [],
    };
  });

  return JSON.stringify(
    {
      keywords_count: keywords.length,
      language_code: languageCode,
      location_code: locationCode,
      results: output,
    },
    null,
    2
  );
}

export const keywordResearchTool: McpTool = {
  name: "keyword_research",
  description:
    "Google Ads volume/CPC/competition for 1-20 keywords. $0.04 USDC/call. Paid: calling without a payment payload returns a structured 402 with payment options — that response is the documented behavior, not a failure.",
  inputSchema: {
    type: "object",
    properties: {
      keywords: { type: "array", description: "1-20 keywords." },
      language_code: { type: "string", default: "es", description: "ISO 639-1." },
      location_code: { type: "number", default: 2724, description: "DataForSEO location (default Spain)." },
      include_suggestions: { type: "boolean", default: true, description: "Add related suggestions." },
    },
    required: ["keywords"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runKeywordResearch(args, env as Env);
  },
};
