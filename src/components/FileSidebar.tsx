import { useEffect, useMemo, useState } from 'react';
import { apiJson, postJson } from '../lib/desktop';
import type { FileAttachment } from '../lib/types';
import { Icon } from './Icon';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

interface FileListResponse {
  path: string;
  items: FileItem[];
}

interface FileContentResponse {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'unsupported';
  mimeType: string;
  size: number;
  content?: string;
  truncated: boolean;
  language: string;
  reason?: string;
}

interface FileSidebarProps {
  rootPath: string;
  open: boolean;
  onClose(): void;
  onInsert(file: FileAttachment): void;
}

function formatSize(size?: number): string {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(item: FileItem): string {
  if (item.isDirectory) return '▸';
  const extension = item.name.split('.').pop()?.toLowerCase();
  const labels: Record<string, string> = {
    ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', rs: 'RS', py: 'PY', json: '{}', md: 'MD', css: '#', html: '<>', toml: 'T', yaml: 'Y', yml: 'Y',
  };
  return labels[extension || ''] || '·';
}

export function FileSidebar({ rootPath, open, onClose, onInsert }: FileSidebarProps) {
  const [itemsByPath, setItemsByPath] = useState<Record<string, FileItem[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<FileContentResponse | null>(null);

  const load = async (path: string) => {
    if (!path) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiJson<FileListResponse>(`/api/files?path=${encodeURIComponent(path)}`);
      setItemsByPath((current) => ({ ...current, [path]: data.items || [] }));
    } catch (value) {
      setError(String(value));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItemsByPath({});
    setExpanded(new Set());
    setPreview(null);
    if (open && rootPath) void load(rootPath);
  }, [open, rootPath]);

  const rootItems = itemsByPath[rootPath] || [];

  const openPreview = async (item: FileItem) => {
    try {
      const content = await apiJson<FileContentResponse>(`/api/file/content?path=${encodeURIComponent(item.path)}`);
      setPreview(content);
    } catch (value) {
      setError(String(value));
    }
  };

  const insert = (item: FileItem) => {
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    onInsert({ path: item.path, name: item.name, ext });
  };

  const toggleDirectory = async (item: FileItem) => {
    const willExpand = !expanded.has(item.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (willExpand) next.add(item.path); else next.delete(item.path);
      return next;
    });
    if (willExpand && !itemsByPath[item.path]) await load(item.path);
  };

  const renderItems = (items: FileItem[], depth: number): React.ReactNode =>
    items.map((item) => {
      const isExpanded = expanded.has(item.path);
      return (
        <div key={item.path}>
          <div
            className={`file-item${item.isDirectory ? ' directory' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            role="treeitem"
            aria-expanded={item.isDirectory ? isExpanded : undefined}
            tabIndex={0}
            draggable={!item.isDirectory}
            onClick={() => item.isDirectory ? void toggleDirectory(item) : void openPreview(item)}
            onDoubleClick={() => !item.isDirectory && insert(item)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') item.isDirectory ? void toggleDirectory(item) : void openPreview(item);
            }}
            onDragStart={(event) => {
              if (!item.isDirectory) event.dataTransfer.setData('text/plain', item.path);
            }}
          >
            <span className={`file-chevron${item.isDirectory ? '' : ' placeholder'}${isExpanded ? ' expanded' : ''}`}>›</span>
            <span className="file-icon">{fileIcon(item)}</span>
            <span className="file-name" title={item.path}>{item.name}</span>
            <span className="file-size">{formatSize(item.size)}</span>
            {!item.isDirectory ? (
              <span className="file-row-actions">
                <button className="file-row-action insert" type="button" title="添加到消息" onClick={(event) => { event.stopPropagation(); insert(item); }}>+</button>
                <button className="file-row-action open" type="button" title="在 VS Code 中打开" onClick={(event) => { event.stopPropagation(); void postJson('/api/open-editor', { filePath: item.path }); }}>↗</button>
              </span>
            ) : null}
          </div>
          {item.isDirectory && isExpanded ? renderItems(itemsByPath[item.path] || [], depth + 1) : null}
        </div>
      );
    });

  const previewLines = useMemo(() => preview?.kind === 'text' ? (preview.content || '').split('\n') : [], [preview]);

  return (
    <>
      <div className={`file-sidebar-overlay${open ? ' visible' : ''}`} onClick={onClose} />
      <aside className={`file-sidebar${open ? '' : ' collapsed'}`} aria-label="文件浏览器">
        <div className="file-sidebar-header">
          <div><span className="eyebrow">工作区</span><strong className="file-sidebar-title">文件</strong></div>
          <div className="file-sidebar-actions">
            <button className="icon-btn" type="button" title="全部折叠" aria-label="全部折叠" onClick={() => setExpanded(new Set())}><Icon name="arrow-left" width={14} height={14} style={{ transform: 'rotate(90deg)' }} /></button>
            <button className="icon-btn" type="button" title="在文件管理器中打开" aria-label="在文件管理器中打开" disabled={!rootPath} onClick={() => void postJson('/api/open', { filePath: rootPath })}><Icon name="folder" width={14} height={14} /></button>
            <button className="icon-btn" type="button" title="关闭文件栏" aria-label="关闭文件栏" onClick={onClose}><Icon name="close" width={14} height={14} /></button>
          </div>
        </div>
        <div className="file-sidebar-path" title={rootPath}>{rootPath}</div>
        <div className="file-list file-browser-host">
          {preview ? (
            <div className="file-preview-view">
              <div className="file-preview-shell">
                <div className="file-preview-header">
                  <button className="file-preview-back" type="button" onClick={() => setPreview(null)}>‹ 返回</button>
                  <div className="file-preview-info"><strong className="file-preview-name">{preview.name}</strong><span className="file-preview-meta">{preview.language} · {formatSize(preview.size)}</span></div>
                  <div className="file-preview-actions">
                    <button className="file-preview-action insert" type="button" onClick={() => insert({ name: preview.name, path: preview.path, isDirectory: false })}>添加到消息</button>
                    <button className="file-preview-action open" type="button" onClick={() => void postJson('/api/open-editor', { filePath: preview.path })}>在编辑器中打开</button>
                  </div>
                </div>
                <div className="file-preview-content">
                  {preview.kind === 'image' && preview.content ? <div className="file-preview-image-wrap"><img className="file-preview-image" src={`data:${preview.mimeType};base64,${preview.content}`} alt={preview.name} /></div> : null}
                  {preview.kind === 'text' ? <code className="file-preview-code">{previewLines.map((line, index) => <span className="file-preview-line" key={index}><span className="file-preview-line-number">{index + 1}</span><span className="file-preview-line-content">{line || ' '}</span></span>)}</code> : null}
                  {preview.kind === 'unsupported' ? <div className="file-preview-unsupported">{preview.reason || '此文件无法预览。'}</div> : null}
                  {preview.truncated ? <div className="file-preview-notice">文件较大，仅显示前 1 MiB。</div> : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="file-tree-view" role="tree" aria-label="项目文件树">
              {!rootPath ? <div className="file-loading">请先打开一个项目</div> : null}
              {loading && rootItems.length === 0 ? <div className="file-loading loading">正在加载文件…</div> : null}
              {error ? <div className="file-tree-status error">{error}</div> : null}
              {renderItems(rootItems, 0)}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
