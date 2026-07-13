/**
 * Normalizes Pi's actual outbound OpenAI payloads.
 *
 * Pi's models.json uses strings in thinkingLevelMap verbatim. `omit` is useful
 * for keeping “关闭” selectable, but Pi itself would otherwise send the literal
 * value to the provider. This hook removes it for off, and ensures a selected
 * supported level is present in the provider-specific payload.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Payload = Record<string, unknown>;

function object(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : null;
}

function removeOffReasoning(payload: Payload): Payload {
  const next = { ...payload };
  if (next.reasoning_effort === "omit" || next.reasoning_effort === "none") {
    delete next.reasoning_effort;
  }
  const reasoning = object(next.reasoning);
  if (reasoning?.effort === "omit" || reasoning?.effort === "none") {
    delete next.reasoning;
    if (Array.isArray(next.include)) {
      next.include = next.include.filter((item) => item !== "reasoning.encrypted_content");
    }
  }
  return next;
}

/**
 * `getThinkingLevel` was present in an earlier extension context, but is not
 * part of the current Pi runtime.  The session records every level change,
 * which also makes this work across both runtime versions.
 */
function currentThinkingLevel(ctx: { sessionManager?: { getEntries?: () => unknown[] } }): string {
  const entries = ctx.sessionManager?.getEntries?.() || [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; thinkingLevel?: unknown } | null;
    if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      return entry.thinkingLevel;
    }
  }
  return "off";
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const payload = object(event.payload);
    if (!payload) return;

    const level = currentThinkingLevel(ctx);
    if (level === "off") return removeOffReasoning(payload);

    const model = ctx.model;
    const mappedEffort = model?.thinkingLevelMap?.[level];
    // Old pi-studio configs serialized “最高” as `xhigh: "high"`.  A running
    // Pi session can retain that model object after the config has been fixed,
    // so normalize at the last point before the request is sent as well.
    const effort = level === "xhigh" && mappedEffort === "high" ? "xhigh" : mappedEffort;
    if (typeof effort !== "string") return;

    if (model.api === "openai-responses") {
      return { ...payload, reasoning: { ...object(payload.reasoning), effort } };
    }
    if (model.api === "openai-completions") {
      return { ...payload, reasoning_effort: effort };
    }
  });
}
