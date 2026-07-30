import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, PlanSessionState } from '../lib/types';
import { FileSidebar } from './FileSidebar';

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

describe('FileSidebar plan editor', () => {
  afterEach(() => vi.clearAllMocks());

  it('edits, reorders, adds and removes steps before saving a fresh review', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: '编辑计划' }));
    fireEvent.change(screen.getByLabelText('步骤 1 标题'), { target: { value: 'Persist state in the session' } });

    const moveDown = screen.getAllByRole('button', { name: '下移步骤' })[0]!;
    fireEvent.click(moveDown);
    fireEvent.click(screen.getByRole('button', { name: '添加步骤' }));
    expect(screen.getByLabelText('步骤 3 标题')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '删除步骤' })[2]!);
    expect(screen.queryByLabelText('步骤 3 标题')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(controllerMocks.updatePlan).toHaveBeenCalledWith({
      goal: 'Implement plan mode',
      steps: [
        { id: 'ui', title: 'Render the review UI', status: 'pending', detail: undefined },
        { id: 'state', title: 'Persist state in the session', status: 'pending', detail: undefined },
      ],
    }));
    expect(screen.queryByLabelText('步骤 1 标题')).not.toBeInTheDocument();
  });

  it('does not permit edits while the confirmed plan is executing', () => {
    render(
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

    fireEvent.click(screen.getByRole('tab', { name: '计划' }));
    expect(screen.getByRole('button', { name: '编辑计划' })).toBeDisabled();
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
