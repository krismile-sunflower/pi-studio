/**
 * Models refresh extension for pi-studio.
 *
 * Pi's RPC `get_available_models` reads the in-memory ModelRegistry and does not
 * re-read ~/.pi/agent/models.json. Interactive mode calls modelRegistry.refresh()
 * when opening /model; RPC has no equivalent, so we expose a slash command that
 * the desktop app can invoke after saving models.json.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("refresh-models", {
    description: "Reload models.json into the current Pi session",
    handler: async (_args, ctx) => {
      try {
        ctx.modelRegistry.refresh();
        const available = await ctx.modelRegistry.getAvailable();
        await ctx.ui.notify(
          `已重新加载模型配置（${available.length} 个可用模型）`,
          "info",
        );
      } catch (error) {
        await ctx.ui.notify(
          `重新加载模型失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
