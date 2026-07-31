/**
 * Projection of the `pi-subagents` extension's tool payloads into something the
 * timeline can render.
 *
 * The extension registers two tools (`subagent` and `subagent_wait`) and streams
 * progress through `tool_execution_update.partialResult.details`, which carries
 * `{ mode, progress[], results[], ... }`. Session files persist only the tool
 * call arguments and the final text, so every field here is optional and the
 * parser degrades to an arguments-only skeleton when replaying history.
 */

export type SubagentChildStatus = 'pending' | 'running' | 'completed' | 'failed' | 'detached';

export type SubagentMode = 'single' | 'parallel' | 'chain' | 'management' | 'wait';

export interface SubagentChild {
  index: number;
  agent: string;
  task: string;
  status: SubagentChildStatus;
  /** Chain step or fan-out group label, when the call supplied one. */
  phase?: string;
  model?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: string[];
  toolCount?: number;
  tokens?: number;
  durationMs?: number;
  error?: string;
  /** Final text the child returned, once it has finished. */
  output?: string;
}

export interface SubagentRun {
  mode: SubagentMode;
  /** Management/control action such as `status` or `stop`, when present. */
  action?: string;
  children: SubagentChild[];
  async?: boolean;
  asyncId?: string;
  runId?: string;
  chainAgents?: string[];
  totalSteps?: number;
  currentStepIndex?: number;
  tokens?: number;
  cost?: number;
  timedOut?: boolean;
  stopped?: boolean;
  /** True once live `details` arrived; false while showing an arguments-only skeleton. */
  live: boolean;
}

const childStatuses = new Set<SubagentChildStatus>(['pending', 'running', 'completed', 'failed', 'detached']);

export function isSubagentTool(name: string): boolean {
  const tool = String(name || '').toLowerCase();
  return tool === 'subagent' || tool === 'subagent_wait';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `details` is only attached to live events; session history replays without it. */
export function subagentDetailsOf(result: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(result)?.details);
}

/** Number of children a parallel task expands to (`count` defaults to 1). */
function taskCount(task: Record<string, unknown>): number {
  const count = asCount(task.count);
  return count && count >= 1 ? Math.floor(count) : 1;
}

function childFromSpec(spec: Record<string, unknown>, index: number, fallbackTask: string): SubagentChild {
  return {
    index,
    agent: asText(spec.agent) || '?',
    task: asText(spec.task) || fallbackTask,
    status: 'pending',
    phase: asText(spec.phase) || asText(spec.label),
    model: asText(spec.model),
    recentTools: [],
  };
}

/**
 * Skeleton derived purely from the tool call arguments. This is what renders
 * before the first progress event and when replaying a saved session.
 */
export function subagentRunFromArgs(args: Record<string, unknown>, toolName = 'subagent'): SubagentRun {
  if (String(toolName).toLowerCase() === 'subagent_wait') {
    return { mode: 'wait', children: [], runId: asText(args.id), live: false };
  }

  const action = asText(args.action);
  const base: SubagentRun = {
    mode: 'single',
    action,
    children: [],
    async: args.async === true,
    runId: asText(args.id) || asText(args.runId),
    live: false,
  };

  if (action) return { ...base, mode: 'management' };

  const chain = asArray(args.chain);
  if (chain.length) {
    const children: SubagentChild[] = [];
    chain.forEach((step, stepIndex) => {
      const parallel = asArray(step.parallel);
      if (parallel.length) {
        for (const task of parallel) {
          for (let repeat = 0; repeat < taskCount(task); repeat += 1) {
            children.push({ ...childFromSpec(task, children.length, ''), phase: asText(task.phase) || `步骤 ${stepIndex + 1}` });
          }
        }
        return;
      }
      children.push({ ...childFromSpec(step, children.length, ''), phase: asText(step.phase) || asText(step.label) || `步骤 ${stepIndex + 1}` });
    });
    return {
      ...base,
      mode: 'chain',
      children,
      totalSteps: chain.length,
      chainAgents: chain.map((step) => asText(step.agent)).filter((name): name is string => Boolean(name)),
    };
  }

  const tasks = asArray(args.tasks);
  if (tasks.length) {
    const children: SubagentChild[] = [];
    for (const task of tasks) {
      for (let repeat = 0; repeat < taskCount(task); repeat += 1) {
        children.push(childFromSpec(task, children.length, ''));
      }
    }
    return { ...base, mode: 'parallel', children };
  }

  const agent = asText(args.agent);
  const task = asText(args.task) || '';
  return {
    ...base,
    children: agent || task ? [{ index: 0, agent: agent || '?', task, status: 'pending', model: asText(args.model), recentTools: [] }] : [],
  };
}

function statusOf(value: unknown): SubagentChildStatus | undefined {
  return typeof value === 'string' && childStatuses.has(value as SubagentChildStatus)
    ? (value as SubagentChildStatus)
    : undefined;
}

