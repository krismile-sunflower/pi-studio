import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

    expect(screen.getByRole('heading', { name: '从一个问题开始' })).toBeInTheDocument();
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
});
