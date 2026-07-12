import { useEffect, useMemo, useState } from 'react';
import { apiJson, postJson } from '../lib/desktop';
import type { AppSnapshot, FileAttachment, GitChange, TimelineItem, ToolExecution } from '../lib/types';
import { Icon } from './Icon';
import { controller } from '../app/controller';

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

interface GitChangeTreeNode {
  name: string;
  path: string;
  change?: GitChange;
  children: Map<string, GitChangeTreeNode>;
}

type WorkspaceTab = 'plan' | 'changes' | 'files' | 'terminal';
type TaskPlanStatus = 'pending' | 'in_progress' | 'complete';

interface TaskPlanItem {
  id: string;
  title: string;
  status: TaskPlanStatus;
}

interface FileSidebarProps {
  rootPath: string;
  open: boolean;
  snapshot: AppSnapshot;
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

function gitChangeLabel(indexStatus: string, worktreeStatus: string): string {
  const status = `${indexStatus}${worktreeStatus}`;
  if (status.includes('A') || status === '??') return '新增';
  if (status.includes('D')) return '删除';
  if (status.includes('R')) return '重命名';
  return '修改';
}

function buildGitChangeTree(changes: GitChange[]): GitChangeTreeNode {
  const root: GitChangeTreeNode = { name: '', path: '', children: new Map() };
  for (const change of changes) {
    const parts = change.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let current = root;
    parts.forEach((name, index) => {
      const path = current.path ? `${current.path}/${name}` : name;
      let node = current.children.get(name);
      if (!node) {
        node = { name, path, children: new Map() };
        current.children.set(name, node);
      }
      if (index === parts.length - 1) node.change = change;
      current = node;
    });
  }
  return root;
}

function latestUserRequest(timeline: TimelineItem[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.kind === 'message' && item.message.role === 'user' && item.message.content.trim()) return item.message.content;
  }
  return '';
}

function isTerminalTool(tool: ToolExecution): boolean {
  return /(?:command|terminal|shell|powershell|bash|exec|run)/i.test(tool.toolName);
}

function terminalCommand(tool: ToolExecution): string {
  for (const key of ['command', 'cmd', 'script', 'input']) {
    const value = tool.args[key];
    if (typeof value === 'string' && value) return value;
  }
  return tool.toolName;
}

function readTaskPlan(key: string): TaskPlanItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Partial<TaskPlanItem>;
      return typeof value.id === 'string' && typeof value.title === 'string' && ['pending', 'in_progress', 'complete'].includes(value.status || '')
        ? [{ id: value.id, title: value.title, status: value.status as TaskPlanStatus }]
        : [];
    });
  } catch {
    return [];
  }
}

function nextTaskPlanStatus(status: TaskPlanStatus): TaskPlanStatus {
  return status === 'pending' ? 'in_progress' : status === 'in_progress' ? 'complete' : 'pending';
}

