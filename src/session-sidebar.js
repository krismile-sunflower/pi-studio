/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

import { invoke } from '@tauri-apps/api/core';

export class SessionSidebar {
  constructor(container, onSessionSelect) {
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.activeSessionFile = null;
    this.projects = [];
    this.collapsedProjects = new Set();
    this.searchQuery = '';
    this.favourites = JSON.parse(localStorage.getItem('tau-favourites') || '[]');
    this.contextMenu = null;

    // Close context menu on click anywhere
    document.addEventListener('click', () => this.closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // Close if right-clicking outside a session item
      if (!e.target.closest('.session-item')) this.closeContextMenu();
    });
  }

  saveFavourites() {
    localStorage.setItem('tau-favourites', JSON.stringify(this.favourites));
  }

  isFavourite(filePath) {
    return this.favourites.includes(filePath);
  }

  toggleFavourite(filePath) {
    const idx = this.favourites.indexOf(filePath);
    if (idx >= 0) {
      this.favourites.splice(idx, 1);
    } else {
      this.favourites.push(filePath);
    }
    this.saveFavourites();
    this.render();
  }

  projectKey(project) {
    return project?.noFolder ? '__no_folder__' : (project?.dirName || project?.path || '');
  }

  async loadSessions() {
    try {
      this.container.innerHTML = Array.from({length: 6}, () =>
        '<div class="session-skeleton"><div class="session-skeleton-title"></div><div class="session-skeleton-meta"></div></div>'
      ).join('');
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        throw new Error(`Session API returned ${res.status}`);
      }
      const data = await res.json();
      const apiProjects = data.projects || [];
      const localProjects = await this.loadLocalSessionsFallback();
      this.projects = this.mergeSessionProjects(apiProjects, localProjects);
      this.render();
    } catch (error) {
      console.error('[Sidebar] Failed to load sessions:', error);
      this.projects = await this.loadLocalSessionsFallback();
      if (this.projects.length > 0) {
        this.render();
        return;
      }
      this.container.innerHTML = '<div class="session-loading">没有找到会话</div>';
    }
  }

  async loadLocalSessionsFallback() {
    if (!window.tauDesktop?.isTauri) return [];

    try {
      const data = await invoke('list_local_sessions');
      return data.projects || [];
    } catch (error) {
      console.error('[Sidebar] Local session fallback failed:', error);
      return [];
    }
  }

  mergeSessionProjects(apiProjects, localProjects) {
    const merged = new Map();

    const addProjects = (projects) => {
      for (const project of projects || []) {
        const key = this.projectKey(project);
        if (!key) continue;

        if (!merged.has(key)) {
          merged.set(key, {
            ...project,
            sessions: [...(project.sessions || [])],
          });
          continue;
        }

        const existing = merged.get(key);
        if (project.noFolder) {
          existing.noFolder = true;
          existing.displayName = project.displayName || '无文件夹';
          existing.path = project.path || existing.path;
        }
        const seenFiles = new Set((existing.sessions || []).map(session => session.filePath || session.file));
        for (const session of project.sessions || []) {
          const sessionKey = session.filePath || session.file;
          if (sessionKey && seenFiles.has(sessionKey)) continue;
          existing.sessions.push(session);
          if (sessionKey) seenFiles.add(sessionKey);
        }
        existing.sessions.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      }
    };

    addProjects(apiProjects);
    addProjects(localProjects);

    return [...merged.values()]
      .filter(project => (project.sessions || []).length > 0)
      .sort((a, b) => ((b.sessions?.[0]?.mtime || 0) - (a.sessions?.[0]?.mtime || 0)));
  }

  setSearchQuery(query) {
    this.searchQuery = query.toLowerCase().trim();

    // Clear pending full-text search
    if (this._searchTimer) clearTimeout(this._searchTimer);

    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }

    // Instant: filter titles
    this.applySearch();

    // Debounced: full-text search (300ms)
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => this.fullTextSearch(this.searchQuery), 300);
    }
  }

  async fullTextSearch(query) {
    // Don't search if query changed since debounce
    if (query !== this.searchQuery) return;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (query !== this.searchQuery) return; // stale

      this._searchResults = data.results || [];
      this.renderSearchResults();
    } catch (err) {
      console.error('[Sidebar] Search failed:', err);
    }
  }

  renderSearchResults() {
    if (!this._searchResults || this._searchResults.length === 0) return;

    // Remove previous search results section
    const existing = this.container.querySelector('.search-results-group');
    if (existing) existing.remove();

    const group = document.createElement('div');
    group.className = 'search-results-group';

    const header = document.createElement('div');
    header.className = 'project-header search-results-header';
    header.innerHTML = `<span>搜索结果</span> <span class="project-count">${this._searchResults.length}</span>`;
    group.appendChild(header);

    const sessionsDiv = document.createElement('div');
    sessionsDiv.className = 'project-sessions';

    for (const result of this._searchResults) {
      const item = document.createElement('div');
      item.className = 'session-item search-result-item';
      item.dataset.filePath = result.filePath;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');

      if (result.filePath === this.activeSessionFile) {
        item.classList.add('active');
      }

      const title = result.sessionName || result.firstMessage || '未命名会话';
      const snippet = result.matches[0]?.snippet || '';
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);

      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        </div>
        <div class="search-snippet">${this.highlightMatch(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${matchCount} 处匹配` : ''}</div>
      `;

      // Find the matching project/session to pass to onSessionSelect
      const selectResult = () => {
        for (const project of this.projects) {
          const session = project.sessions.find(s => s.filePath === result.filePath);
          if (session) {
            this.onSessionSelect(session, project);
            return;
          }
        }
        // Session not in loaded list, try switching by path.
        this.onSessionSelect({ filePath: result.filePath, name: result.sessionName }, { path: result.project });
      };
      item.addEventListener('click', selectResult);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectResult();
        }
      });

      sessionsDiv.appendChild(item);
    }

    group.appendChild(sessionsDiv);
    // Insert at top of container
    this.container.insertBefore(group, this.container.firstChild);
  }

  highlightMatch(text, query) {
    if (!query) return this.escapeHtml(text);
    const escaped = this.escapeHtml(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('hidden'));
      this.container.querySelectorAll('.project-group').forEach(el => el.style.display = '');
      const favSection = this.container.querySelector('.favourites-group');
      if (favSection) favSection.style.display = '';
      // Remove full-text results
      const searchGroup = this.container.querySelector('.search-results-group');
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search favourites section
    const favSection = this.container.querySelector('.favourites-group');
    if (favSection) {
      let hasVisible = false;
      favSection.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      favSection.style.display = hasVisible ? '' : 'none';
    }

    this.container.querySelectorAll('.project-group').forEach(group => {
      let hasVisible = false;
      group.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? '' : 'none';
    });
  }

  setActive(filePath) {
    this.activeSessionFile = filePath;
    this.container.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.filePath === filePath);
    });
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  }

  // Context menu

  showContextMenu(e, session, project, itemEl) {
    e.preventDefault();
    this.closeContextMenu();

    const isFav = this.isFavourite(session.filePath);
    const menu = document.createElement('div');
    menu.className = 'session-context-menu';

    const items = [
      { icon: isFav ? '★' : '☆', label: isFav ? '取消收藏' : '收藏', action: () => this.toggleFavourite(session.filePath) },
      { icon: '✎', label: '重命名', action: () => this.startRename(itemEl) },
      { icon: '↗', label: '导出 HTML', action: () => this.exportSession(session) },
      { icon: '×', label: '删除', danger: true, action: () => this.deleteSession(session, itemEl) },
    ];

    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `context-menu-item${item.danger ? ' danger' : ''}`;
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${item.label}`;
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    // Position
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    this.contextMenu = menu;
  }

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  startRename(itemEl) {
    const titleEl = itemEl.querySelector('.session-title');
    if (!titleEl) return;
    const currentName = titleEl.textContent;

    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.value = currentName;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'set_session_name', name: newName }),
          });
        } catch { /* silent */ }
      }
      const newTitle = document.createElement('div');
      newTitle.className = 'session-title';
      newTitle.title = newName || currentName;
      newTitle.textContent = newName || currentName;
      input.replaceWith(newTitle);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
      if (ke.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  async deleteSession(session, itemEl) {
    if (!confirm(`删除“${session.name || session.firstMessage || '这个会话'}”？`)) return;
    try {
      const res = await fetch('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: session.filePath }),
      });
      if (res.ok) {
        itemEl.remove();
        // Remove from favourites if present
        const favIdx = this.favourites.indexOf(session.filePath);
        if (favIdx >= 0) {
          this.favourites.splice(favIdx, 1);
          this.saveFavourites();
        }
        // If this was the active session, clear it
        if (session.filePath === this.activeSessionFile) {
          this.clearActive();
          if (this.onSessionSelect) this.onSessionSelect(null, null);
        }
        window.dispatchEvent(new CustomEvent('pi-studio:toast', { detail: { title: '会话已删除', type: 'success' } }));
      }
    } catch (e) {
      console.error('[Sidebar] Delete failed:', e);
      window.dispatchEvent(new CustomEvent('pi-studio:toast', { detail: { title: '删除会话失败', message: String(e), type: 'error' } }));
    }
  }

  async exportSession(session) {
    try {
      const data = await (await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'export_html' }),
      })).json();
      if (data?.success && data.data?.path) {
        window.open(`/api/sessions/${encodeURIComponent(data.data.path)}`);
        window.dispatchEvent(new CustomEvent('pi-studio:toast', { detail: { title: '会话已导出', message: data.data.path, type: 'success' } }));
      }
    } catch (error) {
      window.dispatchEvent(new CustomEvent('pi-studio:toast', { detail: { title: '导出失败', message: String(error), type: 'error' } }));
    }
  }

  // Render

  buildSessionItem(session, project) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.filePath = session.filePath;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    if (session.filePath === this.activeSessionFile) {
      item.classList.add('active');
    }

    const title = session.name || session.firstMessage || '空会话';
    const time = this.formatTime(session.timestamp);
    const tmuxTag = session.tmux ? '<span class="session-tag tmux-tag">tmux</span>' : '';
    const liveTag = session.live ? '<span class="session-tag live-tag">live</span>' : '';
    const favIcon = this.isFavourite(session.filePath) ? '<span class="session-fav-icon">★</span>' : '';

    item.innerHTML = `
      <div class="session-title-row">
        ${favIcon}
        <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        ${liveTag}
        ${tmuxTag}
      </div>
      <div class="session-meta">${time}</div>
    `;

    item.addEventListener('click', () => this.onSessionSelect(session, project));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.onSessionSelect(session, project);
      }
    });
    item.addEventListener('contextmenu', (e) => this.showContextMenu(e, session, project, item));

    return item;
  }

  render() {
    if (this.projects.length === 0) {
      this.container.innerHTML = '<div class="session-loading">没有找到会话</div>';
      return;
    }

    this.container.innerHTML = '';

    // Favourites section, collected from all projects.
    const favSessions = [];
    for (const project of this.projects) {
      for (const session of project.sessions) {
        if (this.isFavourite(session.filePath)) {
          favSessions.push({ session, project });
        }
      }
    }

    if (favSessions.length > 0) {
      const favGroup = document.createElement('div');
      favGroup.className = 'favourites-group';

      const header = document.createElement('div');
      header.className = 'project-header favourites-header';
      header.innerHTML = `<span class="fav-star">★</span> <span>收藏</span> <span class="project-count">${favSessions.length}</span>`;
      favGroup.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'project-sessions';
      for (const { session, project } of favSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }
      favGroup.appendChild(sessionsDiv);
      this.container.appendChild(favGroup);
    }

    // Regular project groups
    for (const project of this.projects) {
      const group = document.createElement('div');
      group.className = 'project-group';
      const projectKey = this.projectKey(project);
      const isCollapsed = this.collapsedProjects.has(projectKey);

      const header = document.createElement('div');
      header.className = `project-header${isCollapsed ? ' collapsed' : ''}`;

      const projectPath = project.path || '';
      const pathParts = projectPath.split(/[\\/]/).filter(Boolean);
      const shortPath = project.displayName || (project.noFolder ? '无文件夹' : (pathParts.length > 0 ? pathParts[pathParts.length - 1] : projectPath));

      header.innerHTML = `
        <span class="chevron">&rsaquo;</span>
        <span title="${this.escapeHtml(projectPath)}">${this.escapeHtml(shortPath)}</span>
        <span class="project-count">${project.sessions.length}</span>
      `;

      header.addEventListener('click', () => {
        if (this.collapsedProjects.has(projectKey)) {
          this.collapsedProjects.delete(projectKey);
        } else {
          this.collapsedProjects.add(projectKey);
        }
        header.classList.toggle('collapsed');
        sessionsDiv.classList.toggle('collapsed');
      });

      group.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = `project-sessions${isCollapsed ? ' collapsed' : ''}`;

      for (const session of project.sessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }

      group.appendChild(sessionsDiv);
      this.container.appendChild(group);
    }

    if (this.searchQuery) this.applySearch();
  }

  formatTime(isoTimestamp) {
    try {
      const date = new Date(isoTimestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const days = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return '刚刚';
      if (diffMins < 60) return `${diffMins} 分钟前`;
      if (diffHours < 24) return `${diffHours} 小时前`;
      if (days === 1) return '昨天';
      if (days < 7) return date.toLocaleDateString('zh-CN', { weekday: 'long' });
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
