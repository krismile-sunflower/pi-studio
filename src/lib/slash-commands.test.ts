import { describe, expect, it } from 'vitest';
import {
  applySlashCompletion,
  fuzzyFilterCommands,
  matchSlashCommand,
  mergeSlashCommands,
  BUILTIN_SLASH_COMMANDS,
} from './slash-commands';

describe('slash-commands', () => {
  it('matches slash prefix at the start of input', () => {
    expect(matchSlashCommand('/')).toEqual({ prefix: '/', query: '', start: 0 });
    expect(matchSlashCommand('/mod')).toEqual({ prefix: '/mod', query: 'mod', start: 0 });
    expect(matchSlashCommand('/model ')).toBeNull();
    expect(matchSlashCommand('hello /mod')).toBeNull();
  });

  it('filters commands by fuzzy query', () => {
    const results = fuzzyFilterCommands(BUILTIN_SLASH_COMMANDS, 'comp');
    expect(results.some((command) => command.name === 'compact')).toBe(true);
    expect(results.every((command) => command.name.includes('comp') || command.description.toLowerCase().includes('comp'))).toBe(true);
  });

  it('applies completion with trailing space', () => {
    expect(applySlashCompletion('/mo', 'model')).toEqual({ text: '/model ', cursor: 7 });
  });

  it('merges remote commands without clobbering builtins', () => {
    const merged = mergeSlashCommands([
      { name: 'compact', description: 'remote compact', source: 'extension' },
      { name: 'todo', description: 'todo list', source: 'extension' },
      { name: 'skill:review', description: 'review skill', source: 'skill' },
    ]);
    expect(merged.find((command) => command.name === 'compact')?.description).not.toBe('remote compact');
    expect(merged.some((command) => command.name === 'todo')).toBe(true);
    expect(merged.some((command) => command.name === 'skill:review')).toBe(true);
  });
});
