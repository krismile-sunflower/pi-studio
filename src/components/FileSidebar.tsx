import { useEffect, useMemo, useState } from 'react';
import { apiJson, postJson } from '../lib/desktop';
import type { AppSnapshot, FileAttachment, GitChange, GitChangeArea, PlanSessionState, PlanStep, TimelineItem, ToolExecution } from '../lib/types';
import { Icon } from './Icon';
import { controller } from '../app/controller';
import { canExecutePlan } from '../app/plan-state';

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

interface FileSidebarProps {
  rootPath: string;
  open: boolean;
  snapshot: AppSnapshot;
  /** Incremented by the chat card when the plan editor should be revealed. */
  planRequest?: number;
  /** Incremented when the plan summary should be made visible without editing. */
  planTabRequest?: number;
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

function planStatusLabel(status: PlanStep['status']): string {
  return { pending: '待办', in_progress: '进行中', complete: '完成', blocked: '受阻' }[status];
}

function planPhaseLabel(phase: PlanSessionState['phase']): string {
  return { build: '构建', plan: '规划中', review: '待确认', executing: '执行中', complete: '已完成' }[phase];
}

function editablePlanStep(): PlanStep {
  return { id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: '', detail: '', status: 'pending' };
}

export function FileSidebar({ rootPath, open, snapshot, planRequest = 0, planTabRequest = 0, onClose, onInsert }: FileSidebarProps) {
  const [itemsByPath, setItemsByPath] = useState<Record<string, FileItem[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<FileContentResponse | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('files');
  const [expandedChangePaths, setExpandedChangePaths] = useState<Set<string>>(new Set());
  const [gitCommitMessage, setGitCommitMessage] = useState('');
  const [gitAction, setGitAction] = useState<'pull' | 'commit' | 'push' | 'stage' | 'unstage' | null>(null);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState<PlanSessionState>(snapshot.plan);

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
    setPlanDraft(snapshot.plan);
  }, [snapshot.plan, snapshot.selectedSessionFile]);

  useEffect(() => {
    if (!planRequest) return;
    setTab('plan');
    setPlanEditorOpen(true);
  }, [planRequest]);

  useEffect(() => {
    if (!planTabRequest) return;
    setTab('plan');
  }, [planTabRequest]);

