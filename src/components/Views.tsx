import { useMemo, useState } from 'react';
import type { AppSnapshot, PiExtensionInfo, ProjectInfo, ThemeId } from '../lib/types';
import { basename, formatRelativeTime } from '../lib/utils';
import { applyTheme, getCurrentTheme, themes } from '../lib/theme';
import { controller } from '../app/controller';
import { Icon } from './Icon';

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
  const thinkingLabels: Record<string, string> = { off: '关闭', minimal: '极简', low: '较低', medium: '中等', high: '较高', xhigh: '最高', max: '最高' };
  const info = snapshot.runtimeInfo;
  return (
    <section className="settings-panel workspace-view">
      <div className="settings-header">
        <div><span className="eyebrow">偏好设置</span><h3>设置</h3><p className="settings-subtitle">管理外观、Pi 运行时和桌面行为</p></div>
        <button className="settings-close" type="button" aria-label="关闭设置" onClick={() => controller.returnToChat()}><Icon name="close" /></button>
      </div>
      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-title">外观</div>
          <div className="theme-grid">
            {(Object.entries(themes) as Array<[ThemeId, (typeof themes)[ThemeId]]>).map(([id, value]) => (
              <button className={`theme-swatch${theme === id ? ' active' : ''}`} data-label={value.name} aria-label={`切换为${value.name}主题`} type="button" key={id} onClick={() => { setTheme(applyTheme(id)); }}>
                <span className="swatch-colors">{value.colors.map((color) => <span className="swatch-dot" style={{ background: color }} key={color} />)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">智能体</div>
          <div className="settings-row"><span className="settings-label">自动压缩上下文</span><Toggle enabled={snapshot.autoCompactionEnabled} label="自动压缩上下文" onChange={(enabled) => void controller.setAutoCompaction(enabled)} /></div>
          <div className="settings-row"><span className="settings-label">思考级别</span><button className="settings-value-btn" type="button" disabled={!snapshot.thinkingSupported} onClick={() => void controller.cycleThinking()}>{snapshot.thinkingSupported ? thinkingLabels[snapshot.thinkingLevel] || snapshot.thinkingLevel : '不可用'}</button></div>
          <div className="settings-row"><span className="settings-label">显示思考过程</span><Toggle enabled={snapshot.showThinking} label="显示思考过程" onChange={(enabled) => controller.setShowThinking(enabled)} /></div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">桌面端</div>
          <div className="settings-row"><span className="settings-label">开机自动启动</span><Toggle enabled={snapshot.autostartEnabled} label="开机自动启动" disabled={!window.tauDesktop.isTauri} onChange={(enabled) => void controller.setAutostart(enabled)} /></div>
          <div className="settings-row"><span className="settings-label">连接方式</span><button className="settings-value-btn" type="button" disabled>{!window.tauDesktop.isTauri ? 'Web 模式' : window.tauDesktop.transport === 'mirror' ? String(snapshot.settings?.tauPort || 3001) : '原生 RPC'}</button></div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">Pi 运行时</div>
          <div className="settings-row"><span className="settings-label">来源</span><span className={`settings-value${info?.bundled || ['system', 'override'].includes(info?.source || '') ? ' ok' : ' warn'}`}>{runtimeSource(snapshot)}</span></div>
          <div className="settings-row"><span className="settings-label">Pi 版本</span><span className="settings-value">{info?.piVersion || '不可用'}</span></div>
          <div className="settings-row"><span className="settings-label">Node 版本</span><span className="settings-value">{info?.nodeVersion || '不可用'}</span></div>
          <div className="settings-row"><span className="settings-label">平台</span><span className="settings-value">{info?.platform || '未知'}</span></div>
          <div className="settings-runtime-path" title={info?.command || ''}>{info?.command || ''}</div>
          {info?.error ? <div className="settings-runtime-warning">{info.error}</div> : null}
        </div>
        {snapshot.authConfigured ? (
          <div className="settings-section"><div className="settings-section-title">身份验证</div><div className="settings-row"><span className="settings-label">需要登录</span><Toggle enabled={snapshot.authEnabled} label="需要登录" onChange={(enabled) => void controller.setAuth(enabled)} /></div></div>
        ) : null}
      </div>
    </section>
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
        <div><span className="eyebrow">能力中心</span><h3>扩展</h3><p className="settings-subtitle">浏览并安装 Pi 全局扩展</p></div>
        <button className="settings-close" type="button" aria-label="关闭扩展" onClick={() => controller.returnToChat()}><Icon name="close" /></button>
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
