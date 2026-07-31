import { describe, expect, it } from 'vitest';
import {
  isSubagentTool,
  parseSubagentRun,
  subagentDetailsOf,
  subagentModeLabel,
} from './subagents';

describe('pi-subagents tool projection', () => {
  it('recognises both tools the extension registers', () => {
    expect(isSubagentTool('subagent')).toBe(true);
    expect(isSubagentTool('subagent_wait')).toBe(true);
    expect(isSubagentTool('bash')).toBe(false);
  });

  it('builds a single-agent skeleton from arguments alone', () => {
    const run = parseSubagentRun({ agent: 'scout', task: '梳理组件结构', model: 'sonnet' });
    expect(run.mode).toBe('single');
    expect(run.live).toBe(false);
    expect(run.children).toEqual([
      { index: 0, agent: 'scout', task: '梳理组件结构', status: 'pending', model: 'sonnet', recentTools: [] },
    ]);
  });

  it('expands parallel tasks by their count', () => {
    const run = parseSubagentRun({ tasks: [{ agent: 'a', task: 'x', count: 2 }, { agent: 'b', task: 'y' }] });
    expect(run.mode).toBe('parallel');
    expect(run.children.map((child) => child.agent)).toEqual(['a', 'a', 'b']);
    expect(subagentModeLabel(run)).toBe('并行 · 3 个');
  });

  it('flattens chain steps, including a step that fans out', () => {
    const run = parseSubagentRun({
      chain: [
        { agent: 'scout', task: '调研' },
        { parallel: [{ agent: 'writer', task: '写' }, { agent: 'critic', task: '评' }] },
      ],
    });
    expect(run.mode).toBe('chain');
    expect(run.totalSteps).toBe(2);
    expect(run.children.map((child) => child.agent)).toEqual(['scout', 'writer', 'critic']);
    expect(run.children[1].phase).toBe('步骤 2');
  });

  it('treats an action argument as a management call', () => {
    const run = parseSubagentRun({ action: 'status', id: 'run-1' });
    expect(run.mode).toBe('management');
    expect(subagentModeLabel(run)).toBe('管理 · status');
  });

  it('overlays live progress from tool_execution_update details', () => {
    const details = subagentDetailsOf({
      content: [{ type: 'text', text: '…' }],
      details: {
        mode: 'parallel',
        progress: [
          {
            index: 0,
            agent: 'scout',
            status: 'running',
            task: '调研',
            currentTool: 'read',
            currentToolArgs: 'src/app/App.tsx',
            recentTools: [{ tool: 'grep', args: 'Composer', endMs: 1 }],
            recentOutput: [],
            toolCount: 4,
            tokens: 8400,
            durationMs: 12_000,
            model: 'sonnet',
          },
          { index: 1, agent: 'critic', status: 'failed', task: '评审', recentTools: [], recentOutput: [], toolCount: 1, tokens: 300, durationMs: 900, error: '子代理超时' },
        ],
        results: [{ agent: 'scout', task: '调研', exitCode: 0, usage: {} }],
        totalChildUsage: { input: 9000, output: 1200 },
        totalCost: { total: 0.0421 },
      },
    });
    expect(details).toBeDefined();

    const run = parseSubagentRun({ tasks: [{ agent: 'scout', task: '调研' }, { agent: 'critic', task: '评审' }] }, details);
    expect(run.live).toBe(true);
    expect(run.tokens).toBe(10_200);
    expect(run.cost).toBeCloseTo(0.0421);
    expect(run.children[0]).toMatchObject({
      agent: 'scout',
      status: 'running',
      currentTool: 'read',
      currentToolArgs: 'src/app/App.tsx',
      recentTools: ['grep Composer'],
      toolCount: 4,
    });
    expect(run.children[1]).toMatchObject({ status: 'failed', error: '子代理超时' });
  });

  it('derives child status from results when progress is absent', () => {
    const run = parseSubagentRun(
      { agent: 'scout', task: '调研' },
      { mode: 'single', results: [{ agent: 'scout', task: '调研', exitCode: 1, error: '崩溃', usage: {} }] },
    );
    expect(run.children[0].status).toBe('failed');
    expect(run.children[0].error).toBe('崩溃');
  });

  it('ignores tool results that carry no details', () => {
    expect(subagentDetailsOf({ content: [{ type: 'text', text: 'ok' }] })).toBeUndefined();
    expect(subagentDetailsOf('plain string')).toBeUndefined();
    expect(subagentDetailsOf(null)).toBeUndefined();
  });
});
