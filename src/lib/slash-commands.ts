import type { SlashCommand } from './types';

/** Built-in slash commands from Pi CLI (`core/slash-commands.js`). */
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'settings', description: '打开设置', source: 'builtin' },
  { name: 'model', description: '选择模型（打开选择器）', source: 'builtin' },
  { name: 'scoped-models', description: '启用/禁用 Ctrl+P 循环模型列表', source: 'builtin' },
  { name: 'export', description: '导出会话（默认 HTML，可指定 .html/.jsonl 路径）', source: 'builtin' },
  { name: 'import', description: '从 JSONL 文件导入并恢复会话', source: 'builtin' },
  { name: 'share', description: '将会话分享为私密 GitHub Gist', source: 'builtin' },
  { name: 'copy', description: '复制上一条助手消息到剪贴板', source: 'builtin' },
  { name: 'name', description: '设置会话显示名称', source: 'builtin' },
  { name: 'session', description: '显示会话信息与统计', source: 'builtin' },
  { name: 'changelog', description: '显示更新日志', source: 'builtin' },
  { name: 'hotkeys', description: '显示全部快捷键', source: 'builtin' },
  { name: 'fork', description: '从之前的用户消息创建分支', source: 'builtin' },
  { name: 'clone', description: '在当前位置复制当前会话', source: 'builtin' },
  { name: 'tree', description: '浏览会话树（切换分支）', source: 'builtin' },
  { name: 'trust', description: '保存项目信任决策', source: 'builtin' },
  { name: 'login', description: '配置提供商认证', source: 'builtin' },
  { name: 'logout', description: '移除提供商认证', source: 'builtin' },
  { name: 'new', description: '开始新会话', source: 'builtin' },
  { name: 'compact', description: '手动压缩会话上下文', source: 'builtin' },
  { name: 'resume', description: '恢复另一个会话', source: 'builtin' },
  { name: 'reload', description: '重新加载快捷键、扩展、技能、提示词与主题', source: 'builtin' },
  { name: 'quit', description: '退出', source: 'builtin' },
];

const SOURCE_ORDER: Record<string, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

export function mergeSlashCommands(remote: SlashCommand[] = []): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of BUILTIN_SLASH_COMMANDS) {
    byName.set(command.name, command);
  }
  for (const command of remote) {
    const name = String(command.name || '').replace(/^\//, '').trim();
    if (!name) continue;
    // Built-ins win for description localization when names collide.
    if (byName.has(name) && byName.get(name)?.source === 'builtin') continue;
    byName.set(name, {
      name,
      description: command.description || '',
      source: command.source || 'extension',
      argumentHint: command.argumentHint,
    });
  }
  return Array.from(byName.values()).sort((left, right) => {
    const sourceDiff = (SOURCE_ORDER[left.source || ''] ?? 9) - (SOURCE_ORDER[right.source || ''] ?? 9);
    if (sourceDiff !== 0) return sourceDiff;
    return left.name.localeCompare(right.name);
  });
}

/** Lightweight fuzzy filter (token subsequence match), similar to Pi TUI. */
export function fuzzyFilterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  const tokens = needle.split(/[\s/]+/).filter(Boolean);
  return commands
    .map((command) => {
      const haystack = `${command.name} ${command.description}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        const index = haystack.indexOf(token);
        if (index < 0) return null;
        score += index === 0 || haystack[index - 1] === ' ' || haystack[index - 1] === ':' ? 0 : 2;
        score += index;
      }
      // Prefer prefix matches on the command name.
      if (command.name.toLowerCase().startsWith(needle)) score -= 20;
      return { command, score };
    })
    .filter((item): item is { command: SlashCommand; score: number } => Boolean(item))
    .sort((left, right) => left.score - right.score || left.command.name.localeCompare(right.command.name))
    .map((item) => item.command);
}

export interface SlashMatch {
  /** Full slash prefix being completed, e.g. `/mod` or `/` */
  prefix: string;
  /** Query after `/`, e.g. `mod` */
  query: string;
  /** Start index of the `/` within the input text */
  start: number;
}

/** Detect a slash-command completion context at the start of the input. */
export function matchSlashCommand(text: string, cursor = text.length): SlashMatch | null {
  const before = text.slice(0, cursor);
  // Only trigger when the line starts with `/` and there is no space yet
  // (argument completion is not implemented in the web UI).
  if (!before.startsWith('/')) return null;
  if (before.includes('\n')) return null;
  const spaceIndex = before.indexOf(' ');
  if (spaceIndex !== -1) return null;
  return {
    prefix: before,
    query: before.slice(1),
    start: 0,
  };
}

export function applySlashCompletion(text: string, commandName: string, cursor = text.length): { text: string; cursor: number } {
  const match = matchSlashCommand(text, cursor);
  if (!match) return { text, cursor };
  const after = text.slice(cursor);
  const next = `/${commandName} ${after}`;
  const nextCursor = commandName.length + 2; // `/` + name + space
  return { text: next, cursor: nextCursor };
}
