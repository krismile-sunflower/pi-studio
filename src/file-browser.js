/**
 * File Browser — lazy workspace tree, read-only preview and file references.
 */

const FILE_ICONS = {
  directory: 'DIR',
  js: 'JS', ts: 'TS', jsx: 'JSX', tsx: 'TSX',
  py: 'PY', rb: 'RB', go: 'GO', rs: 'RS',
  html: 'HTML', css: 'CSS', svg: 'SVG',
  json: 'JSON', yaml: 'YML', yml: 'YML', toml: 'TOML',
  xml: 'XML', csv: 'CSV',
  md: 'MD', txt: 'TXT', rst: 'RST',
  png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'GIF',
  webp: 'IMG', ico: 'ICO',
  env: 'ENV', gitignore: 'GIT', lock: 'LOCK',
  default: 'FILE',
};

const MAX_RENDERED_LINES = 10000;

export function getFileIcon(name, isDirectory) {
  if (isDirectory) return FILE_ICONS.directory;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function basename(filePath) {
  return String(filePath || '').split(/[/\\]/).filter(Boolean).pop() || filePath || '';
}

export class FileBrowser {
  constructor(container, pathEl, messageInput, onFileInserted = null) {
    this.container = container;
    this.pathEl = pathEl;
    this.messageInput = messageInput;
    this.onFileInserted = onFileInserted;
    this.currentPath = null;
    this.rootPath = null;
    this.selectedPath = null;
    this.previewPath = null;
    this.treeScrollTop = 0;
    this.rootLoadId = 0;
    this.expandedPaths = new Set();
    this.childrenCache = new Map();
    this.loadingPaths = new Set();
    this.setupViews();
    this.setupDropTarget();
  }

  setupViews() {
    this.container.classList.add('file-browser-host');
    this.treeView = document.createElement('div');
    this.treeView.className = 'file-tree-view';
    this.treeView.setAttribute('role', 'tree');
    this.treeView.setAttribute('aria-label', '项目文件树');

    this.previewView = document.createElement('div');
    this.previewView.className = 'file-preview-view hidden';

    this.container.replaceChildren(this.treeView, this.previewView);
    this.renderEmptyTree('请先打开一个项目');
  }

  async setRoot(rootPath, { force = false } = {}) {
    const nextRoot = String(rootPath || '').trim();
    if (!nextRoot) {
      this.rootPath = null;
      this.currentPath = null;
      this.pathEl.textContent = '';
      this.pathEl.title = '';
      this.expandedPaths.clear();
      this.childrenCache.clear();
      this.showTree();
      this.renderEmptyTree('请先打开一个项目');
      return;
    }
    if (!force && this.rootPath === nextRoot && this.childrenCache.has(this.rootPath)) return;

    const loadId = ++this.rootLoadId;
    this.rootPath = nextRoot;
    this.currentPath = nextRoot;
    this.selectedPath = null;
    this.previewPath = null;
    this.treeScrollTop = 0;
    this.expandedPaths.clear();
    this.childrenCache.clear();
    this.loadingPaths.clear();
    this.showTree();
    this.renderEmptyTree('正在加载文件…', true);

    try {
      const data = await this.fetchDirectory(nextRoot);
      if (loadId !== this.rootLoadId) return;
      this.rootPath = data.path;
      this.currentPath = data.path;
      this.pathEl.textContent = data.path;
      this.pathEl.title = data.path;
      this.childrenCache.set(data.path, data.items || []);
      this.renderTree();
    } catch (error) {
      if (loadId !== this.rootLoadId) return;
      this.renderEmptyTree(this.errorText(error, '文件加载失败'));
    }
  }

  async load(dirPath = null) {
    if (dirPath || !this.rootPath) {
      await this.setRoot(dirPath || this.rootPath, { force: true });
      return;
    }
    await this.setRoot(this.rootPath, { force: true });
  }

  getParentPath() {
    return null;
  }

  async fetchDirectory(dirPath) {
    const url = dirPath ? `/api/files?path=${encodeURIComponent(dirPath)}` : '/api/files';
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `文件加载失败（${response.status}）`);
    return data;
  }

  async toggleDirectory(item, row = null) {
    const path = item.path;
    if (this.expandedPaths.has(path)) {
      this.expandedPaths.delete(path);
      this.renderTree();
      this.focusPath(path);
      return;
    }

    this.expandedPaths.add(path);
    if (!this.childrenCache.has(path) && !this.loadingPaths.has(path)) {
      this.loadingPaths.add(path);
      this.renderTree();
      try {
        const data = await this.fetchDirectory(path);
        this.childrenCache.set(path, data.items || []);
      } catch (error) {
        this.childrenCache.set(path, { error: this.errorText(error, '文件夹加载失败') });
      } finally {
        this.loadingPaths.delete(path);
      }
    }
    this.renderTree();
    this.focusPath(path, row);
  }

  collapseAll() {
    this.expandedPaths.clear();
    this.renderTree();
    this.treeView.querySelector('.file-item')?.focus();
  }

  renderTree() {
    this.treeView.innerHTML = '';
    if (!this.rootPath) {
      this.renderEmptyTree('请先打开一个项目');
      return;
    }

    const items = this.childrenCache.get(this.rootPath);
    if (!Array.isArray(items) || items.length === 0) {
      this.renderEmptyTree('此项目中没有可显示的文件');
      return;
    }

    const fragment = document.createDocumentFragment();
    this.appendItems(fragment, items, 0, this.rootPath);
    this.treeView.appendChild(fragment);
  }

  appendItems(fragment, items, depth, parentPath) {
    for (const item of items) {
      const row = this.createRow(item, depth, parentPath);
      fragment.appendChild(row);

      if (!item.isDirectory || !this.expandedPaths.has(item.path)) continue;
      if (this.loadingPaths.has(item.path)) {
        fragment.appendChild(this.createTreeStatus('正在加载…', depth + 1));
        continue;
      }

      const children = this.childrenCache.get(item.path);
      if (children?.error) {
        fragment.appendChild(this.createTreeStatus(children.error, depth + 1, true));
      } else if (Array.isArray(children) && children.length > 0) {
        this.appendItems(fragment, children, depth + 1, item.path);
      } else {
        fragment.appendChild(this.createTreeStatus('空文件夹', depth + 1));
      }
    }
  }

  createRow(item, depth, parentPath) {
    const row = document.createElement('div');
    row.className = `file-item${item.isDirectory ? ' directory' : ''}${item.path === this.selectedPath ? ' selected' : ''}`;
    row.style.setProperty('--tree-depth', depth);
    row.dataset.path = item.path;
    row.dataset.parentPath = parentPath;
    row.dataset.name = item.name;
    row.dataset.isDirectory = String(item.isDirectory);
    row.draggable = true;
    row.tabIndex = 0;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    if (item.isDirectory) row.setAttribute('aria-expanded', String(this.expandedPaths.has(item.path)));

    const chevron = document.createElement('span');
    chevron.className = `file-chevron${item.isDirectory ? '' : ' placeholder'}`;
    chevron.innerHTML = item.isDirectory
      ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="m3 2 3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = getFileIcon(item.name, item.isDirectory);

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.name;
    name.title = item.name;

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = item.isDirectory ? '' : formatSize(item.size);

    const actions = document.createElement('span');
    actions.className = 'file-row-actions';
    actions.append(
      this.createRowAction('添加到对话', 'attach', () => this.insertPath(item.path)),
      this.createRowAction('在 VS Code 中打开', 'editor', () => this.openEditor(item.path))
    );

    row.append(chevron, icon, name, size, actions);
    row.addEventListener('click', (event) => {
      if (event.target.closest('.file-row-action')) return;
      if (event.detail > 1) return;
      if (item.isDirectory) this.toggleDirectory(item, row);
      else this.previewFile(item);
    });
    row.addEventListener('dblclick', (event) => {
      if (item.isDirectory || event.target.closest('.file-row-action')) return;
      event.preventDefault();
      this.openEditor(item.path);
    });
    row.addEventListener('keydown', (event) => this.handleRowKeydown(event, item, row));
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', item.path);
      event.dataTransfer.effectAllowed = 'copy';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    return row;
  }

  createRowAction(label, type, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `file-row-action ${type}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = type === 'attach'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 9 4 12l4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  }

  createTreeStatus(text, depth, error = false) {
    const status = document.createElement('div');
    status.className = `file-tree-status${error ? ' error' : ''}`;
    status.style.setProperty('--tree-depth', depth);
    status.textContent = text;
    return status;
  }

  renderEmptyTree(text, loading = false) {
    this.treeView.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = `file-loading${loading ? ' loading' : ''}`;
    empty.textContent = text;
    this.treeView.appendChild(empty);
  }

  handleRowKeydown(event, item, row) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      const rows = [...this.treeView.querySelectorAll('.file-item')];
      const currentIndex = rows.indexOf(row);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
      event.preventDefault();
      rows[nextIndex]?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (item.isDirectory) this.toggleDirectory(item, row);
      else this.previewFile(item);
      return;
    }
    if (event.key === 'ArrowRight' && item.isDirectory) {
      event.preventDefault();
      if (!this.expandedPaths.has(item.path)) this.toggleDirectory(item, row);
      else this.focusFirstChild(item.path);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (item.isDirectory && this.expandedPaths.has(item.path)) {
        this.toggleDirectory(item, row);
      } else {
        this.focusPath(row.dataset.parentPath);
      }
    }
  }

  focusFirstChild(parentPath) {
    this.treeView.querySelector(`[data-parent-path="${CSS.escape(parentPath)}"]`)?.focus();
  }

  focusPath(path, fallback = null) {
    requestAnimationFrame(() => {
      const row = path ? this.treeView.querySelector(`[data-path="${CSS.escape(path)}"]`) : null;
      (row || fallback)?.focus();
    });
  }

  async previewFile(item) {
    this.selectedPath = item.path;
    this.previewPath = item.path;
    this.treeScrollTop = this.treeView.scrollTop;
    this.renderTree();
    this.previewView.classList.remove('hidden');
    this.treeView.classList.add('hidden');
    this.previewView.innerHTML = '<div class="file-preview-loading">正在读取文件…</div>';

    try {
      const response = await fetch(`/api/file/content?path=${encodeURIComponent(item.path)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `文件读取失败（${response.status}）`);
      if (this.previewPath !== item.path) return;
      this.renderPreview(data);
    } catch (error) {
      if (this.previewPath !== item.path) return;
      this.renderPreviewError(item, this.errorText(error, '文件读取失败'));
    }
  }

  renderPreview(data) {
    this.previewView.innerHTML = '';
    const shell = this.createPreviewShell(data);
    const content = shell.querySelector('.file-preview-content');

    if (data.truncated) {
      const notice = document.createElement('div');
      notice.className = 'file-preview-notice';
      notice.textContent = '文件较大，仅显示前 1 MiB 内容。';
      content.appendChild(notice);
    }

    if (data.kind === 'image' && data.content) {
      const imageWrap = document.createElement('div');
      imageWrap.className = 'file-preview-image-wrap';
      const image = document.createElement('img');
      image.className = 'file-preview-image';
      image.src = `data:${data.mimeType || 'image/png'};base64,${data.content}`;
      image.alt = data.name || '文件图片预览';
      imageWrap.appendChild(image);
      content.appendChild(imageWrap);
    } else if (data.kind === 'text') {
      content.appendChild(this.createTextPreview(data.content || ''));
    } else {
      content.appendChild(this.createUnsupportedPreview(data.reason || '此文件无法在应用内预览。'));
    }

    this.previewView.appendChild(shell);
  }

  createPreviewShell(data) {
    const shell = document.createElement('div');
    shell.className = 'file-preview-shell';

    const header = document.createElement('div');
    header.className = 'file-preview-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'file-preview-back';
    back.title = '返回文件树';
    back.setAttribute('aria-label', '返回文件树');
    back.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>';
    back.addEventListener('click', () => this.showTree());

    const info = document.createElement('div');
    info.className = 'file-preview-info';
    const name = document.createElement('strong');
    name.className = 'file-preview-name';
    name.textContent = data.name || basename(data.path);
    name.title = data.path || '';
    const meta = document.createElement('span');
    meta.className = 'file-preview-meta';
    meta.textContent = [this.relativePath(data.path), formatSize(data.size), data.language || 'file'].filter(Boolean).join(' · ');
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'file-preview-actions';
    const copy = this.createPreviewAction('复制内容', 'copy', () => this.copyPreviewContent(data));
    copy.disabled = data.kind !== 'text';
    actions.append(
      this.createPreviewAction('添加到对话', 'attach', () => this.insertPath(data.path)),
      copy,
      this.createPreviewAction('在 VS Code 中打开', 'editor', () => this.openEditor(data.path))
    );
    header.append(back, info, actions);

    const content = document.createElement('div');
    content.className = 'file-preview-content';
    shell.append(header, content);
    return shell;
  }

  createPreviewAction(label, type, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `file-preview-action ${type}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = type === 'attach' ? '+' : type === 'copy' ? '复制' : 'VS Code';
    button.addEventListener('click', handler);
    return button;
  }

  createTextPreview(text) {
    const code = document.createElement('div');
    code.className = 'file-preview-code';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const displayed = lines.slice(0, MAX_RENDERED_LINES);
    const fragment = document.createDocumentFragment();
    displayed.forEach((line, index) => {
      const row = document.createElement('div');
      row.className = 'file-preview-line';
      const number = document.createElement('span');
      number.className = 'file-preview-line-number';
      number.textContent = String(index + 1);
      const value = document.createElement('span');
      value.className = 'file-preview-line-content';
      value.textContent = line || ' ';
      row.append(number, value);
      fragment.appendChild(row);
    });
    code.appendChild(fragment);
    if (lines.length > displayed.length) {
      const limit = document.createElement('div');
      limit.className = 'file-preview-line-limit';
      limit.textContent = `内容超过 ${MAX_RENDERED_LINES.toLocaleString()} 行，请在 VS Code 中继续查看。`;
      code.appendChild(limit);
    }
    return code;
  }

  createUnsupportedPreview(reason) {
    const empty = document.createElement('div');
    empty.className = 'file-preview-unsupported';
    empty.innerHTML = '<span class="file-preview-unsupported-icon">FILE</span><strong>无法在应用内预览</strong>';
    const message = document.createElement('p');
    message.textContent = reason;
    empty.appendChild(message);
    return empty;
  }

  renderPreviewError(item, message) {
    this.previewView.innerHTML = '';
    const shell = this.createPreviewShell({
      path: item.path,
      name: item.name,
      size: item.size,
      language: 'file',
      kind: 'unsupported',
    });
    shell.querySelector('.file-preview-content').appendChild(this.createUnsupportedPreview(message));
    this.previewView.appendChild(shell);
  }

  showTree() {
    this.previewPath = null;
    this.previewView.classList.add('hidden');
    this.treeView.classList.remove('hidden');
    requestAnimationFrame(() => {
      this.treeView.scrollTop = this.treeScrollTop;
      this.focusPath(this.selectedPath);
    });
  }

  relativePath(filePath) {
    if (!this.rootPath || !filePath) return basename(filePath);
    const normalizedRoot = this.rootPath.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = filePath.replace(/\\/g, '/');
    return normalizedPath.startsWith(`${normalizedRoot}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : basename(filePath);
  }

  async copyPreviewContent(data) {
    if (data.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(data.content || '');
      this.toast('文件内容已复制', '', 'success');
    } catch (error) {
      this.toast('复制失败', String(error), 'error');
    }
  }

  async openEditor(filePath, line = null, column = null) {
    try {
      const response = await fetch('/api/open-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, line, column }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `打开失败（${response.status}）`);
    } catch (error) {
      this.toast('无法打开 VS Code', this.errorText(error, '请确认已安装 VS Code'), 'error');
    }
  }

  async openNatively(filePath) {
    try {
      const response = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `打开失败（${response.status}）`);
    } catch (error) {
      this.toast('无法打开文件', this.errorText(error, ''), 'error');
    }
  }

  insertPath(filePath) {
    const input = this.messageInput;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.substring(0, start) + filePath + ' ' + input.value.substring(end);
    input.selectionStart = input.selectionEnd = start + filePath.length + 1;
    input.focus();
    input.dispatchEvent(new Event('input'));
    if (this.onFileInserted) this.onFileInserted(filePath);
    this.toast('已添加到对话', basename(filePath), 'success');
  }

  toast(title, message = '', type = 'info') {
    window.dispatchEvent(new CustomEvent('pi-studio:toast', {
      detail: { title, message, type },
    }));
  }

  errorText(error, fallback) {
    const text = error?.message || String(error || '');
    return text || fallback;
  }

  setupDropTarget() {
    const input = this.messageInput;
    input.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      input.classList.add('file-drop-hover');
    });
    input.addEventListener('dragleave', () => input.classList.remove('file-drop-hover'));
    input.addEventListener('drop', (event) => {
      event.preventDefault();
      input.classList.remove('file-drop-hover');
      const filePath = event.dataTransfer.getData('text/plain');
      if (filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath))) {
        this.insertPath(filePath);
      }
    });
  }
}
