import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSnapshot,
  ModelsConfig,
  ModelsProviderConfig,
  ModelsProviderModel,
  PiExtensionInfo,
  ProjectInfo,
  ThemeId,
} from '../lib/types';
import { basename, formatRelativeTime } from '../lib/utils';
import { applyTheme, getCurrentTheme, themes } from '../lib/theme';
import { controller } from '../app/controller';
import { Icon } from './Icon';
import { DEFAULT_REASONING_PROFILE, migrateReasoningConfig, PI_REASONING_LEVELS, REASONING_UI_LABELS } from '../lib/reasoning';

const API_OPTIONS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

const THINKING_LEVELS = [
  ['off', '关闭'],
  ['minimal', '极简'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '最高'],
] as const;

const THINKING_LABELS: Record<string, string> = { off: '关闭', minimal: '极简', low: '较低', medium: '中等', high: '较高', xhigh: '最高', max: '最高' };

function emptyProvider(): ModelsProviderConfig {
  return {
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
    models: [],
    // This is an explicit preset attached to a newly-created OpenAI-compatible
    // provider; no model receives it until the user selects it on that model.
    reasoningProfiles: {
      'openai-gpt': structuredClone(DEFAULT_REASONING_PROFILE),
    },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function cloneConfig(config: ModelsConfig | null | undefined): ModelsConfig {
  return migrateReasoningConfig(JSON.parse(JSON.stringify(config || { providers: {} })) as ModelsConfig);
}

function configSignature(config: ModelsConfig | null | undefined): string {
  try {
    return JSON.stringify(config || { providers: {} });
  } catch {
    return '';
  }
}

function maskApiKey(value?: string): string {
  if (!value) return '未配置';
  if (value.startsWith('!') || value.startsWith('$')) return value;
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export function ProjectsView({ snapshot }: { snapshot: AppSnapshot }) {
  const [query, setQuery] = useState('');
  const projects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...snapshot.projects]
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return Number(right.lastActive || 0) - Number(left.lastActive || 0);
      })
      .filter((project) => !normalized || `${project.name || ''} ${project.path}`.toLowerCase().includes(normalized));
  }, [query, snapshot.projects]);

  const openProject = (project: ProjectInfo) => {
    if (project.active) controller.returnToChat();
    else void controller.launchProject(project.path);
  };

  return (
    <section className="launcher workspace-view" aria-label="项目">
      <div className="launcher-content">
        <div className="launcher-title-row">
          <div className="launcher-heading">
            <span className="eyebrow">工作区</span>
            <h2 className="launcher-title">项目</h2>
            <p className="launcher-subtitle">选择一个项目启动 Pi，或进入无文件夹模式直接开始。</p>
          </div>
          <div className="launcher-title-actions">
            <button className="launcher-action" type="button" onClick={() => snapshot.noFolderActive ? controller.returnToChat() : void controller.launchNoFolder()}>无文件夹模式</button>
            <button className="launcher-action primary" type="button" onClick={() => void controller.addProject()}>添加项目</button>
            {snapshot.hasActivePiSession ? <button className="launcher-close" type="button" title="返回聊天" aria-label="返回聊天" onClick={() => controller.returnToChat()}><Icon name="close" width={15} height={15} /></button> : null}
          </div>
        </div>
        {snapshot.projectError ? <div className="launcher-error">{snapshot.projectError}</div> : null}
        <label className="launcher-search">
          <Icon name="search" width={15} height={15} />
          <input type="search" placeholder="搜索项目名称或路径" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="launcher-grid">
          {!query || '无文件夹 no folder'.includes(query.toLowerCase()) ? (
            <article className={`launcher-card no-folder${snapshot.noFolderActive ? ' active' : ''}`}>
              <div className="launcher-card-icon"><Icon name="plus" width={20} height={20} /></div>
              <div className="launcher-card-main">
                <div className="launcher-card-name">无文件夹模式 {snapshot.noFolderActive ? <span className="launcher-live">运行中</span> : null}</div>
                <div className="launcher-card-path">使用 pi-studio 专属目录，不关联本地项目</div>
                <div className="launcher-card-meta"><span>适合快速提问和临时任务</span></div>
              </div>
              <div className="launcher-card-actions">
                <button className="launcher-card-open" type="button" disabled={Boolean(snapshot.projectBusyPath)} onClick={() => snapshot.noFolderActive ? controller.returnToChat() : void controller.launchNoFolder()}>
                  {snapshot.projectBusyPath === '__no_folder__' ? '正在启动…' : snapshot.noFolderActive ? '返回会话' : '打开'}
                </button>
              </div>
            </article>
          ) : null}
          {projects.map((project) => (
            <article className={`launcher-card${project.active ? ' active' : ''}`} key={project.path} onClick={() => openProject(project)}>
              <div className="launcher-card-icon"><Icon name="folder" width={20} height={20} /></div>
              <div className="launcher-card-main">
                <div className="launcher-card-name">{project.name || basename(project.path) || '未命名项目'} {project.active ? <span className="launcher-live">运行中</span> : null}</div>
                <div className="launcher-card-path" title={project.path}>{project.path}</div>
                <div className="launcher-card-meta"><span>{Number(project.sessionCount || 0)} 个会话</span><span>{formatRelativeTime(project.lastActive) || '尚未使用'}</span></div>
              </div>
              <div className="launcher-card-actions">
                <button className="launcher-window-btn" type="button" title="在新窗口打开" disabled={Boolean(snapshot.projectBusyPath)} onClick={(event) => { event.stopPropagation(); void controller.openProjectWindow(project.path); }}><Icon name="external" width={13} height={13} /></button>
                <button className="launcher-card-open" type="button" disabled={Boolean(snapshot.projectBusyPath)} onClick={(event) => { event.stopPropagation(); openProject(project); }}>
                  {snapshot.projectBusyPath === project.path ? '正在启动…' : project.active ? '返回会话' : '打开'}
                </button>
              </div>
            </article>
          ))}
          {!snapshot.projectsLoading && projects.length === 0 && query ? <div className="launcher-empty"><strong>没有匹配的项目</strong><p className="hint">尝试搜索其他名称或路径。</p></div> : null}
          {snapshot.projectsLoading ? <div className="launcher-loading">正在加载项目…</div> : null}
        </div>
      </div>
    </section>
  );
}

