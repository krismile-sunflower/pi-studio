import type {
  ImageContentBlock,
  ModelInfo,
  PiInstance,
  PiMessage,
  SessionEntry,
  SessionProject,
  TimelineItem,
  ToolExecution,
  Usage,
} from '../lib/types';
import {
  formatToolOutput,
  getMessageText,
  getMessageThinking,
  modelIdFromValue,
  totalInputTokens,
} from '../lib/utils';

export function instanceTransport(instance?: PiInstance | null): 'rpc' | 'mirror' {
  return instance?.transport || (instance?.port ? 'mirror' : 'rpc');
}

export function modelSupportsThinking(
  model?: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> } | null,
): boolean {
  if (!model) return true;
  return Boolean(model.reasoning || model.thinkingLevelMap);
}

export function resolveModel(value: unknown, models: ModelInfo[]): ModelInfo | null {
  if (value && typeof value === 'object') {
    const candidate = value as ModelInfo;
    if (candidate.id || candidate.modelId || candidate.name) {
      const id = candidate.id || candidate.modelId || candidate.name || '';
      const provider = normalizedModelPart(candidate.provider);
      const matched = models.find((model) =>
        (model.id === id || model.modelId === id) && (!provider || model.provider === provider),
      ) || models.find((model) => model.id === id || model.modelId === id);
      return {
        ...matched,
        ...candidate,
        id,
        provider: provider || matched?.provider,
      };
    }
  }
  const id = modelIdFromValue(value);
  return models.find((model) => model.id === id || model.modelId === id) || (id ? { id } : null);
}

function normalizedModelPart(value?: string): string {
  const normalized = String(value || '').trim();
  return normalized && !['unknown', 'undefined', 'null'].includes(normalized.toLowerCase())
    ? normalized
    : '';
}

export function assistantError(message?: PiMessage | null): string | null {
  if (!message) return null;
  const value = message as PiMessage & {
    stop_reason?: string;
    error_message?: string;
    error?: unknown;
  };
  if (
    value.stopReason !== 'error' &&
    value.stop_reason !== 'error' &&
    !value.errorMessage &&
    !value.error_message &&
    !value.error
  ) {
    return null;
  }
  const raw = value.errorMessage || value.error_message || value.error;
  return typeof raw === 'string' ? raw : JSON.stringify(raw || '模型响应失败');
}

export function mergeSessionProjects(
  apiProjects: SessionProject[],
  localProjects: SessionProject[],
): SessionProject[] {
  const merged = new Map<string, SessionProject>();
  for (const project of [...apiProjects, ...localProjects]) {
    const key = project.noFolder ? '__no_folder__' : project.dirName || project.path || '';
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...project, sessions: [...(project.sessions || [])] });
      continue;
    }
    const files = new Set(current.sessions.map((session) => session.filePath || session.file));
    for (const session of project.sessions || []) {
      const file = session.filePath || session.file;
      if (file && files.has(file)) continue;
      current.sessions.push(session);
      if (file) files.add(file);
    }
    current.sessions.sort((left, right) => (right.mtime || 0) - (left.mtime || 0));
  }
  return [...merged.values()]
    .filter((project) => project.sessions.length > 0)
    .sort((left, right) => (right.sessions[0]?.mtime || 0) - (left.sessions[0]?.mtime || 0));
}

export function buildHistoryTimeline(entries: SessionEntry[]): {
  timeline: TimelineItem[];
  sessionTotalCost: number;
  lastUsage: Usage | null;
} {
  const timeline: TimelineItem[] = [];
  let sessionTotalCost = 0;
  let lastUsage: Usage | null = null;

  entries.forEach((entry, entryIndex) => {
    if (entry.type !== 'message' || !entry.message) return;
    const message = entry.message;
    if (message.role === 'user') {
      const images = Array.isArray(message.content)
        ? message.content
            .filter((block) => block.type === 'image')
            .map((block) => {
              const image = block as ImageContentBlock;
              return {
                data: image.source?.data || image.data || '',
                mimeType: image.source?.media_type || image.mime_type || 'image/png',
              };
            })
        : [];
      if (getMessageText(message) || images.length) {
        // Stable keys prevent remount/jitter when history is re-rendered.
        const id = `history-${entryIndex}-user`;
        timeline.push({
          id,
          kind: 'message',
          message: {
            id,
            role: 'user',
            content: getMessageText(message),
            images,
            history: true,
          },
        });
      }
      return;
    }

    if (message.role === 'assistant') {
      const error = assistantError(message);
      const id = `history-${entryIndex}-assistant`;
      if (error || getMessageText(message) || getMessageThinking(message)) {
        timeline.push({
          id,
          kind: 'message',
          message: {
            id,
            role: error ? 'error' : 'assistant',
            content: error || getMessageText(message),
            thinking: getMessageThinking(message),
            usage: message.usage,
            history: true,
          },
        });
      }
      if (message.usage?.cost?.total) sessionTotalCost += message.usage.cost.total;
      if (message.usage && totalInputTokens(message.usage) > 0) lastUsage = message.usage;

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== 'toolCall' || !('id' in block) || !('name' in block)) continue;
          const tool: ToolExecution = {
            toolCallId: String(block.id),
            toolName: String(block.name),
            args:
              'arguments' in block && block.arguments && typeof block.arguments === 'object'
                ? (block.arguments as Record<string, unknown>)
                : {},
            status: 'complete',
            output: '',
            history: true,
          };
          timeline.push({ id: `history-${entryIndex}-tool-${tool.toolCallId}`, kind: 'tool', tool });
        }
      }
      return;
    }

    if (message.role === 'toolResult' && message.toolCallId) {
      const index = timeline.findIndex(
        (item) => item.kind === 'tool' && item.tool.toolCallId === message.toolCallId,
      );
      const existing = timeline[index];
      if (index >= 0 && existing?.kind === 'tool') {
        timeline[index] = {
          ...existing,
          tool: {
            ...existing.tool,
            status: message.isError ? 'error' : 'complete',
            isError: message.isError,
            output: formatToolOutput({ content: message.content }),
          },
        };
      }
    }
  });

  return { timeline, sessionTotalCost, lastUsage };
}