  const rootItems = itemsByPath[rootPath] || [];
  const stagedGitChanges = useMemo(() => (snapshot.gitStatus?.changes || []).filter(isStagedGitChange), [snapshot.gitStatus?.changes]);
  const unstagedGitChanges = useMemo(() => (snapshot.gitStatus?.changes || []).filter(isUnstagedGitChange), [snapshot.gitStatus?.changes]);
  const stagedGitChangeTree = useMemo(() => buildGitChangeTree(stagedGitChanges), [stagedGitChanges]);
  const unstagedGitChangeTree = useMemo(() => buildGitChangeTree(unstagedGitChanges), [unstagedGitChanges]);
  const taskRequest = useMemo(() => snapshot.plan.goal || latestUserRequest(snapshot.timeline), [snapshot.plan.goal, snapshot.timeline]);
  const toolCount = useMemo(() => snapshot.timeline.filter((item) => item.kind === 'tool').length, [snapshot.timeline]);
  const terminalTools = useMemo(() => snapshot.timeline.filter((item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool').map((item) => item.tool).filter(isTerminalTool).reverse(), [snapshot.timeline]);
  const plan = snapshot.plan;
  const completedPlanCount = plan.steps.filter((item) => item.status === 'complete').length;
  const canEditPlan = !snapshot.isStreaming && plan.phase !== 'executing';
  const gitBusy = snapshot.gitLoading || Boolean(gitAction);
  const updateDraftStep = (id: string, patch: Partial<PlanStep>) => {
    setPlanDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => step.id === id ? { ...step, ...patch } : step),
    }));
  };
  const savePlan = async () => {
    const steps = planDraft.steps.filter((step) => step.title.trim()).map((step) => ({
      ...step,
      title: step.title.trim(),
      detail: step.detail?.trim() || undefined,
      status: 'pending' as const,
    }));
    const saved = await controller.updatePlan({ goal: planDraft.goal.trim(), steps });
    if (saved) setPlanEditorOpen(false);
  };
  const runGitAction = async (action: 'pull' | 'commit' | 'push' | 'stage' | 'unstage', operation: () => Promise<boolean>) => {
    setGitAction(action);
    try {
      const completed = await operation();
      if (completed && action === 'commit') setGitCommitMessage('');
    } finally {
      setGitAction(null);
    }
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

  const renderGitChanges = (node: GitChangeTreeNode, depth: number, area: GitChangeArea): React.ReactNode =>
    [...node.children.values()]
      .sort((left, right) => {
        if (Boolean(left.change) !== Boolean(right.change)) return left.change ? 1 : -1;
        return left.name.localeCompare(right.name);
      })
      .map((child) => {
        const isDirectory = !child.change;
        const expansionKey = `${area}:${child.path}`;
        const isExpanded = expandedChangePaths.has(expansionKey);
        if (isDirectory) {
          return (
            <div key={`${area}:${child.path}`}>
              <button
                className="file-change-directory"
                type="button"
                style={{ paddingLeft: 10 + depth * 14 }}
                aria-expanded={isExpanded}
                onClick={() => setExpandedChangePaths((current) => {
                  const next = new Set(current);
                  if (next.has(expansionKey)) next.delete(expansionKey); else next.add(expansionKey);
                  return next;
                })}
              >
                <Icon name="arrow-left" width={12} className={`file-change-chevron${isExpanded ? ' expanded' : ''}`} />
                <Icon name="folder" width={14} />
                <span>{child.name}</span>
              </button>
              {isExpanded ? renderGitChanges(child, depth + 1, area) : null}
            </div>
          );
        }
        const change = child.change!;
        const label = gitAreaChangeLabel(change, area);
        const active = snapshot.selectedGitPath === change.path && snapshot.selectedGitArea === area;
        const actionLabel = area === 'staged' ? `取消暂存 ${change.path}` : `暂存 ${change.path}`;
        return (
          <div className={`file-change-row${active ? ' active' : ''}`} key={`${area}:${change.path}`} style={{ paddingLeft: 10 + depth * 14 }}>
            <button className="file-change-select" type="button" onClick={() => void controller.selectGitChange(change.path, area)}>
              <span className={`file-change-status ${label}`}>{label}</span>
              <span className="file-change-path" title={change.path}>{child.name}</span>
            </button>
            <button className="file-change-stage" type="button" aria-label={actionLabel} title={actionLabel} disabled={gitBusy} onClick={() => void runGitAction(area === 'staged' ? 'unstage' : 'stage', () => area === 'staged' ? controller.unstageGit(gitChangePaths(change)) : controller.stageGit(gitChangePaths(change)))}>
              <Icon name={area === 'staged' ? 'close' : 'plus'} width={12} height={12} />
            </button>
          </div>
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
            {tab === 'changes' ? <button className="icon-btn" type="button" title="刷新 Git 变更" aria-label="刷新 Git 变更" disabled={gitBusy} onClick={() => void controller.loadGitStatus()}><Icon name="refresh" width={14} height={14} /></button> : null}
            <button className="icon-btn" type="button" title="在文件管理器中打开" aria-label="在文件管理器中打开" disabled={!rootPath} onClick={() => void postJson('/api/open', { filePath: rootPath })}><Icon name="folder" width={14} height={14} /></button>
            <button className="icon-btn" type="button" title="关闭文件栏" aria-label="关闭文件栏" onClick={onClose}><Icon name="close" width={14} height={14} /></button>
          </div>
        </div>
        <div className="file-sidebar-path" title={rootPath}>{tab === 'files' ? rootPath : tab === 'changes' ? snapshot.gitStatus?.branch || rootPath : tab === 'terminal' ? '本次会话命令输出' : '当前任务概览'}</div>
        <div className="file-list file-browser-host">
          {tab === 'plan' ? (
            <div className="file-task-view">
              <div className={`task-state-row plan-state-${plan.phase}`}><span className={`task-state-dot${snapshot.isStreaming ? ' active' : ''}`} /><span>{snapshot.isStreaming ? 'Agent 正在工作' : `${planPhaseLabel(plan.phase)} · ${plan.phase === 'plan' || plan.phase === 'review' ? '只读护栏已开启' : '可使用当前权限设置'}`}</span></div>
              <section className="task-section">
                <div className="task-plan-heading"><span className="task-section-label">目标</span><span>{plan.updatedAt === new Date(0).toISOString() ? '当前会话' : '已保存至会话'}</span></div>
                <p className={`task-request${taskRequest ? '' : ' empty'}`}>{taskRequest || '切换到计划模式，然后描述想要完成的目标。计划不会写入项目文件。'}</p>
              </section>
              <section className="task-section">
                <div className="task-plan-heading"><span className="task-section-label">计划步骤</span><span>{plan.steps.length ? `${completedPlanCount}/${plan.steps.length}` : '待生成'}</span></div>
                <div className="task-plan-list">
                  {plan.steps.map((item, index) => (
                    <div className={`task-plan-item ${item.status}`} key={item.id}>
                      <span className="task-plan-status" aria-label={planStatusLabel(item.status)}>{item.status === 'complete' ? <Icon name="check" width={11} /> : item.status === 'blocked' ? '!' : index + 1}</span>
                      <span className="task-plan-copy"><span className="task-plan-title">{item.title}</span>{item.detail ? <small>{item.detail}</small> : null}</span>
                      <span className="task-plan-status-label">{planStatusLabel(item.status)}</span>
                    </div>
                  ))}
                  {!plan.steps.length ? <p className="task-plan-empty">生成计划后，步骤会保留在当前 Pi 会话，并在这里显示进度。</p> : null}
                </div>
                <div className="task-plan-actions">
                  <button type="button" disabled={!canEditPlan} onClick={() => { setPlanDraft(plan); setPlanEditorOpen((value) => !value); }}>{planEditorOpen ? '收起编辑器' : '编辑计划'}</button>
                  {plan.phase === 'plan' || plan.phase === 'review' ? <button type="button" disabled={snapshot.isStreaming} onClick={() => void controller.revisePlan()}>继续规划</button> : null}
                  {plan.phase === 'review' ? <button className="task-plan-execute" type="button" disabled={snapshot.isStreaming || !canExecutePlan(plan)} onClick={() => void controller.executePlan()}>开始执行</button> : null}
                </div>
                {planEditorOpen ? (
                  <div className="task-plan-editor" aria-label="编辑计划">
                    <label>目标<textarea value={planDraft.goal} disabled={!canEditPlan} onChange={(event) => setPlanDraft((current) => ({ ...current, goal: event.target.value }))} placeholder="这份计划要完成什么？" /></label>
                    <div className="task-plan-editor-heading"><span>步骤</span><button type="button" disabled={!canEditPlan} onClick={() => setPlanDraft((current) => ({ ...current, steps: [...current.steps, editablePlanStep()] }))}>添加步骤</button></div>
                    {planDraft.steps.map((step, index) => (
                      <div className="task-plan-editor-step" key={step.id}>
                        <span>{index + 1}</span>
                        <div>
                          <input value={step.title} disabled={!canEditPlan} onChange={(event) => updateDraftStep(step.id, { title: event.target.value })} placeholder="步骤标题" aria-label={`步骤 ${index + 1} 标题`} />
                          <textarea value={step.detail || ''} disabled={!canEditPlan} onChange={(event) => updateDraftStep(step.id, { detail: event.target.value })} placeholder="实现说明（可选）" aria-label={`步骤 ${index + 1} 说明`} />
                        </div>
                        <div className="task-plan-editor-step-actions">
                          <button type="button" disabled={!canEditPlan || index === 0} aria-label="上移步骤" onClick={() => setPlanDraft((current) => { const steps = [...current.steps]; [steps[index - 1], steps[index]] = [steps[index]!, steps[index - 1]!]; return { ...current, steps }; })}>↑</button>
                          <button type="button" disabled={!canEditPlan || index === planDraft.steps.length - 1} aria-label="下移步骤" onClick={() => setPlanDraft((current) => { const steps = [...current.steps]; [steps[index + 1], steps[index]] = [steps[index]!, steps[index + 1]!]; return { ...current, steps }; })}>↓</button>
                          <button type="button" disabled={!canEditPlan} aria-label="删除步骤" onClick={() => setPlanDraft((current) => ({ ...current, steps: current.steps.filter((item) => item.id !== step.id) }))}>×</button>
                        </div>
                      </div>
                    ))}
                    <div className="task-plan-editor-footer"><span>保存有效步骤后会回到“待确认”，需要再次开始执行。</span><button type="button" disabled={!canEditPlan} onClick={() => void savePlan()}>保存计划</button></div>
                  </div>
                ) : null}
              </section>
              <section className="task-section task-metrics" aria-label="任务概览">
                <div><strong>{toolCount}</strong><span>工具步骤</span></div>
                <div><strong>{snapshot.gitStatus?.changes.length || 0}</strong><span>文件变更</span></div>
                <div><strong>{terminalTools.length}</strong><span>命令记录</span></div>
              </section>
              <section className="task-section">
                <span className="task-section-label">当前状态</span>
                <p className="task-next-step">{plan.phase === 'plan' || plan.phase === 'review' ? '计划期只能读取、搜索和运行安全的只读命令。' : plan.phase === 'executing' ? '步骤完成情况会随 Agent 的 [DONE:n] 回报实时更新。' : snapshot.gitStatus?.changes.length ? '可在“变更”中审阅工作区修改。' : '准备就绪。发送消息即可开始一个任务。'}</p>
              </section>
            </div>
          ) : tab === 'changes' ? (
            <div className="file-changes-view">
              {snapshot.gitStatus?.isRepository ? (
                <div className="file-git-controls">
                  <div className="file-git-sync">
                    <span title={snapshot.gitStatus.upstream || undefined}>{snapshot.gitStatus.upstream ? `↑ ${snapshot.gitStatus.ahead} · ↓ ${snapshot.gitStatus.behind}` : '无上游'}</span>
                    <div>
                      <button type="button" disabled={gitBusy || !snapshot.gitStatus.upstream} title={snapshot.gitStatus.upstream ? '仅快进拉取上游分支' : '需要先设置上游分支'} onClick={() => void runGitAction('pull', () => controller.pullGit())}>{gitAction === 'pull' ? '拉取中…' : '拉取'}</button>
                      <button type="button" disabled={gitBusy} onClick={() => void runGitAction('push', () => controller.pushGit())}>{gitAction === 'push' ? '推送中…' : '推送'}</button>
                    </div>
                  </div>
                  <div className="file-git-stage-summary">
                    <span>{stagedGitChanges.length} 已暂存 · {unstagedGitChanges.length} 未暂存</span>
                    <div>
                      <button type="button" disabled={gitBusy || !unstagedGitChanges.length} onClick={() => void runGitAction('stage', () => controller.stageAllGit())}>全部暂存</button>
                      <button type="button" disabled={gitBusy || !stagedGitChanges.length} onClick={() => void runGitAction('unstage', () => controller.unstageAllGit())}>全部取消</button>
                    </div>
                  </div>
                  <form className="file-git-commit" onSubmit={(event) => {
                    event.preventDefault();
                    if (!gitCommitMessage.trim() || !stagedGitChanges.length || gitBusy) return;
                    void runGitAction('commit', () => controller.commitGit(gitCommitMessage));
                  }}>
                    <input value={gitCommitMessage} maxLength={500} disabled={gitBusy || !stagedGitChanges.length} onChange={(event) => setGitCommitMessage(event.target.value)} placeholder={stagedGitChanges.length ? '提交说明' : '请先暂存改动'} aria-label="Git 提交说明" />
                    <button type="submit" disabled={gitBusy || !stagedGitChanges.length || !gitCommitMessage.trim()}>{gitAction === 'commit' ? '提交中…' : '提交暂存'}</button>
                  </form>
                </div>
              ) : null}
              {snapshot.gitLoading ? <div className="file-loading loading">正在读取 Git 变更…</div> : null}
              {!snapshot.gitLoading && snapshot.gitError ? <div className="file-tree-status error">{snapshot.gitError}</div> : null}
              {!snapshot.gitLoading && !snapshot.gitError && snapshot.gitStatus && !snapshot.gitStatus.isRepository ? <div className="file-loading">当前文件夹不是 Git 仓库。</div> : null}
              {!snapshot.gitLoading && snapshot.gitStatus?.isRepository && snapshot.gitStatus.changes.length === 0 ? <div className="file-loading">工作区干净。</div> : null}
              <div className="file-change-list">
                {snapshot.gitStatus?.changes.length ? <div className="file-change-section-heading"><span>暂存的更改</span><strong>{stagedGitChanges.length}</strong></div> : null}
                {renderGitChanges(stagedGitChangeTree, 0, 'staged')}
                {snapshot.gitStatus?.changes.length ? <div className="file-change-section-heading"><span>更改</span><strong>{unstagedGitChanges.length}</strong></div> : null}
                {renderGitChanges(unstagedGitChangeTree, 0, 'unstaged')}
              </div>
              {snapshot.selectedGitPath ? <div className="file-change-diff"><div className="file-change-diff-head"><span>{snapshot.gitDiffLoading ? '正在加载 diff…' : snapshot.gitDiff?.path}</span><small>{snapshot.selectedGitArea === 'staged' ? '暂存区' : '工作区'}</small></div>{!snapshot.gitDiffLoading && snapshot.gitDiff ? <pre>{snapshot.gitDiff.diff || '新建的未跟踪文件或二进制文件没有可展示的文本 diff。'}</pre> : null}</div> : null}
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
