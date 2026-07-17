import type { MessageContentBlock, PiMessage, Usage } from './types';

export interface MessageToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export function uniqueId(prefix = 'item'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function basename(path: string): string {
  return String(path || '').split(/[/\\]/).filter(Boolean).pop() || '';
}

export function normalizePath(path: string): string {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return Boolean(a && b && a === b);
}

export function getMessageText(message?: PiMessage | null): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is MessageContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

export function getMessageThinking(message?: PiMessage | null): string {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => ('thinking' in block ? String(block.thinking || '') : ''))
    .join('\n');
}

/**
 * Pi stores tool calls inside assistant message content.  The live RPC stream
 * normally also emits tool_execution events, but not every transport/provider
 * forwards those events.  Keep this parser in one place so history and live
 * rendering can both fall back to the message payload.
 */
export function getMessageToolCalls(message?: PiMessage | null): MessageToolCall[] {
  if (!message || !Array.isArray(message.content)) return [];

  return message.content.flatMap((block) => {
    if (block.type !== 'toolCall' || !('id' in block) || !('name' in block)) return [];
    const rawArguments = 'arguments' in block ? block.arguments : undefined;
    let args: Record<string, unknown> = {};
    if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
      args = rawArguments as Record<string, unknown>;
    } else if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        const parsed = JSON.parse(rawArguments);
        args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : { input: rawArguments };
      } catch {
        args = { input: rawArguments };
      }
    }
    return [{ id: String(block.id), name: String(block.name), args }];
  });
}

export function normalizeMessageText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function totalInputTokens(usage?: Usage | null): number {
  return (usage?.input || 0) + (usage?.cacheRead || 0);
}

export function formatRelativeTime(value?: string | number): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return date.toLocaleDateString('zh-CN', { weekday: 'long' });
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function modelIdFromValue(model: unknown): string {
  if (!model) return '';
  if (typeof model === 'string') return model;
  if (typeof model !== 'object') return '';
  const value = model as Record<string, unknown>;
  return String(value.id || value.modelId || value.name || '');
}

export function shortModelName(modelId: string): string {
  return modelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function formatToolOutput(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result && 'content' in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'object' && block && 'type' in block && block.type === 'text' && 'text' in block) {
            return String(block.text || '');
          }
          return JSON.stringify(block);
        })
        .join('\n');
    }
  }
  return JSON.stringify(result, null, 2);
}
