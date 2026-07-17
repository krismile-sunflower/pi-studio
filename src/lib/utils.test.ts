import { describe, expect, it } from 'vitest';
import {
  basename,
  formatTokens,
  getMessageText,
  getMessageThinking,
  normalizeMessageText,
  samePath,
  normalizeContextUsage,
  totalContextTokens,
  totalPromptTokens,
} from './utils';

describe('frontend protocol utilities', () => {
  it('normalizes Windows and POSIX workspace paths', () => {
    expect(samePath('D:\\work\\pi-studio\\', 'd:/work/pi-studio')).toBe(true);
    expect(samePath('/work/a', '/work/b')).toBe(false);
    expect(basename('D:\\work\\pi-studio')).toBe('pi-studio');
  });

  it('extracts text and thinking blocks from Pi messages', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '分析' },
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    };
    expect(getMessageText(message)).toBe('第一段\n第二段');
    expect(getMessageThinking(message)).toBe('分析');
  });

  it('formats usage values consistently', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(totalPromptTokens({ input: 20, cacheRead: 80, cacheWrite: 5 })).toBe(105);
    expect(totalContextTokens({ input: 20, output: 10, cacheRead: 80, cacheWrite: 5 })).toBe(115);
    expect(totalContextTokens({ input: 20, output: 10, totalTokens: 101 })).toBe(101);
    expect(normalizeMessageText('  hello\n world  ')).toBe('hello world');
  });

  it('keeps Pi context estimates typed, including the unknown state after compaction', () => {
    expect(normalizeContextUsage({ tokens: null, contextWindow: 500_000, percent: null })).toEqual({
      tokens: null,
      contextWindow: 500_000,
      percent: null,
    });
    expect(normalizeContextUsage({ tokens: 28_474, contextWindow: 500_000, percent: 5.6948 })).toEqual({
      tokens: 28_474,
      contextWindow: 500_000,
      percent: 5.6948,
    });
    expect(normalizeContextUsage({ tokens: '28k' })).toBeUndefined();
  });
});
