/**
 * PiCode permission gate and session-scoped Plan → Review → Build controller.
 *
 * Pi has no built-in permission UI. This extension keeps the user's global
 * permission policy for normal work, while making Plan/Review a stricter,
 * reliable read-only mode that is persisted inside the Pi session itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type PermissionMode = 'ask' | 'read-only' | 'full-access';
type PlanPhase = 'build' | 'plan' | 'review' | 'executing' | 'complete';
type PlanStepStatus = 'pending' | 'in_progress' | 'complete' | 'blocked';

interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
}

interface PlanSessionState {
  phase: PlanPhase;
  goal: string;
  steps: PlanStep[];
  updatedAt: string;
}

type PiToolMetadata = {
  name?: unknown;
  sourceInfo?: { source?: unknown };
};

type PlanEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

const sessionAllowances = new Set<string>();
const planToolNames = new Set(['read', 'grep', 'find', 'ls', 'bash']);
const planControlEvent = 'picode:plan-control';
const planPhases = new Set<PlanPhase>(['build', 'plan', 'review', 'executing', 'complete']);
const stepStatuses = new Set<PlanStepStatus>(['pending', 'in_progress', 'complete', 'blocked']);

function emptyPlan(): PlanSessionState {
  return { phase: 'build', goal: '', steps: [], updatedAt: new Date(0).toISOString() };
}

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

function normalizeStep(value: unknown, index: number): PlanStep | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PlanStep>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const status = stepStatuses.has(raw.status as PlanStepStatus)
    ? raw.status as PlanStepStatus
    : 'pending';
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `step-${index + 1}`,
    title,
    ...(detail ? { detail } : {}),
    status,
  };
}

function normalizePlan(value: unknown): PlanSessionState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PlanSessionState>;
  return {
    phase: planPhases.has(raw.phase as PlanPhase) ? raw.phase as PlanPhase : 'build',
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    steps: Array.isArray(raw.steps)
      ? raw.steps.flatMap((step, index) => {
        const normalized = normalizeStep(step, index);
        return normalized ? [normalized] : [];
      })
      : [],
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString(),
  };
}

function latestPlan(entries: unknown[]): PlanSessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as PlanEntry;
    if (entry?.type !== 'custom' || entry.customType !== 'plan-mode') continue;
    const parsed = normalizePlan(entry.data);
    if (parsed) return parsed;
  }
  return emptyPlan();
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

/**
 * Only accept one plainly read-only command. The deliberately small list is
 * portable across PowerShell, cmd, and POSIX shells. Chaining/redirection is
 * rejected before prefix matching so an allowed reader cannot become a writer.
 */
