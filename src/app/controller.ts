import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { apiJson, isDesktop, postJson } from '../lib/desktop';
import { initialTransportUrl, PiTransport } from '../lib/transport';
import type {
  DesktopSettings,
  ExtensionUiRequest,
  ImageAttachment,
  ModelInfo,
  PiExtensionInfo,
  PiExtensionsCatalog,
  PiInstance,
  PiMessage,
  PiRuntimeInfo,
  PiSession,
  RpcEvent,
  RpcResponse,
  RenderedMessage,
  SessionEntry,
  SessionProject,
  SessionSearchResult,
  TimelineItem,
  ToolExecution,
  TransportEnvelope,
  Usage,
  WorkspaceView,
} from '../lib/types';
import {
  basename,
  formatToolOutput,
  getMessageText,
  getMessageThinking,
  modelIdFromValue,
  normalizeMessageText,
  samePath,
  totalInputTokens,
  uniqueId,
} from '../lib/utils';
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
    if (view === 'settings') void this.loadSettings();
    if (view === 'extensions') void this.loadExtensions();
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
          request: { title: 'pi-studio', body: 'Pi 已启动，工作台连接成功。' },
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
      notify('桌面端功能', '添加本地项目仅在 pi-studio 桌面应用中可用。');
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
      appStore.update({ selectedSessionFile: null, selectedSessionTitle: '' });
      this.resetConversationWithWelcome();
      return;
    }

    // Skip no-op reselect to avoid timeline flash.
    if (session.filePath && session.filePath === appStore.getSnapshot().selectedSessionFile) {
      return;
    }

    appStore.update({
      selectedSessionFile: session.filePath,
      selectedSessionTitle: session.name || session.firstMessage || session.file || '当前会话',
      sessionTotalCost: 0,
      lastUsage: null,
      isStreaming: false,
      queue: [],
    });
    this.selectedSessionLiveOnly = Boolean(session.live && session.fileExists === false);

    try {
      await this.ensureWorkspaceForSession(session, project);
      await this.switchSession(session, project);
    } catch (error) {
      this.addError(`切换会话失败：${String(error)}`);
    }
  }

  async newSession(): Promise<void> {
    const state = appStore.getSnapshot();
    if (this.isMirrorMode || state.hasActivePiSession) {
      const result = await this.rpcCommand<{ sessionFile?: string; entries?: SessionEntry[]; cancelled?: boolean }>(
        { type: 'new_session' },
        '正在创建新会话…',
      );
      if (!result.success || result.data?.cancelled) {
        throw new Error(result.error || 'Pi 未能创建新会话');
      }
      const sessionFile = result.data?.sessionFile || null;
      appStore.update({
        selectedSessionFile: sessionFile,
        activeSessionFile: sessionFile,
        selectedSessionTitle: '新会话',
        sessionTotalCost: 0,
        lastUsage: null,
        timeline: [],
        view: 'chat',
      });
      this.selectedSessionLiveOnly = false;
      this.renderHistory(result.data?.entries || []);
      if ((result.data?.entries || []).length === 0) this.addWelcome();
      this.transport.send({ type: 'mirror_sync_request' });
      this.refreshSessionsSoon(300);
      return;
    }
    this.resetConversationWithWelcome();
  }

  async sendMessage(message: string, images: ImageAttachment[] = []): Promise<void> {
    const text = message.trim();
    if (!text && images.length === 0) return;
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

  async showSessionStats(): Promise<void> {
    const result = await this.rpcCommand<Record<string, unknown>>(
      { type: 'get_session_stats' },
      '正在读取会话统计…',
    );
    if (!result.success || !result.data) return;
    const stats = result.data;
    const tokens = stats.tokens as { input?: number } | undefined;
    const lines = [
      '会话统计',
      `消息：${stats.totalMessages || 0} 条（用户 ${stats.userMessages || 0}，助手 ${stats.assistantMessages || 0}）`,
      `工具调用：${stats.toolCalls || 0} 次`,
    ];
    if (tokens?.input) lines.push(`上下文：约 ${(tokens.input / 1000).toFixed(1)}k Token`);
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
    } else {
      appStore.update({
        runtimeInfo: {
          source: 'web',
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
    this.refreshSessionsSoon(300);
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
      this.currentStreamingId = this.appendMessage('assistant', '', { streaming: true });
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

  private handleMessageUpdate(event: RpcEvent): void {
    const update = event.assistantMessageEvent;
    if (!update) return;
    if (!this.currentStreamingId) {
      this.currentStreamingText = getMessageText(update.partial);
      this.currentStreamingThinking = getMessageThinking(update.partial);
      this.currentStreamingId = this.appendMessage('assistant', this.currentStreamingText, {
        streaming: true,
        thinking: this.currentStreamingThinking,
      });
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
    this.updateMessage(this.currentStreamingId, {
      content: this.currentStreamingText,
      thinking: this.currentStreamingThinking,
      streaming: true,
    });
  }

  private handleMessageEnd(message?: PiMessage): void {
    if (!message) return;
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
    const selectedFile = state.selectedSessionFile || activeFile;
    appStore.update({ activeSessionFile: activeFile, selectedSessionFile: selectedFile });

    const model = resolveModel(snapshot.model, appStore.getSnapshot().models);
    if (model) {
      appStore.update({
        currentModelId: model.id,
        thinkingSupported: modelSupportsThinking(model),
        contextWindowSize: model.contextWindow || model.context_window || state.contextWindowSize,
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
      const sameLength = current.length === next.timeline.length;
      const sameTail =
        sameLength &&
        (current.length === 0 ||
          (current[current.length - 1]?.id === next.timeline[next.timeline.length - 1]?.id &&
            current[0]?.id === next.timeline[0]?.id));
      if (!sameTail) appStore.update(next);
    } else if (!hasPending && !state.isStreaming && state.timeline.length === 0) {
      this.addWelcome();
    }
    this.refreshSessionsSoon(300);
  }

  private renderHistory(entries: SessionEntry[]): void {
    appStore.update(buildHistoryTimeline(entries));
  }

  private async switchSession(session: PiSession, project: SessionProject | null): Promise<void> {
    this.currentStreamingId = null;
    this.currentStreamingText = '';
    this.currentStreamingThinking = '';
    this.pendingPrompts = [];

    // Prefer a single timeline replace. Avoid empty flash when possible.
    let loadedFromFile = false;
    const canLoad = !session.live || session.fileExists !== false;
    if (canLoad && project?.dirName && session.file) {
      try {
        const history = await apiJson<{ entries?: SessionEntry[] }>(
          `/api/sessions/${encodeURIComponent(project.dirName)}/${encodeURIComponent(session.file)}`,
        );
        this.renderHistory(history.entries || []);
        loadedFromFile = true;
      } catch (error) {
        appStore.update({ timeline: [] });
        this.addError(`会话加载失败：${String(error)}`);
      }
    } else {
      appStore.update({ timeline: [] });
      this.addWelcome();
    }

    const activeFile = appStore.getSnapshot().activeSessionFile;
    if (session.live && session.fileExists === false) {
      appStore.update({ activeSessionFile: session.filePath });
      this.selectedSessionLiveOnly = true;
      this.transport.send({ type: 'mirror_sync_request' });
    } else if (session.filePath === activeFile) {
      // Already the live session — request sync only if file history was empty.
      if (!loadedFromFile || appStore.getSnapshot().timeline.length === 0) {
        this.transport.send({ type: 'mirror_sync_request' });
      }
    } else if (session.filePath) {
      await this.resumeSession(session.filePath, { keepExistingHistory: loadedFromFile });
    }
  }

  private async resumeSession(
    sessionFile: string,
    options: { keepExistingHistory?: boolean } = {},
  ): Promise<void> {
    // Quiet RPC — toast popups on every switch feel like UI jitter.
    const result = await this.rpcCommand<{
      sessionFile?: string;
      entries?: SessionEntry[];
      cancelled?: boolean;
      error?: string;
    }>({ type: 'switch_session', sessionFile }, '', true);
    if (!result.success || result.data?.cancelled) {
      throw new Error(result.error || result.data?.error || 'Pi 未能恢复该会话');
    }
    const resumed = result.data?.sessionFile || sessionFile;
    appStore.update({ selectedSessionFile: resumed, activeSessionFile: resumed });
    this.selectedSessionLiveOnly = false;
    if (result.data?.entries?.length) {
      // Replace only when resume provides authoritative history.
      this.renderHistory(result.data.entries);
    } else if (!options.keepExistingHistory) {
      this.transport.send({ type: 'mirror_sync_request' });
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
    if (!this.transport.send(request)) throw new Error('pi-studio 尚未连接到 Pi');
  }

  private async flushQueue(): Promise<void> {
    const next = appStore.getSnapshot().queue[0];
    if (!next || appStore.getSnapshot().isStreaming) return;
    this.cancelQueuedMessage(next.id);
    await this.sendMessage(next.message, next.images || []);
  }

  private async loadModels(): Promise<void> {
    const [models, state] = await Promise.all([
      this.rpcCommand<ModelsResponse>({ type: 'get_available_models' }, '', true),
      this.rpcCommand<StateResponse>({ type: 'get_state' }, '', true),
    ]);
    const available = models.success ? models.data?.models || [] : [];
    const current = state.success ? resolveModel(state.data?.model, available) : null;
    appStore.update({
      models: available,
      currentModelId: current?.id || modelIdFromValue(state.data?.model),
      thinkingLevel: state.data?.thinkingLevel || appStore.getSnapshot().thinkingLevel,
      thinkingSupported: modelSupportsThinking(current),
      contextWindowSize:
        current?.contextWindow || current?.context_window || appStore.getSnapshot().contextWindowSize,
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
    const state = appStore.getSnapshot();
    if (!isDesktop || !state.hasActivePiSession) return;
    const noFolder = Boolean(session.noFolder || project?.noFolder);
    const path = session.cwd || project?.path || '';
    if (!noFolder && !path) return;
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

  private resetConversationWithWelcome(): void {
    appStore.resetConversation();
    appStore.update({ selectedSessionFile: null, selectedSessionTitle: '' });
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
      timeline: [...state.timeline, { id: tool.toolCallId, kind: 'tool', tool }],
    }));
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
      lastUsage: totalInputTokens(usage) > 0 ? usage : state.lastUsage,
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
            appStore.update({
              hasActivePiSession: false,
              connection: 'idle',
              view: 'projects',
              projectError: payload.error || 'Pi 自动启动失败',
            });
          } else if (payload?.status === 'exited') {
            appStore.update({ hasActivePiSession: false, connection: 'disconnected', view: 'projects' });
            this.addError('Pi 进程已退出，请打开“项目”重新启动。');
          }
        },
      ),
    );
  }
}

export const controller = new PiStudioController();