function gitChangeLabel(indexStatus: string, worktreeStatus: string): string {
  const status = `${indexStatus}${worktreeStatus}`;
  if (status.includes('A') || status === '??') return '新增';
  if (status.includes('D')) return '删除';
  if (status.includes('R')) return '重命名';
  return '修改';
}

export function ChangesView({ snapshot }: { snapshot: AppSnapshot }) {
  const git = snapshot.gitStatus;
  const selected = snapshot.selectedGitPath;
  const changeCount = git?.changes.length || 0;
  return (
    <section className="changes-panel workspace-view">
      <div className="settings-header changes-header">
        <div className="settings-header-copy">
          <span className="eyebrow">工作区</span>
          <div className="settings-title-row">
            <h3>Git 变更</h3>
            <button className="settings-close" type="button" aria-label="关闭变更中心" onClick={() => controller.returnToChat()}><Icon name="close" width={16} height={16} /></button>
          </div>
          <p className="settings-subtitle">查看当前项目的未提交改动；此处不会修改仓库。</p>
        </div>
        <button className="settings-action-btn" type="button" onClick={() => void controller.loadGitStatus()} disabled={snapshot.gitLoading}>
          {snapshot.gitLoading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {snapshot.gitError ? <div className="changes-notice error">{snapshot.gitError}</div> : null}
      {!snapshot.gitLoading && !snapshot.gitError && git && !git.isRepository ? <div className="changes-notice">当前文件夹不是 Git 仓库。</div> : null}
      {git?.isRepository ? (
        <div className="changes-workbench">
          <aside className="changes-file-list">
            <div className="changes-summary">
              <span className="changes-branch">{git.branch || 'HEAD'}</span>
              <span>{changeCount ? `${changeCount} 个文件有改动` : '工作区干净'}</span>
            </div>
            {git.changes.length ? git.changes.map((change) => (
              <button className={`change-file${selected === change.path ? ' active' : ''}`} key={change.path} type="button" onClick={() => void controller.selectGitChange(change.path)}>
                <span className={`change-status ${gitChangeLabel(change.indexStatus, change.worktreeStatus)}`}>{gitChangeLabel(change.indexStatus, change.worktreeStatus)}</span>
                <span className="change-file-copy"><strong>{change.path}</strong>{change.originalPath ? <small>{change.originalPath} → {change.path}</small> : null}</span>
              </button>
            )) : <div className="changes-empty">没有未提交的改动。</div>}
          </aside>
          <article className="changes-diff-panel">
            {!selected ? <div className="changes-empty">选择左侧文件以查看 diff。</div> : null}
            {snapshot.gitDiffLoading ? <div className="changes-empty">正在读取 diff…</div> : null}
            {selected && !snapshot.gitDiffLoading && snapshot.gitDiff ? (
              <>
                <div className="changes-diff-header"><strong>{snapshot.gitDiff.path}</strong><span>相对 HEAD</span></div>
                <pre className="changes-diff">{snapshot.gitDiff.diff || '新建的未跟踪文件或二进制文件没有可展示的文本 diff。'}</pre>
              </>
            ) : null}
          </article>
        </div>
      ) : null}
    </section>
  );
}

function Toggle({ enabled, label, onChange, disabled = false }: { enabled: boolean; label: string; onChange(value: boolean): void; disabled?: boolean }) {
  return <button className={`settings-toggle${enabled ? ' on' : ''}`} type="button" aria-label={label} aria-pressed={enabled} disabled={disabled} onClick={() => onChange(!enabled)} />;
}

function runtimeSource(snapshot: AppSnapshot): string {
  const info = snapshot.runtimeInfo;
  if (!info) return '正在检查…';
  if (info.bundled) return '应用内置';
  return ({ system: '系统安装', override: '自定义路径', web: 'Web 模式', unknown: '未知' } as Record<string, string>)[info.source || 'unknown'] || info.source || '未知';
}

export function SettingsView({ snapshot }: { snapshot: AppSnapshot }) {
  const [theme, setTheme] = useState<ThemeId>(() => getCurrentTheme());
  const info = snapshot.runtimeInfo;
  const canUpdate = Boolean(info?.canUpdateSystem || info?.canUpdateBundled);
  return (
    <section className="settings-panel workspace-view">
      <div className="settings-header">
        <div className="settings-header-copy">
          <span className="eyebrow">偏好设置</span>
          <div className="settings-title-row">
            <h3>设置</h3>
            <button className="settings-close" type="button" aria-label="关闭设置" onClick={() => controller.returnToChat()}>
              <Icon name="close" width={16} height={16} />
            </button>
          </div>
          <p className="settings-subtitle">外观、权限、模型提供商、Pi 运行时与桌面行为</p>
        </div>
      </div>

      <div className="settings-body">
        <div className="settings-group">
          <div className="settings-group-label">常规</div>
          <div className="settings-grid settings-grid-3">
            <div className="settings-section">
              <div className="settings-section-title">外观</div>
              <div className="theme-grid">
                {(Object.entries(themes) as Array<[ThemeId, (typeof themes)[ThemeId]]>).map(([id, value]) => (
                  <button
                    className={`theme-swatch${theme === id ? ' active' : ''}`}
                    data-label={value.name}
                    aria-label={`切换为${value.name}主题`}
                    type="button"
                    key={id}
                    onClick={() => { setTheme(applyTheme(id)); }}
                  >
                    <span className="swatch-colors">
                      {value.colors.map((color) => <span className="swatch-dot" style={{ background: color }} key={color} />)}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">智能体</div>
              <div className="settings-row">
                <span className="settings-label">自动压缩上下文</span>
                <Toggle enabled={snapshot.autoCompactionEnabled} label="自动压缩上下文" onChange={(enabled) => void controller.setAutoCompaction(enabled)} />
              </div>
              <div className="settings-row">
                <span className="settings-label">思考级别</span>
                <button className="settings-value-btn" type="button" disabled={!snapshot.thinkingSupported} onClick={() => void controller.cycleThinking()}>
                  {snapshot.thinkingSupported ? THINKING_LABELS[snapshot.thinkingLevel] || snapshot.thinkingLevel : '不可用'}
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">显示思考过程</span>
                <Toggle enabled={snapshot.showThinking} label="显示思考过程" onChange={(enabled) => controller.setShowThinking(enabled)} />
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">桌面端</div>
              <div className="settings-row">
                <span className="settings-label">开机自动启动</span>
                <Toggle enabled={snapshot.autostartEnabled} label="开机自动启动" disabled={!window.tauDesktop.isTauri} onChange={(enabled) => void controller.setAutostart(enabled)} />
              </div>
              <div className="settings-row">
                <span className="settings-label">连接方式</span>
                <button className="settings-value-btn" type="button" disabled>
                  {!window.tauDesktop.isTauri ? 'Web 模式' : window.tauDesktop.transport === 'mirror' ? String(snapshot.settings?.tauPort || 3001) : '原生 RPC'}
                </button>
              </div>
              {snapshot.authConfigured ? (
                <div className="settings-row">
                  <span className="settings-label">需要登录</span>
                  <Toggle enabled={snapshot.authEnabled} label="需要登录" onChange={(enabled) => void controller.setAuth(enabled)} />
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-label">权限</div>
          <div className="settings-section settings-section-wide">
            <div className="settings-section-title-row">
              <div>
                <div className="settings-section-title">工具执行权限</div>
                <p className="settings-help settings-help-inline">控制 Pi 读取、修改文件和运行命令时的授权方式；变更会立即应用到当前会话。</p>
              </div>
            </div>
            <div className="permission-mode-grid" role="radiogroup" aria-label="Pi 工具执行权限">
              {([
                ['ask', '请求确认', '读取和搜索自动允许；修改文件或执行命令前询问。'],
                ['read-only', '只读', '仅允许读取、搜索和列出文件；阻止修改及命令执行。'],
                ['full-access', '完全访问', '不显示确认，直接执行 Pi 的全部工具操作。'],
              ] as const).map(([mode, title, description]) => {
                const active = (snapshot.settings?.permissionMode || 'ask') === mode;
                return (
                  <button
                    className={`permission-mode-card${active ? ' active' : ''}${mode === 'full-access' ? ' caution' : ''}`}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    key={mode}
                    disabled={!window.tauDesktop.isTauri || !snapshot.settings}
                    onClick={() => void controller.setPermissionMode(mode)}
                  >
                    <span className="permission-mode-title">{title}</span>
                    <span className="permission-mode-description">{description}</span>
                  </button>
                );
              })}
            </div>
            <div className="trust-row">
              <div className="trust-copy">
                <strong>项目可信任</strong>
                <span title={snapshot.workspace.path || undefined}>
                  {snapshot.workspace.noFolder || !snapshot.workspace.path
                    ? '无文件夹会话不加载项目级 .pi 资源。'
                    : '可信任后，Pi 可加载此项目中的 .pi 设置、扩展与技能。'}
                </span>
              </div>
              {snapshot.workspace.noFolder || !snapshot.workspace.path ? null : (() => {
                const trusted = (snapshot.settings?.trustedProjectPaths || []).includes(snapshot.workspace.path);
                return <button className={`settings-action-btn${trusted ? ' danger' : ' primary'}`} type="button" onClick={() => void controller.setProjectTrusted(snapshot.workspace.path, !trusted)}>
                  {trusted ? '撤销可信任' : '信任此项目'}
                </button>;
              })()}
            </div>
            {!snapshot.workspace.noFolder && snapshot.workspace.path ? <p className="settings-help">项目可信任变更会在下次启动该项目的 Pi 会话时生效。</p> : null}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-label">模型</div>
          <ModelsProvidersSection snapshot={snapshot} />
        </div>

        <div className="settings-group">
          <div className="settings-group-label">运行时</div>
          <div className="settings-section settings-section-wide">
            <div className="settings-section-title-row">
              <div>
                <div className="settings-section-title">Pi 运行时</div>
                <p className="settings-help settings-help-inline">检测版本、更新系统安装或内置 sidecar</p>
              </div>
              <div className="settings-section-actions">
                <button className="settings-action-btn" type="button" disabled={!window.tauDesktop.isTauri || snapshot.piUpdating} onClick={() => void controller.checkPiUpdate()}>
                  检查更新
                </button>
                <button className="settings-action-btn primary" type="button" disabled={!window.tauDesktop.isTauri || snapshot.piUpdating || !canUpdate} onClick={() => void controller.updatePiRuntime()}>
                  {snapshot.piUpdating ? '正在更新…' : '更新 Pi'}
                </button>
              </div>
            </div>

            <div className="settings-kv-grid">
              <div className="settings-kv">
                <span className="settings-kv-label">来源</span>
                <span className={`settings-kv-value${info?.bundled || ['system', 'override'].includes(info?.source || '') ? ' ok' : ' warn'}`}>{runtimeSource(snapshot)}</span>
              </div>
              <div className="settings-kv">
                <span className="settings-kv-label">当前版本</span>
                <span className="settings-kv-value">{info?.piVersion || '不可用'}</span>
              </div>
              <div className="settings-kv">
                <span className="settings-kv-label">最新版本</span>
                <span className={`settings-kv-value${info?.updateAvailable ? ' warn' : info?.latestVersion ? ' ok' : ''}`}>
                  {info?.latestVersion || '未检查'}
                  {info?.updateAvailable ? ' · 可更新' : info?.latestVersion ? ' · 已是最新' : ''}
                </span>
              </div>
              <div className="settings-kv">
                <span className="settings-kv-label">Node</span>
                <span className="settings-kv-value">{info?.nodeVersion || '不可用'}</span>
              </div>
              <div className="settings-kv">
                <span className="settings-kv-label">平台</span>
                <span className="settings-kv-value">{info?.platform || '未知'}</span>
              </div>
            </div>

            {info?.command ? <div className="settings-runtime-path" title={info.command}>{info.command}</div> : null}
            {info?.error ? <div className="settings-runtime-warning">{info.error}</div> : null}
            {snapshot.piUpdateMessage ? <div className="settings-runtime-warning">{snapshot.piUpdateMessage}</div> : null}
            <p className="settings-help">更新会停止当前 Pi 会话。系统安装走 npm 全局更新；内置版本会替换 binaries 中的 pi-package。</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ModelsProvidersSection({ snapshot }: { snapshot: AppSnapshot }) {
  const [draft, setDraft] = useState<ModelsConfig>(() => cloneConfig(snapshot.modelsConfig));
  const [editing, setEditing] = useState<string | null>(null);
  const [newProviderName, setNewProviderName] = useState('');
  const [dirty, setDirty] = useState(false);
  const lastSynced = useRef(configSignature(snapshot.modelsConfig));
  const desktop = Boolean(window.tauDesktop.isTauri);

  useEffect(() => {
    const nextSignature = configSignature(snapshot.modelsConfig);
    // Only reset local draft when server content actually changed and the user
    // is not mid-edit — avoids flash/collapse on silent refresh.
    if (nextSignature === lastSynced.current) return;
    if (dirty) return;
    lastSynced.current = nextSignature;
    setDraft(cloneConfig(snapshot.modelsConfig));
  }, [snapshot.modelsConfig, dirty]);

  const providers = useMemo(
    () => Object.entries(draft.providers || {}).sort(([left], [right]) => left.localeCompare(right)),
    [draft.providers],
  );

  if (!desktop) {
    return (
      <div className="settings-section settings-section-wide">
        <div className="settings-section-title">模型提供商</div>
        <p className="settings-help">模型配置（~/.pi/agent/models.json）仅在桌面应用中可管理。</p>
      </div>
    );
  }

  const updateProvider = (name: string, next: ModelsProviderConfig) => {
    setDirty(true);
    setDraft((current) => ({
      ...current,
      providers: {
        ...(current.providers || {}),
        [name]: next,
      },
    }));
  };

  const removeProvider = (name: string) => {
    setDirty(true);
    setDraft((current) => {
      const providers = { ...(current.providers || {}) };
      delete providers[name];
      return { ...current, providers };
    });
    if (editing === name) setEditing(null);
  };

  const addProvider = () => {
    const name = newProviderName.trim();
    if (!name) return;
    if (draft.providers?.[name]) {
      setEditing(name);
      setNewProviderName('');
      return;
    }
    setDirty(true);
    setDraft((current) => ({
      ...current,
      providers: {
        ...(current.providers || {}),
        [name]: emptyProvider(),
      },
    }));
    setEditing(name);
    setNewProviderName('');
  };

  const save = async () => {
    const ok = await controller.saveModelsConfig(draft);
    if (ok) {
      setDirty(false);
      lastSynced.current = configSignature(draft);
    }
  };

  const refresh = async () => {
    // Silent refresh keeps the list mounted; no "loading…" swap.
    await controller.loadModelsConfig({ silent: true });
  };

  return (
    <div className="settings-section settings-section-wide models-section">
      <div className="settings-section-title-row">
        <div>
          <div className="settings-section-title">模型提供商</div>
          <p className="settings-help settings-help-inline">
            编辑 `~/.pi/agent/models.json`，保存后自动刷新可用模型
            {dirty ? ' · 有未保存更改' : ''}
          </p>
        </div>
        <div className="settings-section-actions">
          <button
            className="settings-action-btn"
            type="button"
            onClick={() => void refresh()}
            disabled={snapshot.modelsConfigLoading || snapshot.modelsConfigSaving}
          >
            {snapshot.modelsConfigLoading ? '刷新中…' : '刷新'}
          </button>
          <button className="settings-action-btn" type="button" onClick={() => void controller.openModelsConfig()}>打开文件</button>
          <button className="settings-action-btn primary" type="button" onClick={() => void save()} disabled={snapshot.modelsConfigSaving}>
            {snapshot.modelsConfigSaving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {snapshot.modelsConfigPath ? (
        <div className="settings-meta-chip" title={snapshot.modelsConfigPath}>
          <span className="settings-meta-chip-label">配置文件</span>
          <span className="settings-meta-chip-value">{snapshot.modelsConfigPath}</span>
        </div>
      ) : null}
      {snapshot.modelsConfigError ? <div className="settings-runtime-warning">{snapshot.modelsConfigError}</div> : null}
      {/* First-load only: never blank the list during silent refresh. */}
      {snapshot.modelsConfigLoading && !snapshot.modelsConfig ? (
        <div className="settings-help">正在加载模型配置…</div>
      ) : null}

      <div className="provider-toolbar">
        <input
          className="settings-text-input"
          type="text"
          placeholder="新 provider 名称，例如 ollama"
          value={newProviderName}
          onChange={(event) => setNewProviderName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addProvider();
            }
          }}
        />
        <button className="settings-action-btn" type="button" onClick={addProvider}>添加 Provider</button>
      </div>

      <div className="provider-list">
        {providers.length === 0 ? (
          <div className="settings-empty-state">
            <strong>还没有自定义 provider</strong>
            <p>在上方输入名称添加，例如 ollama、openrouter。</p>
          </div>
        ) : null}
        {providers.map(([name, provider]) => (
          <ProviderCard
            key={name}
            name={name}
            provider={provider}
            thinkingLevel={snapshot.thinkingLevel || 'off'}
            expanded={editing === name}
            onToggle={() => setEditing((current) => (current === name ? null : name))}
            onChange={(next) => updateProvider(name, next)}
            onRemove={() => removeProvider(name)}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({
  name,
  provider,
  thinkingLevel,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  name: string;
  provider: ModelsProviderConfig;
  thinkingLevel: string;
  expanded: boolean;
  onToggle(): void;
  onChange(next: ModelsProviderConfig): void;
  onRemove(): void;
}) {
  const models = provider.models || [];
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testingModelIndex, setTestingModelIndex] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { output?: string; error?: string }>>({});
  const updateModel = (index: number, patch: Partial<ModelsProviderModel>) => {
    const nextModels = models.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model));
    onChange({ ...provider, models: nextModels });
  };
  const removeModel = (index: number) => {
    onChange({ ...provider, models: models.filter((_, modelIndex) => modelIndex !== index) });
  };
  const addModel = () => {
    onChange({
      ...provider,
      models: [...models, { id: '', name: '' }],
    });
  };
  const profiles = provider.reasoningProfiles || {};
  const addProfile = () => {
    let id = 'openai-standard';
    let suffix = 2;
    while (profiles[id]) id = `openai-standard-${suffix++}`;
    onChange({
      ...provider,
      compat: { ...(provider.compat || {}), supportsReasoningEffort: true },
      reasoningProfiles: { ...profiles, [id]: structuredClone(DEFAULT_REASONING_PROFILE) },
    });
  };
  const fetchModels = async () => {
    setFetchingModels(true);
    try {
      const fetched = await controller.fetchProviderModels(provider);
      if (!fetched.length) return;
      const existing = new Set(models.map((model) => model.id).filter(Boolean));
      const additions = fetched
        .filter((model) => model.id && !existing.has(model.id))
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
        }));
      if (additions.length) {
        onChange({
          ...provider,
          models: [...models, ...additions],
        });
      }
      window.dispatchEvent(new CustomEvent('pi-studio:toast', {
        detail: {
          title: additions.length ? '模型草稿已更新' : '模型列表已是最新',
          message: additions.length ? `已添加 ${additions.length} 个模型。请明确选择兼容性预设后保存。` : '没有发现新的模型。',
          type: 'success',
        },
      }));
    } finally {
      setFetchingModels(false);
    }
  };
  const testModel = async (index: number, model: ModelsProviderModel) => {
    setTestingModelIndex(index);
    setTestResults((current) => ({ ...current, [index]: {} }));
    try {
      const output = await controller.testProviderModel(provider, model.id || '', model.reasoningProfile, thinkingLevel, model.thinkingLevelMap);
      setTestResults((current) => ({ ...current, [index]: { output } }));
    } catch (error) {
      setTestResults((current) => ({ ...current, [index]: { error: String(error) } }));
    } finally {
      setTestingModelIndex(null);
    }
  };

  return (
    <article className={`provider-card${expanded ? ' expanded' : ''}`}>
      <button className="provider-card-header" type="button" onClick={onToggle}>
        <div className="provider-card-main">
          <div className="provider-card-title-row">
            <strong className="provider-card-name">{name}</strong>
            <span className="provider-badge">{models.length} 模型</span>
            <span className="provider-badge muted">{provider.api || 'api 未设'}</span>
          </div>
          <span className="provider-card-meta">
            {provider.baseUrl || '未设置 baseUrl'} · Key {maskApiKey(provider.apiKey)}
          </span>
        </div>
        <span className="provider-card-chevron">{expanded ? '收起' : '编辑'}</span>
      </button>

      {expanded ? (
        <div className="provider-card-body">
          <div className="provider-form-grid">
            <label className="provider-field">
              <span>Base URL</span>
              <input className="settings-text-input" value={provider.baseUrl || ''} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
            </label>
            <label className="provider-field">
              <span>API 类型</span>
              <select className="settings-text-input" value={provider.api || 'openai-completions'} onChange={(event) => onChange({ ...provider, api: event.target.value })}>
                {API_OPTIONS.map((api) => <option value={api} key={api}>{api}</option>)}
              </select>
            </label>
            <label className="provider-field provider-field-wide">
              <span>API Key</span>
              <input
                className="settings-text-input"
                type="password"
                value={provider.apiKey || ''}
                onChange={(event) => onChange({ ...provider, apiKey: event.target.value })}
                placeholder={provider.apiKey ? maskApiKey(provider.apiKey) : '可选，支持 $ENV 或 !command；留空保留原值'}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="provider-compat-row">
            <label className="provider-check">
              <input
                type="checkbox"
                checked={provider.compat?.supportsDeveloperRole === false}
                onChange={(event) => onChange({
                  ...provider,
                  compat: {
                    ...(provider.compat || {}),
                    supportsDeveloperRole: event.target.checked ? false : true,
                  },
                })}
              />
              <span>禁用 developer 角色</span>
            </label>
            <label className="provider-check">
              <input
                type="checkbox"
                checked={provider.compat?.supportsReasoningEffort === false}
                onChange={(event) => onChange({
                  ...provider,
                  compat: {
                    ...(provider.compat || {}),
                    supportsReasoningEffort: event.target.checked ? false : true,
                  },
                })}
              />
              <span>禁用 reasoning_effort</span>
            </label>
          </div>

          <div className="provider-models-header">
            <div><strong>推理预设（Reasoning Profile）</strong><span className="provider-models-count">{Object.keys(profiles).length}</span></div>
            <button className="settings-action-btn" type="button" onClick={addProfile}>添加 OpenAI 标准预设</button>
          </div>
          <p className="settings-help settings-help-inline">GPT 5.5 请在模型行选择 “OpenAI 标准” 预设；当前聊天选择“高”时，会发送 <code>high</code>。测试按钮也按当前聊天强度发送。</p>
          <div className="provider-models">
            {Object.entries(profiles).map(([profileId, profile]) => (
              <div className="provider-model-entry" key={profileId}>
                <div className="provider-thinking-map">
                  <label className="provider-thinking-level"><span>预设名称</span><input className="settings-text-input" value={profile.name || profileId} onChange={(event) => onChange({ ...provider, reasoningProfiles: { ...profiles, [profileId]: { ...profile, name: event.target.value } } })} /></label>
                  {THINKING_LEVELS.map(([level, label]) => (
                    <label className="provider-thinking-level" key={level}>
                      <span>{level === 'off' ? REASONING_UI_LABELS.off : label}</span>
                      <select className="settings-text-input" value={profile.levelMap[level]} onChange={(event) => onChange({ ...provider, reasoningProfiles: { ...profiles, [profileId]: { ...profile, levelMap: { ...profile.levelMap, [level]: event.target.value } } } })}>
                        {level === 'off' ? <option value="omit">{REASONING_UI_LABELS.omit}</option> : null}
                        {level !== 'off' ? <option value="unsupported">{REASONING_UI_LABELS.unsupported}</option> : null}
                        {level !== 'off' ? PI_REASONING_LEVELS.filter((item) => item !== 'off').map((item) => <option value={item} key={item}>{item}</option>) : null}
                      </select>
                    </label>
                  ))}
                  <button className="settings-action-btn danger" type="button" onClick={() => { const next = { ...profiles }; delete next[profileId]; onChange({ ...provider, reasoningProfiles: next, models: models.map((model) => model.reasoningProfile === profileId ? { ...model, reasoningProfile: undefined, reasoning: undefined } : model) }); }}>删除预设</button>
                </div>
              </div>
            ))}
            {!Object.keys(profiles).length ? <div className="settings-help">没有预设。模型能力不会根据 ID 猜测；需要推理时请先添加并明确配置预设。</div> : null}
          </div>

          <div className="provider-models-header">
            <div>
              <strong>模型列表</strong>
              <span className="provider-models-count">{models.length}</span>
            </div>
            <div className="provider-models-actions">
              <button className="settings-action-btn" type="button" onClick={() => void fetchModels()} disabled={fetchingModels}>
                {fetchingModels ? '拉取中…' : '拉取模型'}
              </button>
              <button className="settings-action-btn" type="button" onClick={addModel}>添加模型</button>
            </div>
          </div>

          <div className="provider-models">
            {models.length === 0 ? <div className="settings-help">还没有模型，点击“添加模型”。</div> : null}
            {models.length > 0 ? (
              <div className="provider-model-table-head">
                <span>模型 ID</span>
                <span>显示名</span>
                <span>Context</span>
                <span>推理预设</span>
                <span />
              </div>
            ) : null}
            {models.map((model, index) => (
              <div className="provider-model-entry" key={`${name}-model-${index}`}>
                <div className="provider-model-row">
                  <input className="settings-text-input" value={model.id || ''} placeholder="model-id" onChange={(event) => updateModel(index, { id: event.target.value })} />
                  <input className="settings-text-input" value={model.name || ''} placeholder="可选" onChange={(event) => updateModel(index, { name: event.target.value })} />
                  <input
                    className="settings-text-input"
                    type="number"
                    min={1}
                    value={model.contextWindow ?? ''}
                    placeholder="按模型文档填写"
                    onChange={(event) => updateModel(index, { contextWindow: event.target.value ? Number(event.target.value) : undefined })}
                  />
                  <select className="settings-text-input" value={model.reasoningProfile || (model.reasoning || model.thinkingLevelMap ? '__model-map__' : '')} onChange={(event) => {
                    const selected = event.target.value;
                    const reasoningProfile = selected && selected !== '__model-map__' ? selected : undefined;
                    const nextModels = models.map((item, modelIndex) => {
                      if (modelIndex !== index) return item;
                      if (selected === '__model-map__') return { ...item, reasoningProfile: undefined, reasoning: true };
                      if (reasoningProfile) return { ...item, reasoningProfile, reasoning: true, thinkingLevelMap: undefined };
                      return { ...item, reasoningProfile: undefined, reasoning: false, thinkingLevelMap: undefined };
                    });
                    onChange({ ...provider, compat: selected ? { ...(provider.compat || {}), supportsReasoningEffort: true } : provider.compat, models: nextModels });
                  }}>
                    <option value="">不支持推理</option>
                    {(model.reasoning || model.thinkingLevelMap) && !model.reasoningProfile ? <option value="__model-map__">模型强度映射</option> : null}
                    {Object.entries(profiles).map(([profileId, profile]) => <option value={profileId} key={profileId}>{profile.name || profileId}</option>)}
                  </select>
                  <div className="provider-model-actions">
                    <button className="settings-action-btn" type="button" title={`按当前 Pi 强度「${THINKING_LABELS[thinkingLevel] || thinkingLevel}」测试`} onClick={() => void testModel(index, model)} disabled={testingModelIndex !== null}>
                      {testingModelIndex === index ? '测试中…' : `测试·${THINKING_LABELS[thinkingLevel] || thinkingLevel}`}
                    </button>
                    <button className="settings-action-btn danger" type="button" onClick={() => removeModel(index)}>删除</button>
                  </div>
                </div>
                {!model.reasoningProfile && model.thinkingLevelMap ? (
                  <div className="provider-thinking-map provider-model-thinking-map">
                    <span className="provider-thinking-map-label">模型强度映射<br />直接配置，保存后按此映射发送</span>
                    {THINKING_LEVELS.map(([level, label]) => {
                      const configured = model.thinkingLevelMap?.[level];
                      const value = configured === null ? 'unsupported' : typeof configured === 'string' ? configured : level === 'off' ? 'omit' : 'unsupported';
                      return (
                        <label className="provider-thinking-level" key={level}>
                          <span>{level === 'off' ? REASONING_UI_LABELS.off : label}</span>
                          <select className="settings-text-input" value={value} onChange={(event) => {
                            const selected = event.target.value;
                            updateModel(index, {
                              reasoning: true,
                              thinkingLevelMap: { ...(model.thinkingLevelMap || {}), [level]: selected === 'unsupported' ? null : selected },
                            });
                          }}>
                            {level === 'off' ? <option value="omit">{REASONING_UI_LABELS.omit}</option> : null}
                            {level !== 'off' ? <option value="unsupported">{REASONING_UI_LABELS.unsupported}</option> : null}
                            {level !== 'off' ? PI_REASONING_LEVELS.filter((item) => item !== 'off').map((item) => <option value={item} key={item}>{item}</option>) : null}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
                {testResults[index] ? (
                  <div className={`provider-model-test-result${testResults[index].error ? ' error' : ''}`}>
                    <strong>{testResults[index].error ? '测试失败' : '非流式响应'}</strong>
                    <pre>{testResults[index].error || testResults[index].output}</pre>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="provider-card-footer">
            <button className="settings-action-btn danger" type="button" onClick={onRemove}>删除 Provider</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function shortenPath(path?: string): string {
  if (!path) return '';
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length <= 3 ? path : `...${separator}${parts.slice(-3).join(separator)}`;
}

function ExtensionRow({ item, installing }: { item: PiExtensionInfo; installing: boolean }) {
  return (
    <div className={`extension-row${item.installed ? ' installed' : ''}`}>
      <div className="extension-main">
        <div className="extension-title-row">
          <div className="extension-name">{item.name}</div>
          {item.installed ? <span className="extension-tag ok">已安装</span> : null}
          {item.requiresDependencies ? <span className="extension-tag">需要 npm 依赖</span> : null}
        </div>
        <div className="extension-description">{item.description || 'Pi 扩展'}</div>
        <div className="extension-meta">
          <span className="extension-meta-item">{item.category}</span>
          <span className="extension-meta-item">{item.kind === 'directory' ? '文件夹' : '文件'}</span>
          <span className="extension-meta-item">{item.source}</span>
          {item.installedPath ? <span className="extension-meta-item" title={item.installedPath}>{shortenPath(item.installedPath)}</span> : null}
        </div>
      </div>
      <button className="extension-install" type="button" disabled={item.installed || installing} onClick={() => void controller.installExtension(item.id)}>
        {item.installed ? <><Icon name="check" width={14} height={14} /><span>已安装</span></> : installing ? <span>正在安装…</span> : <><Icon name="download" width={14} height={14} /><span>安装</span></>}
      </button>
    </div>
  );
}

export function ExtensionsView({ snapshot }: { snapshot: AppSnapshot }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const extensions = snapshot.extensions?.extensions || [];
  const categories = ['All', 'Installed', ...new Set(extensions.map((item) => item.category).filter((value) => value && value !== 'Installed'))];
  const filtered = extensions.filter((item) => {
    const categoryMatch = category === 'All' || (category === 'Installed' && item.installed) || item.category === category;
    const textMatch = `${item.name} ${item.id} ${item.description} ${item.category} ${item.source}`.toLowerCase().includes(query.toLowerCase());
    return categoryMatch && textMatch;
  });
  const status = snapshot.extensionError || (snapshot.extensionsLoading ? '正在加载扩展…' : extensions.length ? `显示 ${filtered.length} / ${extensions.length} 个扩展 · 安装目录：${snapshot.extensions?.installDir || ''}` : '未找到 Pi 扩展目录，请重新运行 vendor 脚本或在本机安装 Pi。');

  return (
    <section className="extensions-panel workspace-view">
      <div className="settings-header extensions-header">
        <div className="settings-header-copy">
          <span className="eyebrow">能力中心</span>
          <div className="settings-title-row">
            <h3>扩展</h3>
            <button className="settings-close" type="button" aria-label="关闭扩展" onClick={() => controller.returnToChat()}>
              <Icon name="close" width={16} height={16} />
            </button>
          </div>
          <p className="settings-subtitle">浏览并安装 Pi 全局扩展</p>
        </div>
      </div>
      <div className="extensions-body">
        <div className="extensions-toolbar">
          <label className="extensions-search-wrap"><Icon name="search" width={14} height={14} /><input type="search" className="extensions-search" placeholder="搜索扩展" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button className="extensions-refresh" type="button" title="刷新扩展" aria-label="刷新扩展" onClick={() => void controller.loadExtensions(true)}><Icon name="refresh" width={14} height={14} /></button>
        </div>
        <div className="extensions-categories">
          {categories.map((value) => <button className={`extensions-category${category === value ? ' active' : ''}`} type="button" key={value} onClick={() => setCategory(value)}>{({ All: '全部', Installed: '已安装' } as Record<string, string>)[value] || value}</button>)}
        </div>
        <div className={`extensions-status${snapshot.extensionError ? ' error' : ''}`}>{status}</div>
        <div className="extensions-list">
          {filtered.map((item) => <ExtensionRow item={item} installing={snapshot.extensionInstallingId === item.id} key={item.id} />)}
          {!snapshot.extensionsLoading && filtered.length === 0 ? <div className="extensions-empty">没有符合当前筛选条件的扩展。</div> : null}
        </div>
      </div>
    </section>
  );
}
