import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, PlanSessionState } from '../lib/types';
import { FileSidebar, formatPreviewText } from './FileSidebar';

const controllerMocks = vi.hoisted(() => ({
  commitGit: vi.fn(),
  executePlan: vi.fn(),
  loadGitStatus: vi.fn(),
  pullGit: vi.fn(),
  revisePlan: vi.fn(),
  selectGitChange: vi.fn(),
  stageAllGit: vi.fn(),
  stageGit: vi.fn(),
  pushGit: vi.fn(),
  unstageAllGit: vi.fn(),
  unstageGit: vi.fn(),
  updatePlan: vi.fn(),
}));

vi.mock('../app/controller', () => ({ controller: controllerMocks }));

const reviewPlan: PlanSessionState = {
  phase: 'review',
  goal: 'Implement plan mode',
  steps: [
    { id: 'state', title: 'Persist session state', status: 'pending' },
    { id: 'ui', title: 'Render the review UI', status: 'pending' },
  ],
  updatedAt: '2026-07-30T15:00:00.000Z',
};

function snapshot(plan: PlanSessionState = reviewPlan): AppSnapshot {
  return {
    plan,
    isStreaming: false,
    selectedSessionFile: null,
    timeline: [],
    gitStatus: null,
    gitLoading: false,
    gitError: '',
    selectedGitPath: null,
    selectedGitArea: null,
    gitDiff: null,
    gitDiffLoading: false,
  } as unknown as AppSnapshot;
}

describe('file preview formatting', () => {
  it('expands compact JSON for line-by-line preview', () => {
    expect(formatPreviewText('{"name":"pi","nested":{"enabled":true}}', 'settings.json', 'json')).toBe([
      '{',
      '  "name": "pi",',
      '  "nested": {',
      '    "enabled": true',
      '  }',
      '}',
    ].join('\n'));
  });

  it('keeps invalid or truncated JSON unchanged', () => {
    expect(formatPreviewText('{"broken":', 'settings.json', 'json')).toBe('{"broken":');
    expect(formatPreviewText('{"partial":true', 'large.json', 'json', true)).toBe('{"partial":true');
  });
});

