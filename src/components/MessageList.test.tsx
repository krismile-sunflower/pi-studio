import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '../lib/types';
import { MessageList } from './MessageList';

describe('MessageList', () => {
  it('renders welcome, assistant markdown and tool state', () => {
    const timeline: TimelineItem[] = [
      {
        id: 'welcome',
        kind: 'message',
        message: { id: 'welcome', role: 'system', content: '__PI_STUDIO_WELCOME__' },
      },
      {
        id: 'assistant',
        kind: 'message',
        message: {
          id: 'assistant',
          role: 'assistant',
          content: '**完成**',
          thinking: '检查项目结构',
          usage: { input: 100, output: 20 },
        },
      },
      {
        id: 'tool-1',
        kind: 'tool',
        tool: {
          toolCallId: 'tool-1',
          toolName: 'read',
          args: { path: 'src/main.tsx' },
          status: 'complete',
          output: 'ok',
        },
      },
    ];

    render(<MessageList timeline={timeline} streaming={false} />);

    expect(screen.getByRole('heading', { name: '把想法变成下一步行动。' })).toBeInTheDocument();
    expect(screen.getByText('完成')).toBeInTheDocument();
    expect(screen.getByText('思考过程')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('renders an accessible error card', () => {
    const timeline: TimelineItem[] = [
      {
        id: 'error',
        kind: 'message',
        message: { id: 'error', role: 'error', content: '连接失败' },
      },
    ];
    render(<MessageList timeline={timeline} streaming={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('连接失败');
  });

  it('shows non-overlapping request usage fields', () => {
    render(<MessageList timeline={[{
      id: 'assistant-usage',
      kind: 'message',
      message: {
        id: 'assistant-usage',
        role: 'assistant',
        content: '完成',
        usage: {
          input: 6_507,
          output: 1_643,
          cacheRead: 20_224,
          cacheWrite: 0,
          totalTokens: 28_374,
        },
      },
    }]} streaming={false} />);

    expect(screen.getByText('输入 6.5k / 输出 1.6k / 缓存读取 20.2k / 总计 28.4k')).toBeInTheDocument();
  });

  it('renders streamed assistant content as Markdown before the response completes', () => {
    render(<MessageList timeline={[{
      id: 'streaming-markdown',
      kind: 'message',
      message: {
        id: 'streaming-markdown',
        role: 'assistant',
        content: '## 正在分析\n\n这里有 **实时格式**。',
        streaming: true,
      },
    }]} streaming />);

    expect(screen.getByRole('heading', { name: '正在分析' })).toBeInTheDocument();
    expect(screen.getByText('实时格式').tagName).toBe('STRONG');
  });

  it('keeps completed terminal commands collapsed until opened', () => {
    const timeline: TimelineItem[] = [{
      id: 'bash-1',
      kind: 'tool',
      tool: {
        toolCallId: 'bash-1',
        toolName: 'bash',
        args: { command: 'pwd && ls' },
        status: 'complete',
        output: '/workspace\nREADME.md',
      },
    }];

    const { container } = render(<MessageList timeline={timeline} streaming={false} />);

    expect(container.querySelector('.tool-card-body')).not.toHaveClass('expanded');
    fireEvent.click(screen.getByRole('button', { name: /bash/ }));
    expect(container.querySelector('.tool-card-body')).toHaveClass('expanded');
    expect(screen.getAllByText('pwd && ls')).toHaveLength(2);
    expect(screen.getByText(/README\.md/)).toBeVisible();
  });

  it('lets users copy their own messages', () => {
    render(<MessageList timeline={[{
      id: 'user-copy',
      kind: 'message',
      message: { id: 'user-copy', role: 'user', content: '请复制这条用户消息' },
    }]} streaming={false} />);

    expect(screen.getByRole('button', { name: '复制消息' })).toBeInTheDocument();
  });

  it('adds a right-side marker for every user conversation after the first one', () => {
    const timeline: TimelineItem[] = [
      { id: 'user-1', kind: 'message', message: { id: 'user-1', role: 'user', content: '先分析这个项目' } },
      { id: 'assistant-1', kind: 'message', message: { id: 'assistant-1', role: 'assistant', content: '好的。' } },
      { id: 'user-2', kind: 'message', message: { id: 'user-2', role: 'user', content: '接着检查测试' } },
    ];

    render(<MessageList timeline={timeline} streaming={false} />);

    expect(screen.getByRole('navigation', { name: '对话快速定位' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /跳转到用户消息 1：先分析这个项目/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /跳转到用户消息 2：接着检查测试/ })).toBeInTheDocument();
  });

  it('renders command permission requests inline and returns the selected allowance', () => {
    const onRespond = vi.fn();
    const request = {
      id: 'permission-1',
      method: 'select' as const,
      title: 'Pi 请求权限\n执行命令\npnpm test -- --run',
      options: ['仅允许本次', '本会话允许此类操作', '拒绝'],
    };

    render(
      <MessageList
        timeline={[]}
        streaming
        extensionUiRequest={request}
        onRespondToExtension={onRespond}
      />,
    );

    expect(screen.getByRole('region', { name: 'Pi 工具执行授权' })).toHaveTextContent('pnpm test -- --run');
    expect(screen.getByText('等待授权')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '仅允许本次' }));
    expect(onRespond).toHaveBeenCalledWith(request, { value: '仅允许本次' });
  });

  it('keeps existing one-line permission requests readable', () => {
    render(
      <MessageList
        timeline={[]}
        streaming
        extensionUiRequest={{
          id: 'permission-old',
          method: 'select',
          title: 'Pi 请求权限\n修改文件 · src/app/App.tsx',
          options: ['仅允许本次', '拒绝'],
        }}
        onRespondToExtension={() => undefined}
      />,
    );

    expect(screen.getByRole('region', { name: 'Pi 工具执行授权' })).toHaveTextContent('允许 Pi 修改文件？');
    expect(screen.getByText('src/app/App.tsx')).toBeInTheDocument();
  });

  it('does not append a duplicate plan card to the chat', () => {
    render(<MessageList timeline={[]} streaming={false} />);
    expect(screen.queryByRole('region', { name: '计划审阅' })).not.toBeInTheDocument();
  });

  it('renders a subagent delegation as a child-progress card', () => {
    const timeline: TimelineItem[] = [
      {
        id: 'tool-sub',
        kind: 'tool',
        tool: {
          toolCallId: 'tool-sub',
          toolName: 'subagent',
          args: { tasks: [{ agent: 'scout', task: '梳理组件结构' }, { agent: 'critic', task: '评审' }] },
          status: 'streaming',
          output: '',
          resultDetails: {
            mode: 'parallel',
            progress: [
              {
                index: 0,
                agent: 'scout',
                status: 'running',
                task: '梳理组件结构',
                currentTool: 'read',
                currentToolArgs: 'src/app/App.tsx',
                recentTools: [],
                recentOutput: [],
                toolCount: 4,
                tokens: 8400,
                durationMs: 12_000,
              },
              { index: 1, agent: 'critic', status: 'completed', task: '评审', recentTools: [], recentOutput: [], toolCount: 2, tokens: 900, durationMs: 3000 },
            ],
            results: [],
          },
        },
      },
    ];

    render(<MessageList timeline={timeline} streaming />);

    expect(screen.getByText('子代理')).toBeInTheDocument();
    expect(screen.getByText('并行 · 2 个')).toBeInTheDocument();
    expect(screen.getByText('scout')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText(/src\/app\/App\.tsx/)).toBeInTheDocument();
    expect(screen.getByText(/1\/2 完成/)).toBeInTheDocument();
  });

  it('falls back to the arguments-only skeleton when a session replays without details', () => {
    render(
      <MessageList
        timeline={[{
          id: 'tool-sub',
          kind: 'tool',
          tool: {
            toolCallId: 'tool-sub',
            toolName: 'subagent',
            args: { agent: 'planner', task: '拆解任务' },
            status: 'complete',
            output: '完成了拆解',
            history: true,
          },
        }]}
        streaming={false}
      />,
    );

    expect(screen.getByText('单个 · planner')).toBeInTheDocument();
    expect(screen.getByText('拆解任务')).toBeInTheDocument();
    // No progress payload survives a session reload, so the child inherits the tool's outcome.
    expect(screen.getByText('完成了拆解')).toBeInTheDocument();
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(1);
  });
});
