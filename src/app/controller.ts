import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { apiJson, isDesktop, postJson } from '../lib/desktop';
import { initialTransportUrl, PiTransport } from '../lib/transport';
import type {
  DesktopSettings,
  ExtensionUiRequest,
  GitFileDiff,
  GitStatus,
  ImageAttachment,
  ModelInfo,
  ModelsConfig,
  ModelsConfigResponse,
  ModelsProviderConfig,
  ModelsProviderModel,
  PiModelDefaultsResponse,
  PiExtensionInfo,
  PiExtensionsCatalog,
  PiPackagesCatalog,
  PiPackageCatalogItem,
  PiInstance,
  PiMessage,
  PiRuntimeInfo,
  PiSession,
  PiUpdateResult,
  RpcEvent,
  RpcResponse,
  RenderedMessage,
  SessionEntry,
  SessionProject,
  SessionSearchResult,
  SlashCommand,
  TimelineItem,
  ToolExecution,
  TransportEnvelope,
  Usage,
  WorkspaceView,
} from '../lib/types';
import {
  basename,
  formatTokens,
  formatToolOutput,
  getMessageText,
  getMessageThinking,
  getMessageToolCalls,
  modelIdFromValue,
  normalizeContextUsage,
  normalizeMessageText,
  samePath,
  totalContextTokens,
  uniqueId,
} from '../lib/utils';
import { mergeSlashCommands } from '../lib/slash-commands';
import { appStore } from './store';
import {
  assistantError,
  buildHistoryTimeline,
  instanceTransport,
  mergeSessionProjects,
  modelSupportsThinking,
  resolveModel,
} from './session-model';
import type {
  LaunchResponse,
  ModelsResponse,
  PendingPrompt,
  ProjectsResponse,
  SessionResponse,
  StateResponse,
} from './controller-contracts';
import { fetchRunningInstances, notify } from './controller-contracts';

function knownModelValue(value?: string | null): string {
  const normalized = String(value || '').trim();
  return normalized && !['unknown', 'undefined', 'null'].includes(normalized.toLowerCase())
    ? normalized
    : '';
}

export class PiStudioController {
  readonly transport = new PiTransport(initialTransportUrl(), {
    onConnected: () => this.handleConnected(),
    onDisconnected: () => appStore.update({ connection: 'disconnected' }),
    onNeedsPiSession: () => {
      appStore.update({ connection: 'idle', hasActivePiSession: false, view: 'projects' });
      void this.loadProjects();
    },
    onRpcEvent: (event) => this.handleRpcEvent(event),
    onMirrorSync: (snapshot) => this.handleMirrorSync(snapshot),
    onServerError: (message) => this.addError(message),
  });

  private initialized = false;
  private currentStreamingId: string | null = null;
  private currentStreamingText = '';
  private currentStreamingThinking = '';
  private selectedSessionLiveOnly = false;
  private isMirrorMode = false;
  private pendingPrompts: PendingPrompt[] = [];
  private sessionRefreshTimer: number | null = null;
  private pollTimer: number | null = null;
  private unlisten: UnlistenFn[] = [];
  /** Monotonic token so only the latest session switch may mutate the timeline. */
  private sessionSwitchGeneration = 0;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    document.body.classList.toggle('hide-thinking', !appStore.getSnapshot().showThinking);

    await this.loadProjects();
    await this.loadSessions();
    await this.installDesktopListeners();

    if (isDesktop && !window.tauDesktop.instancePort && !window.tauDesktop.instanceId) {
      try {
        await this.ensureDefaultPiSession();
      } catch (error) {
        appStore.update({
          connection: 'idle',
          hasActivePiSession: false,
          view: 'projects',
          projectError: `Pi 自动启动失败：${String(error)}`,
        });
        return;
      }
    }

    if (appStore.getSnapshot().timeline.length === 0) this.addWelcome();
    if (!isDesktop) {
      try {
        const health = await apiJson<{ ok?: boolean }>('/api/health');
        if (!health.ok) {
          appStore.update({ connection: 'idle' });
          return;
        }
      } catch {
        appStore.update({ connection: 'idle' });
        return;
      }
    }
    await this.transport.connect();
    await this.pollInstances();
    this.pollTimer = window.setInterval(() => void this.pollInstances(), 5000);

