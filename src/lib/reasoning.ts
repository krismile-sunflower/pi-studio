import type { ModelsConfig, ModelsProviderConfig, ModelsProviderModel, PiReasoningLevel, ProviderReasoningValue, ReasoningProfile } from './types';

export const PI_REASONING_LEVELS: PiReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const REASONING_UI_LABELS = { off: '关闭（不发送推理参数）', omit: '不发送推理参数', unsupported: '不支持' } as const;

export const DEFAULT_REASONING_PROFILE: ReasoningProfile = {
  name: 'OpenAI 标准',
  levelMap: { off: 'omit', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
};

export function migrateReasoningConfig(config: ModelsConfig): ModelsConfig {
  const next = structuredClone(config);
  for (const provider of Object.values(next.providers || {})) {
    for (const profile of Object.values(provider.reasoningProfiles || {})) {
      if (profile.levelMap.off === 'unsupported') profile.levelMap.off = 'omit';
      if (profile.levelMap.xhigh === 'high') profile.levelMap.xhigh = 'xhigh';
    }
    for (const model of provider.models || []) {
      // Legacy null meant unsupported, but old UI wrote null for “关闭”. Only off is migrated.
      if (model.thinkingLevelMap?.off === null || model.thinkingLevelMap?.off === 'unsupported') {
        model.thinkingLevelMap.off = 'omit';
      }
      if (model.thinkingLevelMap?.xhigh === 'high') model.thinkingLevelMap.xhigh = 'xhigh';
    }
  }
  return next;
}

export function resolveReasoningValue(provider: ModelsProviderConfig, model: ModelsProviderModel, level: PiReasoningLevel): ProviderReasoningValue {
  const profile = model.reasoningProfile ? provider.reasoningProfiles?.[model.reasoningProfile] : undefined;
  const mapped = model.thinkingLevelMap?.[level] ?? profile?.levelMap[level];
  if (level === 'off' || mapped === 'omit') return 'omit';
  if (mapped === null || mapped === undefined || mapped === 'unsupported') return 'unsupported';
  return mapped;
}

export function withReasoningPayload(payload: Record<string, unknown>, api: string, mapped: ProviderReasoningValue): Record<string, unknown> {
  if (mapped === 'omit') return payload;
  if (mapped === 'unsupported') throw new Error('此模型不支持该强度');
  return api === 'openai-responses'
    ? { ...payload, reasoning: { effort: mapped } }
    : { ...payload, reasoning_effort: mapped };
}
