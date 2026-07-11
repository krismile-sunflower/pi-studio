import { describe, expect, it } from 'vitest';
import type { SessionEntry, SessionProject } from '../lib/types';
import { buildHistoryTimeline, mergeSessionProjects } from './session-model';

describe('session model', () => {
  it('merges API and native session groups without duplicate files', () => {
    const api: SessionProject[] = [
      {
        path: 'D:\\work\\demo',
        dirName: 'demo',
        sessions: [{ filePath: 'one.jsonl', mtime: 10 }],
      },
    ];
    const native: SessionProject[] = [
      {
        path: 'D:\\work\\demo',
        dirName: 'demo',
        sessions: [
          { filePath: 'one.jsonl', mtime: 10 },
          { filePath: 'two.jsonl', mtime: 20 },
        ],
      },
    ];

    const result = mergeSessionProjects(api, native);

    expect(result).toHaveLength(1);
    expect(result[0]?.sessions.map((session) => session.filePath)).toEqual([
      'two.jsonl',
      'one.jsonl',
    ]);
  });

  it('builds a typed timeline and attaches tool results', () => {
    const entries: SessionEntry[] = [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Done' },
            { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
          ],
          usage: { input: 100, output: 10, cost: { total: 0.01 } },
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'tool-1',
          content: [{ type: 'text', text: 'contents' }],
        },
      },
    ];

    const result = buildHistoryTimeline(entries);
    const tool = result.timeline.find((item) => item.kind === 'tool');

    expect(result.sessionTotalCost).toBe(0.01);
    expect(result.lastUsage?.input).toBe(100);
    expect(tool?.kind === 'tool' ? tool.tool.output : '').toBe('contents');
    // Stable ids for history items (no random uniqueId).
    expect(result.timeline[0]?.id).toBe('history-0-assistant');
    expect(tool?.id).toBe('history-0-tool-tool-1');
  });

  it('produces identical ids for the same history payload', () => {
    const entries: SessionEntry[] = [
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ];
    const first = buildHistoryTimeline(entries).timeline.map((item) => item.id);
    const second = buildHistoryTimeline(entries).timeline.map((item) => item.id);
    expect(first).toEqual(second);
  });
});
