import type { PlanPhase, PlanSessionState, PlanStep, PlanStepStatus, SessionEntry } from '../lib/types';

const planPhases = new Set<PlanPhase>(['build', 'plan', 'review', 'executing', 'complete']);
const stepStatuses = new Set<PlanStepStatus>(['pending', 'in_progress', 'complete', 'blocked']);

export function createPlanSessionState(): PlanSessionState {
  return {
    phase: 'build',
    goal: '',
    steps: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export function hasPlanSteps(plan: PlanSessionState | null | undefined): boolean {
  return Boolean(plan?.steps.some((step) => step.title.trim()));
}

/** An edited draft cannot be reviewed or executed until it has a real step. */
export function planDraftPhase(steps: readonly Pick<PlanStep, 'title'>[]): 'plan' | 'review' {
  return steps.some((step) => step.title.trim()) ? 'review' : 'plan';
}

export function canExecutePlan(plan: PlanSessionState | null | undefined): boolean {
  return Boolean(
    plan &&
      hasPlanSteps(plan) &&
      plan.phase === 'review' &&
      plan.steps.some((step) => step.status === 'pending') &&
      !plan.steps.some((step) => step.status === 'blocked'),
  );
}

/** Turns the persisted step list into the single editable plan document shown in the sidebar. */
export function formatPlanSteps(steps: readonly Pick<PlanStep, 'title' | 'detail'>[]): string {
  return steps
    .filter((step) => step.title.trim())
    .map((step, index) => {
      const lines = [`${index + 1}. ${step.title.trim()}`];
      const detail = step.detail?.trim();
      if (detail) {
        lines.push(...detail.split(/\r\n?|\n/).map((line) => `   ${line.trim()}`));
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Parses the sidebar's numbered plan document back into the execution step list. */
export function parsePlanSteps(value: string, existingSteps: readonly Pick<PlanStep, 'id'>[] = []): PlanStep[] {
  const parsed: Array<{ title: string; detailLines: string[] }> = [];
  let current: { title: string; detailLines: string[] } | null = null;

  for (const line of value.replace(/\r/g, '').split('\n')) {
    const match = line.match(/^(?:\d+)\s*[.)、]\s*(.*?)\s*$/);
    if (match) {
      const title = match[1]?.trim() || '';
      if (!title) {
        current = null;
        continue;
      }
      current = { title, detailLines: [] };
      parsed.push(current);
      continue;
    }

    if (current && line.trim()) current.detailLines.push(line.trim());
  }

  return parsed.map((step, index) => {
    const detail = step.detailLines.join('\n').trim();
    return {
      id: existingSteps[index]?.id || `step-${index + 1}`,
      title: step.title,
      ...(detail ? { detail } : {}),
      status: 'pending',
    };
  });
}

function normalizeStep(value: unknown, index: number): PlanStep | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PlanStep>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  const status = stepStatuses.has(raw.status as PlanStepStatus) ? raw.status as PlanStepStatus : 'pending';
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `step-${index + 1}`,
    title,
    ...(detail ? { detail } : {}),
    status,
  };
}

/** Accept persisted Pi custom-entry data without trusting its shape. */
export function normalizePlanSessionState(value: unknown): PlanSessionState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PlanSessionState>;
  const phase = planPhases.has(raw.phase as PlanPhase) ? raw.phase as PlanPhase : 'build';
  const steps = Array.isArray(raw.steps)
    ? raw.steps.flatMap((step, index) => {
      const normalized = normalizeStep(step, index);
      return normalized ? [normalized] : [];
    })
    : [];
  return {
    phase,
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    steps,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString(),
  };
}

/** Finds the latest plan state from a Pi session history. */
export function planStateFromEntries(entries: SessionEntry[]): PlanSessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as SessionEntry & { customType?: string; data?: unknown };
    if (entry.type !== 'custom' || entry.customType !== 'plan-mode') continue;
    const plan = normalizePlanSessionState(entry.data);
    if (plan) return plan;
  }
  return createPlanSessionState();
}

/** UI-only cleanup. The raw marker remains in Pi history for the extension. */
export function stripPlanControlMarkers(value: string): string {
  return value
    .replace(/[ \t]*\[(?:DONE|BLOCKED):\d+\][ \t]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function markedStepIndexes(value: string, marker: 'DONE' | 'BLOCKED', length: number): Set<number> {
  const indexes = new Set<number>();
  const pattern = new RegExp(`\\[${marker}:(\\d+)\\]`, 'gi');
  for (const match of value.matchAll(pattern)) {
    const index = Number.parseInt(match[1] || '', 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < length) indexes.add(index);
  }
  return indexes;
}

/** Optimistically reflects agent control markers while the extension writes its next entry. */
export function applyPlanControlMarkers(plan: PlanSessionState, value: string): PlanSessionState {
  if (plan.phase !== 'executing') return plan;
  const done = markedStepIndexes(value, 'DONE', plan.steps.length);
  const blocked = markedStepIndexes(value, 'BLOCKED', plan.steps.length);
  if (!done.size && !blocked.size) return plan;

  let changed = false;
  const steps = plan.steps.map((step, index) => {
    // Match the extension's behavior: a completed marker wins over a blocked
    // marker if both are accidentally emitted for the same step.
    const nextStatus = done.has(index)
      ? 'complete'
      : blocked.has(index) && step.status !== 'complete'
        ? 'blocked'
        : step.status;
    if (nextStatus === step.status) return step;
    changed = true;
    return { ...step, status: nextStatus };
  });

  const hasBlocked = steps.some((step) => step.status === 'blocked');
  if (!hasBlocked) {
    const firstRemaining = steps.findIndex((step) => step.status === 'pending');
    if (firstRemaining >= 0 && !steps.some((step) => step.status === 'in_progress')) {
      steps[firstRemaining] = { ...steps[firstRemaining]!, status: 'in_progress' };
      changed = true;
    }
  }

  if (!changed) return plan;
  const complete = steps.length > 0 && steps.every((step) => step.status === 'complete');
  return {
    ...plan,
    phase: complete ? 'complete' : hasBlocked ? 'review' : 'executing',
    steps,
    updatedAt: new Date().toISOString(),
  };
}

export function encodePlanCommandState(plan: PlanSessionState): string {
  const json = JSON.stringify(plan);
  // base64url works in browsers without depending on Node Buffer.
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
