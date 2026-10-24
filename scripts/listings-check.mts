/**
 * Live review of the directories where ToolSnap MCP is listed.
 *
 * Reads registry/listings.json (what to check per row), checks every listing
 * live (ToolSnap fetch_extract for pages, local fetch as fallback, `gh api`
 * for PRs/issues/files, the official registry API) and prints a Markdown
 * report: changes since the last run, contradictions with the table in vault
 * note 11, warnings, what needs a browser and what only Unai can do.
 *
 * Run:  npx tsx scripts/listings-check.mts [--cadence weekly|monthly|all|auto]
 *                                          [--only id,id] [--no-save] [--json]
 *
 * --cadence auto (default): `all` during the first 7 days of the month,
 * `weekly` otherwise. Each run saves a snapshot and the report under
 * <vault>/11-anexos/ (override the vault with TOOLSNAP_VAULT) unless --no-save.
 *
 * Cost: no KV, no X API, no D1 reads. Each fetch_extract call writes one
 * analytics row; set TOOLSNAP_INTERNAL_TOKEN to mark them internal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Obs = Record<string, string | number | boolean | null>;
interface CheckResult {
  label: string;
  obs: Obs;
  warnings: string[];
  error?: string;
  browser?: string;
  notFound?: boolean;
  published?: boolean;
}
interface Check {
  type: "registry" | "page" | "json" | "gh_pr" | "gh_issue" | "gh_file" | "manual";
  [k: string]: any;
}
interface Listing {
  id: string;
  match: string;
  cadence: "weekly" | "monthly";
  owner: "claude" | "unai";
  checks: Check[];
  unai_todo?: string;
  browser_fallback?: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = process.env.TOOLSNAP_VAULT ?? "/Volumes/SSD Música/CODING AREA/unai-brain/mcp.toolsnap.app";
const MCP = "https://mcp.toolsnap.app/mcp";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const today = new Date().toISOString().slice(0, 10);
let cadence = arg("cadence") ?? "auto";
if (cadence === "auto") cadence = new Date().getDate() <= 7 ? "all" : "weekly";
const only = arg("only")?.split(",");

const config = JSON.parse(readFileSync(join(ROOT, "registry/listings.json"), "utf8"));
const listings: Listing[] = config.listings;

// ---------- ground truth ----------

async function mcpCall(method: string, params: unknown): Promise<any> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (process.env.TOOLSNAP_INTERNAL_TOKEN) headers["x-toolsnap-internal"] = process.env.TOOLSNAP_INTERNAL_TOKEN;
  const res = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  // Streamable HTTP may answer as SSE; take the last data: line.
  const json = body.startsWith("{") ? body : (body.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").slice(5);
  return JSON.parse(json);
}

async function truth() {
  const serverJson = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
  const skill = readFileSync(join(ROOT, "skills/toolsnap/SKILL.md"), "utf8");
  const manifest = await (await fetch("https://mcp.toolsnap.app/.well-known/mcp.json")).json();
  const list = await mcpCall("tools/list", {});
  const tools: any[] = manifest.tools;
  return {
    version: serverJson.version as string,
    skill_version: /^version:\s*(\S+)/m.exec(skill)?.[1] ?? "?",
    total: tools.length,
    free: tools.filter((t) => t.tier === "free").length,
    paid: tools.filter((t) => t.tier !== "free").length,
    core: list.result.tools.length as number,
    repo: config.repo as string,
    old_repo: config.old_repo as string,
  };
}
type Truth = Awaited<ReturnType<typeof truth>>;
let T: Truth;

const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => String((T as any)[k] ?? `{${k}}`));

// ---------- helpers ----------

/** "47 tools", "41 tools" … → counts that are neither the total nor the core. */
function toolCountWarnings(text: string): { counts: number[]; warnings: string[] } {
  const counts = [...text.matchAll(/(\d{1,3})\s+(?:MCP\s+)?tools\b/gi)].map((m) => Number(m[1]));
  const ok = new Set([T.total, T.core, T.free, T.paid]);
  const bad = [...new Set(counts.filter((n) => !ok.has(n)))];
  return { counts: [...new Set(counts)], warnings: bad.map((n) => `cifra vieja: "${n} tools" (hoy ${T.total}, núcleo ${T.core})`) };
}

function repoWarnings(text: string): string[] {
  return text.includes(T.old_repo) ? [`enlaza a la ruta vieja ${T.old_repo}`] : [];
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");
}

