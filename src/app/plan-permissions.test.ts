import { describe, expect, it } from 'vitest';
// Vite resolves this alias to the desktop extension; TypeScript only sees the
// small browser-safe declaration in vite-env.d.ts.
import { applyPlanExecutionMarkers, builtinPlanToolNames, isPlanToolAllowed, isSafePlanBash, parsePlanResponse } from '@picode-plan-permissions';

describe('plan-mode permissions', () => {
  it('allows a narrow, cross-platform read-only Bash set', () => {
    expect(isSafePlanBash('Get-Content src/app/controller.ts')).toBe(true);
    expect(isSafePlanBash('rg -n "Plan:" src')).toBe(true);
    expect(isSafePlanBash('git diff -- src/app/controller.ts')).toBe(true);
    expect(isSafePlanBash('find . -maxdepth 2')).toBe(true);
  });

  it('rejects shell composition, writes, process launches, and Git writes', () => {
    for (const command of [
      'Get-Content src/app/controller.ts > plan.txt',
      'rg Plan src | Set-Content plan.txt',
      'git status; git add .',
      'git commit -am "ship"',
      'git diff --output=plan.patch',
      'git show --output plan.txt HEAD',
      'pnpm install',
      'Start-Process notepad',
      'find . -exec rm {} \\;',
      'find . -fprintf plan.txt %p',
    ]) {
      expect(isSafePlanBash(command)).toBe(false);
    }
  });

  it('parses only an explicit numbered Plan block and retains stable step ids', () => {
    const existing = {
      phase: 'plan' as const,
      goal: 'Ship the workflow',
      steps: [{ id: 'persist', title: 'Old step', status: 'pending' as const }],
      updatedAt: '2026-07-30T00:00:00.000Z',
    };

    expect(parsePlanResponse('Analysis first.\n\n## Plan:\n1. Persist state\n   Store it in a custom entry.\n2) Render review UI', existing)).toEqual([
      { id: 'persist', title: 'Persist state', detail: 'Store it in a custom entry.', status: 'pending' },
      { id: 'step-2', title: 'Render review UI', status: 'pending' },
    ]);
    expect(parsePlanResponse('A numbered list without the Plan header:\n1. Do not accept this', existing)).toEqual([]);
  });

  it('blocks write and unknown tools while preserving approved readers', () => {
    expect(isPlanToolAllowed('read', { path: 'src/app/controller.ts' })).toBe(true);
    expect(isPlanToolAllowed('grep', { pattern: 'Plan' })).toBe(true);
    expect(isPlanToolAllowed('bash', { command: 'pwd' })).toBe(true);
    expect(isPlanToolAllowed('bash', { command: 'Set-Content x y' })).toBe(false);
    expect(isPlanToolAllowed('edit', { path: 'src/app/controller.ts' })).toBe(false);
    expect(isPlanToolAllowed('write', { path: 'notes.md' })).toBe(false);
    expect(isPlanToolAllowed('custom_mutator', {})).toBe(false);
  });

  it('does not enable custom tools that impersonate built-in readers', () => {
    expect(builtinPlanToolNames([
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'grep', sourceInfo: { source: 'extension' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
      { name: 'write', sourceInfo: { source: 'builtin' } },
      { name: 'ls', sourceInfo: { source: 'sdk' } },
    ])).toEqual(['read', 'bash']);
  });

  it('pauses on blockers without regressing completed work or advancing later steps', () => {
    const executing = {
      phase: 'executing' as const,
      goal: 'Ship the workflow',
      steps: [
        { id: 'one', title: 'Persist state', status: 'in_progress' as const },
        { id: 'two', title: 'Render UI', status: 'pending' as const },
        { id: 'three', title: 'Verify', status: 'complete' as const },
      ],
      updatedAt: '2026-07-30T00:00:00.000Z',
    };

    expect(applyPlanExecutionMarkers(executing, new Set([0]), new Set([1]))).toMatchObject({
      phase: 'review',
      steps: [
        { status: 'complete' },
        { status: 'blocked' },
        { status: 'complete' },
      ],
    });
    expect(applyPlanExecutionMarkers(executing, new Set([0]), new Set([0]))).toMatchObject({
      phase: 'executing',
      steps: [
        { status: 'complete' },
        { status: 'in_progress' },
        { status: 'complete' },
      ],
    });
    const lateBlocked = applyPlanExecutionMarkers({
      ...executing,
      steps: [{ ...executing.steps[0]!, status: 'complete' as const }, { ...executing.steps[1]!, status: 'in_progress' as const }, executing.steps[2]!],
    }, new Set(), new Set([0]));
    expect(lateBlocked.steps[0]).toMatchObject({ status: 'complete' });
  });
});
