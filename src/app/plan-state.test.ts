import { describe, expect, it } from 'vitest';
import type { PlanSessionState, SessionEntry } from '../lib/types';
import {
  applyPlanControlMarkers,
  canExecutePlan,
  formatPlanSteps,
  normalizePlanSessionState,
  parsePlanSteps,
  planDraftPhase,
  planStateFromEntries,
  stripPlanControlMarkers,
} from './plan-state';

const reviewPlan: PlanSessionState = {
  phase: 'review',
  goal: 'Ship the plan workflow',
  steps: [
    { id: 'one', title: 'Persist plan state', status: 'pending' },
    { id: 'two', title: 'Render review UI', detail: 'Keep it session scoped.', status: 'pending' },
  ],
  updatedAt: '2026-07-30T08:00:00.000Z',
};

describe('plan session state', () => {
  it('restores only the latest valid custom plan entry', () => {
    const entries: SessionEntry[] = [
      { type: 'custom', customType: 'plan-mode', data: { ...reviewPlan, phase: 'plan' } },
      { type: 'message', message: { role: 'assistant', content: 'Plan: 1. ignored by parser' } },
      { type: 'custom', customType: 'plan-mode', data: reviewPlan },
    ];

    expect(planStateFromEntries(entries)).toEqual(reviewPlan);
  });

  it('drops malformed steps and preserves a safe default for invalid history', () => {
    const state = normalizePlanSessionState({
      phase: 'not-a-real-phase',
      goal: 4,
      steps: [{ title: 'valid' }, { title: '' }, { id: 3, title: 'also valid', status: 'blocked' }],
    });

    expect(state).toMatchObject({
      phase: 'build',
      goal: '',
      steps: [
        { id: 'step-1', title: 'valid', status: 'pending' },
        { id: 'step-3', title: 'also valid', status: 'blocked' },
      ],
    });
    expect(canExecutePlan(state)).toBe(false);
    expect(canExecutePlan(reviewPlan)).toBe(true);
    expect(canExecutePlan({ ...reviewPlan, phase: 'plan' })).toBe(false);
    expect(planDraftPhase([{ title: '   ' }])).toBe('plan');
    expect(planDraftPhase([{ title: 'Review the state model' }])).toBe('review');
  });

  it('round-trips a numbered plan document into pending execution steps', () => {
    const document = formatPlanSteps(reviewPlan.steps);
    expect(document).toBe('1. Persist plan state\n\n2. Render review UI\n   Keep it session scoped.');
    expect(parsePlanSteps('1、梳理范围\n   明确约束。\n2) 实施改动\n   覆盖测试。', reviewPlan.steps)).toEqual([
      { id: 'one', title: '梳理范围', detail: '明确约束。', status: 'pending' },
      { id: 'two', title: '实施改动', detail: '覆盖测试。', status: 'pending' },
    ]);
  });

  it('ignores unnumbered and empty plan entries', () => {
    expect(parsePlanSteps('说明文字\n\n1. 保留这一项\n\n2.   ')).toEqual([
      { id: 'step-1', title: '保留这一项', status: 'pending' },
    ]);
  });

  it('marks finished steps from agent control markers and advances progress', () => {
    const executing: PlanSessionState = { ...reviewPlan, phase: 'executing' };
    const progress = applyPlanControlMarkers(executing, 'Implemented persistence. [DONE:1]');

    expect(progress.phase).toBe('executing');
    expect(progress.steps.map((step) => step.status)).toEqual(['complete', 'in_progress']);
    const completed = applyPlanControlMarkers(progress, 'UI done [DONE:2]');
    expect(completed.phase).toBe('complete');
    expect(completed.steps.every((step) => step.status === 'complete')).toBe(true);
  });

  it('never exposes internal completion markers in rendered text', () => {
    expect(stripPlanControlMarkers('Finished one. [DONE:1]\n\n[BLOCKED:2] Needs input.')).toBe('Finished one.\n\nNeeds input.');
  });

  it('moves back to review when an executing step is blocked', () => {
    const executing: PlanSessionState = {
      ...reviewPlan,
      phase: 'executing',
      steps: [
        { ...reviewPlan.steps[0]!, status: 'in_progress' },
        reviewPlan.steps[1]!,
      ],
    };

    const blocked = applyPlanControlMarkers(executing, 'The dependency is unavailable. [BLOCKED:1]');

    expect(blocked.phase).toBe('review');
    expect(blocked.steps.map((step) => step.status)).toEqual(['blocked', 'pending']);
    expect(canExecutePlan(blocked)).toBe(false);
  });

  it('lets completion win over blockers and never advances past a blocked step', () => {
    const executing: PlanSessionState = {
      ...reviewPlan,
      phase: 'executing',
      steps: [{ ...reviewPlan.steps[0]!, status: 'in_progress' }, reviewPlan.steps[1]!],
    };

    const blocked = applyPlanControlMarkers(executing, '[DONE:1] [BLOCKED:2]');
    expect(blocked.phase).toBe('review');
    expect(blocked.steps.map((step) => step.status)).toEqual(['complete', 'blocked']);

    const completed = applyPlanControlMarkers(executing, '[DONE:1] [BLOCKED:1]');
    expect(completed.phase).toBe('executing');
    expect(completed.steps.map((step) => step.status)).toEqual(['complete', 'in_progress']);
  });

  it('ignores out-of-range control markers', () => {
    const executing: PlanSessionState = { ...reviewPlan, phase: 'executing' };
    expect(applyPlanControlMarkers(executing, '[DONE:99]')).toBe(executing);
  });
});
