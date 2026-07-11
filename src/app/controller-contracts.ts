import type {
  ModelInfo,
  PiInstance,
  ProjectInfo,
  SessionProject,
} from '../lib/types';
import { apiJson, isDesktop } from '../lib/desktop';
import { instanceTransport } from './session-model';

export interface SessionResponse {
  projects?: SessionProject[];
}

export interface ProjectsResponse {
  projects?: ProjectInfo[];
  noFolderActive?: boolean;
  error?: string;
}

export interface LaunchResponse {
  ok?: boolean;
  instance?: PiInstance;
  error?: string;
}

export interface ModelsResponse {
  models?: ModelInfo[];
}

export interface StateResponse {
  model?: ModelInfo | string;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
}

export interface PendingPrompt {
  message: string;
  createdAt: number;
  confirmed: boolean;
}

export function notify(
  title: string,
  message = '',
  type: 'success' | 'error' | 'warning' | 'info' = 'info',
): void {
  window.dispatchEvent(
    new CustomEvent('pi-studio:toast', { detail: { title, message, type } }),
  );
}

export async function fetchRunningInstances(): Promise<PiInstance[]> {
  if (!isDesktop) return [];
  try {
    const data = await apiJson<{ instances?: PiInstance[] }>('/api/instances');
    return (data.instances || []).filter(
      (instance) => instanceTransport(instance) === window.tauDesktop.transport,
    );
  } catch {
    return [];
  }
}
