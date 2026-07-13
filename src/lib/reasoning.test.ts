import { describe, expect, it } from 'vitest';
import { migrateReasoningConfig, REASONING_UI_LABELS, resolveReasoningValue, withReasoningPayload } from './reasoning';
import type { ModelsConfig, ModelsProviderConfig, ModelsProviderModel } from './types';

const provider: ModelsProviderConfig = { api: 'openai-completions', reasoningProfiles: { standard: { levelMap: { off: 'omit', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } } } };
const model: ModelsProviderModel = { id: 'any-model-id', reasoning: true, reasoningProfile: 'standard' };

describe('reasoning profiles', () => {
  it('off omits reasoning without making the model unavailable', () => expect(withReasoningPayload({ model: model.id }, provider.api!, resolveReasoningValue(provider, model, 'off'))).toEqual({ model: model.id }));
  it('uses the API-specific field for concrete values', () => {
    expect(withReasoningPayload({}, 'openai-completions', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(withReasoningPayload({}, 'openai-responses', 'low')).toEqual({ reasoning: { effort: 'low' } });
  });
  it('rejects only an unsupported selected level', () => {
    const custom = { ...model, thinkingLevelMap: { low: 'unsupported' as const } };
    expect(() => withReasoningPayload({}, 'openai-completions', resolveReasoningValue(provider, custom, 'low'))).toThrow('此模型不支持该强度');
    expect(resolveReasoningValue(provider, custom, 'off')).toBe('omit');
  });
  it('migrates legacy off null/unsupported to omit', () => {
    const config = { providers: { p: { models: [{ id: 'm', thinkingLevelMap: { off: null, xhigh: 'high' } }] } } } as ModelsConfig;
    const migrated = migrateReasoningConfig(config).providers.p.models?.[0].thinkingLevelMap;
    expect(migrated?.off).toBe('omit');
    expect(migrated?.xhigh).toBe('xhigh');
  });
  it('never labels off as unsupported in the UI', () => {
    expect(REASONING_UI_LABELS.off).toContain('不发送推理参数');
    expect(REASONING_UI_LABELS.off).not.toBe(REASONING_UI_LABELS.unsupported);
  });
});