async function getText(url: string, via: "auto" | "local"): Promise<{ status: number; text: string; via: string }> {
  if (via === "auto") {
    try {
      const r = await mcpCall("tools/call", { name: "fetch_extract", arguments: { url, maxChars: 30000 } });
      const text: string = r.result?.content?.[0]?.text ?? "";
      if (!r.result?.isError) return { status: 200, text, via: "toolsnap" };
      const m = /HTTP (\d{3})/.exec(text);
      if (m && m[1] === "404") return { status: 404, text: "", via: "toolsnap" };
    } catch {
      /* fall through to a local fetch */
    }
  }
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const raw = await res.text();
  // Keep raw HTML too: links (repo URLs) live in attributes.
  return { status: res.status, text: `${stripHtml(raw)}\n${raw}`, via: "local" };
}

function gh(path: string): any {
  const out = execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? o : k === "length" && Array.isArray(o) ? o.length : o[k]), obj);
}

const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

// ---------- checks ----------

async function runCheck(c: Check, l: Listing): Promise<CheckResult> {
  const r: CheckResult = { label: c.label ?? c.url ?? `${c.repo ?? ""}#${c.number ?? c.path ?? ""}`, obs: {}, warnings: [] };
  try {
    switch (c.type) {
      case "manual":
        r.obs.manual = c.note;
        break;

      case "registry": {
        const d = await (await fetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(c.name)}`)).json();
        const latest = d.servers.find((s: any) => s._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest)?.server;
        if (!latest) throw new Error("sin versión isLatest en el registro");
        r.label = c.name;
        r.obs.version = latest.version;
        r.obs.repo = latest.repository?.url ?? null;
        r.obs.description = latest.description;
        if (latest.version !== T.version) r.warnings.push(`registro en ${latest.version}, server.json en ${T.version}: republicar`);
        if (!String(latest.repository?.url).includes(T.repo)) r.warnings.push(`repo del registro: ${latest.repository?.url}`);
        r.warnings.push(...toolCountWarnings(latest.description).warnings);
        break;
      }

      case "page": {
        const url = fill(c.url);
        const { status, text, via } = await getText(url, c.via ?? "auto");
        r.obs.http = status;
        r.obs.via = via;
        // Existence probes: some sites answer an unknown slug with 500, not 404.
        if (status === 404 || (c.probe && status >= 400)) {
          r.notFound = true;
          break;
        }
        if (status >= 400) {
          r.error = `HTTP ${status}`;
          r.browser = c.browser_fallback ?? l.browser_fallback ?? `abrir ${url} en el navegador`;
          break;
        }
        r.published = true;
        if (c.tools) {
          const t = toolCountWarnings(text);
          r.obs.tools = t.counts.join(",") || null;
          r.warnings.push(...t.warnings);
        }
        if (c.repo) r.warnings.push(...repoWarnings(text));
        for (const s of c.contains ?? []) {
          const want = fill(s);
          if (!text.toLowerCase().includes(want.toLowerCase())) r.warnings.push(`no aparece "${want}"`);
        }
        for (const s of c.absent ?? []) if (text.toLowerCase().includes(s.toLowerCase())) r.warnings.push(`sigue diciendo "${s}"`);
        for (const [k, re] of Object.entries<string>(c.capture ?? {})) r.obs[k] = new RegExp(re, "i").exec(text)?.[1] ?? null;
        break;
      }

      case "json": {
        const res = await fetch(c.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
        r.obs.http = res.status;
        if (!res.ok) {
          r.error = `HTTP ${res.status}`;
          break;
        }
        const d = await res.json();
        for (const [k, p] of Object.entries<string>(c.fields ?? {})) {
          const v = getPath(d, p);
          r.obs[k] = v == null || typeof v !== "object" ? (v ?? null) : JSON.stringify(v);
        }
        for (const [k, v] of Object.entries<string>(c.expect ?? {})) {
          if (String(r.obs[k]) !== fill(v)) r.warnings.push(`${k} = ${r.obs[k]}, se esperaba ${fill(v)}`);
        }
        for (const [k, v] of Object.entries<string>(c.warn_if_contains ?? {})) {
          if (String(r.obs[k] ?? "").includes(v)) r.warnings.push(`${k} contiene "${v}"${c.warn_note ? `: ${c.warn_note}` : ""}`);
        }
        if (c.tools_path) r.warnings.push(...toolCountWarnings(String(getPath(d, c.tools_path) ?? "")).warnings);
        r.warnings.push(...repoWarnings(JSON.stringify(d)));
        break;
      }

      case "gh_pr": {
        const pr = gh(`repos/${c.repo}/pulls/${c.number}`);
        const reviews: any[] = gh(`repos/${c.repo}/pulls/${c.number}/reviews`);
        const comments: any[] = gh(`repos/${c.repo}/issues/${c.number}/comments`);
        r.label = `${c.repo}#${c.number}`;
        r.obs.state = pr.merged ? "merged" : pr.state;
        r.obs.mergeable = pr.mergeable_state;
        r.obs.reviews = reviews.length;
        r.obs.comments = comments.length + pr.review_comments;
        r.obs.updated = pr.updated_at.slice(0, 10);
        const lastReview = [...reviews].pop();
        if (lastReview) r.obs.last_review = `${lastReview.user?.login} ${lastReview.state} ${String(lastReview.submitted_at).slice(0, 10)}`;
        const changesRequested = reviews.some((x) => x.state === "CHANGES_REQUESTED");
        if (changesRequested) r.warnings.push("piden cambios en la review");
        if (pr.state === "open" && days(pr.updated_at) > 30) r.warnings.push(`sin movimiento desde hace ${days(pr.updated_at)} días`);
        if (pr.state === "closed" && !pr.merged) r.warnings.push("cerrada sin merge");
        const last = [...comments].pop();
        if (last && last.user?.login !== "icosaedro-git") r.obs.last_comment = `${last.user.login} ${last.created_at.slice(0, 10)}`;
        break;
      }

      case "gh_issue": {
        const is = gh(`repos/${c.repo}/issues/${c.number}`);
        r.label = `${c.repo}#${c.number}`;
        r.obs.state = is.state === "closed" ? `closed (${is.state_reason ?? "?"})` : "open";
        r.obs.comments = is.comments;
        r.obs.updated = is.updated_at.slice(0, 10);
        if (is.state === "open" && days(is.updated_at) > 30) r.warnings.push(`sin movimiento desde hace ${days(is.updated_at)} días`);
        break;
      }

      case "gh_file": {
        const f = gh(`repos/${c.repo}/contents/${c.path}`);
        const text = Buffer.from(f.content, "base64").toString("utf8");
        const lines = text.split("\n").filter((x) => x.toLowerCase().includes(String(c.near).toLowerCase()));
        r.label = c.label ?? `${c.repo}/${c.path}`;
        r.obs.present = lines.length > 0;
        r.published = lines.length > 0;
        if (c.tools && lines.length) r.warnings.push(...toolCountWarnings(lines.join("\n")).warnings);
        if (lines.length) r.warnings.push(...repoWarnings(lines.join("\n")));
        break;
      }
    }
  } catch (e: any) {
    r.error = (e?.stderr?.toString() || e?.message || String(e)).trim().split("\n")[0];
    r.browser ??= l.browser_fallback;
  }
  return r;
}