    if (!isDesktop && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.sessionRefreshTimer != null) window.clearTimeout(this.sessionRefreshTimer);
    if (this.pollTimer != null) window.clearInterval(this.pollTimer);
    this.unlisten.forEach((stop) => stop());
    this.unlisten = [];
    await this.transport.dispose();
    this.initialized = false;
  }

  setView(view: WorkspaceView): void {
    appStore.update({ view });
    if (view === 'projects') void this.loadProjects();
    if (view === 'settings') {
      void this.loadSettings();
      void this.loadModelsConfig();
    }
    if (view === 'customization') {
      void this.loadExtensions();
      void this.loadPackages();
      void this.searchPackages();
    }
    if (view === 'changes') void this.loadGitStatus();
  }

  returnToChat(): void {
    if (isDesktop && !appStore.getSnapshot().hasActivePiSession) this.setView('projects');
    else this.setView('chat');
  }

  async loadProjects(): Promise<void> {
    appStore.update({ projectsLoading: true, projectError: '' });
    try {
      const data = await apiJson<ProjectsResponse>('/api/projects');
      appStore.update({
        projects: data.projects || [],
        noFolderActive: Boolean(data.noFolderActive),
        projectError: data.error || '',
        projectsLoading: false,
      });
    } catch (error) {
      appStore.update({
        projectsLoading: false,
        projectError: isDesktop ? String(error) : '',
      });
    }
  }

  async launchProject(path: string): Promise<void> {
    if (!path || appStore.getSnapshot().projectBusyPath) return;
    appStore.update({ projectBusyPath: path, projectError: '', connection: 'connecting' });
    try {
      const result = await postJson<LaunchResponse>('/api/projects/launch', { path });
      if (!result.ok || !result.instance) throw new Error(result.error || 'Pi 启动失败');
      this.acceptInstance(result.instance, true);
      appStore.update({ projectBusyPath: null, view: 'chat', hasActivePiSession: true });
      await this.loadProjects();
      this.transport.forceReconnect();
      this.refreshSessionsSoon(800);
      if (isDesktop) {
        void invoke('notify_desktop', {
          request: { title: 'PiCode', body: 'Pi 已启动，工作台连接成功。' },
        }).catch(() => undefined);
      }
    } catch (error) {
      appStore.update({
        projectBusyPath: null,
        projectError: String(error),
        connection: 'idle',
      });
    }
  }

  async launchNoFolder(): Promise<void> {
    if (appStore.getSnapshot().projectBusyPath) return;
    appStore.update({ projectBusyPath: '__no_folder__', projectError: '', connection: 'connecting' });
    try {
      const result = await postJson<LaunchResponse>('/api/projects/launch', { noFolder: true });
      if (!result.ok || !result.instance) throw new Error(result.error || 'Pi 启动失败');
      this.acceptInstance(result.instance, true);
      appStore.update({ projectBusyPath: null, view: 'chat', hasActivePiSession: true });
      await this.loadProjects();
      this.transport.forceReconnect();
      this.refreshSessionsSoon(800);
    } catch (error) {
      appStore.update({
        projectBusyPath: null,
        projectError: String(error),
        connection: 'idle',
      });
    }
  }

  async addProject(): Promise<void> {
    if (!isDesktop) {
      notify('桌面端功能', '添加本地项目仅在 PiCode 桌面应用中可用。');
      return;
    }
    const folder = await invoke<string | null>('pick_project_folder');
    if (folder) await this.loadProjects();
  }

  async openProjectWindow(path: string): Promise<void> {
    if (!isDesktop) {
      notify('桌面端功能', '新窗口打开仅在桌面应用中可用。');
      return;
    }
    await invoke('open_project_window', { request: { path } });
  }

  async loadSessions(options: { silent?: boolean } = {}): Promise<void> {
    const silent = Boolean(options.silent) && appStore.getSnapshot().sessionProjects.length > 0;
    if (!silent) appStore.update({ sessionsLoading: true });
    try {
      let apiProjects: SessionProject[] = [];
      try {
        const data = await apiJson<SessionResponse>('/api/sessions');
        apiProjects = data.projects || [];
      } catch {
        // Native session fallback below remains authoritative in desktop mode.
      }

      let localProjects: SessionProject[] = [];
      if (isDesktop) {
        try {
          const data = await invoke<SessionResponse>('list_local_sessions');
          localProjects = data.projects || [];
        } catch {
          localProjects = [];
        }
      }

      appStore.update({
        sessionProjects: mergeSessionProjects(apiProjects, localProjects),
        sessionsLoading: false,
      });
    } catch (error) {
      console.error('[Sessions] Failed to load:', error);
      appStore.update({
        // Keep existing list on background refresh failure — don't wipe the sidebar.
        ...(silent ? {} : { sessionProjects: [] }),
        sessionsLoading: false,
      });
    }
  }

  async searchSessions(query: string): Promise<void> {
    const value = query.trim();
    if (value.length < 2) {
      appStore.update({ sessionSearchResults: [] });
      return;
    }
    try {
      const data = await apiJson<{ results?: SessionSearchResult[] }>(
        `/api/search?q=${encodeURIComponent(value)}`,
      );
      appStore.update({ sessionSearchResults: data.results || [] });
    } catch {
      appStore.update({ sessionSearchResults: [] });
    }
  }

  async selectSession(session: PiSession | null, project: SessionProject | null): Promise<void> {
    this.setView('chat');
    if (!session) {
      this.sessionSwitchGeneration += 1;
      appStore.update({
        selectedSessionFile: null,
        selectedSessionTitle: '',
        sessionSwitching: false,
      });
      this.resetConversationWithWelcome();
      return;
    }

    // Skip no-op reselect to avoid timeline flash.
    if (
      session.filePath &&
      session.filePath === appStore.getSnapshot().selectedSessionFile &&
      !appStore.getSnapshot().sessionSwitching
    ) {
      return;
    }

    const generation = ++this.sessionSwitchGeneration;
    // Keep the previous timeline visible until the next history is ready.
    appStore.update({
      selectedSessionFile: session.filePath,
      selectedSessionTitle: session.name || session.firstMessage || session.file || '当前会话',
      sessionTotalCost: 0,
      contextUsage: undefined,
      lastUsage: null,
      isStreaming: false,
      queue: [],
      sessionSwitching: true,
    });
    this.selectedSessionLiveOnly = Boolean(session.live && session.fileExists === false);
    this.currentStreamingId = null;
    this.currentStreamingText = '';
    this.currentStreamingThinking = '';
    this.pendingPrompts = [];

    try {
      await this.ensureWorkspaceForSession(session, project);
      if (!this.isCurrentSessionSwitch(generation, session.filePath)) return;
      await this.switchSession(session, project, generation);
    } catch (error) {
      if (!this.isCurrentSessionSwitch(generation, session.filePath)) return;
      appStore.update({ sessionSwitching: false });
      this.addError(`切换会话失败：${String(error)}`);
    }
  }

  async newSession(): Promise<void> {
    const state = appStore.getSnapshot();
    if (this.isMirrorMode || state.hasActivePiSession) {
      const generation = ++this.sessionSwitchGeneration;
      appStore.update({ sessionSwitching: true });
      const result = await this.rpcCommand<{ sessionFile?: string; entries?: SessionEntry[]; cancelled?: boolean }>(
        { type: 'new_session' },
        '正在创建新会话…',
      );
      if (!this.isCurrentSessionSwitch(generation)) return;
      if (!result.success || result.data?.cancelled) {
        appStore.update({ sessionSwitching: false });
        throw new Error(result.error || 'Pi 未能创建新会话');
      }
      const sessionFile = result.data?.sessionFile || null;
      appStore.update({
        selectedSessionFile: sessionFile,
        activeSessionFile: sessionFile,
        selectedSessionTitle: '新会话',
        sessionTotalCost: 0,
        contextUsage: undefined,
        lastUsage: null,
        view: 'chat',
        sessionSwitching: false,
      });
      this.selectedSessionLiveOnly = false;
      this.applyHistory(result.data?.entries || [], { allowEmptyWelcome: true });
      this.transport.send({ type: 'mirror_sync_request' });
      this.refreshSessionsSoon(300);
      return;
    }
    this.sessionSwitchGeneration += 1;
    this.resetConversationWithWelcome();
  }

  async sendMessage(message: string, images: ImageAttachment[] = []): Promise<void> {
    const text = message.trim();
    if (!text && images.length === 0) return;

    // Handle Pi CLI-compatible slash commands locally when possible.
    if (!images.length && text.startsWith('/')) {
      const handled = await this.handleLocalSlashCommand(text);
      if (handled) return;
    }

    if (appStore.getSnapshot().models.length === 0) {
      await this.loadModels();
      if (appStore.getSnapshot().models.length === 0) {
        const message = '当前 Pi 会话没有加载到可用模型。请在设置中检查 models.json，或重新启动当前项目。';
        this.addError(message);
        notify('无法发送消息', message, 'error');
        return;
      }
    }

    const prompt = text || '（请查看附图）';
    const command = {
      type: 'prompt',
      message: prompt,
      ...(images.length
        ? { images: images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })) }
        : {}),
    };

    if (appStore.getSnapshot().isStreaming) {
      appStore.update((state) => ({
        queue: [...state.queue, { id: uniqueId('queued'), message: prompt, images }],
      }));
      return;
    }

    this.removeWelcome();
    this.appendMessage('user', prompt, { images });
    this.pendingPrompts.push({ message: prompt, createdAt: Date.now(), confirmed: false });
    try {
      await this.sendPrompt(command);
    } catch (error) {
      this.pendingPrompts = this.pendingPrompts.filter((item) => item.message !== prompt);
      this.addError(`发送失败：${String(error)}`);
      this.transport.forceReconnect();
    }
  }

  cancelQueuedMessage(id: string): void {
    appStore.update((state) => ({ queue: state.queue.filter((item) => item.id !== id) }));
  }

  abort(): void {
    void this.rpcCommand({ type: 'abort' }).catch(() => this.transport.send({ type: 'abort' }));
    this.addError('已停止生成');
    appStore.update({ isStreaming: false });
  }

  async compact(): Promise<void> {
    await this.rpcCommand({ type: 'compact' }, '正在压缩上下文…');
  }

  async exportHtml(): Promise<void> {
    const result = await this.rpcCommand<{ path?: string }>({ type: 'export_html' }, '正在导出会话…');
    if (result.success && result.data?.path) notify('会话已导出', result.data.path, 'success');
  }

  async deleteSessionMessage(entryId: string): Promise<boolean> {
    const state = appStore.getSnapshot();
    const filePath = state.selectedSessionFile || state.activeSessionFile;
    if (!filePath || !entryId || state.isStreaming) return false;
    try {
      const result = await postJson<{ ok?: boolean; entries?: SessionEntry[] }>(
        '/api/sessions/entry/delete',
        { filePath, entryId, includeDescendants: false },
      );
      if (!result.ok) throw new Error('会话消息删除失败');
      this.applyHistory(result.entries || [], { allowEmptyWelcome: true });
      try {
        await this.resumeSession(filePath, { keepExistingHistory: false });
      } catch {
        // The file is already updated; a later session sync/restart will reload it.
      }
      this.refreshSessionsSoon(200);
      notify('消息已删除', '会话上下文已重新连接。', 'success');
      return true;
    } catch (error) {
      notify('删除消息失败', String(error), 'error');
      return false;
    }
  }

  async resendLastUserMessage(
    entryId: string,
    message: string,
    images: ImageAttachment[] = [],
  ): Promise<boolean> {
    const state = appStore.getSnapshot();
    const filePath = state.selectedSessionFile || state.activeSessionFile;
    if (!filePath || !entryId || !message.trim() || state.isStreaming) return false;
    try {
      const result = await postJson<{ ok?: boolean; entries?: SessionEntry[] }>(
        '/api/sessions/entry/delete',
        { filePath, entryId, includeDescendants: true },
      );
      if (!result.ok) throw new Error('无法回退到上一轮会话');
      this.applyHistory(result.entries || [], { allowEmptyWelcome: true });
      await this.resumeSession(filePath, { keepExistingHistory: false });
      await this.sendMessage(message, images);
      return true;
    } catch (error) {
      notify('重新发送失败', String(error), 'error');
      return false;
    }
  }

  async showSessionStats(): Promise<void> {
    const result = await this.rpcCommand<Record<string, unknown>>(
      { type: 'get_session_stats' },
      '正在读取会话统计…',
    );
    if (!result.success || !result.data) return;
    const stats = result.data;
    const reportedContext = normalizeContextUsage(stats.contextUsage);
    const legacyTokens = stats.tokens as { input?: unknown; total?: unknown } | undefined;
    const legacyContextTokens = legacyTokens?.total ?? legacyTokens?.input;
    const contextTokens = reportedContext
      ? reportedContext.tokens
      : typeof legacyContextTokens === 'number' && Number.isFinite(legacyContextTokens)
        ? legacyContextTokens
        : null;
    const contextWindow = reportedContext?.contextWindow || appStore.getSnapshot().contextWindowSize;
    const contextPercent = contextTokens != null && contextWindow > 0
      ? Math.round((contextTokens / contextWindow) * 100)
      : reportedContext?.percent != null
        ? Math.round(reportedContext.percent)
        : null;
    if (reportedContext) appStore.update({ contextUsage: reportedContext });
    const lines = [
      '会话统计',
      `消息：${stats.totalMessages || 0} 条（用户 ${stats.userMessages || 0}，助手 ${stats.assistantMessages || 0}）`,
      `工具调用：${stats.toolCalls || 0} 次`,
    ];
    if (contextTokens != null) {
      const total = contextWindow > 0 ? ` / ${formatTokens(contextWindow)}` : '';
      const percent = contextPercent != null ? `（${contextPercent}%）` : '';
      lines.push(`上下文：约 ${formatTokens(contextTokens)}${total} Token${percent}`);
    }
    this.appendMessage('system', lines.join('\n'));
  }

  async setModel(model: ModelInfo): Promise<void> {
    const result = await this.rpcCommand<{ model?: ModelInfo; thinkingLevel?: string }>(
      { type: 'set_model', provider: model.provider, modelId: model.id },
      `正在切换到 ${model.id}…`,
    );
    if (!result.success) return;
    const selected = result.data?.model || model;
    appStore.update({
      currentModelId: model.id,
      currentModelProvider: model.provider || '',
      thinkingSupported: modelSupportsThinking(selected),
      thinkingLevel: result.data?.thinkingLevel || appStore.getSnapshot().thinkingLevel,
      contextWindowSize: model.contextWindow || model.context_window || 0,
    });
  }

  async cycleThinking(): Promise<void> {
    if (!appStore.getSnapshot().thinkingSupported) return;
    const result = await this.rpcCommand<{ level?: string; thinkingLevel?: string }>(
      { type: 'cycle_thinking_level' },
    );
    if (!result.success) return;
    const data = result.data;
    const level =
      typeof data === 'string'
        ? data
        : data?.level || data?.thinkingLevel;
    if (level) appStore.update({ thinkingLevel: level, thinkingSupported: true });
    else appStore.update({ thinkingSupported: false });
  }

  async loadSettings(): Promise<void> {
    const runtimeAvailable =
      appStore.getSnapshot().hasActivePiSession ||
      appStore.getSnapshot().connection === 'connected';
    if (runtimeAvailable) {
      const modelState = await this.rpcCommand<StateResponse>({ type: 'get_state' }, '', true);
      if (modelState.success && modelState.data) {
        const model = resolveModel(modelState.data.model, appStore.getSnapshot().models);
        appStore.update({
          autoCompactionEnabled: Boolean(modelState.data.autoCompactionEnabled),
          thinkingLevel: modelState.data.thinkingLevel || 'off',
          thinkingSupported: modelSupportsThinking(model),
        });
      }
    }

    if (isDesktop) {
      const [settings, autostartEnabled, runtimeInfo] = await Promise.all([
        invoke<DesktopSettings>('get_desktop_settings').catch(() => null),
        invoke<boolean>('is_autostart_enabled').catch(() => false),
        invoke<PiRuntimeInfo>('get_pi_runtime_info').catch((error) => ({ error: String(error) })),
      ]);
      appStore.update({ settings, autostartEnabled, runtimeInfo });
      // Best-effort latest version check; don't block settings open.
      void this.checkPiUpdate(true);
    } else {
      appStore.update({
        runtimeInfo: {
          source: 'web',
          updateChannel: 'web',
          piVersion: '不可用',
          nodeVersion: '不可用',
          platform: navigator.platform || 'browser',
        },
      });
    }

    if (runtimeAvailable) {
      const auth = await this.rpcCommand<{ configured?: boolean; enabled?: boolean }>({ type: 'get_auth' }, '', true);
      appStore.update({
        authConfigured: Boolean(auth.success && auth.data?.configured),
        authEnabled: Boolean(auth.success && auth.data?.enabled),
      });
    } else {
      appStore.update({ authConfigured: false, authEnabled: false });
    }
  }

  async loadModelsConfig(options: { silent?: boolean } = {}): Promise<void> {
    if (!isDesktop) {
      appStore.update({
        modelsConfig: { providers: {} },
        modelsConfigPath: '',
        piSettingsPath: '',
        defaultProvider: '',
        defaultModel: '',
        modelsConfigError: '模型配置仅在桌面应用中可用。',
        modelsConfigLoading: false,
      });
      return;
    }
    const silent = Boolean(options.silent) || Boolean(appStore.getSnapshot().modelsConfig);
    // Keep the existing list visible during refresh to avoid layout flash.
    if (!silent) appStore.update({ modelsConfigLoading: true, modelsConfigError: '' });
    else appStore.update({ modelsConfigError: '' });
    try {
      const [result, defaults] = await Promise.all([
        invoke<ModelsConfigResponse>('get_models_config'),
        invoke<PiModelDefaultsResponse>('get_pi_model_defaults'),
      ]);
      const nextConfig = result.config || { providers: {} };
      const current = appStore.getSnapshot();
      // Skip store write when nothing changed — prevents child draft resets / flicker.
      const samePath = (current.modelsConfigPath || '') === (result.path || '');
      const sameConfig =
        JSON.stringify(current.modelsConfig || { providers: {} }) === JSON.stringify(nextConfig);
      const sameDefaults =
        current.defaultProvider === (defaults.defaultProvider || '') &&
        current.defaultModel === (defaults.defaultModel || '') &&
        current.piSettingsPath === (defaults.path || '');
      if (samePath && sameConfig && sameDefaults) {
        appStore.update({ modelsConfigLoading: false, modelsConfigError: '' });
        return;
      }
      appStore.update({
        modelsConfig: nextConfig,
        modelsConfigPath: result.path || '',
        piSettingsPath: defaults.path || '',
        defaultProvider: defaults.defaultProvider || '',
        defaultModel: defaults.defaultModel || '',
        modelsConfigLoading: false,
        modelsConfigError: '',
      });
    } catch (error) {
      appStore.update({
        modelsConfigLoading: false,
        modelsConfigError: `读取 models.json 失败：${String(error)}`,
      });
    }
  }

  async setDefaultModel(provider: string, modelId: string): Promise<boolean> {
    if (!isDesktop || !provider || !modelId) return false;
    try {
      const defaults = await invoke<PiModelDefaultsResponse>('set_pi_model_defaults', {
        request: { provider, modelId },
      });
      appStore.update({
        piSettingsPath: defaults.path || '',
        defaultProvider: defaults.defaultProvider || provider,
        defaultModel: defaults.defaultModel || modelId,
      });

      const available = appStore.getSnapshot().models.find(
        (model) => model.provider === provider && model.id === modelId,
      );
      if (available) {
        await this.setModel(available);
        notify('默认供应商已更新', `${provider} · ${modelId}`, 'success');
      } else {
        notify('默认供应商已更新', `${provider} · ${modelId}，将在下次启动 Pi 会话时生效。`, 'success');
      }
      return true;
    } catch (error) {
      notify('更新默认供应商失败', String(error), 'error');
      return false;
    }
  }

  async saveModelsConfig(config: ModelsConfig): Promise<boolean> {
    if (!isDesktop) {
      notify('桌面端功能', '保存模型配置仅在桌面应用中可用。', 'warning');
      return false;
    }
    appStore.update({ modelsConfigSaving: true, modelsConfigError: '' });
    try {
      // Preserve existing apiKey when the editor leaves it blank.
      const previous = appStore.getSnapshot().modelsConfig;
      const merged: ModelsConfig = {
        ...config,
        providers: Object.fromEntries(
          Object.entries(config.providers || {}).map(([name, provider]) => {
            const prevKey = previous?.providers?.[name]?.apiKey;
            const nextKey = provider.apiKey;
            const apiKey =
              nextKey == null || String(nextKey).trim() === ''
                ? prevKey
                : nextKey;
            return [name, { ...provider, ...(apiKey != null && apiKey !== '' ? { apiKey } : {}) }];
          }),
        ),
      };
      const result = await invoke<ModelsConfigResponse>('save_models_config', {
        request: { config: merged },
      });
      appStore.update({
        modelsConfig: result.config,
        modelsConfigPath: result.path,
        modelsConfigSaving: false,
      });
      notify('模型配置已保存', result.path, 'success');
      // Force Pi to re-read models.json, then refresh the header picker.
      await this.refreshPiModels();
      return true;
    } catch (error) {
      appStore.update({
        modelsConfigSaving: false,
        modelsConfigError: `保存失败：${String(error)}`,
      });
      notify('保存模型配置失败', String(error), 'error');
      return false;
    }
  }

  async fetchProviderModels(provider: ModelsProviderConfig): Promise<ModelsProviderModel[]> {
    if (!isDesktop) {
      notify('桌面端功能', '拉取模型仅在 PiCode 桌面应用中可用。', 'warning');
      return [];
    }
    try {
      const result = await invoke<{ models?: ModelsProviderModel[] }>('fetch_provider_models', { request: { provider } });
      return result.models || [];
    } catch (error) {
      notify('拉取模型失败', String(error), 'error');
      return [];
    }
  }

  async testProviderModel(provider: ModelsProviderConfig, modelId: string, reasoningProfile?: string, thinkingLevel = 'off', thinkingLevelMap?: ModelsProviderModel['thinkingLevelMap']): Promise<string> {
    if (!isDesktop) throw new Error('模型测试仅在 PiCode 桌面应用中可用。');
    const result = await invoke<{ output?: string }>('test_provider_model', {
      request: { provider, modelId, reasoningProfile, thinkingLevel, thinkingLevelMap },
    });
    return result.output || '';
  }

  /**
   * Ask the running Pi session to re-load ~/.pi/agent/models.json, then refresh UI models.
   * Falls back to restarting the current workspace if the refresh extension is not loaded.
   */
  async refreshPiModels(): Promise<void> {
    const state = appStore.getSnapshot();
    if (!state.hasActivePiSession || state.connection !== 'connected') {
      await this.loadModels();
      return;
    }

    // Prefer the lightweight extension command when available (models-refresh.ts).
    // Older Pi sessions started before this extension was added won't have it.
    let hasRefreshCommand = false;
    try {
      const commands = await this.rpcCommand<{ commands?: SlashCommand[] }>(
        { type: 'get_commands' },
        '',
        true,
      );
      hasRefreshCommand = Boolean(
        commands.success &&
          commands.data?.commands?.some(
            (command) => command.name === 'refresh-models' || command.name === '/refresh-models',
          ),
      );
    } catch {
      hasRefreshCommand = false;
    }

    if (hasRefreshCommand) {
      const refresh = await this.rpcCommand(
        { type: 'prompt', message: '/refresh-models' },
        '',
        true,
      );
      if (refresh.success) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        await this.loadModels();
        // Also refresh slash commands so newly-added skill/prompt names can appear later.
        void this.loadSlashCommands();
        notify('模型列表已刷新', `当前可用 ${appStore.getSnapshot().models.length} 个模型`, 'success');
        return;
      }
    }

    // Fallback: restart Pi so it boots with the new models.json / refresh extension.
    try {
      const workspace = appStore.getSnapshot().workspace;
      if (workspace.noFolder || !workspace.path) await this.launchNoFolder();
      else await this.launchProject(workspace.path);
      await this.loadModels();
      notify('模型列表已刷新', '已重启 Pi 会话以加载新配置', 'success');
    } catch (error) {
      await this.loadModels();
      notify(
        '模型已写入，但会话未刷新',
        `${String(error)}。请重新打开项目，或在输入框发送 /refresh-models。`,
        'warning',
      );
    }
  }

  async openModelsConfig(): Promise<void> {
    if (!isDesktop) {
      notify('桌面端功能', '打开 models.json 仅在桌面应用中可用。', 'warning');
      return;
    }
    try {
      const path = await invoke<string>('open_models_config');
      notify('已打开 models.json', path, 'info');
    } catch (error) {
      notify('打开失败', String(error), 'error');
    }
  }

  async checkPiUpdate(quiet = false): Promise<void> {
    if (!isDesktop) return;
    try {
      const info = await invoke<PiRuntimeInfo>('check_pi_update');
      appStore.update({ runtimeInfo: info, piUpdateMessage: '' });
      if (!quiet) {
        if (info.updateAvailable) {
          notify('发现新版本', `Pi ${info.latestVersion} 可用（当前 ${info.piVersion || '未知'}）`, 'info');
        } else {
          notify('已是最新', `当前 Pi ${info.piVersion || '未知'}`, 'success');
        }
      }
    } catch (error) {
      if (!quiet) notify('检查更新失败', String(error), 'error');
    }
  }

  async updatePiRuntime(): Promise<void> {
    if (!isDesktop || appStore.getSnapshot().piUpdating) return;
    const info = appStore.getSnapshot().runtimeInfo;
    if (info?.updateChannel === 'override') {
      notify('无法更新', '当前使用 PI_DESKTOP_CLI 覆盖路径，请手动更新。', 'warning');
      return;
    }
    if (!info?.canUpdateSystem && !info?.canUpdateBundled) {
      notify('无法更新', '当前运行时通道不支持应用内更新。', 'warning');
      return;
    }

    // Remember the workspace so we can relaunch Pi after the update stops it.
    const previousWorkspace = appStore.getSnapshot().workspace;
    appStore.update({ piUpdating: true, piUpdateMessage: '正在更新 Pi…' });
    try {
      const result = await invoke<PiUpdateResult>('update_pi_runtime');
      // Clear stale instance identity immediately — the old PID is gone.
      window.tauDesktop.setInstanceId(null);
      window.tauDesktop.setInstancePort(null);
      appStore.update({
        piUpdating: false,
        piUpdateMessage: result.message,
        hasActivePiSession: false,
        connection: 'idle',
        liveInstances: [],
        activeSessionFile: null,
      });
      if (result.ok) {
        notify('Pi 更新完成', result.newVersion ? `新版本 ${result.newVersion}` : result.message, 'success');
        await this.loadSettings();
        // Automatically restart Pi so the workbench is usable again.
        appStore.update({ piUpdateMessage: '正在重新启动 Pi…', connection: 'connecting' });
        try {
          await this.relaunchAfterUpdate(previousWorkspace);
          appStore.update({ piUpdateMessage: result.message });
          notify('Pi 已重新连接', '更新后的运行时已启动', 'success');
        } catch (error) {
          appStore.update({
            connection: 'idle',
            piUpdateMessage: `更新成功，但重新启动失败：${String(error)}。请从“项目”手动打开。`,
            view: 'projects',
          });
          notify('请重新打开项目', String(error), 'warning');
        }
      } else {
        notify('Pi 更新失败', result.message, 'error');
      }
    } catch (error) {
      appStore.update({ piUpdating: false, piUpdateMessage: String(error) });
      notify('Pi 更新失败', String(error), 'error');
    }
  }

  /** Restart Pi for the previous workspace (or default no-folder) after an update. */
  private async relaunchAfterUpdate(workspace: { path: string; noFolder: boolean }): Promise<void> {
    if (workspace.noFolder || !workspace.path) {
      await this.launchNoFolder();
      return;
    }
    await this.launchProject(workspace.path);
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    appStore.update({ autoCompactionEnabled: enabled });
    const result = await this.rpcCommand({ type: 'set_auto_compaction', enabled });
    if (!result.success) appStore.update({ autoCompactionEnabled: !enabled });
  }

  setShowThinking(enabled: boolean): void {
    appStore.update({ showThinking: enabled });
    document.body.classList.toggle('hide-thinking', !enabled);
    localStorage.setItem('tau-show-thinking', String(enabled));
  }

  async setAutostart(enabled: boolean): Promise<void> {
    if (!isDesktop) return;
    try {
      const value = await invoke<boolean>('set_autostart', { request: { enabled } });
      appStore.update({ autostartEnabled: value });
    } catch (error) {
      notify('开机启动设置失败', String(error), 'error');
    }
  }

  async setPermissionMode(permissionMode: 'ask' | 'read-only' | 'full-access'): Promise<void> {
    if (!isDesktop) return;
    const current = appStore.getSnapshot().settings;
    if (!current) return;
    try {
      const settings = await invoke<DesktopSettings>('save_desktop_settings', {
        settings: { ...current, permissionMode },
      });
      appStore.update({ settings });
      notify(
        '权限已更新',
        ({
          ask: '写入文件和执行命令前会请求确认。',
          'read-only': 'Pi 只能读取和搜索文件。',
          'full-access': 'Pi 将直接执行工具操作。',
        } as Record<string, string>)[permissionMode],
        'success',
      );
    } catch (error) {
      notify('权限设置失败', String(error), 'error');
    }
  }

  async setProjectTrusted(path: string, trusted: boolean): Promise<void> {
    if (!isDesktop || !path) return;
    const current = appStore.getSnapshot().settings;
    if (!current) return;
    const paths = new Set(current.trustedProjectPaths || []);
    if (trusted) paths.add(path);
    else paths.delete(path);
    try {
      const settings = await invoke<DesktopSettings>('save_desktop_settings', {
        settings: { ...current, trustedProjectPaths: [...paths] },
      });
      appStore.update({ settings });
      notify(
        trusted ? '项目已设为可信任' : '已撤销项目可信任',
        trusted ? '下次启动该项目的 Pi 会话时会加载项目级 .pi 资源。' : '下次启动该项目的 Pi 会话时将忽略项目级 .pi 资源。',
        trusted ? 'success' : 'info',
      );
    } catch (error) {
      notify('项目可信任设置失败', String(error), 'error');
    }
  }

  async loadGitStatus(): Promise<void> {
    const root = appStore.getSnapshot().workspace.path;
    if (!isDesktop || !root || appStore.getSnapshot().workspace.noFolder) {
      appStore.update({ gitStatus: null, gitLoading: false, gitError: '请先打开一个本地项目。', selectedGitPath: null, gitDiff: null });
      return;
    }
    appStore.update({ gitLoading: true, gitError: '' });
    try {
      const gitStatus = await invoke<GitStatus>('get_git_status', { path: root });
      const selected = appStore.getSnapshot().selectedGitPath;
      const stillExists = gitStatus.changes.some((change) => change.path === selected);
      appStore.update({ gitStatus, gitLoading: false, selectedGitPath: stillExists ? selected : null, gitDiff: stillExists ? appStore.getSnapshot().gitDiff : null });
    } catch (error) {
      appStore.update({ gitStatus: null, gitLoading: false, gitError: String(error), selectedGitPath: null, gitDiff: null });
    }
  }

  async selectGitChange(filePath: string): Promise<void> {
    const root = appStore.getSnapshot().workspace.path;
    if (!isDesktop || !root) return;
    appStore.update({ selectedGitPath: filePath, gitDiff: null, gitDiffLoading: true });
    try {
      const gitDiff = await invoke<GitFileDiff>('get_git_file_diff', { path: root, filePath });
      if (appStore.getSnapshot().selectedGitPath === filePath) appStore.update({ gitDiff, gitDiffLoading: false });
    } catch (error) {
      if (appStore.getSnapshot().selectedGitPath === filePath) appStore.update({ gitDiff: { path: filePath, diff: `无法加载 diff：${String(error)}` }, gitDiffLoading: false });
    }
  }

  async setAuth(enabled: boolean): Promise<void> {
    const result = await this.rpcCommand<{ enabled?: boolean }>({ type: 'set_auth', enabled });
    if (result.success) appStore.update({ authEnabled: result.data?.enabled ?? enabled });
  }

  async loadExtensions(force = false): Promise<void> {
    if (!isDesktop) {
      appStore.update({
        extensions: { installDir: '', catalogRoots: [], extensions: [] },
        extensionError: '扩展仅在桌面应用中可用。',
      });
      return;
    }
    if (appStore.getSnapshot().extensions && !force) return;
    appStore.update({ extensionsLoading: true, extensionError: '' });
    try {
      const catalog = await invoke<PiExtensionsCatalog>('list_pi_extensions');
      appStore.update({ extensions: catalog, extensionsLoading: false });
    } catch (error) {
      appStore.update({
        extensions: { installDir: '', catalogRoots: [], extensions: [] },
        extensionsLoading: false,
        extensionError: `扩展加载失败：${String(error)}`,
      });
    }
  }

  async installExtension(id: string): Promise<void> {
    if (!isDesktop || appStore.getSnapshot().extensionInstallingId) return;
    appStore.update({ extensionInstallingId: id });
    try {
      const result = await invoke<{
        extension: PiExtensionInfo;
        warning?: string;
        dependencyStatus?: string;
      }>('install_pi_extension', { request: { id } });
      appStore.update((state) => ({
        extensionInstallingId: null,
        extensions: state.extensions
          ? {
              ...state.extensions,
              extensions: state.extensions.extensions.map((extension) =>
                extension.id === id ? result.extension : extension,
              ),
            }
          : null,
      }));
      notify('扩展安装完成', result.extension.name, 'success');
    } catch (error) {
      appStore.update({ extensionInstallingId: null, extensionError: `安装失败：${String(error)}` });
      notify('扩展安装失败', String(error), 'error');
    }
  }

  async loadPackages(force = false): Promise<void> {
    if (!isDesktop) {
      appStore.update({ packages: { settingsPath: '', packages: [] }, packageError: 'Pi 软件包仅在桌面应用中可用。' });
      return;
    }
    if (appStore.getSnapshot().packages && !force) return;
    appStore.update({ packagesLoading: true, packageError: '' });
    try {
      const packages = await invoke<PiPackagesCatalog>('list_pi_packages');
      appStore.update({ packages, packagesLoading: false });
    } catch (error) {
      appStore.update({ packages: { settingsPath: '', packages: [] }, packagesLoading: false, packageError: `软件包加载失败：${String(error)}` });
    }
  }

  async installPackage(source: string): Promise<void> {
    if (!isDesktop || appStore.getSnapshot().packageInstalling) return;
    appStore.update({ packageInstalling: true, packageError: '' });
    try {
      const packages = await invoke<PiPackagesCatalog>('install_pi_package', { request: { source } });
      appStore.update({ packages, packageInstalling: false });
      notify('Pi 软件包安装完成', source.trim(), 'success');
    } catch (error) {
      appStore.update({ packageInstalling: false, packageError: `安装失败：${String(error)}` });
      notify('Pi 软件包安装失败', String(error), 'error');
    }
  }

  async removePackage(source: string): Promise<void> {
    if (!isDesktop || appStore.getSnapshot().packageRemovingSource) return;
    appStore.update({ packageRemovingSource: source, packageError: '' });
    try {
      const packages = await invoke<PiPackagesCatalog>('remove_pi_package', { request: { source } });
      appStore.update({ packages, packageRemovingSource: null });
      notify('Pi 软件包已移除', source, 'success');
    } catch (error) {
      appStore.update({ packageRemovingSource: null, packageError: `移除失败：${String(error)}` });
      notify('Pi 软件包移除失败', String(error), 'error');
    }
  }

  async searchPackages(query = ''): Promise<void> {
    if (!isDesktop) return;
    appStore.update({ packageSearchLoading: true, packageSearchError: '' });
    try {
      const packageSearchResults = await invoke<PiPackageCatalogItem[]>('search_pi_packages', { query });
      appStore.update({ packageSearchResults, packageSearchLoading: false });
    } catch (error) {
      appStore.update({ packageSearchResults: [], packageSearchLoading: false, packageSearchError: `软件包搜索失败：${String(error)}` });
    }
  }

  respondToExtension(request: ExtensionUiRequest, response: Record<string, unknown>): void {
    const id = request.id || request.requestId;
    this.transport.send({ type: 'extension_ui_response', id, ...response });
    appStore.update({ extensionUiRequest: null });
  }

  async rpcCommand<T = Record<string, unknown>>(
    command: Record<string, unknown>,
    statusMessage = '',
    quiet = false,
  ): Promise<RpcResponse<T>> {
    try {
      const result = await postJson<RpcResponse<T>>('/api/rpc', command);
      if (result.success) {
        if (statusMessage && !quiet) notify('操作完成', statusMessage.replace(/[…\.]+$/, ''), 'success');
      } else {
        if (!quiet) notify('操作失败', result.error || 'Pi 未返回成功结果', 'error');
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!quiet) notify('操作失败', message, 'error');
      return { success: false, error: message };
    }
  }

  private handleConnected(): void {
    appStore.update({ connection: 'connected', hasActivePiSession: true });
    void this.refreshWorkspaceFromHealth();
    void this.loadModels();
    void this.loadSlashCommands();
    this.refreshSessionsSoon(300);
  }

  /**
   * Load extension/prompt/skill commands from Pi RPC and merge with built-ins.
   * Falls back to built-ins alone if get_commands is unavailable.
   */
  async loadSlashCommands(): Promise<void> {
    const fallback = mergeSlashCommands([]);
    try {
      const result = await this.rpcCommand<{ commands?: SlashCommand[] }>(
        { type: 'get_commands' },
        '',
        true,
      );
      const remote = result.success ? result.data?.commands || [] : [];
      appStore.update({ slashCommands: mergeSlashCommands(remote) });
    } catch {
      appStore.update({ slashCommands: fallback });
    }
  }

  /**
   * Locally handle a subset of Pi CLI slash commands that map cleanly to the workbench UI.
   * Returns true when the command was fully handled (should not be sent as a prompt).
   */
  private async handleLocalSlashCommand(text: string): Promise<boolean> {
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const name = match[1]?.toLowerCase() || '';
    const args = (match[2] || '').trim();

    switch (name) {
      case 'new':
        await this.newSession();
        return true;
      case 'compact':
        await this.rpcCommand({ type: 'compact', ...(args ? { customInstructions: args } : {}) }, '正在压缩上下文…');
        return true;
      case 'export':
        await this.exportHtml();
        return true;
      case 'session':
        await this.showSessionStats();
        return true;
      case 'settings':
        this.setView('settings');
        return true;
      case 'model': {
        // Open model dropdown via a custom event the Header listens for.
        window.dispatchEvent(
          new CustomEvent('pi-studio:open-model-picker', { detail: { query: args } }),
        );
        return true;
      }
      case 'name': {
        if (!args) {
          notify('用法', '/name <会话名称>', 'info');
          return true;
        }
        await this.rpcCommand({ type: 'set_session_name', name: args }, `会话已命名为 ${args}`);
        appStore.update({ selectedSessionTitle: args });
        return true;
      }
      case 'copy': {
        await this.copyLastAssistantMessage();
        return true;
      }
      case 'hotkeys': {
        this.appendMessage(
          'system',
          [
            '快捷键',
            'Enter — 发送',
            'Shift+Enter — 换行',
            '⌘/Ctrl+K — 命令面板',
            '⌘/Ctrl+N — 新建会话',
            '⌘/Ctrl+B — 切换会话栏',
            'Esc — 停止生成 / 关闭面板',
            '/ — 斜杠命令自动补全',
          ].join('\n'),
        );
        return true;
      }
      case 'quit':
        notify('提示', '请使用窗口关闭按钮退出 PiCode', 'info');
        return true;
      // Extension commands, skills and prompt templates are forwarded to Pi via prompt().
      default:
        return false;
    }
  }

  private async copyLastAssistantMessage(): Promise<void> {
    const timeline = appStore.getSnapshot().timeline;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item?.kind === 'message' && item.message.role === 'assistant' && item.message.content.trim()) {
        try {
          await navigator.clipboard.writeText(item.message.content);
          notify('已复制', '上一条助手消息已复制到剪贴板', 'success');
        } catch (error) {
          notify('复制失败', String(error), 'error');
        }
        return;
      }
    }
    notify('无可复制内容', '当前会话中没有助手消息', 'info');
  }

  private handleRpcEvent(event: RpcEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.pendingPrompts[0] && (this.pendingPrompts[0].confirmed = true);
        appStore.update({ isStreaming: true });
        break;
      case 'agent_end':
        this.finishStreaming();
        appStore.update({ isStreaming: false });
        void this.syncCurrentHistory();
        void this.flushQueue();
        break;
      case 'message_start':
        this.handleMessageStart(event.message);
        break;
      case 'message_update':
        this.handleMessageUpdate(event);
        break;
      case 'message_end':
        this.handleMessageEnd(event.message);
        break;
      case 'tool_execution_start':
        this.upsertTool({
          toolCallId: event.toolCallId || uniqueId('tool'),
          toolName: event.toolName || 'tool',
          args: event.args || {},
          status: 'pending',
          output: '',
        });
        break;
      case 'tool_execution_update':
        this.updateTool(event.toolCallId || '', {
          status: 'streaming',
          output: formatToolOutput(event.partialResult),
        });
        break;
      case 'tool_execution_end':
        this.updateTool(event.toolCallId || '', {
          status: event.isError ? 'error' : 'complete',
          output: formatToolOutput(event.result),
          isError: Boolean(event.isError),
        });
        break;
      case 'auto_compaction_start':
        this.appendMessage('system', '正在压缩上下文…', { id: 'compaction-indicator' });
        break;
      case 'auto_compaction_end':
        this.updateMessage('compaction-indicator', {
          content: `上下文已压缩${event.summary ? ` — ${event.summary}` : ''}`,
        });
        break;
      case 'extension_ui_request':
        appStore.update({ extensionUiRequest: event as ExtensionUiRequest });
        break;
      case 'extension_error':
        this.addError(`扩展执行错误：${event.error || ''}`);
        break;
      case 'session_name':
        if (event.name) appStore.update({ selectedSessionTitle: event.name });
        break;
      default:
        break;
    }
  }

  private handleMessageStart(message?: PiMessage): void {
    if (!message) return;
    if (message.role === 'assistant') {
      this.currentStreamingText = '';
      this.currentStreamingThinking = '';
      this.recordMessageToolCalls(message);
      const text = getMessageText(message);
      const thinking = getMessageThinking(message);
      // A tool-only assistant message has no prose to render. Creating an
      // empty streaming message here used to leave a blank cursor/placeholder
      // between the usage line and the actual tool execution.
      this.currentStreamingId = text || thinking
        ? this.appendMessage('assistant', text, { streaming: true, thinking })
        : null;
      this.currentStreamingText = text;
      this.currentStreamingThinking = thinking;
      return;
    }
    if (message.role === 'user') {
      const content = getMessageText(message);
      const alreadyLocal = this.pendingPrompts.some(
        (prompt) => normalizeMessageText(prompt.message) === normalizeMessageText(content),
      );
      if (content && !alreadyLocal) this.appendMessage('user', content);
      this.pendingPrompts = this.pendingPrompts.map((prompt) =>
        normalizeMessageText(prompt.message) === normalizeMessageText(content)
          ? { ...prompt, confirmed: true }
          : prompt,
      );
    }
  }

  private async syncCurrentHistory(): Promise<void> {
    if (this.isMirrorMode) {
      this.transport.send({ type: 'mirror_sync_request' });
      return;
    }
    const result = await this.rpcCommand<{ entries?: SessionEntry[] }>(
      { type: 'get_entries' },
      '',
      true,
    );
    if (result.success) {
      this.applyHistory(result.data?.entries || [], { allowEmptyWelcome: true });
    }
  }

  private handleMessageUpdate(event: RpcEvent): void {
    const update = event.assistantMessageEvent;
    if (!update) return;
    this.recordMessageToolCalls(update.partial);
    if (!this.currentStreamingId) {
      this.currentStreamingText = getMessageText(update.partial);
      this.currentStreamingThinking = getMessageThinking(update.partial);
    }

    if (update.type === 'thinking_delta') {
      this.currentStreamingThinking =
        getMessageThinking(update.partial) || `${this.currentStreamingThinking}${update.delta || ''}`;
    } else if (update.type === 'thinking_end') {
      this.currentStreamingThinking =
        update.content || getMessageThinking(update.partial) || this.currentStreamingThinking;
    } else if (update.type === 'text_delta') {
      this.currentStreamingText =
        getMessageText(update.partial) || `${this.currentStreamingText}${update.delta || ''}`;
    } else if (update.type === 'text_end') {
      this.currentStreamingText =
        update.content || getMessageText(update.partial) || this.currentStreamingText;
    }
    if (!this.currentStreamingId && (this.currentStreamingText || this.currentStreamingThinking)) {
      this.currentStreamingId = this.appendMessage('assistant', this.currentStreamingText, {
        streaming: true,
        thinking: this.currentStreamingThinking,
      });
    } else if (this.currentStreamingId) {
      this.updateMessage(this.currentStreamingId, {
        content: this.currentStreamingText,
        thinking: this.currentStreamingThinking,
        streaming: true,
      });
    }
  }

  private handleMessageEnd(message?: PiMessage): void {
    if (!message) return;
    if (message.role === 'toolResult') {
      if (message.toolCallId) {
        this.updateTool(message.toolCallId, {
          status: message.isError ? 'error' : 'complete',
          output: formatToolOutput({ content: message.content }),
          isError: Boolean(message.isError),
        });
      }
      return;
    }
    if (message.role === 'assistant') this.recordMessageToolCalls(message);
    const error = assistantError(message);
    if (!this.currentStreamingId && message.role === 'assistant') {
      if (error) this.addError(error);
      else if (getMessageText(message) || getMessageThinking(message)) {
        this.appendMessage('assistant', getMessageText(message), {
          thinking: getMessageThinking(message),
          usage: message.usage,
        });
      }
      this.rememberUsage(message.usage);
      this.refreshSessionsSoon(800);
      return;
    }

    if (this.currentStreamingId) {
      if (error) {
        this.updateMessage(this.currentStreamingId, {
          role: 'error',
          content: error,
          streaming: false,
        });
      } else {
        this.currentStreamingText = getMessageText(message) || this.currentStreamingText;
        this.currentStreamingThinking = getMessageThinking(message) || this.currentStreamingThinking;
        if (!this.currentStreamingText.trim() && !this.currentStreamingThinking.trim()) {
          this.removeTimelineItem(this.currentStreamingId);
        } else {
          this.updateMessage(this.currentStreamingId, {
            content: this.currentStreamingText,
            thinking: this.currentStreamingThinking,
            usage: message.usage,
            streaming: false,
          });
        }
      }
      this.rememberUsage(message.usage);
      this.currentStreamingId = null;
      this.currentStreamingText = '';
      this.currentStreamingThinking = '';
    }
    this.refreshSessionsSoon(800);
  }

  private finishStreaming(): void {
    if (!this.currentStreamingId) return;
    this.updateMessage(this.currentStreamingId, { streaming: false });
    this.currentStreamingId = null;
    this.currentStreamingText = '';
    this.currentStreamingThinking = '';
    this.pendingPrompts = [];
  }

  private handleMirrorSync(snapshot: TransportEnvelope): void {
    this.isMirrorMode = true;
    const activeFile = snapshot.sessionFile || null;
    const state = appStore.getSnapshot();
    // During an intentional session switch, ignore stale mirror snapshots for other sessions.
    if (
      state.sessionSwitching &&
      state.selectedSessionFile &&
      activeFile &&
      state.selectedSessionFile !== activeFile
    ) {
      return;
    }

    const selectedFile = state.selectedSessionFile || activeFile;
    const contextUsage = normalizeContextUsage(snapshot.contextUsage);
    appStore.update({
      activeSessionFile: activeFile,
      selectedSessionFile: selectedFile,
      ...(contextUsage ? { contextUsage } : {}),
    });

    const model = resolveModel(snapshot.model, appStore.getSnapshot().models);
    if (model) {
      const modelId = knownModelValue(model.id) || knownModelValue(state.currentModelId) || knownModelValue(state.defaultModel);
      const available = state.models.find((item) => item.id === modelId);
      const provider = knownModelValue(model.provider) || knownModelValue(available?.provider) || knownModelValue(state.currentModelProvider) || knownModelValue(state.defaultProvider);
      appStore.update({
        currentModelId: modelId,
        currentModelProvider: provider,
        thinkingSupported: modelSupportsThinking(available || model),
        contextWindowSize: available?.contextWindow || available?.context_window || model.contextWindow || model.context_window || state.contextWindowSize,
      });
    }
    if (snapshot.thinkingLevel) appStore.update({ thinkingLevel: snapshot.thinkingLevel });

    const entries = snapshot.entries || [];
    const hasPending = this.pendingPrompts.some(
      (prompt) =>
        Date.now() - prompt.createdAt < 60_000 &&
        !entries.some(
          (entry) =>
            entry.message?.role === 'user' &&
            normalizeMessageText(getMessageText(entry.message)) === normalizeMessageText(prompt.message),
        ),
    );
    // Avoid re-rendering identical history (prevents flicker during switch/sync).
    if (!hasPending && entries.length > 0) {
      const next = buildHistoryTimeline(entries);
      const current = appStore.getSnapshot().timeline;
      if (next.timeline.length === 0 && !state.isStreaming) {
        const alreadyShowingWelcome = current.some(
          (item) => item.kind === 'message' && item.message.content === '__PI_STUDIO_WELCOME__',
        );
        if (alreadyShowingWelcome) {
          if (state.sessionSwitching) appStore.update({ sessionSwitching: false });
        } else {
          appStore.update({
            timeline: [],
            sessionTotalCost: 0,
            lastUsage: null,
            contextUsage: undefined,
            sessionSwitching: false,
          });
          this.addWelcome();
        }
        this.refreshSessionsSoon(300);
        return;
      }
      const sameLength = current.length === next.timeline.length;
      const sameTail =
        sameLength &&
        (current.length === 0 ||
          (current[current.length - 1]?.id === next.timeline[next.timeline.length - 1]?.id &&
            current[0]?.id === next.timeline[0]?.id));
      if (!sameTail) {
        appStore.update({ ...next, sessionSwitching: false });
      } else if (state.sessionSwitching) {
        appStore.update({ sessionSwitching: false });
      }
    } else if (!hasPending && !state.isStreaming && state.timeline.length === 0) {
      this.addWelcome();
      if (state.sessionSwitching) appStore.update({ sessionSwitching: false });
    } else if (state.sessionSwitching && !hasPending) {
      // Live session with no entries yet — clear the switching spinner.
      appStore.update({ sessionSwitching: false });
    }
    this.refreshSessionsSoon(300);
  }

  private applyHistory(
    entries: SessionEntry[],
    options: { allowEmptyWelcome?: boolean } = {},
  ): void {
    const next = buildHistoryTimeline(entries);
    if (next.timeline.length === 0 && options.allowEmptyWelcome) {
      appStore.update({
        timeline: [],
        sessionTotalCost: 0,
        lastUsage: null,
        contextUsage: undefined,
        sessionSwitching: false,
      });
      this.addWelcome();
      return;
    }
    appStore.update({ ...next, sessionSwitching: false });
  }

  private isCurrentSessionSwitch(generation: number, sessionFile?: string | null): boolean {
    if (generation !== this.sessionSwitchGeneration) return false;
    if (sessionFile == null) return true;
    return appStore.getSnapshot().selectedSessionFile === sessionFile;
  }

  private async switchSession(
    session: PiSession,
    project: SessionProject | null,
    generation: number,
  ): Promise<void> {
    this.currentStreamingId = null;
    this.currentStreamingText = '';
    this.currentStreamingThinking = '';
    this.pendingPrompts = [];

    // Prefer a single timeline replace. Keep the previous conversation visible until then.
    let loadedFromFile = false;
    const canLoad = !session.live || session.fileExists !== false;
    if (canLoad && project?.dirName && session.file) {
      try {
        const history = await apiJson<{ entries?: SessionEntry[] }>(
          `/api/sessions/${encodeURIComponent(project.dirName)}/${encodeURIComponent(session.file)}`,
        );
        if (!this.isCurrentSessionSwitch(generation, session.filePath)) return;
        this.applyHistory(history.entries || [], { allowEmptyWelcome: true });
        loadedFromFile = true;
      } catch (error) {
        if (!this.isCurrentSessionSwitch(generation, session.filePath)) return;
        // Don't blank the pane on file load failure — wait for resume / show error.
        this.addError(`会话预加载失败，正在尝试从 Pi 恢复：${String(error)}`);
      }
    } else if (session.live && session.fileExists === false) {
      // Live-only sessions have no file history yet — show welcome once mirror sync arrives.
      if (!this.isCurrentSessionSwitch(generation, session.filePath)) return;
      this.applyHistory([], { allowEmptyWelcome: true });
    }

    if (!this.isCurrentSessionSwitch(generation, session.filePath)) return;

    const activeFile = appStore.getSnapshot().activeSessionFile;
    if (session.live && session.fileExists === false) {
      appStore.update({ activeSessionFile: session.filePath, sessionSwitching: false });
      this.selectedSessionLiveOnly = true;
      this.transport.send({ type: 'mirror_sync_request' });
    } else if (session.filePath === activeFile) {
      // Already the live session — request sync only if file history was empty.
      if (!loadedFromFile || appStore.getSnapshot().timeline.length === 0) {
        this.transport.send({ type: 'mirror_sync_request' });
      }
      appStore.update({ sessionSwitching: false });
    } else if (session.filePath) {
      await this.resumeSession(session.filePath, {
        keepExistingHistory: loadedFromFile,
        generation,
      });
    } else {
      appStore.update({ sessionSwitching: false });
    }
  }

  private async resumeSession(
    sessionFile: string,
    options: { keepExistingHistory?: boolean; generation?: number } = {},
  ): Promise<void> {
    const generation = options.generation ?? this.sessionSwitchGeneration;
    // Quiet RPC — toast popups on every switch feel like UI jitter.
    const result = await this.rpcCommand<{
      sessionFile?: string;
      entries?: SessionEntry[];
      cancelled?: boolean;
      error?: string;
    }>({ type: 'switch_session', sessionFile }, '', true);
    if (!this.isCurrentSessionSwitch(generation, sessionFile)) return;
    if (!result.success || result.data?.cancelled) {
      appStore.update({ sessionSwitching: false });
      throw new Error(result.error || result.data?.error || 'Pi 未能恢复该会话');
    }
    const resumed = result.data?.sessionFile || sessionFile;
    if (!this.isCurrentSessionSwitch(generation, sessionFile)) return;
    appStore.update({ selectedSessionFile: resumed, activeSessionFile: resumed });
    this.selectedSessionLiveOnly = false;
    if (result.data?.entries?.length) {
      // Replace only when resume provides authoritative history.
      this.applyHistory(result.data.entries);
    } else if (!options.keepExistingHistory) {
      this.transport.send({ type: 'mirror_sync_request' });
      appStore.update({ sessionSwitching: false });
    } else {
      appStore.update({ sessionSwitching: false });
    }
  }

  private async sendPrompt(command: Record<string, unknown>): Promise<void> {
    const state = appStore.getSnapshot();
    if (
      state.selectedSessionFile &&
      state.selectedSessionFile !== state.activeSessionFile &&
      !this.selectedSessionLiveOnly
    ) {
      await this.resumeSession(state.selectedSessionFile);
    }
    const request = {
      ...command,
      id: uniqueId('pi-ui'),
      streamingBehavior: 'followUp',
    };
    if (!this.transport.send(request)) throw new Error('PiCode 尚未连接到 Pi');
  }

  private async flushQueue(): Promise<void> {
    const next = appStore.getSnapshot().queue[0];
    if (!next || appStore.getSnapshot().isStreaming) return;
    this.cancelQueuedMessage(next.id);
    await this.sendMessage(next.message, next.images || []);
  }

  async loadModels(options: { tryRefresh?: boolean } = {}): Promise<void> {
    const [models, state] = await Promise.all([
      this.rpcCommand<ModelsResponse>({ type: 'get_available_models' }, '', true),
      this.rpcCommand<StateResponse>({ type: 'get_state' }, '', true),
    ]);
    const available = models.success ? models.data?.models || [] : [];
    if (available.length === 0 && options.tryRefresh !== false) {
      const commands = await this.rpcCommand<{ commands?: SlashCommand[] }>(
        { type: 'get_commands' },
        '',
        true,
      );
      const canRefresh = commands.success && commands.data?.commands?.some(
        (command) => command.name === 'refresh-models' || command.name === '/refresh-models',
      );
      if (canRefresh) {
        const refreshed = await this.rpcCommand(
          { type: 'prompt', message: '/refresh-models' },
          '',
          true,
        );
        if (refreshed.success) {
          await new Promise((resolve) => window.setTimeout(resolve, 150));
          return this.loadModels({ tryRefresh: false });
        }
      }
    }
    const current = state.success ? resolveModel(state.data?.model, available) : null;
    const previous = appStore.getSnapshot();
    const currentId = knownModelValue(current?.id) || knownModelValue(previous.currentModelId) || knownModelValue(previous.defaultModel);
    const availableCurrent = available.find((model) => model.id === currentId && (!previous.defaultProvider || model.provider === previous.defaultProvider))
      || available.find((model) => model.id === currentId);
    const currentProvider = knownModelValue(current?.provider) || knownModelValue(availableCurrent?.provider) || knownModelValue(previous.currentModelProvider) || knownModelValue(previous.defaultProvider);
    appStore.update({
      models: available,
      currentModelId: currentId || modelIdFromValue(state.data?.model),
      currentModelProvider: currentProvider,
      thinkingLevel: state.data?.thinkingLevel || previous.thinkingLevel,
      thinkingSupported: modelSupportsThinking(availableCurrent || current),
      contextWindowSize:
        availableCurrent?.contextWindow || availableCurrent?.context_window || current?.contextWindow || current?.context_window || previous.contextWindowSize,
    });
  }

  private async ensureDefaultPiSession(): Promise<PiInstance | null> {
    appStore.update({ connection: 'connecting' });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const instances = await fetchRunningInstances();
      if (instances.length > 0 && instances[0]) {
        this.acceptInstance(instances[0], true);
        return instances[0];
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    const instance = await invoke<PiInstance>('ensure_default_pi_session');
    this.acceptInstance(instance, true);
    return instance;
  }

  private async ensureWorkspaceForSession(
    session: PiSession,
    project: SessionProject | null,
  ): Promise<void> {
    if (!isDesktop) return;
    const state = appStore.getSnapshot();
    const noFolder = Boolean(session.noFolder || project?.noFolder);
    const path = session.cwd || project?.path || '';
    if (!noFolder && !path) return;

    // If Pi was stopped (e.g. after an update), launch it for this workspace.
    if (!state.hasActivePiSession || state.connection === 'idle' || state.connection === 'disconnected') {
      if (noFolder) await this.launchNoFolder();
      else await this.launchProject(path);
      return;
    }

    if (state.workspace.noFolder === noFolder && (noFolder || samePath(state.workspace.path, path))) return;
    const result = await postJson<LaunchResponse>(
      '/api/projects/launch',
      noFolder ? { noFolder: true } : { path },
    );
    if (!result.ok || !result.instance) throw new Error(result.error || '工作区切换失败');
    this.acceptInstance(result.instance, false);
    this.transport.forceReconnect();
  }

  private acceptInstance(instance: PiInstance, resetSession: boolean): void {
    const transport = instanceTransport(instance);
    window.tauDesktop.setTransport(transport);
    if (transport === 'rpc') {
      window.tauDesktop.setInstancePort(null);
      window.tauDesktop.setInstanceId(instance.pid || null);
      this.transport.setTarget('pi-rpc://desktop');
    } else if (instance.port) {
      window.tauDesktop.setInstanceId(null);
      window.tauDesktop.setInstancePort(instance.port);
      this.transport.setTarget(`ws://127.0.0.1:${instance.port}/ws`);
    }
    const sessionFile = instance.sessionFile || instance.session_file || null;
    appStore.update((state) => ({
      hasActivePiSession: true,
      connection: 'connected',
      workspace: {
        path: instance.projectPath || instance.project_path || '',
        noFolder: Boolean(instance.noFolder ?? instance.no_folder),
      },
      liveInstances: [instance, ...state.liveInstances.filter((item) => item.pid !== instance.pid)],
      ...(resetSession
        ? {
            selectedSessionFile: sessionFile,
            activeSessionFile: sessionFile,
            selectedSessionTitle: instance.noFolder || instance.no_folder ? '无文件夹会话' : '当前会话',
          }
        : {}),
    }));
  }

  private async refreshWorkspaceFromHealth(): Promise<void> {
    if (!isDesktop) return;
    try {
      const data = await apiJson<{ pi?: PiInstance }>('/api/health');
      if (data.pi) this.acceptInstance(data.pi, false);
    } catch {
      // Connection status already communicates failure.
    }
  }

  private async pollInstances(): Promise<void> {
    const instances = await fetchRunningInstances();
    appStore.update({ liveInstances: instances });
  }

  private refreshSessionsSoon(delay: number): void {
    if (this.sessionRefreshTimer != null) window.clearTimeout(this.sessionRefreshTimer);
    this.sessionRefreshTimer = window.setTimeout(() => {
      this.sessionRefreshTimer = null;
      // Background refresh — never flash the sidebar loading skeleton.
      void this.loadSessions({ silent: true });
    }, delay);
  }

  private appendMessage(
    role: 'user' | 'assistant' | 'system' | 'error',
    content: string,
    options: {
      id?: string;
      thinking?: string;
      images?: ImageAttachment[];
      usage?: Usage;
      streaming?: boolean;
      history?: boolean;
    } = {},
  ): string {
    const id = options.id || uniqueId(role);
    const item: TimelineItem = {
      id,
      kind: 'message',
      message: { id, role, content, ...options },
    };
    appStore.update((state) => ({ timeline: [...state.timeline, item] }));
    return id;
  }

  private appendWelcome(): void {
    this.appendMessage('system', '__PI_STUDIO_WELCOME__', { id: uniqueId('welcome') });
  }

  private addWelcome(): void {
    if (appStore.getSnapshot().timeline.length === 0) this.appendWelcome();
  }

  private removeWelcome(): void {
    appStore.update((state) => ({
      timeline: state.timeline.filter(
        (item) => item.kind !== 'message' || item.message.content !== '__PI_STUDIO_WELCOME__',
      ),
    }));
  }

  private resetConversationWithWelcome(): void {
    appStore.resetConversation();
    appStore.update({
      selectedSessionFile: null,
      selectedSessionTitle: '',
      sessionSwitching: false,
    });
    this.appendWelcome();
  }

  private addError(message: string): void {
    this.appendMessage('error', message || '未知错误');
  }

  private updateMessage(id: string, patch: Partial<RenderedMessage>): void {
    appStore.update((state) => ({
      timeline: state.timeline.map((item) =>
        item.id === id && item.kind === 'message'
          ? { ...item, message: { ...item.message, ...patch } }
          : item,
      ),
    }));
  }

  private removeTimelineItem(id: string): void {
    appStore.update((state) => ({ timeline: state.timeline.filter((item) => item.id !== id) }));
  }

  private upsertTool(tool: ToolExecution): void {
    appStore.update((state) => ({
      timeline: state.timeline.some(
        (item) => item.kind === 'tool' && item.tool.toolCallId === tool.toolCallId,
      )
        ? state.timeline.map((item) =>
            item.kind === 'tool' && item.tool.toolCallId === tool.toolCallId
              ? { ...item, tool: { ...item.tool, ...tool } }
              : item,
          )
        : [...state.timeline, { id: tool.toolCallId, kind: 'tool', tool }],
    }));
  }

  /** Fallback for transports that only expose tool calls in assistant messages. */
  private recordMessageToolCalls(message?: PiMessage): void {
    for (const call of getMessageToolCalls(message)) {
      const existing = appStore.getSnapshot().timeline.find(
        (item) => item.kind === 'tool' && item.tool.toolCallId === call.id,
      );
      this.upsertTool({
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
        // Do not replace a completed event-driven card when the assistant
        // message arrives late; this path only fills the event-stream gap.
        status: existing?.kind === 'tool' ? existing.tool.status : 'streaming',
        output: existing?.kind === 'tool' ? existing.tool.output : '',
        isError: existing?.kind === 'tool' ? existing.tool.isError : undefined,
      });
    }
  }

  private updateTool(id: string, patch: Partial<ToolExecution>): void {
    if (!id) return;
    appStore.update((state) => ({
      timeline: state.timeline.map((item) =>
        item.kind === 'tool' && item.tool.toolCallId === id
          ? { ...item, tool: { ...item.tool, ...patch } }
          : item,
      ),
    }));
  }

  private rememberUsage(usage?: Usage): void {
    if (!usage) return;
    appStore.update((state) => ({
      lastUsage: totalContextTokens(usage) > 0 ? usage : state.lastUsage,
      sessionTotalCost: state.sessionTotalCost + (usage.cost?.total || 0),
    }));
  }

  private async installDesktopListeners(): Promise<void> {
    if (!isDesktop) return;
    this.unlisten.push(
      await listen<string>('pi-studio-command', ({ payload }) => {
        if (payload === 'show-launcher') this.setView('projects');
        else if (payload === 'new-session') void this.newSession();
        else if (payload === 'open-settings') this.setView('settings');
      }),
      await listen<{ status?: string; instance?: PiInstance; error?: string }>(
        'tau-pi-status',
        ({ payload }) => {
          if (payload?.status === 'running') {
            if (payload.instance) this.acceptInstance(payload.instance, false);
            appStore.update({ hasActivePiSession: true, connection: 'connected', view: 'chat' });
            this.transport.forceReconnect();
            this.refreshSessionsSoon(300);
          } else if (payload?.status === 'error') {
            window.tauDesktop.setInstanceId(null);
            window.tauDesktop.setInstancePort(null);
            appStore.update({
              hasActivePiSession: false,
              connection: 'idle',
              view: 'projects',
              projectError: payload.error || 'Pi 自动启动失败',
              liveInstances: [],
            });
          } else if (payload?.status === 'exited') {
            window.tauDesktop.setInstanceId(null);
            window.tauDesktop.setInstancePort(null);
            appStore.update({
              hasActivePiSession: false,
              connection: 'disconnected',
              view: 'projects',
              liveInstances: [],
              activeSessionFile: null,
            });
            this.addError('Pi 进程已退出，请打开“项目”重新启动。');
          }
        },
      ),
    );
  }
}

export const controller = new PiStudioController();
