/**
 * Pi Studio permission gate.
 *
 * Pi intentionally has no built-in permission popups. Its `tool_call` extension
 * hook runs before every tool invocation, which lets the desktop host provide a
 * familiar approval policy without weakening Pi's normal extension model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

type PermissionMode = 'ask' | 'read-only' | 'full-access';
const sessionAllowances = new Set<string>();

function settingsPath(): string {
  if (process.env.PI_STUDIO_SETTINGS_PATH) return process.env.PI_STUDIO_SETTINGS_PATH;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pi-studio', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'pi-studio', 'settings.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pi-studio', 'settings.json');
}

function permissionMode(): PermissionMode {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).permissionMode;
    return value === 'read-only' || value === 'full-access' || value === 'ask' ? value : 'ask';
  } catch {
    return 'ask';
  }
}

function isReadOnlyTool(toolName: string): boolean {
  return ['read', 'grep', 'find', 'ls'].includes(toolName);
}

function detail(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') return String(input.command || '(未提供命令)').slice(0, 1200);
  if (typeof input.path === 'string') return input.path;
  try {
    return JSON.stringify(input).slice(0, 1200);
  } catch {
    return '工具参数不可显示';
  }
}

function actionLabel(toolName: string): string {
  if (toolName === 'bash') return '执行命令';
  if (toolName === 'write' || toolName === 'edit') return '修改文件';
  return `执行 ${toolName}`;
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    const mode = permissionMode();
    if (mode === 'full-access' || isReadOnlyTool(event.toolName)) return;

    if (mode === 'read-only') {
      return { block: true, reason: `只读模式已阻止 ${event.toolName} 工具。` };
    }

    const allowanceKey = `${event.toolName}:${process.cwd()}`;
    if (sessionAllowances.has(allowanceKey)) return;

    const choice = await ctx.ui.select(
      `Pi 请求权限\n${actionLabel(event.toolName)}\n${detail(event.toolName, event.input as Record<string, unknown>)}`,
      ['仅允许本次', '本会话允许此类操作', '拒绝'],
      { signal: ctx.signal },
    );
    if (choice === '仅允许本次') return;
    if (choice === '本会话允许此类操作') {
      sessionAllowances.add(allowanceKey);
      return;
    }
    return { block: true, reason: '操作未获用户批准。' };
  });
}
