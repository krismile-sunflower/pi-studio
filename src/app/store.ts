import { useSyncExternalStore } from 'react';
import type { AppSnapshot } from '../lib/types';
import { BUILTIN_SLASH_COMMANDS } from '../lib/slash-commands';

const initialSnapshot: AppSnapshot = {
  view: 'chat',
  connection: 'idle',
  isStreaming: false,
  hasActivePiSession: Boolean(window.tauDesktop.instanceId || window.tauDesktop.instancePort),
  workspace: { path: '', noFolder: false },
  selectedSessionFile: null,
  selectedSessionTitle: '',
  activeSessionFile: null,
  timeline: [],
  sessionProjects: [],
  sessionSearchResults: [],
  sessionsLoading: false,
  sessionSwitching: false,
  projects: [],
  projectsLoading: false,
  projectError: '',
  projectBusyPath: null,
  noFolderActive: false,
  liveInstances: [],
  models: [],
  currentModelId: '',
  thinkingLevel: 'off',
  thinkingSupported: true,
  contextWindowSize: 0,
  lastUsage: null,
  sessionTotalCost: 0,
  queue: [],
  slashCommands: BUILTIN_SLASH_COMMANDS,
  modelsConfig: null,
  modelsConfigPath: '',
  modelsConfigLoading: false,
  modelsConfigSaving: false,
  modelsConfigError: '',
  piUpdating: false,
  piUpdateMessage: '',
  extensions: null,
  extensionsLoading: false,
  extensionError: '',
  extensionInstallingId: null,
  settings: null,
  runtimeInfo: null,
  autostartEnabled: false,
  autoCompactionEnabled: false,
  showThinking: localStorage.getItem('tau-show-thinking') !== 'false',
  authConfigured: false,
  authEnabled: false,
  gitStatus: null,
  gitLoading: false,
  gitError: '',
  selectedGitPath: null,
  gitDiff: null,
  gitDiffLoading: false,
  extensionUiRequest: null,
};

export class AppStore {
  private snapshot: AppSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): AppSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<AppSnapshot> | ((state: AppSnapshot) => Partial<AppSnapshot>)): void {
    const nextPatch = typeof patch === 'function' ? patch(this.snapshot) : patch;
    this.snapshot = { ...this.snapshot, ...nextPatch };
    this.listeners.forEach((listener) => listener());
  }

  resetConversation(): void {
    this.update({
      timeline: [],
      isStreaming: false,
      lastUsage: null,
      sessionTotalCost: 0,
      queue: [],
    });
  }
}

export const appStore = new AppStore();

export function useAppSnapshot(): AppSnapshot {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot, appStore.getSnapshot);
}