function finalStatusOf(result: Record<string, unknown>): SubagentChildStatus {
  if (result.detached === true) return 'detached';
  const exitCode = asCount(result.exitCode);
  if (asText(result.error) || (exitCode != null && exitCode !== 0)) return 'failed';
  return 'completed';
}

/** Overlays a live `details` payload onto the arguments-derived skeleton. */
export function mergeSubagentDetails(base: SubagentRun, details: Record<string, unknown>): SubagentRun {
  const progress = asArray(details.progress);
  const results = asArray(details.results);
  const mode = asText(details.mode);
  const children: SubagentChild[] = [];
  const size = Math.max(base.children.length, progress.length, results.length);

  for (let index = 0; index < size; index += 1) {
    const skeleton = base.children[index] || { index, agent: '?', task: '', status: 'pending' as const, recentTools: [] };
    const step = progress[index];
    const result = results[index];
    const recentTools = asArray(step?.recentTools)
      .map((entry) => [asText(entry.tool), asText(entry.args)].filter(Boolean).join(' '))
      .filter(Boolean);
    children.push({
      ...skeleton,
      index,
      agent: asText(step?.agent) || asText(result?.agent) || skeleton.agent,
      task: asText(step?.task) || asText(result?.task) || skeleton.task,
      status: statusOf(step?.status) || (result ? finalStatusOf(result) : skeleton.status),
      model: asText(step?.model) || asText(result?.model) || skeleton.model,
      currentTool: asText(step?.currentTool),
      currentToolArgs: asText(step?.currentToolArgs),
      recentTools: recentTools.length ? recentTools : skeleton.recentTools,
      toolCount: asCount(step?.toolCount) ?? skeleton.toolCount,
      tokens: asCount(step?.tokens) ?? skeleton.tokens,
      durationMs: asCount(step?.durationMs) ?? skeleton.durationMs,
      error: asText(step?.error) || asText(result?.error) || skeleton.error,
      output: asText(result?.finalOutput) || skeleton.output,
    });
  }

  const usage = asRecord(details.totalChildUsage);
  const cost = asRecord(details.totalCost);
  return {
    ...base,
    mode: mode === 'single' || mode === 'parallel' || mode === 'chain' || mode === 'management' ? mode : base.mode,
    children,
    runId: asText(details.runId) || base.runId,
    asyncId: asText(details.asyncId),
    async: base.async || Boolean(asText(details.asyncId)),
    chainAgents: Array.isArray(details.chainAgents)
      ? details.chainAgents.map((name) => String(name)).filter(Boolean)
      : base.chainAgents,
    totalSteps: asCount(details.totalSteps) ?? base.totalSteps,
    currentStepIndex: asCount(details.currentStepIndex) ?? base.currentStepIndex,
    tokens: asCount(usage?.input) !== undefined || asCount(usage?.output) !== undefined
      ? (asCount(usage?.input) || 0) + (asCount(usage?.output) || 0)
      : base.tokens,
    cost: asCount(cost?.total) ?? base.cost,
    timedOut: details.timedOut === true,
    stopped: details.stopped === true,
    live: true,
  };
}

export function parseSubagentRun(
  args: Record<string, unknown>,
  details?: Record<string, unknown>,
  toolName = 'subagent',
): SubagentRun {
  const base = subagentRunFromArgs(args, toolName);
  return details ? mergeSubagentDetails(base, details) : base;
}

/**
 * Session replays arrive without a progress payload, so children would stay
 * "pending" forever. Fall back to the tool call's own outcome in that case.
 */
export function applyToolOutcome(run: SubagentRun, toolStatus: string): SubagentRun {
  if (run.live || (toolStatus !== 'complete' && toolStatus !== 'error')) return run;
  const status: SubagentChildStatus = toolStatus === 'error' ? 'failed' : 'completed';
  return { ...run, children: run.children.map((child) => ({ ...child, status })) };
}

export function subagentModeLabel(run: SubagentRun): string {
  if (run.mode === 'wait') return '等待子代理';
  if (run.mode === 'management') return `管理 · ${run.action || '操作'}`;
  if (run.mode === 'chain') {
    const total = run.totalSteps || run.children.length;
    const current = run.currentStepIndex;
    return current != null && current + 1 <= total ? `链 · 第 ${current + 1}/${total} 步` : `链 · ${total} 步`;
  }
  if (run.mode === 'parallel') return `并行 · ${run.children.length} 个`;
  return run.children[0]?.agent ? `单个 · ${run.children[0].agent}` : '单个';
}

export function subagentStatusLabel(status: SubagentChildStatus): string {
  return { pending: '等待中', running: '运行中', completed: '已完成', failed: '失败', detached: '已分离' }[status];
}

/** `1.2s` / `3m 04s` — compact enough for the metrics row. */
export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}
