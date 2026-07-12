export type TransportKind = 'rpc' | 'mirror';
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type WorkspaceView = 'chat' | 'projects' | 'extensions' | 'settings';
export type ThemeId = 'dark' | 'light';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | string;

export interface ImageAttachment {
  type?: 'image';
  data: string;
  mimeType: string;
}

export interface FileAttachment {
  path: string;
  name: string;
  ext: string;
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ThinkingContentBlock {
  type: 'thinking';
  thinking: string;
}

export interface ImageContentBlock {
  type: 'image';
  data?: string;
  mime_type?: string;
  source?: { data?: string; media_type?: string };
}

export interface ToolCallContentBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export type MessageContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ImageContentBlock
  | ToolCallContentBlock
  | { type: string; [key: string]: unknown };

export interface UsageCost {
  total?: number;
  [key: string]: number | undefined;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: UsageCost;
}

export interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'system' | string;
  content: string | MessageContentBlock[];
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface SessionEntry {
  type: string;
  message?: PiMessage;
  [key: string]: unknown;
}

export interface RenderedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  thinking?: string;
  images?: ImageAttachment[];
  usage?: Usage;
  streaming?: boolean;
  history?: boolean;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'streaming' | 'complete' | 'error';
  output: string;
  isError?: boolean;
  history?: boolean;
}

export type TimelineItem =
  | { id: string; kind: 'message'; message: RenderedMessage }
  | { id: string; kind: 'tool'; tool: ToolExecution };

export interface PiSession {
  filePath: string;
  file?: string;
  dirName?: string;
  name?: string;
  firstMessage?: string;
  timestamp?: string | number;
  sessionTimestamp?: string | number;
  mtime?: number;
  cwd?: string;
  noFolder?: boolean;
  live?: boolean;
  fileExists?: boolean;
  tmux?: boolean;
}

export interface SessionProject {
  path?: string;
  dirName?: string;
  displayName?: string;
  noFolder?: boolean;
  sessions: PiSession[];
}

export interface SessionSearchResult {
  filePath: string;
  sessionName?: string;
  firstMessage?: string;
  sessionTimestamp?: string | number;
  project?: string;
  matches: Array<{ snippet?: string }>;
}

export interface ProjectInfo {
  path: string;
  name?: string;
  active?: boolean;
  lastActive?: string | number;
  sessionCount?: number;
}

export interface PiInstance {
  pid?: number;
  port?: number;
  transport?: TransportKind;
  sessionFile?: string;
  session_file?: string;
  projectPath?: string;
  project_path?: string;
  noFolder?: boolean;
  no_folder?: boolean;
  startedAt?: string | number;
  cwd?: string;
}

export interface WorkspaceState {
  path: string;
  noFolder: boolean;
}

export interface ModelInfo {
  id: string;
  modelId?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  context_window?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
}

export interface RpcResponse<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PiExtensionInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: string;
  source: string;
  sourcePath: string;
  installed: boolean;
  installedPath?: string;
  requiresDependencies: boolean;
}

export interface PiExtensionsCatalog {
  installDir: string;
  catalogRoots: string[];
  extensions: PiExtensionInfo[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory?: boolean;
  is_dir?: boolean;
  size?: number;
  modified?: string | number;
  children?: FileEntry[];
}

export interface FileContent {
  path: string;
  name?: string;
  content?: string;
  mimeType?: string;
  language?: string;
  size?: number;
  binary?: boolean;
  truncated?: boolean;
  unsupportedReason?: string;
}

export interface DesktopSettings {
  tauPort?: number;
  [key: string]: unknown;
}

export interface PiRuntimeInfo {
  source?: string;
  bundled?: boolean;
  piVersion?: string;
  nodeVersion?: string;
  platform?: string;
  command?: string;
  error?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  canUpdateSystem?: boolean;
  canUpdateBundled?: boolean;
  updateChannel?: 'bundled' | 'system' | 'override' | 'web' | string;
}

export interface PiUpdateResult {
  ok: boolean;
  message: string;
  previousVersion?: string;
  newVersion?: string;
  channel?: string;
  log?: string;
}

export interface ModelsProviderModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<'text' | 'image' | string>;
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface ModelsProviderCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  [key: string]: unknown;
}

export interface ModelsProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: ModelsProviderCompat;
  models?: ModelsProviderModel[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsConfig {
  providers: Record<string, ModelsProviderConfig>;
  [key: string]: unknown;
}

export interface ModelsConfigResponse {
  path: string;
  exists: boolean;
  config: ModelsConfig;
}


export interface ToastMessage {
  id: string;
  title: string;
  message?: string;
  type?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

export interface ExtensionUiRequest {
  id?: string;
  requestId?: string;
  method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | string;
  title?: string;
  message?: string;
  prompt?: string;
  options?: Array<string | { label: string; value: unknown }>;
  value?: string;
  defaultValue?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface TransportEnvelope {
  type: string;
  event?: RpcEvent;
  message?: string;
  entries?: SessionEntry[];
  sessionFile?: string;
  model?: ModelInfo | string;
  thinkingLevel?: ThinkingLevel;
  [key: string]: unknown;
}

export interface RpcEvent {
  type: string;
  message?: PiMessage;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    content?: string;
    partial?: PiMessage;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  method?: ExtensionUiRequest['method'];
  name?: string;
  summary?: string;
  error?: string;
  [key: string]: unknown;
}

/** Slash command shown in composer autocomplete (mirrors Pi CLI `/` menu). */
export interface SlashCommand {
  name: string;
  description: string;
  /** builtin | extension | prompt | skill */
  source?: 'builtin' | 'extension' | 'prompt' | 'skill' | string;
  argumentHint?: string;
}

export interface AppSnapshot {
  view: WorkspaceView;
  connection: ConnectionStatus;
  isStreaming: boolean;
  hasActivePiSession: boolean;
  workspace: WorkspaceState;
  selectedSessionFile: string | null;
  selectedSessionTitle: string;
  activeSessionFile: string | null;
  timeline: TimelineItem[];
  sessionProjects: SessionProject[];
  sessionSearchResults: SessionSearchResult[];
  sessionsLoading: boolean;
  /** True while a session switch is loading history / resuming Pi. */
  sessionSwitching: boolean;
  projects: ProjectInfo[];
  projectsLoading: boolean;
  projectError: string;
  projectBusyPath: string | null;
  noFolderActive: boolean;
  liveInstances: PiInstance[];
  models: ModelInfo[];
  currentModelId: string;
  thinkingLevel: ThinkingLevel;
  thinkingSupported: boolean;
  contextWindowSize: number;
  lastUsage: Usage | null;
  sessionTotalCost: number;
  queue: Array<{ id: string; message: string; images?: ImageAttachment[] }>;
  slashCommands: SlashCommand[];
  modelsConfig: ModelsConfig | null;
  modelsConfigPath: string;
  modelsConfigLoading: boolean;
  modelsConfigSaving: boolean;
  modelsConfigError: string;
  piUpdating: boolean;
  piUpdateMessage: string;
  extensions: PiExtensionsCatalog | null;
  extensionsLoading: boolean;
  extensionError: string;
  extensionInstallingId: string | null;
  settings: DesktopSettings | null;
  runtimeInfo: PiRuntimeInfo | null;
  autostartEnabled: boolean;
  autoCompactionEnabled: boolean;
  showThinking: boolean;
  authConfigured: boolean;
  authEnabled: boolean;
  extensionUiRequest: ExtensionUiRequest | null;
}