export function FileSidebar({ rootPath, open, snapshot, onClose, onInsert }: FileSidebarProps) {
  const [itemsByPath, setItemsByPath] = useState<Record<string, FileItem[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<FileContentResponse | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('files');
  const [expandedChangePaths, setExpandedChangePaths] = useState<Set<string>>(new Set());
  const [planDraft, setPlanDraft] = useState('');
  const planStorageKey = useMemo(() => `pi-studio:task-plan:${rootPath || 'no-folder'}:${snapshot.selectedSessionFile || 'active'}`, [rootPath, snapshot.selectedSessionFile]);
  const [taskPlan, setTaskPlan] = useState<TaskPlanItem[]>(() => readTaskPlan(planStorageKey));

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

  useEffect(() => {
    if (open && tab === 'changes') void controller.loadGitStatus();
  }, [open, rootPath, tab]);

  useEffect(() => {
    setTaskPlan(readTaskPlan(planStorageKey));
    setPlanDraft('');
  }, [planStorageKey]);

  const rootItems = itemsByPath[rootPath] || [];
  const gitChangeTree = useMemo(() => buildGitChangeTree(snapshot.gitStatus?.changes || []), [snapshot.gitStatus?.changes]);
  const taskRequest = useMemo(() => latestUserRequest(snapshot.timeline), [snapshot.timeline]);
  const toolCount = useMemo(() => snapshot.timeline.filter((item) => item.kind === 'tool').length, [snapshot.timeline]);
  const terminalTools = useMemo(() => snapshot.timeline.filter((item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool').map((item) => item.tool).filter(isTerminalTool).reverse(), [snapshot.timeline]);
  const completedPlanCount = taskPlan.filter((item) => item.status === 'complete').length;
  const saveTaskPlan = (next: TaskPlanItem[]) => {
    setTaskPlan(next);
    localStorage.setItem(planStorageKey, JSON.stringify(next));
  };
  const addTaskPlanItem = () => {
    const title = planDraft.trim();
    if (!title) return;
    saveTaskPlan([...taskPlan, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, status: taskPlan.some((item) => item.status === 'in_progress') ? 'pending' : 'in_progress' }]);
    setPlanDraft('');
  };

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

  const renderGitChanges = (node: GitChangeTreeNode, depth: number): React.ReactNode =>
    [...node.children.values()]
      .sort((left, right) => {
        if (Boolean(left.change) !== Boolean(right.change)) return left.change ? 1 : -1;
        return left.name.localeCompare(right.name);
      })
      .map((child) => {
        const isDirectory = !child.change;
        const isExpanded = expandedChangePaths.has(child.path);
        if (isDirectory) {
          return (
            <div key={child.path}>
              <button
                className="file-change-directory"
                type="button"
                style={{ paddingLeft: 10 + depth * 14 }}
                aria-expanded={isExpanded}
                onClick={() => setExpandedChangePaths((current) => {
                  const next = new Set(current);
                  if (next.has(child.path)) next.delete(child.path); else next.add(child.path);
                  return next;
                })}
              >
                <Icon name="arrow-left" width={12} className={`file-change-chevron${isExpanded ? ' expanded' : ''}`} />
                <Icon name="folder" width={14} />
                <span>{child.name}</span>
              </button>
              {isExpanded ? renderGitChanges(child, depth + 1) : null}
            </div>
          );
        }
        const change = child.change!;
        return (
          <button className={`file-change-row${snapshot.selectedGitPath === change.path ? ' active' : ''}`} type="button" key={change.path} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => void controller.selectGitChange(change.path)}>
            <span className={`file-change-status ${gitChangeLabel(change.indexStatus, change.worktreeStatus)}`}>{gitChangeLabel(change.indexStatus, change.worktreeStatus)}</span>
            <span className="file-change-path" title={change.path}>{child.name}</span>
          </button>
        );
      });

  const previewLines = useMemo(() => preview?.kind === 'text' ? (preview.content || '').split('\n') : [], [preview]);

  return (
    <>
      <div className={`file-sidebar-overlay${open ? ' visible' : ''}`} onClick={onClose} />
      <aside className={`file-sidebar${open ? '' : ' collapsed'}`} aria-label="文件浏览器">
        <div className="file-sidebar-header">
          <div>
            <span className="eyebrow">工作区</span>
            <div className="file-sidebar-tabs" role="tablist" aria-label="工作区视图">
              <button className={tab === 'plan' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'plan'} onClick={() => setTab('plan')}>计划</button>
              <button className={tab === 'changes' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>变更{snapshot.gitStatus?.changes.length ? ` ${snapshot.gitStatus.changes.length}` : ''}</button>
              <button className={tab === 'files' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>文件</button>
              <button className={tab === 'terminal' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'terminal'} onClick={() => setTab('terminal')}>终端{terminalTools.length ? ` ${terminalTools.length}` : ''}</button>
            </div>
          </div>
          <div className="file-sidebar-actions">
            {tab === 'files' ? <button className="icon-btn" type="button" title="全部折叠" aria-label="全部折叠" onClick={() => setExpanded(new Set())}><Icon name="arrow-left" width={14} height={14} style={{ transform: 'rotate(90deg)' }} /></button> : null}
            {tab === 'changes' ? <button className="icon-btn" type="button" title="刷新 Git 变更" aria-label="刷新 Git 变更" onClick={() => void controller.loadGitStatus()}><Icon name="refresh" width={14} height={14} /></button> : null}
            <button className="icon-btn" type="button" title="在文件管理器中打开" aria-label="在文件管理器中打开" disabled={!rootPath} onClick={() => void postJson('/api/open', { filePath: rootPath })}><Icon name="folder" width={14} height={14} /></button>
            <button className="icon-btn" type="button" title="关闭文件栏" aria-label="关闭文件栏" onClick={onClose}><Icon name="close" width={14} height={14} /></button>
          </div>
        </div>
        <div className="file-sidebar-path" title={rootPath}>{tab === 'files' ? rootPath : tab === 'changes' ? snapshot.gitStatus?.branch || rootPath : tab === 'terminal' ? '本次会话命令输出' : '当前任务概览'}</div>
        <div className="file-list file-browser-host">
          {tab === 'plan' ? (
            <div className="file-task-view">
              <div className="task-state-row"><span className={`task-state-dot${snapshot.isStreaming ? ' active' : ''}`} /><span>{snapshot.isStreaming ? 'Agent 正在执行' : snapshot.connection === 'connected' ? '等待下一步' : '未连接'}</span></div>
              <section className="task-section">
                <span className="task-section-label">当前任务</span>
                <p className={`task-request${taskRequest ? '' : ' empty'}`}>{taskRequest || '在对话中描述一个目标，Agent 的执行状态将显示在这里。'}</p>
              </section>
              <section className="task-section">
                <div className="task-plan-heading"><span className="task-section-label">任务计划</span><span>{taskPlan.length ? `${completedPlanCount}/${taskPlan.length}` : '未创建'}</span></div>
                <div className="task-plan-list">
                  {taskPlan.map((item) => (
                    <div className={`task-plan-item ${item.status}`} key={item.id}>
                      <button className="task-plan-status" type="button" title="切换步骤状态" aria-label={`将“${item.title}”切换为下一状态`} onClick={() => saveTaskPlan(taskPlan.map((current) => current.id === item.id ? { ...current, status: nextTaskPlanStatus(current.status) } : current))}><Icon name={item.status === 'complete' ? 'check' : 'chevron'} width={11} /></button>
                      <span className="task-plan-title">{item.title}</span>
                      <span className="task-plan-status-label">{item.status === 'pending' ? '待开始' : item.status === 'in_progress' ? '进行中' : '完成'}</span>
                      <button className="task-plan-remove" type="button" title="删除步骤" aria-label={`删除“${item.title}”`} onClick={() => saveTaskPlan(taskPlan.filter((current) => current.id !== item.id))}>×</button>
                    </div>
                  ))}
                  {!taskPlan.length ? <p className="task-plan-empty">将复杂任务拆成 3–5 步，进度会保留在当前会话中。</p> : null}
                </div>
                <div className="task-plan-add">
                  <input value={planDraft} onChange={(event) => setPlanDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTaskPlanItem(); }} placeholder="添加下一步" aria-label="添加计划步骤" />
                  <button type="button" disabled={!planDraft.trim()} onClick={addTaskPlanItem}>添加</button>
                </div>
              </section>
              <section className="task-section task-metrics" aria-label="任务概览">
                <div><strong>{toolCount}</strong><span>工具步骤</span></div>
                <div><strong>{snapshot.gitStatus?.changes.length || 0}</strong><span>文件变更</span></div>
                <div><strong>{terminalTools.length}</strong><span>命令记录</span></div>
              </section>
              <section className="task-section">
                <span className="task-section-label">当前状态</span>
                <p className="task-next-step">{snapshot.isStreaming ? '执行过程会实时出现在对话与终端中。' : snapshot.gitStatus?.changes.length ? '可在“变更”中审阅工作区修改，然后继续任务。' : '准备就绪。发送消息即可开始一个任务。'}</p>
              </section>
            </div>
          ) : tab === 'changes' ? (
            <div className="file-changes-view">
              {snapshot.gitLoading ? <div className="file-loading loading">正在读取 Git 变更…</div> : null}
              {!snapshot.gitLoading && snapshot.gitError ? <div className="file-tree-status error">{snapshot.gitError}</div> : null}
              {!snapshot.gitLoading && !snapshot.gitError && snapshot.gitStatus && !snapshot.gitStatus.isRepository ? <div className="file-loading">当前文件夹不是 Git 仓库。</div> : null}
              {!snapshot.gitLoading && snapshot.gitStatus?.isRepository && snapshot.gitStatus.changes.length === 0 ? <div className="file-loading">工作区干净。</div> : null}
              <div className="file-change-list">
                {renderGitChanges(gitChangeTree, 0)}
              </div>
              {snapshot.selectedGitPath ? <div className="file-change-diff"><div className="file-change-diff-head">{snapshot.gitDiffLoading ? '正在加载 diff…' : snapshot.gitDiff?.path}</div>{!snapshot.gitDiffLoading && snapshot.gitDiff ? <pre>{snapshot.gitDiff.diff || '新建的未跟踪文件或二进制文件没有可展示的文本 diff。'}</pre> : null}</div> : null}
            </div>
          ) : tab === 'terminal' ? (
            <div className="file-terminal-view">
              {terminalTools.length ? terminalTools.map((tool) => (
                <section className={`terminal-record${tool.isError ? ' error' : ''}`} key={tool.toolCallId}>
                  <div className="terminal-record-head"><span>{tool.toolName}</span><span>{tool.status === 'streaming' ? '执行中' : tool.isError ? '失败' : '完成'}</span></div>
                  <code className="terminal-command">$ {terminalCommand(tool)}</code>
                  <pre>{tool.output || '命令未返回文本输出。'}</pre>
                </section>
              )) : <div className="file-terminal-empty">本次会话还没有命令执行记录。运行命令后的输出会显示在这里。</div>}
            </div>
          ) : preview ? (
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
