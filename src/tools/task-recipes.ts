import type { McpTool } from "../mcp/types.js";
import { RECIPES, recipeMenu } from "../recipes.js";

/**
 * task_recipes (free) — a menu of pre-designed multi-tool workflows.
 *
 * The agent calls it with no args to get the menu, then with `recipe: "<id>"`
 * to get a ready-to-run prompt that drives the right ToolSnap tools end-to-end.
 * This is self-marketing: it teaches agents the high-value bundles (B6).
 */
export const taskRecipesTool: McpTool = {
  name: "task_recipes",
  description: "Free. Multi-tool workflow prompts (clone a site, SEO audit). No args → menu; recipe='<id>' → prompt.",
  inputSchema: {
    type: "object",
    properties: {
      recipe: { type: "string", description: "Recipe id; omit for menu." },
    },
    required: [],
  },
  run(args) {
    const id = typeof args.recipe === "string" ? args.recipe.trim() : "";
    if (!id) {
      return JSON.stringify(
        {
          recipes: recipeMenu(),
          how_to_use:
            "Call task_recipes again with recipe='<id>' to get the full ready-to-paste prompt for that task.",
        },
        null,
        2
      );
    }
    const recipe = RECIPES.find((r) => r.id === id);
    if (!recipe) {
      throw new Error(
        `Unknown recipe "${id}". Available: ${RECIPES.map((r) => r.id).join(", ")}`
      );
    }
    return JSON.stringify(recipe, null, 2);
  },
};