// ---------- table in note 11 ----------

function noteFile(): string | null {
  try {
    const name = execFileSync("ls", [VAULT], { encoding: "utf8" }).split("\n").find((n) => n.startsWith("11 "));
    return name ? join(VAULT, name) : null;
  } catch {
    return null;
  }
}

function tableRows(): string[][] {
  const f = noteFile();
  if (!f) return [];
  const md = readFileSync(f, "utf8");
  const start = md.indexOf("## Tabla de listados");
  const section = md.slice(start, md.indexOf("\n## ", start + 5));
  return section
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Target") && !l.startsWith("|---"))
    .map((l) => l.slice(2, -2).split(" | "));
}

// ---------- main ----------

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j]);
    }
  }));
  return out;
}

T = await truth();
const selected = listings.filter((l) => (only ? only.includes(l.id) : cadence === "all" || cadence === "monthly" || l.cadence === "weekly"));
const results = await pool(selected, 4, async (l) => ({ l, checks: await Promise.all(l.checks.map((c) => runCheck(c, l))) }));
const checkOf = (l: Listing, r: CheckResult) => l.checks[results.find((x) => x.l === l)!.checks.indexOf(r)];

const statePath = join(VAULT, "11-anexos/listados-estado.json");
const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { date: null, listings: {} };
const rows = tableRows();

const changes: string[] = [];
const contradictions: string[] = [];
const warnings: string[] = [];
const browser: string[] = [];
const detail: string[] = [];
const state: Record<string, Obs> = { ...prev.listings };