describe('FileSidebar plan editor', () => {
  afterEach(() => vi.clearAllMocks());

  it('edits the whole plan document before saving a fresh review', async () => {
    controllerMocks.updatePlan.mockResolvedValue(true);
    render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot()}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '计划' }));
    const planContent = screen.getByLabelText('计划内容');
    expect(planContent).toHaveValue('1. Persist session state\n\n2. Render the review UI');
    expect(screen.queryByRole('button', { name: '编辑计划' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled();
    fireEvent.change(planContent, { target: { value: '1. Render the review UI\n   Keep the right sidebar concise.\n\n2、Persist state in the session' } });
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '继续规划' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(controllerMocks.updatePlan).toHaveBeenCalledWith({
      goal: 'Implement plan mode',
      steps: [
        { id: 'state', title: 'Render the review UI', status: 'pending', detail: 'Keep the right sidebar concise.' },
        { id: 'ui', title: 'Persist state in the session', status: 'pending' },
      ],
    }));
  });

  it('keeps the local document when saving fails and the old plan is restored', async () => {
    let resolveSave: ((value: boolean) => void) | undefined;
    controllerMocks.updatePlan.mockImplementation(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    const { rerender } = render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot()}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '计划' }));
    const revised = '1. Keep this local draft\n\n2. Retry the command';
    fireEvent.change(screen.getByLabelText('计划内容'), { target: { value: revised } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));

    rerender(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot({ ...reviewPlan, updatedAt: '2026-07-30T15:01:00.000Z' })}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('计划内容')).toHaveValue('1. Persist session state\n\n2. Render the review UI'));

    resolveSave?.(false);
    await waitFor(() => expect(screen.getByRole('button', { name: '保存计划' })).toBeEnabled());
    rerender(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot()}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('计划内容')).toHaveValue(revised));
  });

  it('shows execution progress instead of a second plan and keeps its task list collapsed', () => {
    const { container } = render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot({
          ...reviewPlan,
          phase: 'executing',
          steps: [{ ...reviewPlan.steps[0]!, status: 'in_progress' }, reviewPlan.steps[1]!],
        })}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '执行' }));
    expect(screen.getByLabelText('执行进度')).toBeInTheDocument();
    expect(screen.getByText('当前任务')).toBeInTheDocument();
    expect(screen.getByText('第 1/2 步')).toBeInTheDocument();
    expect(screen.queryByText('计划步骤')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('计划内容')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑计划' })).not.toBeInTheDocument();
    const taskList = container.querySelector('details[aria-label="任务清单"]');
    expect(taskList).not.toBeNull();
    expect(taskList).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('任务清单'));
    expect(taskList).toHaveAttribute('open');
  });

  it('renders a read-only result summary after all steps complete', () => {
    const { container } = render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot({
          ...reviewPlan,
          phase: 'complete',
          steps: reviewPlan.steps.map((step) => ({ ...step, status: 'complete' })),
        })}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    expect(screen.getAllByText('执行结果')).toHaveLength(2);
    expect(screen.getByText('已记录工具')).toBeInTheDocument();
    expect(screen.queryByLabelText('计划内容')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始执行' })).not.toBeInTheDocument();
    const record = container.querySelector('details[aria-label="执行记录与原计划"]');
    expect(record).not.toBeNull();
    expect(record).not.toHaveAttribute('open');
  });

  it('refreshes result file statistics instead of reporting an unknown count as zero', async () => {
    render(
      <FileSidebar
        rootPath="/workspace"
        open
        snapshot={snapshot({
          ...reviewPlan,
          phase: 'complete',
          steps: reviewPlan.steps.map((step) => ({ ...step, status: 'complete' })),
        })}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    await waitFor(() => expect(controllerMocks.loadGitStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: '结果' }));
    const fileMetric = screen.getByText('当前文件变更').parentElement;
    expect(fileMetric).toHaveTextContent('—当前文件变更');
  });

  it('returns a blocked review to an editable plan that must be reconfirmed', async () => {
    controllerMocks.updatePlan.mockResolvedValue(true);
    render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot({
          ...reviewPlan,
          steps: [{ ...reviewPlan.steps[0]!, status: 'blocked' }, reviewPlan.steps[1]!],
        })}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '计划' }));
    expect(screen.getByText('需要处理的计划')).toBeInTheDocument();
    expect(screen.getByText('受阻步骤')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('计划内容'), { target: { value: '1. Resolve the blocked dependency\n\n2. Render the review UI' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));

    await waitFor(() => expect(controllerMocks.updatePlan).toHaveBeenCalledWith({
      goal: 'Implement plan mode',
      steps: [
        { id: 'state', title: 'Resolve the blocked dependency', status: 'pending' },
        { id: 'ui', title: 'Render the review UI', status: 'pending' },
      ],
    }));
  });

  it('keeps build mode free of editable plan controls', () => {
    render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot({ phase: 'build', goal: '', steps: [], updatedAt: new Date(0).toISOString() })}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '计划' }));
    expect(screen.getByText('下一步')).toBeInTheDocument();
    expect(screen.queryByLabelText('计划内容')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始执行' })).not.toBeInTheDocument();
  });

  it('keeps all workspace tabs connected to their panels and keyboard navigable', () => {
    render(
      <FileSidebar
        rootPath=""
        open
        snapshot={snapshot()}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    const planTab = screen.getByRole('tab', { name: '计划' });
    expect(planTab).toHaveAttribute('aria-controls', 'file-sidebar-panel-plan');
    fireEvent.click(planTab);
    fireEvent.keyDown(planTab, { key: 'ArrowRight' });

    const changesTab = screen.getByRole('tab', { name: '变更' });
    expect(changesTab).toHaveFocus();
    expect(changesTab).toHaveAttribute('aria-controls', 'file-sidebar-panel-changes');
    expect(changesTab).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('file-sidebar-panel-changes')).toHaveAttribute('aria-labelledby', 'file-sidebar-tab-changes');
  });
});

describe('FileSidebar Git controls', () => {
  afterEach(() => vi.clearAllMocks());

  it('commits staged changes with the entered message', async () => {
    controllerMocks.commitGit.mockResolvedValue(true);
    const state = snapshot();
    state.gitStatus = {
      root: 'D:\\project',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      isRepository: true,
      changes: [{ path: 'src/app.ts', indexStatus: 'M', worktreeStatus: ' ' }],
    };
    render(
      <FileSidebar
        rootPath="D:\\project"
        open
        snapshot={state}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /变更/ }));
    fireEvent.change(screen.getByLabelText('Git 提交说明'), { target: { value: 'Add Git workspace actions' } });
    fireEvent.click(screen.getByRole('button', { name: '提交暂存' }));

    await waitFor(() => expect(controllerMocks.commitGit).toHaveBeenCalledWith('Add Git workspace actions'));
    await waitFor(() => expect(screen.getByLabelText('Git 提交说明')).toHaveValue(''));
  });

  it('stages an individual untracked file', async () => {
    controllerMocks.stageGit.mockResolvedValue(true);
    const state = snapshot();
    state.gitStatus = {
      root: 'D:\\project',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isRepository: true,
      changes: [{ path: 'src/new.ts', indexStatus: '?', worktreeStatus: '?' }],
    };
    render(
      <FileSidebar
        rootPath="D:\\project"
        open
        snapshot={state}
        onClose={() => undefined}
        onInsert={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /变更/ }));
    fireEvent.click(screen.getByRole('button', { name: 'src' }));
    fireEvent.click(screen.getByRole('button', { name: '暂存 src/new.ts' }));

    await waitFor(() => expect(controllerMocks.stageGit).toHaveBeenCalledWith(['src/new.ts']));
  });
});
