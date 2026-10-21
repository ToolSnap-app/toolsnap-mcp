/**
 * Every registered tool must carry a human title and an explicit hint that
 * says whether it is read-only or non-destructive. Directories (Glama TDQS,
 * Smithery, Anthropic Software Directory Policy 5E) score exactly this, and a
 * tool added without an entry in src/tools/annotations.ts would silently drop
 * the score again.
 *
 * Run:  npx tsx test/tool-annotations.ts
 */
import { tools, listTools } from "../src/tools/index.js";
import { TOOL_SPECS } from "../src/tools/annotations.js";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

const names = new Set(tools.map((t) => t.name));
for (const name of Object.keys(TOOL_SPECS)) {
  check(names.has(name), `annotations.ts has an entry for unregistered tool "${name}"`);
}

for (const def of listTools("full")) {
  const a = def.annotations;
  check(!!def.title && def.title.length <= 40, `${def.name}: missing or overlong title`);
  check(a?.title === def.title, `${def.name}: annotations.title must equal title`);
  check(!!a, `${def.name}: no annotations`);
  if (!a) continue;
  if (a.readOnlyHint === true) {
    check(a.destructiveHint === undefined, `${def.name}: read-only tool must not set destructiveHint`);
  } else {
    check(a.readOnlyHint === false, `${def.name}: must set readOnlyHint explicitly`);
    check(a.destructiveHint === false, `${def.name}: non-read-only tool must state destructiveHint: false`);
  }
}

// use_tool only dispatches to other catalog tools; it must not be advertised as destructive.
const useTool = listTools("full").find((t) => t.name === "use_tool");
check(useTool?.annotations?.destructiveHint === false, "use_tool must not be destructive");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`ok: ${tools.length} tools have title and coherent annotations`);