for (const { l, checks } of results) {
  const flat: Obs = {};
  checks.forEach((c, i) => {
    for (const [k, v] of Object.entries(c.obs)) if (k !== "description" && k !== "via") flat[checks.length > 1 ? `${i}.${k}` : k] = v;
    if (c.notFound) flat[checks.length > 1 ? `${i}.http` : "http"] = 404;
  });
  const old: Obs = prev.listings[l.id] ?? {};
  for (const [k, v] of Object.entries(flat)) if (prev.date && k in old && old[k] !== v) changes.push(`**${l.id}** ${k}: ${old[k]} → ${v}`);
  state[l.id] = flat;

  const row = rows.find((r) => r[0].includes(l.match));
  const rowText = row?.join(" | ") ?? "";
  if (!row) contradictions.push(`**${l.id}**: no encuentro la fila (\`match\`: "${l.match}")`);

  for (const c of checks) {
    for (const w of c.warnings) warnings.push(`**${l.id}** (${c.label}): ${w}`);
    if (c.error) warnings.push(`**${l.id}** (${c.label}): error: ${c.error}`);
    if (c.browser) browser.push(`**${l.id}**: ${c.browser}`);
    if (!row) continue;
    const state = String(c.obs.state ?? "");
    if ((state === "merged" || state.startsWith("closed")) && /⏳/.test(row[1] ?? "")) contradictions.push(`**${l.id}**: la tabla dice ⏳ y ${c.label} está ${state}`);
    if (c.notFound && /^✅/.test(row[1] ?? "") && !checkOf(l, c).probe) contradictions.push(`**${l.id}**: la tabla dice ✅ y ${c.label} da 404`);
    if (c.published && checkOf(l, c).probe && !/^✅/.test(row[1] ?? "")) contradictions.push(`**${l.id}**: ya está publicada (${c.label}) y la tabla no dice ✅`);
    if (c.warnings.length === 0 && !c.error) {
      const stale = [...(row[2] ?? "").matchAll(/⚠️[^·|]*?"(\d+) tools"/g)].map((m) => m[1]);
      for (const n of stale) contradictions.push(`**${l.id}**: la tabla avisa de "${n} tools" y en vivo ya está bien`);
    }
  }
  const obsText = checks
    .map((c) => (c.notFound ? `${c.label}: no existe` : Object.entries(c.obs).filter(([k]) => k !== "description" && k !== "via").map(([k, v]) => `${k}=${v}`).join(" ")))
    .join(" · ");
  const flagged = checks.some((c) => c.warnings.length || c.error);
  detail.push(`| ${l.id} | ${flagged ? "⚠️" : checks.every((c) => c.obs.manual) ? "—" : "✅"} | ${obsText.replace(/\|/g, "/")} |`);
  void rowText;
}
for (const r of rows) {
  if (!listings.some((l) => r[0].includes(l.match))) contradictions.push(`fila sin entrada en listings.json: ${r[0].slice(0, 80)}`);
}

const unai = listings.filter((l) => l.unai_todo || l.owner === "unai").map((l) => `**${l.id}**: ${l.unai_todo ?? l.checks.map((c) => c.note).join("; ")}`);
const skipped = listings.filter((l) => !selected.includes(l)).map((l) => l.id);

const sec = (title: string, items: string[]) => (items.length ? `\n## ${title}\n\n${items.map((x) => `- ${x}`).join("\n")}\n` : "");
const report = [
  `# Revisión de listados ${today} (${only ? `solo ${only.join(", ")}` : cadence})`,
  "",
  `Verdad hoy: **${T.total} tools** (${T.free} gratis + ${T.paid} de pago), núcleo de \`tools/list\` **${T.core}**, server.json **v${T.version}**, skill **${T.skill_version}**, repo \`${T.repo}\`.`,
  prev.date ? `Comparado con la revisión del ${prev.date}.` : "Primera revisión: sin estado anterior con el que comparar.",
  sec("Cambios desde la última revisión", changes),
  sec("Contradicciones con la tabla de la nota 11", contradictions),
  sec("Avisos", warnings),
  sec("Para el navegador (Claude)", browser),
  sec("Para Unai", unai),
  skipped.length ? `\nNo revisadas en esta pasada (mensuales): ${skipped.join(", ")}.\n` : "",
  "\n## Detalle\n\n| Fila | | Observado |\n|---|---|---|",
  ...detail,
].join("\n");

if (flag("json")) console.log(JSON.stringify({ truth: T, changes, contradictions, warnings, browser, unai, state }, null, 2));
else console.log(report);

if (!flag("no-save") && !only && existsSync(VAULT)) {
  mkdirSync(join(VAULT, "11-anexos"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ date: today, truth: T, listings: state }, null, 2) + "\n");
  writeFileSync(join(VAULT, `11-anexos/listados-${today}.md`), report + "\n");
  console.error(`\nGuardado: ${statePath} y 11-anexos/listados-${today}.md`);
}
