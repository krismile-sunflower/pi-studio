/**
 * Launcher — searchable project workbench.
 * Public constructor and callback contract intentionally remain unchanged.
 */

export class Launcher {
  constructor(container, onLaunch, onAddProject = null, onOpenWindow = null, onNoFolder = null, onClose = null) {
    this.container = container;
    this.onLaunch = onLaunch;
    this.onAddProject = onAddProject;
    this.onOpenWindow = onOpenWindow;
    this.onNoFolder = onNoFolder;
    this.onClose = onClose;
    this.projects = [];
    this.noFolderActive = false;
    this.busyPath = null;
    this.error = '';
    this.searchQuery = '';
  }

  async load() {
    this.container.innerHTML = '<div class="launcher-loading">正在加载项目…</div>';
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      this.projects = data.projects || [];
      this.noFolderActive = Boolean(data.noFolderActive);
      this.error = data.error || '';
      this.busyPath = null;
      this.render();
    } catch (error) {
      console.error('[Launcher] Failed to load projects:', error);
      this.busyPath = null;
      this.container.innerHTML = '<div class="launcher-loading">项目加载失败，请稍后重试</div>';
    }
  }

  render() {
    const sorted = [...this.projects].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });

    this.container.innerHTML = `
      <div class="launcher-content">
        <div class="launcher-title-row">
          <div class="launcher-heading">
            <span class="eyebrow">工作区</span>
            <h2 class="launcher-title">项目</h2>
            <p class="launcher-subtitle">选择一个项目启动 Pi，或进入无文件夹模式直接开始。</p>
          </div>
          <div class="launcher-title-actions">
            <button class="launcher-action" id="launcher-no-folder" type="button">无文件夹模式</button>
            <button class="launcher-action primary" id="launcher-add-project" type="button">添加项目</button>
            ${this.onClose ? '<button class="launcher-close" id="launcher-close" title="返回聊天" aria-label="返回聊天"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 6-12 12M6 6l12 12"/></svg></button>' : ''}
          </div>
        </div>
        ${this.error ? `<div class="launcher-error">${this.escHtml(this.error)}</div>` : ''}
        <label class="launcher-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="launcher-search-input" type="search" placeholder="搜索项目名称或路径" value="${this.escAttr(this.searchQuery)}" autocomplete="off">
        </label>
        <div class="launcher-grid" id="launcher-grid"></div>
      </div>`;

    const search = this.container.querySelector('#launcher-search-input');
    search?.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderCards(sorted);
    });

    this.container.querySelector('#launcher-no-folder')?.addEventListener('click', () => this.handleNoFolder());
    this.container.querySelector('#launcher-add-project')?.addEventListener('click', () => this.onAddProject?.());
    this.container.querySelector('#launcher-close')?.addEventListener('click', () => this.onClose?.());
    this.renderCards(sorted);
  }

  renderCards(sortedProjects = this.projects) {
    const grid = this.container.querySelector('#launcher-grid');
    if (!grid) return;

    const query = this.searchQuery;
    const projects = sortedProjects.filter((project) => {
      if (!query) return true;
      return `${project.name || ''} ${project.path || ''}`.toLowerCase().includes(query);
    });

    const cards = [];
    if (!query || '无文件夹 no folder'.includes(query)) {
      cards.push(this.noFolderCardHtml());
    }
    cards.push(...projects.map(project => this.projectCardHtml(project)));

    if (cards.length === 0) {
      grid.innerHTML = '<div class="launcher-empty"><strong>没有匹配的项目</strong><p class="hint">尝试搜索其他名称或路径。</p></div>';
      return;
    }

    grid.innerHTML = cards.join('');

    grid.querySelector('[data-no-folder="true"]')?.addEventListener('click', (event) => {
      if (!event.target.closest('button')) this.handleNoFolder();
    });
    grid.querySelector('[data-no-folder-open]')?.addEventListener('click', () => this.handleNoFolder());

    grid.querySelectorAll('[data-project-path]').forEach(card => {
      const projectPath = card.dataset.projectPath;
      const project = this.projects.find(item => item.path === projectPath);
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        this.handleProject(project);
      });
      card.querySelector('[data-project-open]')?.addEventListener('click', () => this.handleProject(project));
      card.querySelector('[data-window-path]')?.addEventListener('click', () => this.onOpenWindow?.(projectPath));
    });
  }

  noFolderCardHtml() {
    const busy = this.busyPath === '__no_folder__';
    return `
      <article class="launcher-card no-folder${this.noFolderActive ? ' active' : ''}" data-no-folder="true">
        <div class="launcher-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/></svg></div>
        <div class="launcher-card-main">
          <div class="launcher-card-name">无文件夹模式 ${this.noFolderActive ? '<span class="launcher-live">运行中</span>' : ''}</div>
          <div class="launcher-card-path">使用 pi-studio 专属目录，不关联本地项目</div>
          <div class="launcher-card-meta"><span>适合快速提问和临时任务</span></div>
        </div>
        <div class="launcher-card-actions"><button class="launcher-card-open" data-no-folder-open type="button" ${this.busyPath ? 'disabled' : ''}>${busy ? '正在启动…' : (this.noFolderActive ? '返回会话' : '打开')}</button></div>
      </article>`;
  }

  projectCardHtml(project) {
    const path = project.path || '';
    const busy = this.busyPath === path;
    const sessionCount = Number(project.sessionCount || 0);
    return `
      <article class="launcher-card${project.active ? ' active' : ''}" data-project-path="${this.escAttr(path)}">
        <div class="launcher-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg></div>
        <div class="launcher-card-main">
          <div class="launcher-card-name">${this.escHtml(project.name || this.basename(path) || '未命名项目')} ${project.active ? '<span class="launcher-live">运行中</span>' : ''}</div>
          <div class="launcher-card-path" title="${this.escAttr(path)}">${this.escHtml(path)}</div>
          <div class="launcher-card-meta"><span>${sessionCount} 个会话</span><span>${this.formatRecency(project.lastActive)}</span></div>
        </div>
        <div class="launcher-card-actions">
          <button class="launcher-window-btn" data-window-path="${this.escAttr(path)}" type="button" title="在新窗口打开" ${this.busyPath ? 'disabled' : ''}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>
          <button class="launcher-card-open" data-project-open type="button" ${this.busyPath ? 'disabled' : ''}>${busy ? '正在启动…' : (project.active ? '返回会话' : '打开')}</button>
        </div>
      </article>`;
  }

  handleProject(project) {
    if (!project || this.busyPath) return;
    if (project.active && this.onClose) this.onClose();
    else this.onLaunch?.(project.path);
  }

  handleNoFolder() {
    if (this.busyPath) return;
    if (this.noFolderActive && this.onClose) this.onClose();
    else this.onNoFolder?.();
  }

  formatRecency(timestamp) {
    if (!timestamp) return '尚未使用';
    const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
    if (!Number.isFinite(value)) return '最近使用';
    const diff = Math.max(0, Date.now() - value);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚使用';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }

  basename(path) {
    return String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
  }

  escHtml(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  escAttr(value) {
    return this.escHtml(value).replace(/"/g, '&quot;');
  }

  setBusy(path) {
    this.busyPath = path;
    this.error = '';
    this.render();
  }

  setError(message) {
    this.error = message || '';
    this.busyPath = null;
    this.render();
  }
}
