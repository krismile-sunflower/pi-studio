import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSnapshot,
  GitChange,
  GitChangeArea,
  ModelsConfig,
  ModelsProviderConfig,
  ModelsProviderModel,
  PiExtensionInfo,
  PiPackageInfo,
  PiPromptTemplate,
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

function knownModelSetting(value?: string): string {
  const normalized = String(value || '').trim();
  return normalized && !['unknown', 'undefined', 'null'].includes(normalized.toLowerCase()) ? normalized : '';
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
        <div className="pane-header">
          <div className="pane-header-copy">
            <span className="eyebrow">工作区</span>
            <h2>项目</h2>
            <p className="pane-header-subtitle">选择一个项目启动 Pi，或进入无文件夹模式直接开始。</p>
          </div>
          <div className="pane-header-actions">
            <button className="launcher-action" type="button" onClick={() => snapshot.noFolderActive ? controller.returnToChat() : void controller.launchNoFolder()}>无文件夹模式</button>
            <button className="launcher-action primary" type="button" onClick={() => void controller.addProject()}>添加项目</button>
            {snapshot.hasActivePiSession ? <button className="pane-close" type="button" title="返回聊天" aria-label="返回聊天" onClick={() => controller.returnToChat()}><Icon name="close" width={16} height={16} /></button> : null}
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
                <div className="launcher-card-path">使用 PiCode 专属目录，不关联本地项目</div>
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

function isStagedGitChange(change: GitChange): boolean {
  return change.indexStatus !== ' ' && change.indexStatus !== '?';
}

function isUnstagedGitChange(change: GitChange): boolean {
  return (change.indexStatus === '?' && change.worktreeStatus === '?') || change.worktreeStatus !== ' ';
}

function gitChangePaths(change: GitChange): string[] {
  return change.originalPath ? [change.originalPath, change.path] : [change.path];
}

function gitAreaChangeLabel(change: GitChange, area: GitChangeArea): string {
  if (area === 'unstaged' && change.indexStatus === '?' && change.worktreeStatus === '?') return '新增';
  return area === 'staged'
    ? gitChangeLabel(change.indexStatus, ' ')
    : gitChangeLabel(' ', change.worktreeStatus);
}

export function ChangesView({ snapshot }: { snapshot: AppSnapshot }) {
  const git = snapshot.gitStatus;
  const selected = snapshot.selectedGitPath;
  const selectedArea = snapshot.selectedGitArea;
  const changeCount = git?.changes.length || 0;
  const stagedChanges = (git?.changes || []).filter(isStagedGitChange);
  const unstagedChanges = (git?.changes || []).filter(isUnstagedGitChange);
  const [commitMessage, setCommitMessage] = useState('');
  const [gitAction, setGitAction] = useState<'pull' | 'commit' | 'push' | 'stage' | 'unstage' | null>(null);
  const busy = snapshot.gitLoading || Boolean(gitAction);
  const runGitAction = async (action: 'pull' | 'commit' | 'push' | 'stage' | 'unstage', operation: () => Promise<boolean>) => {
    setGitAction(action);
    try {
      const completed = await operation();
      if (completed && action === 'commit') setCommitMessage('');
    } finally {
      setGitAction(null);
    }
  };
  const renderChange = (change: GitChange, area: GitChangeArea) => {
    const label = gitAreaChangeLabel(change, area);
    const active = selected === change.path && selectedArea === area;
    const actionLabel = area === 'staged' ? `取消暂存 ${change.path}` : `暂存 ${change.path}`;
    return (
      <div className={`change-file-row${active ? ' active' : ''}`} key={`${area}:${change.path}`}>
        <button className="change-file" type="button" onClick={() => void controller.selectGitChange(change.path, area)}>
          <span className={`change-status ${label}`}>{label}</span>
          <span className="change-file-copy"><strong>{change.path}</strong>{change.originalPath ? <small>{change.originalPath} → {change.path}</small> : null}</span>
        </button>
        <button className="change-file-stage" type="button" aria-label={actionLabel} title={actionLabel} disabled={busy} onClick={() => void runGitAction(area === 'staged' ? 'unstage' : 'stage', () => area === 'staged' ? controller.unstageGit(gitChangePaths(change)) : controller.stageGit(gitChangePaths(change)))}>
          <Icon name={area === 'staged' ? 'close' : 'plus'} width={13} height={13} />
        </button>
      </div>
    );
  };
  return (
    <section className="changes-panel workspace-view">
      <div className="pane-header changes-header">
        <div className="pane-header-copy">
          <span className="eyebrow">工作区</span>
          <h2>Git 变更</h2>
          <p className="pane-header-subtitle">审阅并暂存改动，再提交暂存区内容或同步当前分支。</p>
        </div>
        <div className="pane-header-actions">
          <button className="settings-action-btn" type="button" onClick={() => void controller.loadGitStatus()} disabled={busy}>
            {snapshot.gitLoading ? '刷新中…' : '刷新'}
          </button>
          <button className="pane-close" type="button" aria-label="关闭变更中心" title="关闭变更中心" onClick={() => controller.returnToChat()}><Icon name="close" width={16} height={16} /></button>
        </div>
      </div>

      {snapshot.gitError ? <div className="changes-notice error">{snapshot.gitError}</div> : null}
      {!snapshot.gitLoading && !snapshot.gitError && git && !git.isRepository ? <div className="changes-notice">当前文件夹不是 Git 仓库。</div> : null}
      {git?.isRepository ? (
        <>
          <div className="changes-command-deck">
            <div className="changes-sync-row">
              <div className="changes-sync-copy">
                <strong>{git.branch || 'HEAD'}</strong>
                <span>{git.upstream ? `${git.upstream} · ↑ ${git.ahead} · ↓ ${git.behind}` : '尚未设置上游分支'}</span>
              </div>
              <div className="changes-sync-actions">
                <button type="button" disabled={busy || !git.upstream} title={git.upstream ? '仅快进拉取上游分支' : '需要先设置上游分支'} onClick={() => void runGitAction('pull', () => controller.pullGit())}>{gitAction === 'pull' ? '拉取中…' : '拉取'}</button>
                <button type="button" disabled={busy} onClick={() => void runGitAction('push', () => controller.pushGit())}>{gitAction === 'push' ? '推送中…' : '推送'}</button>
              </div>
            </div>
            <div className="changes-stage-row">
              <span>{stagedChanges.length} 个已暂存 · {unstagedChanges.length} 个未暂存</span>
              <div>
                <button type="button" disabled={busy || !unstagedChanges.length} onClick={() => void runGitAction('stage', () => controller.stageAllGit())}>全部暂存</button>
                <button type="button" disabled={busy || !stagedChanges.length} onClick={() => void runGitAction('unstage', () => controller.unstageAllGit())}>取消全部暂存</button>
              </div>
            </div>
            <form className="changes-commit-row" onSubmit={(event) => {
              event.preventDefault();
              if (!commitMessage.trim() || !stagedChanges.length || busy) return;
              void runGitAction('commit', () => controller.commitGit(commitMessage));
            }}>
              <input value={commitMessage} maxLength={500} disabled={busy || !stagedChanges.length} onChange={(event) => setCommitMessage(event.target.value)} placeholder={stagedChanges.length ? '输入提交说明' : '请先暂存需要提交的改动'} aria-label="Git 提交说明" />
              <button type="submit" disabled={busy || !stagedChanges.length || !commitMessage.trim()}>{gitAction === 'commit' ? '提交中…' : `提交暂存 (${stagedChanges.length})`}</button>
            </form>
          </div>
          <div className="changes-workbench">
            <aside className="changes-file-list">
              <div className="changes-summary">
                <span className="changes-branch">{git.branch || 'HEAD'}</span>
                <span>{changeCount ? `${changeCount} 个文件有改动` : '工作区干净'}</span>
              </div>
              <div className="changes-section-heading"><span>暂存的更改</span><strong>{stagedChanges.length}</strong></div>
              {stagedChanges.length ? stagedChanges.map((change) => renderChange(change, 'staged')) : <div className="changes-empty compact">还没有暂存的改动。</div>}
              <div className="changes-section-heading"><span>更改</span><strong>{unstagedChanges.length}</strong></div>
              {unstagedChanges.length ? unstagedChanges.map((change) => renderChange(change, 'unstaged')) : <div className="changes-empty compact">没有未暂存的改动。</div>}
            </aside>
            <article className="changes-diff-panel">
              {!selected ? <div className="changes-empty">选择左侧文件以查看 diff。</div> : null}
              {snapshot.gitDiffLoading ? <div className="changes-empty">正在读取 diff…</div> : null}
              {selected && !snapshot.gitDiffLoading && snapshot.gitDiff ? (
                <>
                  <div className="changes-diff-header"><strong>{snapshot.gitDiff.path}</strong><span>{selectedArea === 'staged' ? '暂存区' : '工作区'}</span></div>
                  <pre className="changes-diff">{snapshot.gitDiff.diff || '新建的未跟踪文件或二进制文件没有可展示的文本 diff。'}</pre>
                </>
              ) : null}
            </article>
          </div>
        </>
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

const SETTINGS_SECTIONS = [
  ['appearance', '外观', '主题与界面外观'],
  ['agent', '智能体', 'Pi 的思考与上下文行为'],
  ['permissions', '权限', '工具执行授权与项目信任'],
  ['models', '模型', 'API 供应商、模型与推理预设'],
  ['runtime', '运行时', 'Pi 运行时、桌面端与连接'],
] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number][0];

const SETTINGS_SECTION_KEY = 'pi-studio:settings-section';

function initialSettingsSection(): SettingsSection {
  const saved = localStorage.getItem(SETTINGS_SECTION_KEY);
  return SETTINGS_SECTIONS.some(([id]) => id === saved) ? (saved as SettingsSection) : 'appearance';
}

export function SettingsView({ snapshot }: { snapshot: AppSnapshot }) {
  const [theme, setTheme] = useState<ThemeId>(() => getCurrentTheme());
  const [section, setSection] = useState<SettingsSection>(initialSettingsSection);
  const info = snapshot.runtimeInfo;
  const canUpdate = Boolean(info?.canUpdateSystem || info?.canUpdateBundled);
  const current = SETTINGS_SECTIONS.find(([id]) => id === section) || SETTINGS_SECTIONS[0];

  const selectSection = (next: SettingsSection) => {
    setSection(next);
    localStorage.setItem(SETTINGS_SECTION_KEY, next);
  };

  return (
    <section className="settings-panel workspace-view">
      <div className="pane-layout">
        <nav className="pane-nav" aria-label="设置分类">
          <div className="pane-nav-title">设置</div>
          {SETTINGS_SECTIONS.map(([id, label]) => (
            <button
              className={`pane-nav-item${section === id ? ' active' : ''}`}
              type="button"
              key={id}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => selectSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="pane-content">
          <div className="pane-header">
            <div className="pane-header-copy">
              <h2>{current[1]}</h2>
              <p className="pane-header-subtitle">{current[2]}</p>
            </div>
            <div className="pane-header-actions">
              <button className="pane-close" type="button" aria-label="关闭设置" title="关闭设置" onClick={() => controller.returnToChat()}>
                <Icon name="close" width={16} height={16} />
              </button>
            </div>
          </div>

          {section === 'appearance' ? (
            <div className="pane-section">
              <div className="pane-section-head">
                <div>
                  <div className="pane-section-title">主题</div>
                  <p className="pane-section-note">切换后立即生效，并同步桌面端窗口标题栏。</p>
                </div>
              </div>
              <div className="theme-grid">
                {(Object.entries(themes) as Array<[ThemeId, (typeof themes)[ThemeId]]>).map(([id, value]) => (
                  <button
                    className={`theme-swatch${theme === id ? ' active' : ''}`}
                    data-label={value.name}
                    aria-label={`切换为${value.name}主题`}
                    aria-pressed={theme === id}
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
          ) : null}

          {section === 'agent' ? (
            <div className="pane-section">
              <div className="pane-section-head">
                <div>
                  <div className="pane-section-title">对话行为</div>
                  <p className="pane-section-note">这些设置立即应用到当前会话。</p>
                </div>
              </div>
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
          ) : null}

          {section === 'permissions' ? (
            <div className="pane-section">
              <div className="pane-section-head">
                <div>
                  <div className="pane-section-title">工具执行权限</div>
                  <p className="pane-section-note">控制 Pi 读取、修改文件和运行命令时的授权方式；变更会立即应用到当前会话。</p>
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
          ) : null}

          {section === 'models' ? <ModelsProvidersSection snapshot={snapshot} /> : null}

          {section === 'runtime' ? (
            <>
              <div className="pane-section">
                <div className="pane-section-head">
                  <div>
                    <div className="pane-section-title">Pi 运行时</div>
                    <p className="pane-section-note">检测版本、更新系统安装或内置 sidecar。</p>
                  </div>
                  <div className="pane-section-actions">
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

              <div className="pane-section">
                <div className="pane-section-head">
                  <div>
                    <div className="pane-section-title">桌面端</div>
                    <p className="pane-section-note">仅在桌面应用中可用。</p>
                  </div>
                </div>
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
            </>
          ) : null}
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
  const currentModelId = knownModelSetting(snapshot.currentModelId) || snapshot.defaultModel;
  const storedCurrentProvider = knownModelSetting(snapshot.currentModelProvider);
  const currentModel = snapshot.models.find((model) => model.id === currentModelId && (!storedCurrentProvider || model.provider === storedCurrentProvider));
  const currentProvider = storedCurrentProvider || currentModel?.provider || snapshot.defaultProvider;
  const selectedProvider = snapshot.defaultProvider || currentProvider;
  const selectedProviderModels = useMemo(() => {
    const result = new Map<string, { id: string; name?: string }>();
    for (const model of snapshot.models.filter((item) => item.provider === selectedProvider)) {
      result.set(model.id, { id: model.id, name: model.name });
    }
    for (const model of draft.providers?.[selectedProvider]?.models || []) {
      if (model.id && !result.has(model.id)) result.set(model.id, { id: model.id, name: model.name });
    }
    return [...result.values()];
  }, [draft.providers, selectedProvider, snapshot.models]);

  const switchProvider = async (providerName: string) => {
    if (!providerName) return;
    const available = snapshot.models.find((model) => model.provider === providerName);
    const configured = draft.providers?.[providerName]?.models?.find((model) => model.id);
    const modelId = providerName === snapshot.defaultProvider && snapshot.defaultModel
      ? snapshot.defaultModel
      : available?.id || configured?.id || '';
    if (!modelId) {
      window.dispatchEvent(new CustomEvent('pi-studio:toast', {
        detail: { title: '无法切换供应商', message: '该供应商还没有可用模型，请先在下方添加或拉取模型并保存。', type: 'warning' },
      }));
      return;
    }
    await controller.setDefaultModel(providerName, modelId);
  };

  if (!desktop) {
    return (
      <div className="pane-section">
        <div className="pane-section-title">模型供应商</div>
        <p className="pane-section-note">模型配置（~/.pi/agent/models.json）仅在桌面应用中可管理。</p>
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
    <div className="pane-section flush models-section">
      <div className="pane-section-head">
        <div>
          <div className="pane-section-title">模型供应商{dirty ? <span className="pane-dirty-dot" title="有未保存更改" /> : null}</div>
          <p className="pane-section-note">
            管理 API 连接、兼容性和模型能力。保存后自动刷新可用模型
            {dirty ? ' · 有未保存更改' : ''}
          </p>
        </div>
        <div className="pane-section-actions">
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

      <div className="provider-selection-panel">
        <div className="provider-selection-copy">
          <span className="provider-selection-label">PI 默认供应商</span>
          <strong>{snapshot.defaultProvider || '尚未设置'}</strong>
          <span>默认模型：{snapshot.defaultModel || '尚未设置'}{currentProvider && currentModelId ? ` · 当前会话：${currentProvider}/${currentModelId}` : ''}</span>
        </div>
        <div className="provider-selection-controls">
          <label className="provider-selection-control">
            <span>默认供应商</span>
            <select className="settings-text-input" value={selectedProvider} onChange={(event) => void switchProvider(event.target.value)} disabled={!providers.length}>
              <option value="">选择供应商</option>
              {snapshot.defaultProvider && !draft.providers?.[snapshot.defaultProvider] ? <option value={snapshot.defaultProvider}>{snapshot.defaultProvider}</option> : null}
              {providers.map(([name]) => <option value={name} key={name}>{name}</option>)}
            </select>
          </label>
          <label className="provider-selection-control">
            <span>默认模型</span>
            <select className="settings-text-input" value={snapshot.defaultModel} onChange={(event) => void controller.setDefaultModel(selectedProvider, event.target.value)} disabled={!selectedProviderModels.length}>
              <option value="">选择模型</option>
              {snapshot.defaultModel && !selectedProviderModels.some((model) => model.id === snapshot.defaultModel) ? <option value={snapshot.defaultModel}>{snapshot.defaultModel}</option> : null}
              {selectedProviderModels.map((model) => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="provider-toolbar">
        <div className="provider-toolbar-copy">
          <strong>供应商列表</strong>
          <span>{providers.length ? `${providers.length} 个已配置` : '添加一个 API 供应商开始使用'}</span>
        </div>
        <div className="provider-toolbar-actions">
          <input
            className="settings-text-input"
            type="text"
            placeholder="输入名称，例如 ollama"
            value={newProviderName}
            onChange={(event) => setNewProviderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addProvider();
              }
            }}
          />
          <button className="settings-action-btn primary" type="button" onClick={addProvider}>添加供应商</button>
        </div>
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
  const [showApiKey, setShowApiKey] = useState(false);
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
          maxTokens: model.maxTokens,
          input: model.input,
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
        <span className="provider-card-mark" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div className="provider-card-main">
          <div className="provider-card-title-row">
            <strong className="provider-card-name">{name}</strong>
            <span className="provider-badge">{models.length} 个模型</span>
            <span className="provider-badge muted">{provider.api || 'API 未设置'}</span>
          </div>
          <span className="provider-card-meta">
            {provider.baseUrl || '未设置 baseUrl'} · Key {maskApiKey(provider.apiKey)}
          </span>
        </div>
        <div className="provider-card-stats" aria-hidden="true">
          <span><strong>{models.length}</strong><small>模型</small></span>
          <span><strong>{Object.keys(provider.reasoningProfiles || {}).length}</strong><small>预设</small></span>
        </div>
        <span className="provider-card-chevron">{expanded ? '收起' : '配置'} <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></span>
      </button>

      {expanded ? (
        <div className="provider-card-body">
          <div className="provider-subsection">
            <div className="provider-subsection-heading"><strong>连接配置</strong><span>请求地址和鉴权信息</span></div>
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
              <span className="provider-secret-input">
                <input
                  className="settings-text-input"
                  type={showApiKey ? 'text' : 'password'}
                  value={provider.apiKey || ''}
                  onChange={(event) => onChange({ ...provider, apiKey: event.target.value })}
                  placeholder={provider.apiKey ? maskApiKey(provider.apiKey) : '可选，支持 $ENV 或 !command；留空保留原值'}
                  autoComplete="off"
                />
                <button
                  className="provider-secret-toggle"
                  type="button"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  aria-label={showApiKey ? '隐藏 API Key' : '查看 API Key'}
                  title={showApiKey ? '隐藏 API Key' : '查看 API Key'}
                >
                  <Icon name={showApiKey ? 'eye-off' : 'eye'} width={15} height={15} />
                </button>
              </span>
            </label>
            </div>
          </div>

          <div className="provider-subsection">
            <div className="provider-subsection-heading"><strong>兼容性设置</strong><span>根据供应商 API 行为调整请求格式</span></div>
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
            <label className="provider-check">
              <input
                type="checkbox"
                checked={provider.compat?.supportsUsageInStreaming !== false}
                onChange={(event) => onChange({
                  ...provider,
                  compat: { ...(provider.compat || {}), supportsUsageInStreaming: event.target.checked },
                })}
              />
              <span>流式响应包含 usage</span>
            </label>
            <label className="provider-compat-field">
              <span>推理参数格式</span>
              <select className="settings-text-input" value={provider.compat?.thinkingFormat || ''} onChange={(event) => {
                const compat = { ...(provider.compat || {}) };
                if (event.target.value) compat.thinkingFormat = event.target.value;
                else delete compat.thinkingFormat;
                onChange({ ...provider, compat });
              }}>
                <option value="">Pi 默认</option>
                {['reasoning_effort', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template'].map((format) => <option value={format} key={format}>{format}</option>)}
              </select>
            </label>
            <label className="provider-compat-field">
              <span>最大输出字段</span>
              <select className="settings-text-input" value={provider.compat?.maxTokensField || ''} onChange={(event) => {
                const compat = { ...(provider.compat || {}) };
                if (event.target.value) compat.maxTokensField = event.target.value;
                else delete compat.maxTokensField;
                onChange({ ...provider, compat });
              }}>
                <option value="">Pi 默认</option>
                <option value="max_completion_tokens">max_completion_tokens</option>
                <option value="max_tokens">max_tokens</option>
              </select>
            </label>
            </div>
          </div>

          <div className="provider-models-header provider-section-header">
            <div><strong>推理预设（Reasoning Profile）</strong><span className="provider-models-count">{Object.keys(profiles).length}</span></div>
            <button className="settings-action-btn" type="button" onClick={addProfile}>添加 OpenAI 标准预设</button>
          </div>
          <p className="settings-help settings-help-inline">GPT 5.5 请在模型行选择 “OpenAI 标准” 预设；当前聊天选择“高”时，会发送 <code>high</code>。测试按钮也按当前聊天强度发送。</p>
          <div className="provider-models">
            {Object.entries(profiles).map(([profileId, profile]) => (
              <div className="provider-model-entry provider-profile-entry" key={profileId}>
                <div className="provider-profile-toolbar">
                  <label className="provider-field"><span>预设名称</span><input className="settings-text-input" value={profile.name || profileId} onChange={(event) => onChange({ ...provider, reasoningProfiles: { ...profiles, [profileId]: { ...profile, name: event.target.value } } })} /></label>
                  <button className="settings-action-btn danger" type="button" onClick={() => { const next = { ...profiles }; delete next[profileId]; onChange({ ...provider, reasoningProfiles: next, models: models.map((model) => model.reasoningProfile === profileId ? { ...model, reasoningProfile: undefined, reasoning: undefined } : model) }); }}>删除预设</button>
                </div>
                <div className="provider-thinking-map provider-profile-map">
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
                </div>
              </div>
            ))}
            {!Object.keys(profiles).length ? <div className="settings-help">没有预设。模型能力不会根据 ID 猜测；需要推理时请先添加并明确配置预设。</div> : null}
          </div>

          <div className="provider-models-header provider-section-header">
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
                    value={model.contextWindow || ''}
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
                <div className="provider-model-capabilities">
                  {model.input?.length ? <span>输入：{model.input.join('、')}</span> : null}
                  <label className="provider-model-limit-field">
                    <span>最大输出 Token</span>
                    <input
                      className="settings-text-input"
                      type="number"
                      min={1}
                      value={model.maxTokens || ''}
                      placeholder="按模型文档填写"
                      onChange={(event) => updateModel(index, { maxTokens: event.target.value ? Number(event.target.value) : undefined })}
                    />
                  </label>
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
    <div className={`catalog-row${item.installed ? ' installed' : ''}`}>
      <div className="catalog-main">
        <div className="catalog-title-row">
          <div className="catalog-name">{item.name}</div>
          {item.installed ? <span className="catalog-tag ok">已安装</span> : null}
          {item.requiresDependencies ? <span className="catalog-tag">需要 npm 依赖</span> : null}
        </div>
        <div className="catalog-description">{item.description || 'Pi 扩展'}</div>
        <div className="catalog-meta">
          <span className="catalog-meta-item">{item.category}</span>
          <span className="catalog-meta-item">{item.source}</span>
          {item.installedPath ? <span className="catalog-meta-item" title={item.installedPath}>{shortenPath(item.installedPath)}</span> : null}
        </div>
      </div>
      <button className={`catalog-action${item.installed ? ' done' : ''}`} type="button" disabled={item.installed || installing} onClick={() => void controller.installExtension(item.id)}>
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
      <div className="pane-section flush">
        <div className="catalog-toolbar">
          <label className="catalog-search-wrap"><Icon name="search" width={14} height={14} /><input type="search" className="catalog-search" placeholder="搜索扩展" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button className="catalog-icon-btn" type="button" title="刷新扩展" aria-label="刷新扩展" onClick={() => void controller.loadExtensions(true)}><Icon name="refresh" width={14} height={14} /></button>
        </div>
        <div className="catalog-filters">
          {categories.map((value) => <button className={`catalog-filter${category === value ? ' active' : ''}`} type="button" key={value} onClick={() => setCategory(value)}>{({ All: '全部', Installed: '已安装' } as Record<string, string>)[value] || value}</button>)}
        </div>
        <div className={`catalog-status${snapshot.extensionError ? ' error' : ''}`}>{status}</div>
        <div className="catalog-list">
          {filtered.map((item) => <ExtensionRow item={item} installing={snapshot.extensionInstallingId === item.id} key={item.id} />)}
          {!snapshot.extensionsLoading && filtered.length === 0 ? <div className="catalog-empty">没有符合当前筛选条件的扩展。</div> : null}
        </div>
      </div>
  );
}

/** `npm:foo@1.2.0` / `foo@1.2.0` / `@scope/foo` all collapse to the bare name. */
function packageKey(value: string): string {
  const bare = value.trim().replace(/^npm:/i, '');
  const version = bare.lastIndexOf('@');
  return (version > 0 ? bare.slice(0, version) : bare).toLowerCase();
}

interface PackageEntry {
  key: string;
  name: string;
  source: string;
  description?: string;
  packageType?: string;
  downloads?: string;
  version?: string;
  installed: boolean;
  enabled: boolean;
}

export function PackagesView({ snapshot }: { snapshot: AppSnapshot }) {
  const [packageSource, setPackageSource] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [pendingSource, setPendingSource] = useState('');

  const installed = useMemo(() => snapshot.packages?.packages || [], [snapshot.packages]);
  const results = snapshot.packageSearchResults;

  // One list: every catalog hit annotated with its real install state, plus any
  // installed package the catalog doesn't know about (git / local sources).
  const entries = useMemo<PackageEntry[]>(() => {
    const installedByKey = new Map<string, PiPackageInfo>();
    for (const item of installed) {
      installedByKey.set(packageKey(item.source), item);
      if (item.name) installedByKey.set(packageKey(item.name), item);
    }
    const catalogKeys = new Set<string>();
    const fromCatalog = results.map((item) => {
      const key = packageKey(item.name);
      catalogKeys.add(key);
      const match = installedByKey.get(key);
      return {
        key,
        name: item.name,
        source: match?.source || `npm:${item.name}`,
        description: item.description || match?.description,
        packageType: item.packageType,
        downloads: item.downloads,
        version: match?.version,
        installed: Boolean(match),
        enabled: match ? match.enabled : true,
      };
    });
    const extras = installed
      .filter((item) => !catalogKeys.has(packageKey(item.source)) && !(item.name && catalogKeys.has(packageKey(item.name))))
      .map((item) => ({
        key: packageKey(item.source),
        name: item.name || item.source,
        source: item.source,
        description: item.description,
        version: item.version,
        installed: true,
        enabled: item.enabled,
      }));
    return [...extras, ...fromCatalog];
  }, [installed, results]);

  const types = ['All', 'Installed', ...new Set(entries.map((item) => item.packageType).filter((value): value is string => Boolean(value)))];
  const visible = entries.filter((item) => filter === 'All' || (filter === 'Installed' ? item.installed : item.packageType === filter));
  const installedCount = entries.filter((item) => item.installed).length;

  const status = snapshot.packageSearchError
    || snapshot.packageError
    || (snapshot.packageSearchLoading || snapshot.packagesLoading ? '正在读取软件包…' : `显示 ${visible.length} / ${entries.length} 个软件包 · 已安装 ${installedCount} 个`);

  const install = (source: string) => {
    setPendingSource(source);
    void controller.installPackage(source).finally(() => setPendingSource(''));
  };

  return (
    <>
      <section className="pane-section flush">
        <div className="catalog-toolbar">
          <form className="catalog-search-wrap" onSubmit={(event) => { event.preventDefault(); void controller.searchPackages(query); }}>
            <Icon name="search" width={14} height={14} />
            <input type="search" className="catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索官方 Pi 软件包，回车确认" aria-label="搜索 Pi 软件包" />
          </form>
          <button className="catalog-icon-btn" type="button" title="刷新软件包" aria-label="刷新软件包" disabled={snapshot.packagesLoading || snapshot.packageSearchLoading} onClick={() => { void controller.loadPackages(true); void controller.searchPackages(query); }}>
            <Icon name="refresh" width={14} height={14} />
          </button>
        </div>
        <div className="catalog-filters">
          {types.map((value) => (
            <button className={`catalog-filter${filter === value ? ' active' : ''}`} type="button" key={value} onClick={() => setFilter(value)}>
              {({ All: '全部', Installed: `已安装${installedCount ? ` ${installedCount}` : ''}` } as Record<string, string>)[value] || value}
            </button>
          ))}
        </div>
        <div className={`catalog-status${snapshot.packageSearchError || snapshot.packageError ? ' error' : ''}`}>{status}</div>
        <div className="catalog-list">
          {visible.map((item) => (
            <PackageRow
              item={item}
              key={item.key || item.source}
              installing={snapshot.packageInstalling && pendingSource === item.source}
              busy={snapshot.packageInstalling}
              removing={snapshot.packageRemovingSource === item.source}
              onInstall={() => install(item.source)}
            />
          ))}
          {!snapshot.packagesLoading && !snapshot.packageSearchLoading && visible.length === 0 ? (
            <div className="catalog-empty">{filter === 'Installed' ? '尚未安装全局 Pi 软件包。' : '没有符合当前筛选条件的软件包。'}</div>
          ) : null}
        </div>
      </section>

      <section className="pane-section">
        <div className="pane-section-head">
          <div>
            <div className="pane-section-title">手动添加</div>
            <p className="pane-section-note">目录里没有的来源：npm 包名、Git 仓库或本地路径。</p>
          </div>
        </div>
        <form className="package-install-form" onSubmit={(event) => { event.preventDefault(); const source = packageSource.trim(); if (!source) return; install(source); setPackageSource(''); }}>
          <input className="settings-text-input" value={packageSource} onChange={(event) => setPackageSource(event.target.value)} placeholder="npm:包名、git:github.com/用户/仓库或本地路径" aria-label="Pi 软件包来源" />
          <button className="settings-action-btn primary" type="submit" disabled={!packageSource.trim() || snapshot.packageInstalling}>{snapshot.packageInstalling ? '正在安装…' : '安装软件包'}</button>
        </form>
        <p className="packages-security-note">第三方软件包可执行扩展代码。请仅安装你信任的来源。</p>
      </section>
    </>
  );
}

const emptyPromptDraft = { scope: 'user' as 'user' | 'project', name: '', description: '', argumentHint: '', body: '', originalPath: '' };

function scopeLabel(scope: string): string {
  return ({ user: '全局', project: '项目', package: '软件包' } as Record<string, string>)[scope] || scope;
}

function PromptRow({
  template,
  busy,
  onEdit,
  onDelete,
}: {
  template: PiPromptTemplate;
  busy: boolean;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <div className="catalog-row">
      <div className="catalog-main">
        <div className="catalog-title-row">
          <div className="catalog-name mono">/{template.name}</div>
          {template.argumentHint ? <span className="prompt-hint mono">{template.argumentHint}</span> : null}
          <span className={`catalog-tag${template.editable ? '' : ' warn'}`}>{scopeLabel(template.scope)}</span>
        </div>
        <div className="catalog-description">{template.description || '该模板没有提供描述。'}</div>
        <div className="catalog-meta">
          <span className="catalog-meta-item" title={template.filePath}>{template.filePath}</span>
          {template.scope === 'package' ? <span className="catalog-meta-item">{template.origin}</span> : null}
        </div>
      </div>
      <div className="catalog-actions">
        <button className="catalog-action" type="button" onClick={onEdit}>{template.editable ? '编辑' : '查看'}</button>
        {template.editable ? (
          <button
            className="catalog-action danger"
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`删除提示模板“/${template.name}”？\n${template.filePath}`)) onDelete();
            }}
          >删除</button>
        ) : null}
      </div>
    </div>
  );
}

function PromptsView({ snapshot }: { snapshot: AppSnapshot }) {
  const [draft, setDraft] = useState<typeof emptyPromptDraft | null>(null);
  const [readOnlyPath, setReadOnlyPath] = useState('');
  const [query, setQuery] = useState('');
  const templates = snapshot.prompts?.templates || [];
  const projectDir = snapshot.prompts?.projectDir;
  const visible = templates.filter((template) => {
    const needle = query.trim().toLowerCase();
    return !needle || `${template.name} ${template.description}`.toLowerCase().includes(needle);
  });
  // Break the count down so package-provided templates do not look like a bug.
  const ownCount = templates.filter((template) => template.editable).length;
  const packageOrigins = new Set(templates.filter((template) => template.scope === 'package').map((template) => template.origin));
  const promptSummary = [
    `${ownCount} 个自建`,
    packageOrigins.size ? `${templates.length - ownCount} 个来自软件包（${[...packageOrigins].join('、')}）` : '',
    '输入 /名称 即可调用',
  ].filter(Boolean).join(' · ');

  const openEditor = (template?: PiPromptTemplate) => {
    setReadOnlyPath(template && !template.editable ? template.filePath : '');
    setDraft(
      template
        ? {
            scope: template.scope === 'project' ? 'project' : 'user',
            name: template.name,
            description: template.description,
            argumentHint: template.argumentHint || '',
            body: template.body,
            originalPath: template.editable ? template.filePath : '',
          }
        : { ...emptyPromptDraft },
    );
  };

  const save = async () => {
    if (!draft) return;
    const saved = await controller.savePrompt({
      scope: draft.scope,
      name: draft.name,
      description: draft.description,
      argumentHint: draft.argumentHint,
      body: draft.body,
      originalPath: draft.originalPath,
    });
    if (saved) setDraft(null);
  };

  if (draft) {
    const readOnly = Boolean(readOnlyPath);
    return (
      <section className="pane-section">
        <div className="pane-section-head">
          <div>
            <div className="pane-section-title">{readOnly ? `查看 /${draft.name}` : draft.originalPath ? `编辑 /${draft.name}` : '新建提示模板'}</div>
            <p className="pane-section-note">
              {readOnly
                ? `该模板来自${scopeLabel(templates.find((item) => item.filePath === readOnlyPath)?.scope || 'package')}，只能查看。`
                : '文件名即命令名。正文支持 $1、$@/$ARGUMENTS、${1:-默认值} 与 ${@:2} 等参数占位符。'}
            </p>
          </div>
          <button className="settings-action-btn" type="button" onClick={() => setDraft(null)}>返回列表</button>
        </div>
        <div className="prompt-editor">
          <label className="prompt-field">
            <span>命令名</span>
            <input
              className="settings-text-input mono"
              value={draft.name}
              disabled={readOnly}
              placeholder="review"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <small>调用方式：/{draft.name.trim().replace(/^\//, '') || 'name'}</small>
          </label>
          <label className="prompt-field">
            <span>保存位置</span>
            <select
              className="settings-text-input"
              value={draft.scope}
              disabled={readOnly}
              onChange={(event) => setDraft({ ...draft, scope: event.target.value as 'user' | 'project' })}
            >
              <option value="user">全局 · {snapshot.prompts?.userDir || '~/.pi/agent/prompts'}</option>
              <option value="project" disabled={!projectDir || !snapshot.prompts?.projectTrusted}>
                项目 · {projectDir ? (snapshot.prompts?.projectTrusted ? projectDir : `${projectDir}（项目尚未信任）`) : '需要先打开一个项目'}
              </option>
            </select>
          </label>
          <label className="prompt-field">
            <span>描述</span>
            <input
              className="settings-text-input"
              value={draft.description}
              disabled={readOnly}
              placeholder="留空时 Pi 会取正文第一行"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="prompt-field">
            <span>参数提示</span>
            <input
              className="settings-text-input mono"
              value={draft.argumentHint}
              disabled={readOnly}
              placeholder="<必填参数> [可选参数]"
              onChange={(event) => setDraft({ ...draft, argumentHint: event.target.value })}
            />
            <small>显示在斜杠命令补全里，尖括号表示必填、方括号表示可选。</small>
          </label>
          <label className="prompt-field wide">
            <span>正文</span>
            <textarea
              className="settings-text-input prompt-body mono"
              value={draft.body}
              disabled={readOnly}
              rows={14}
              placeholder={'审查已暂存的改动（`git diff --cached`），重点关注：\n- 逻辑错误\n- 安全问题'}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
        </div>
        {snapshot.promptError ? <div className="catalog-status error">{snapshot.promptError}</div> : null}
        {!readOnly ? (
          <div className="prompt-editor-actions">
            <button
              className="settings-action-btn primary"
              type="button"
              disabled={!draft.name.trim() || !draft.body.trim() || snapshot.promptSaving}
              onClick={() => void save()}
            >{snapshot.promptSaving ? '正在保存…' : '保存模板'}</button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <section className="pane-section flush">
        <div className="catalog-toolbar">
          <div className="catalog-search-wrap">
            <Icon name="search" width={14} height={14} />
            <input type="search" className="catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示模板" aria-label="搜索提示模板" />
          </div>
          <button className="catalog-icon-btn" type="button" title="刷新模板" aria-label="刷新模板" disabled={snapshot.promptsLoading} onClick={() => void controller.loadPrompts(true)}>
            <Icon name="refresh" width={14} height={14} />
          </button>
          <button className="catalog-action primary" type="button" onClick={() => openEditor()}>新建模板</button>
        </div>
        <div className={`catalog-status${snapshot.promptError ? ' error' : ''}`}>
          {snapshot.promptError || (snapshot.promptsLoading ? '正在加载提示模板…' : promptSummary)}
        </div>
        <div className="catalog-list">
          {visible.map((template) => (
            <PromptRow
              key={template.filePath}
              template={template}
              busy={snapshot.promptSaving}
              onEdit={() => openEditor(template)}
              onDelete={() => void controller.deletePrompt(template.filePath)}
            />
          ))}
          {!snapshot.promptsLoading && visible.length === 0 ? (
            <div className="catalog-empty">{query.trim() ? '没有匹配的提示模板。' : '还没有提示模板。新建一个，之后在输入框里用 /名称 调用。'}</div>
          ) : null}
        </div>
      </section>

      <section className="pane-section">
        <div className="pane-section-head">
          <div>
            <div className="pane-section-title">Pi 从哪里加载模板</div>
            <p className="pane-section-note">目录扫描不递归，只读取 <code>.md</code> 文件。</p>
          </div>
        </div>
        <ul className="prompt-locations">
          <li><span>全局</span><code>{snapshot.prompts?.userDir || '~/.pi/agent/prompts'}</code></li>
          <li>
            <span>项目</span>
            <code>{projectDir || '<项目>/.pi/prompts'}{snapshot.prompts && !snapshot.prompts.projectTrusted ? '（项目尚未信任，Pi 不会加载）' : ''}</code>
          </li>
          <li><span>软件包</span><code>settings.json 里 packages 声明的包：pi.prompts 或 prompts/ 目录</code></li>
        </ul>
        <p className="pane-section-note">
          settings.json 的 <code>prompts</code> 数组不是额外来源，而是对上面前两项的启用/禁用过滤器（只有 <code>!</code>、<code>+</code>、<code>-</code> 前缀的条目生效）。
        </p>
      </section>
    </>
  );
}

export function CustomizationView({ snapshot }: { snapshot: AppSnapshot }) {
  const [tab, setTab] = useState<'extensions' | 'packages' | 'prompts'>('extensions');
  const extensionCount = snapshot.extensions?.extensions.length || 0;
  const packageCount = snapshot.packages?.packages.length || 0;
  const promptCount = snapshot.prompts?.templates.length || 0;
  const tabs = [
    { id: 'extensions' as const, label: '扩展', count: extensionCount, subtitle: '为 Pi 添加独立扩展，安装后在下次会话生效。' },
    { id: 'packages' as const, label: '软件包', count: packageCount, subtitle: '安装包含扩展、技能、提示模板和主题的软件包。' },
    { id: 'prompts' as const, label: '提示模板', count: promptCount, subtitle: '把常用提示存成 Markdown 模板，在输入框里用 /名称 调用。' },
  ];
  const current = tabs.find((item) => item.id === tab) || tabs[0];
  return (
    <section className="extensions-panel workspace-view" aria-label="定制">
      <div className="pane-layout">
        <nav className="pane-nav" aria-label="定制内容">
          <div className="pane-nav-title">定制</div>
          {tabs.map((item) => (
            <button
              className={`pane-nav-item${tab === item.id ? ' active' : ''}`}
              type="button"
              key={item.id}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              <span>{item.label}</span>
              {item.count ? <span className="pane-nav-count">{item.count}</span> : null}
            </button>
          ))}
        </nav>

        <div className="pane-content">
          <div className="pane-header">
            <div className="pane-header-copy">
              <h2>{current.label}</h2>
              <p className="pane-header-subtitle">{current.subtitle}</p>
            </div>
            <div className="pane-header-actions">
              <button className="pane-close" type="button" aria-label="关闭定制" title="关闭定制" onClick={() => controller.returnToChat()}><Icon name="close" width={16} height={16} /></button>
            </div>
          </div>
          {tab === 'extensions' ? <ExtensionsView snapshot={snapshot} /> : null}
          {tab === 'packages' ? <PackagesView snapshot={snapshot} /> : null}
          {tab === 'prompts' ? <PromptsView snapshot={snapshot} /> : null}
        </div>
      </div>
    </section>
  );
}

function PackageRow({
  item,
  installing,
  busy,
  removing,
  onInstall,
}: {
  item: PackageEntry;
  installing: boolean;
  busy: boolean;
  removing: boolean;
  onInstall(): void;
}) {
  const meta = [
    item.packageType,
    item.downloads ? `${item.downloads} 次下载` : '',
    item.installed ? item.source : '',
  ].filter(Boolean);
  return (
    <div className={`catalog-row${item.installed ? ' installed' : ''}`}>
      <div className="catalog-main">
        <div className="catalog-title-row">
          <div className="catalog-name mono" title={item.source}>{item.name}</div>
          {item.installed ? <span className="catalog-tag ok">已安装{item.version ? ` v${item.version}` : ''}</span> : null}
          {item.installed && !item.enabled ? <span className="catalog-tag warn">已禁用</span> : null}
        </div>
        <div className="catalog-description">{item.description || '该软件包没有提供简介。'}</div>
        {meta.length ? (
          <div className="catalog-meta">
            {meta.map((value) => <span className="catalog-meta-item" key={value}>{value}</span>)}
          </div>
        ) : null}
      </div>
      {item.installed ? (
        <button
          className="catalog-action danger"
          type="button"
          disabled={removing}
          onClick={() => {
            if (window.confirm(`移除 Pi 软件包“${item.source}”？`)) void controller.removePackage(item.source);
          }}
        >
          {removing ? '正在移除…' : '移除'}
        </button>
      ) : (
        <button className="catalog-action" type="button" disabled={busy} onClick={onInstall}>
          {installing ? <span>正在安装…</span> : <><Icon name="download" width={14} height={14} /><span>安装</span></>}
        </button>
      )}
    </div>
  );
}
