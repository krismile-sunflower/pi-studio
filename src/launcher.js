/**
 * Launcher — project directory picker with visual bubbles
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
  }

  async load() {
    this.container.innerHTML = '<div class="launcher-loading">Loading projects…</div>';
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      this.projects = data.projects || [];
      this.noFolderActive = Boolean(data.noFolderActive);
      this.error = data.error || '';
      this.render();
    } catch (e) {
      this.container.innerHTML = '<div class="launcher-loading">Failed to load projects</div>';
    }
  }

  render() {
    if (!this.projects.length) {
      this.container.innerHTML = `
        <div class="launcher-empty">
          <p>No projects directory configured.</p>
          <div class="launcher-empty-actions">
            <button class="launcher-action" id="launcher-no-folder-empty">No folder</button>
            <button class="launcher-action" id="launcher-add-project-empty">Add project</button>
          </div>
        </div>`;
      this.container.querySelector('#launcher-no-folder-empty')?.addEventListener('click', () => {
        if (this.onNoFolder) this.onNoFolder();
      });
      this.container.querySelector('#launcher-add-project-empty')?.addEventListener('click', () => {
        if (this.onAddProject) this.onAddProject();
      });
      return;
    }

    // Find max session count for relative sizing
    const maxSessions = Math.max(1, ...this.projects.map(p => p.sessionCount));
    const now = Date.now();

    // Sort: active first, then by recency
    const sorted = [...this.projects].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });

    const noFolderBubble = `
      <button class="launcher-bubble no-folder${this.noFolderActive ? ' active' : ''}"
              data-no-folder="true"
              style="--size: 0.9; --freshness: ${this.noFolderActive ? '1' : '0.35'}"
              ${this.busyPath ? 'disabled' : ''}
              title="No folder">
        <span class="launcher-bubble-name">${this.busyPath === '__no_folder__' ? 'Starting...' : 'No folder'}</span>
        ${this.noFolderActive ? '<span class="launcher-bubble-dot"></span>' : ''}
      </button>`;

    const bubbles = sorted.map(p => {
      // Size: scale between 0.7 and 1.3 based on session count
      const sizeRatio = 0.7 + (p.sessionCount / maxSessions) * 0.6;

      // Recency: how fresh is this project (0 = ancient, 1 = today)
      let freshness = 0;
      if (p.lastActive) {
        const ageMs = now - p.lastActive;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        freshness = Math.max(0, 1 - (ageDays / 30)); // fades over 30 days
      }

      return `
        <button class="launcher-bubble${p.active ? ' active' : ''}"
                data-path="${this.escAttr(p.path)}"
                style="--size: ${sizeRatio}; --freshness: ${freshness.toFixed(2)}"
                ${this.busyPath ? 'disabled' : ''}
                title="${this.escAttr(p.path)}${p.active ? ' (running)' : ''}${p.sessionCount ? ` • ${p.sessionCount} session${p.sessionCount !== 1 ? 's' : ''}` : ''}">
          <span class="launcher-bubble-name">${this.busyPath === p.path ? 'Starting...' : this.escHtml(p.name)}</span>
          <span class="launcher-window-btn" data-window-path="${this.escAttr(p.path)}" title="Open in new window">□</span>
          ${p.active ? '<span class="launcher-bubble-dot"></span>' : ''}
        </button>`;
    }).join('');

    this.container.innerHTML = `
      <div class="launcher-content">
        <div class="launcher-title-row">
          <div class="launcher-title">Projects</div>
          <div class="launcher-title-actions">
            <button class="launcher-action" id="launcher-no-folder">No folder</button>
            <button class="launcher-action" id="launcher-add-project">Add project</button>
            ${this.onClose ? '<button class="launcher-close" id="launcher-close" title="Back to chat" aria-label="Back to chat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' : ''}
          </div>
        </div>
        ${this.error ? `<div class="launcher-error">${this.escHtml(this.error)}</div>` : ''}
        <div class="launcher-grid">${noFolderBubble}${bubbles}</div>
      </div>`;

    this.container.querySelector('#launcher-no-folder')?.addEventListener('click', () => {
      if (this.onNoFolder) this.onNoFolder();
    });

    this.container.querySelector('#launcher-add-project')?.addEventListener('click', () => {
      if (this.onAddProject) this.onAddProject();
    });

    this.container.querySelector('#launcher-close')?.addEventListener('click', () => {
      if (this.onClose) this.onClose();
    });

    // Bind click handlers
    this.container.querySelectorAll('.launcher-bubble').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.noFolder === 'true') {
          if (this.noFolderActive && this.onClose) {
            this.onClose();
            return;
          }
          if (this.onNoFolder) this.onNoFolder();
          return;
        }
        const projectPath = btn.dataset.path;
        const project = this.projects.find(p => p.path === projectPath);
        if (project?.active && this.onClose) {
          this.onClose();
          return;
        }
        if (this.onLaunch) this.onLaunch(projectPath);
      });
    });

    this.container.querySelectorAll('.launcher-window-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const projectPath = btn.dataset.windowPath;
        if (this.onOpenWindow) this.onOpenWindow(projectPath);
      });
    });
  }

  escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  escAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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