export function isSafePlanBash(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const value = command.trim();
  if (!value || value.length > 1_500) return false;
  if (/\r|\n|[|;&<>`]|\$\(|&&|\|\|/u.test(value)) return false;
  if (/\b(?:start|start-process|invoke-expression|iex|cmd|powershell|pwsh|sh|bash|zsh|node|npm|pnpm|yarn|bun|cargo|python|pip|curl|wget|ssh|scp|git\s+(?:add|commit|push|pull|merge|rebase|checkout|switch|reset|clean|restore|config|init|clone)|rm|rmdir|del|erase|remove-item|move-item|copy-item|set-content|add-content|out-file)\b/i.test(value)) return false;
  if (/(?:^|\s)(?:-exec|-execdir|-delete|-ok|-fprint|--pre|--ext-diff)\b/i.test(value)) return false;
  // `find` has a handful of output-file actions that look similar to its
  // normal read-only predicates. Git's --output and external conversion
  // options are likewise writes or process launches, not inspection.
  if (/(?:^|\s)-(?:exec(?:dir)?|ok(?:dir)?|delete|fprint(?:0)?|fprintf|fls)\b/i.test(value)) return false;
  if (
    /^git\s+/i.test(value) &&
    /(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$)|--ext-diff(?:\s|$)|--textconv(?:\s|$)|--paginate(?:\s|$)|--show-signature(?:\s|$))/i.test(value)
  ) return false;

  return /^(?:(?:get-content|get-childitem|select-string|get-location|resolve-path|findstr|dir|type|where|cat|ls|pwd|rg|grep|find)\b|git\s+(?:status|diff|log|show|branch|rev-parse)\b)/i.test(value);
}

/** Pure policy helper kept exportable for permission regression tests. */
export function isPlanToolAllowed(toolName: unknown, input: unknown): boolean {
  if (typeof toolName !== 'string' || !planToolNames.has(toolName)) return false;
  if (toolName !== 'bash') return true;
  const command = input && typeof input === 'object'
    ? (input as { command?: unknown }).command
    : undefined;
  return isSafePlanBash(command);
}

/**
 * Pi lets extensions override a built-in tool by reusing its name. Plan mode
 * must not treat a same-named custom tool as safe: only definitions marked by
 * Pi itself as `builtin` are eligible to be activated.
 */
export function builtinPlanToolNames(tools: readonly unknown[]): string[] {
  const builtin = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const metadata = tool as PiToolMetadata;
    if (
      typeof metadata.name === 'string' &&
      metadata.sourceInfo?.source === 'builtin' &&
      planToolNames.has(metadata.name)
    ) builtin.add(metadata.name);
  }
  return [...planToolNames].filter((name) => builtin.has(name));
}

function decodePlan(value: string): PlanSessionState | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return normalizePlan(JSON.parse(Buffer.from(base64, 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

function parsePlanAction(action: unknown, encoded: unknown = ''): { action: string; encoded: string } | null {
  if (typeof action !== 'string' || typeof encoded !== 'string') return null;
  if (!['enter', 'build', 'revise', 'update', 'execute'].includes(action)) return null;
  if (action === 'update') return /^[A-Za-z0-9_-]+$/.test(encoded) ? { action, encoded } : null;
  return encoded ? null : { action, encoded: '' };
}

function parsePlanControl(value: unknown): { action: string; encoded: string } | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\/pi-plan\s+([^\s]+)(?:\s+([^\s]+))?$/);
  return parsePlanAction(match?.[1], match?.[2] || '');
}

/** Parse the model's explicitly requested numbered Plan block. */
export function parsePlanResponse(text: string, existing: PlanSessionState): PlanStep[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const planStart = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?(?:plan|计划)\s*[:：]\s*$/i.test(line));
  if (planStart < 0) return [];
  const steps: PlanStep[] = [];
  let current: PlanStep | null = null;
  for (const line of lines.slice(planStart + 1)) {
    const match = line.match(/^\s*(\d+)\s*[.)、]\s+(.+?)\s*$/);
    if (match) {
      const title = match[2]?.trim() || '';
      if (!title) continue;
      current = { id: `step-${steps.length + 1}`, title, status: 'pending' };
      steps.push(current);
      continue;
    }
    if (/^\s*(?:#{1,6}\s*)?(?:plan|计划)\s*[:：]/i.test(line) || /^\s*#{1,6}\s/.test(line)) break;
    if (current && line.trim()) {
      current.detail = [current.detail, line.trim()].filter(Boolean).join(' ');
    }
  }
  if (!steps.length) return [];
  // Preserve stable ids when a refinement leaves the same ordinal intact.
  return steps.map((step, index) => ({ ...step, id: existing.steps[index]?.id || step.id }));
}

function doneMarkers(text: string): Set<number> {
  const done = new Set<number>();
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const value = Number.parseInt(match[1] || '', 10);
    if (Number.isFinite(value) && value > 0) done.add(value - 1);
  }
  return done;
}

function blockedMarkers(text: string): Set<number> {
  const blocked = new Set<number>();
  for (const match of text.matchAll(/\[BLOCKED:(\d+)\]/gi)) {
    const value = Number.parseInt(match[1] || '', 10);
    if (Number.isFinite(value) && value > 0) blocked.add(value - 1);
  }
  return blocked;
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text || '')
    .join('\n');
}

export default function planPermissions(pi: ExtensionAPI): void {
  let state = emptyPlan();
  let toolsBeforePlan: string[] | undefined;

  const persist = () => {
    state = { ...state, updatedAt: new Date().toISOString() };
    pi.appendEntry('plan-mode', state);
  };

  const enablePlanTools = () => {
    if (!toolsBeforePlan) toolsBeforePlan = [...pi.getActiveTools()];
    pi.setActiveTools(builtinPlanToolNames(pi.getAllTools() as unknown[]));
  };

  const restoreBuildTools = () => {
    if (toolsBeforePlan?.length) {
      pi.setActiveTools(toolsBeforePlan);
    }
    toolsBeforePlan = undefined;
  };

  const setPlanPhase = (phase: PlanPhase, patch: Partial<PlanSessionState> = {}) => {
    state = { ...state, ...patch, phase };
    if (phase === 'plan' || phase === 'review') enablePlanTools();
    else restoreBuildTools();
    persist();
  };

  const applyPlanAction = (action: string, encoded = ''): boolean => {
    if (action === 'enter') {
      setPlanPhase('plan', { goal: '', steps: [] });
      return true;
    }
    if (action === 'build') {
      setPlanPhase('build');
      return true;
    }
    if (action === 'revise') {
      setPlanPhase('plan');
      return true;
    }
    if (action === 'update') {
      const updated = decodePlan(encoded);
      if (!updated) return false;
      // Empty or invalid editor drafts remain in Plan. There is nothing to
      // confirm or execute until at least one real step exists.
      setPlanPhase(updated.steps.length ? 'review' : 'plan', { goal: updated.goal, steps: updated.steps });
      return true;
    }
    if (action === 'execute') {
      const firstPending = state.steps.findIndex((step) => step.status === 'pending');
      // Execution is deliberately impossible until a reviewable plan contains
      // an unfinished step. This keeps direct control-channel calls from
      // skipping the review confirmation.
      if (state.phase !== 'review' || firstPending < 0 || state.steps.some((step) => step.status === 'blocked')) {
        return false;
      }
      const steps = state.steps.map((step, index) =>
        index === firstPending ? { ...step, status: 'in_progress' as const } : step,
      );
      setPlanPhase('executing', { steps });
      // This is an invisible extension message, not a fabricated user prompt
      // or terminal selection dialog. before_agent_start adds the real context.
      pi.sendMessage(
        { customType: 'pi-plan-execute', content: 'Start the confirmed plan now.', display: false },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
      return true;
    }
    return false;
  };

  pi.registerCommand('pi-plan', {
    description: 'PiCode internal session plan controller',
    handler: async (args) => {
      const [action = '', encoded = ''] = args.trim().split(/\s+/, 2);
      const parsed = parsePlanAction(action, encoded);
      if (parsed) applyPlanAction(parsed.action, parsed.encoded);
    },
  });

  // The legacy mirror extension transports browser prompts with sendUserMessage,
  // which intentionally bypasses Pi's slash-command parser. It relays this
  // private event instead so controls remain invisible in both transports.
  pi.events.on(planControlEvent, (data) => {
    const command = data && typeof data === 'object' && 'command' in data
      ? (data as { command?: unknown }).command
      : data;
    const parsed = parsePlanControl(command);
    if (parsed) applyPlanAction(parsed.action, parsed.encoded);
  });

  pi.on('session_start', async (_event, ctx) => {
    state = latestPlan(ctx.sessionManager.getEntries() as unknown[]);
    if (state.phase === 'plan' || state.phase === 'review') enablePlanTools();
    else restoreBuildTools();
  });

  pi.on('before_agent_start', async (event) => {
    if (state.phase === 'plan' || state.phase === 'review') {
      // Reassert the allow-list at the turn boundary in case another
      // extension changed active tools after Plan mode was entered.
      enablePlanTools();
      if (!state.goal && event.prompt.trim()) {
        state = { ...state, goal: event.prompt.trim() };
        persist();
      }
      return {
        message: {
          customType: 'pi-plan-context',
          display: false,
          content: `[PLAN MODE — READ ONLY]
You are planning, not implementing. You may inspect files and use only safe read-only shell commands.
Never edit, write, install, start processes, or change Git state.
Study the request and reply with a concrete numbered plan under exactly this header:

Plan:
1. Step title
   Optional implementation detail

Use the plan to explain scope, validation, and meaningful risks. If refining an existing plan, output the full replacement Plan: list.`,
        },
      };
    }
    if (state.phase === 'executing' && state.steps.length) {
      const remaining = state.steps
        .map((step, index) => `${index + 1}. [${step.status}] ${step.title}${step.detail ? ` — ${step.detail}` : ''}`)
        .join('\n');
      return {
        message: {
          customType: 'pi-plan-execution-context',
          display: false,
          content: `[EXECUTING CONFIRMED PLAN]
Goal: ${state.goal || 'Complete the confirmed task'}

Steps:
${remaining}

Implement the plan in order. After a completed step, include [DONE:n] in your normal response, where n is the 1-based step number. If a step cannot proceed, include [BLOCKED:n] and explain the blocker. Do not expose these control markers in prose beyond the marker itself.`,
        },
      };
    }
    return undefined;
  });

  pi.on('turn_end', async (event) => {
    const text = assistantText(event.message);
    if (!text) return;
    if (state.phase === 'plan' || state.phase === 'review') {
      const steps = parsePlanResponse(text, state);
      if (steps.length) setPlanPhase('review', { steps });
      return;
    }
    if (state.phase !== 'executing') return;
    const completed = doneMarkers(text);
    const blocked = blockedMarkers(text);
    if (!completed.size && !blocked.size) return;
    const steps = state.steps.map((step, index) => {
      if (completed.has(index)) return { ...step, status: 'complete' as const };
      if (blocked.has(index)) return { ...step, status: 'blocked' as const };
      return step;
    });
    const nextPending = steps.findIndex((step) => step.status === 'pending');
    if (nextPending >= 0 && !steps.some((step) => step.status === 'in_progress')) {
      steps[nextPending] = { ...steps[nextPending]!, status: 'in_progress' };
    }
    const phase: PlanPhase = steps.every((step) => step.status === 'complete')
      ? 'complete'
      : steps.some((step) => step.status === 'blocked')
        ? 'review'
        : 'executing';
    setPlanPhase(phase, { steps });
  });

  pi.on('tool_call', async (event, ctx) => {
    const planning = state.phase === 'plan' || state.phase === 'review';
    if (planning) {
      // Inspect the live registry again rather than trusting only the name.
      // A custom tool can deliberately reuse `read` or `bash`; its metadata
      // must still say builtin at the instant it is about to run.
      const builtinPlanTools = new Set(builtinPlanToolNames(pi.getAllTools() as unknown[]));
      if (!builtinPlanTools.has(event.toolName)) {
        return { block: true, reason: `计划模式仅允许内置只读工具；${event.toolName} 已被禁用。` };
      }
      if (!isPlanToolAllowed(event.toolName, event.input)) {
        if (event.toolName === 'bash') {
          return { block: true, reason: '计划模式只允许单条、安全的只读 Bash 命令。' };
        }
        return { block: true, reason: `计划模式只允许读取与搜索；${event.toolName} 已被禁用。` };
      }
      // Read-only plan tools intentionally bypass the normal ask popup.
      return;
    }

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
