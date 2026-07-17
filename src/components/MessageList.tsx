import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionUiRequest, RenderedMessage, TimelineItem, ToolExecution, Usage } from '../lib/types';
import { isPermissionRequest, permissionRequestDetails } from '../lib/extension-ui';
import { formatTokens } from '../lib/utils';
import { Icon } from './Icon';
import { CopyMessageButton, Markdown } from './Markdown';

function usageText(usage?: Usage): string {
  if (!usage) return '';
  const input = usage.input || 0;
  const output = usage.output || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  const total = input + output + cacheRead + cacheWrite;
  const cache = cacheRead || cacheWrite ? ` / 缓存 ${formatTokens(cacheRead + cacheWrite)}` : '';
  const tokens = `输入 ${formatTokens(input + cacheRead)} / 输出 ${formatTokens(output)}${cache}`;
  return usage.cost?.total
    ? `$${usage.cost.total.toFixed(4)} · ${tokens}`
    : `${tokens} / 总计 ${formatTokens(total)}`;
}

function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(Boolean(streaming));
  if (!content) return null;
  return (
    <div className={`thinking-block${streaming ? ' streaming-thinking' : ''}`}>
      <button
        type="button"
        className={`thinking-toggle${expanded ? ' expanded' : ''}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="chevron">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
            <path d="M2 1l4 3-4 3z" />
          </svg>
        </span>
        <span className="thinking-label">
          <Icon name="brain" width={12} height={12} /> 思考过程
        </span>
      </button>
      <div className={`thinking-content${expanded ? ' expanded' : ''}`}>{content}</div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <img src="/icons/tau-192.png" alt="" className="tau-icon-welcome" />
      </div>
      <span className="eyebrow">PiCode</span>
      <h1>从一个问题开始</h1>
      <p className="hint">与 Pi 协作理解代码、规划改动并完成任务。你也可以从左侧继续历史会话。</p>
      <div className="shortcuts-hint">
        <span><kbd>/</kbd> 聚焦输入框</span>
        <span><kbd>⌘K</kbd> 打开命令</span>
        <span><kbd>Esc</kbd> 停止生成</span>
      </div>
    </div>
  );
}

function ErrorMessage({ message, onDelete }: { message: RenderedMessage; onDelete?(entryId: string): Promise<boolean> }) {
  const [deleting, setDeleting] = useState(false);
  const canDelete = Boolean(onDelete && message.history && message.sessionEntryId);
  return (
    <div className="message assistant assistant-error-message">
      <div className="assistant-error-card" role="alert">
        <span className="assistant-error-icon" aria-hidden="true">!</span>
        <div className="assistant-error-body">
          <strong className="assistant-error-title">操作失败</strong>
          <p className="assistant-error-summary">{message.content}</p>
        </div>
      </div>
      {canDelete ? (
        <div className="message-actions">
          <button className="message-delete-btn" type="button" aria-label="删除这条消息" title="删除这条消息" disabled={deleting} onClick={async () => {
            if (!message.sessionEntryId || !window.confirm('删除这条消息？删除后会同步修改会话上下文。')) return;
            setDeleting(true);
            await onDelete?.(message.sessionEntryId);
            setDeleting(false);
          }}><Icon name="trash" width={12} height={12} /></button>
        </div>
      ) : null}
    </div>
  );
}

function MessageItem({
  message,
  editable,
  onDelete,
  onEdit,
  onElementRef,
}: {
  message: RenderedMessage;
  editable?: boolean;
  onDelete?(entryId: string): Promise<boolean>;
  onEdit?(message: RenderedMessage): void;
  onElementRef?(element: HTMLDivElement | null): void;
}) {
  const [deleting, setDeleting] = useState(false);
  if (message.role === 'system' && message.content === '__PI_STUDIO_WELCOME__') return <Welcome />;
  if (message.role === 'error') return <ErrorMessage message={message} onDelete={onDelete} />;
  if (message.role === 'system') return <div className="system-message">{message.content}</div>;

  const hasUsage = Boolean(usageText(message.usage));
  const canDelete = Boolean(onDelete && message.history && message.sessionEntryId && !message.streaming);
  const canEdit = Boolean(editable && onEdit && message.history && message.sessionEntryId && !message.streaming);
  const canCopy = Boolean(
    !message.streaming &&
    message.content &&
    (message.role === 'assistant' || message.role === 'user'),
  );
  return (
    <div ref={onElementRef} className={`message ${message.role}${message.history ? ' history' : ''}`} data-message-id={message.id}>
      <div className={`message-content${message.streaming ? ' streaming' : ''}`}>
        {message.role === 'assistant' && message.thinking ? (
          <ThinkingBlock content={message.thinking} streaming={message.streaming} />
        ) : null}
        {message.images?.length ? (
          <div className="message-images">
            {message.images.map((image, index) => (
              <img
                key={`${message.id}-image-${index}`}
                className="message-image"
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`附件 ${index + 1}`}
              />
            ))}
          </div>
        ) : null}
        {message.role === 'assistant' ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <span className={message.streaming ? 'streaming-text' : undefined}>{message.content}</span>
        )}
      </div>
      {canCopy || canDelete || canEdit ? (
        <div className="message-actions">
          {canCopy ? <CopyMessageButton text={message.content} /> : null}
          {canEdit ? (
            <button className="message-edit-btn" type="button" aria-label="重新编辑这条消息" title="重新编辑并发送" onClick={() => onEdit?.(message)}>
              <Icon name="edit" width={12} height={12} />
            </button>
          ) : null}
          {canDelete ? (
            <button
              className="message-delete-btn"
              type="button"
              aria-label="删除这条消息"
              title="删除这条消息"
              disabled={deleting}
              onClick={async () => {
                if (!message.sessionEntryId || !window.confirm('删除这条消息？删除后会同步修改会话上下文。')) return;
                setDeleting(true);
                await onDelete?.(message.sessionEntryId);
                setDeleting(false);
              }}
            >
              <Icon name="trash" width={12} height={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {hasUsage ? <span className="message-usage">{usageText(message.usage)}</span> : null}
    </div>
  );
}

function argumentPreview(args: Record<string, unknown>): string {
  for (const key of ['path', 'command', 'query', 'url']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value.slice(0, 80);
  }
  const first = Object.values(args).find((value) => typeof value === 'string' && value);
  return typeof first === 'string' ? first.slice(0, 60) : '';
}

function isTerminalToolName(name: string): boolean {
  return /(?:command|terminal|shell|powershell|bash|exec|run)/i.test(name);
}

function ToolCard({ tool }: { tool: ToolExecution }) {
  const terminalTool = isTerminalToolName(tool.toolName);
  const command = terminalTool ? argumentPreview(tool.args) : '';
  const [expanded, setExpanded] = useState(tool.status === 'pending' || tool.status === 'streaming');
  const statusLabel = {
    pending: '等待中',
    streaming: '执行中',
    complete: '已完成',
    error: '失败',
  }[tool.status];
  const isEdit =
    tool.toolName.toLowerCase() === 'edit' &&
    typeof (tool.args.oldText || tool.args.old_text) === 'string' &&
    typeof (tool.args.newText || tool.args.new_text) === 'string';

  useEffect(() => {
    if (tool.status === 'streaming') setExpanded(true);
    if (tool.status === 'complete' && !tool.isError) setExpanded(false);
  }, [tool.isError, tool.status]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ expanded: boolean }>).detail;
      setExpanded(detail.expanded);
    };
    window.addEventListener('pi-studio:tool-expand', listener);
    return () => window.removeEventListener('pi-studio:tool-expand', listener);
  }, []);

  const diff = useMemo(() => {
    if (!isEdit) return null;
    const oldText = String(tool.args.oldText || tool.args.old_text || '');
    const newText = String(tool.args.newText || tool.args.new_text || '');
    return (
      <div className="tool-diff">
        {oldText.split('\n').map((line, index) => (
          <div className="diff-line diff-removed" key={`old-${index}`}>- {line}</div>
        ))}
        {newText.split('\n').map((line, index) => (
          <div className="diff-line diff-added" key={`new-${index}`}>+ {line}</div>
        ))}
      </div>
    );
  }, [isEdit, tool.args]);

  return (
    <div className={`tool-card${terminalTool ? ' terminal-tool-card' : ''}${tool.history ? ' history' : ''}`} data-tool-call-id={tool.toolCallId}>
      <div
        className="tool-card-header"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <span className="tool-header-left">
          <span className={`tool-card-chevron${expanded ? ' expanded' : ''}`}>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
              <path d="M2 1l4 3-4 3z" />
            </svg>
          </span>
          <span className="tool-name">{tool.toolName}</span>
          {argumentPreview(tool.args) ? (
            <span className="tool-args-preview">{argumentPreview(tool.args)}</span>
          ) : null}
        </span>
        <span className="tool-header-right">
          <button
            className="tool-action-btn copy-output-btn"
            type="button"
            title="复制输出"
            aria-label="复制工具输出"
            onClick={(event) => {
              event.stopPropagation();
              if (tool.output) void navigator.clipboard.writeText(tool.output);
            }}
          >
            <Icon name="copy" width={13} height={13} />
          </button>
          <span className={`tool-status ${tool.status}`}>{statusLabel}</span>
        </span>
      </div>
      <div className={`tool-card-body${expanded ? ' expanded' : ''}`}>
        {diff}
        {terminalTool && command ? (
          <div className="tool-terminal-command"><span>$</span><code>{command}</code></div>
        ) : null}
        {!isEdit && !terminalTool && Object.keys(tool.args).length ? (
          <div className="tool-args">{JSON.stringify(tool.args, null, 2)}</div>
        ) : null}
        <div className="tool-output-wrapper">
          <div className="tool-output">{tool.output}</div>
        </div>
      </div>
    </div>
  );
}

function optionLabel(option: string | { label: string; value: unknown }): string {
  return typeof option === 'string' ? option : option.label;
}

function optionValue(option: string | { label: string; value: unknown }): unknown {
  return typeof option === 'string' ? option : option.value;
}

function PermissionRequestCard({
  request,
  onRespond,
}: {
  request: ExtensionUiRequest;
  onRespond(request: ExtensionUiRequest, response: Record<string, unknown>): void;
}) {
  const [responding, setResponding] = useState(false);
  const { action, detail } = permissionRequestDetails(request);
  const options = [...(request.options || [])].sort((left, right) => {
    const leftDenied = optionLabel(left).includes('拒绝');
    const rightDenied = optionLabel(right).includes('拒绝');
    return leftDenied === rightDenied ? 0 : leftDenied ? -1 : 1;
  });

  useEffect(() => setResponding(false), [request.id, request.requestId, request.title]);

  const respond = (option: string | { label: string; value: unknown }) => {
    if (responding) return;
    setResponding(true);
    onRespond(request, { value: optionValue(option) });
  };

  return (
    <section className="permission-request-card" role="region" aria-label="Pi 工具执行授权">
      <div className="permission-request-icon" aria-hidden="true"><Icon name="shield" width={17} height={17} /></div>
      <div className="permission-request-content">
        <div className="permission-request-heading">
          <div>
            <span className="permission-request-eyebrow">需要你的确认</span>
            <h3>允许 Pi {action}？</h3>
          </div>
          <span className="permission-request-status"><span />等待授权</span>
        </div>
        {detail ? <pre className="permission-request-detail"><code>{detail}</code></pre> : null}
        <p className="permission-request-note">授权仅作用于当前操作；“本会话允许”会在当前项目中放行同类操作。</p>
        <div className="permission-request-actions">
          {options.map((option) => {
            const label = optionLabel(option);
            const kind = label.includes('拒绝')
              ? 'deny'
              : label.includes('本会话')
                ? 'session'
                : 'once';
            const displayLabel = kind === 'session' ? '本会话允许' : label;
            return (
              <button
                className={`permission-request-button ${kind}`}
                type="button"
                disabled={responding}
                key={label}
                onClick={() => respond(option)}
              >
                {displayLabel}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function timelineFingerprint(timeline: TimelineItem[]): string {
  if (!timeline.length) return 'empty';
  return `${timeline.length}:${timeline[0]?.id || ''}:${timeline[timeline.length - 1]?.id || ''}`;
}

function conversationLabel(message: RenderedMessage, index: number): string {
  const preview = message.content.replace(/\s+/g, ' ').trim();
  return preview ? `跳转到用户消息 ${index + 1}：${preview.slice(0, 48)}` : `跳转到用户消息 ${index + 1}`;
}

function conversationPreview(message: RenderedMessage): string {
  const preview = message.content.replace(/\s+/g, ' ').trim();
  return preview.length > 56 ? `${preview.slice(0, 56)}…` : preview || '空白用户消息';
}

export function MessageList({
  timeline,
  streaming,
  switching = false,
  extensionUiRequest,
  onDeleteMessage,
  onEditMessage,
  onRespondToExtension,
}: {
  timeline: TimelineItem[];
  streaming: boolean;
  switching?: boolean;
  extensionUiRequest?: ExtensionUiRequest | null;
  onDeleteMessage?(entryId: string): Promise<boolean>;
  onEditMessage?(message: RenderedMessage): void;
  onRespondToExtension?(request: ExtensionUiRequest, response: Record<string, unknown>): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const conversationNodes = useRef(new Map<string, HTMLDivElement>());
  const [scrolledUp, setScrolledUp] = useState(false);
  const [newMessage, setNewMessage] = useState(false);
  const previousCount = useRef(timeline.length);
  const previousFingerprint = useRef(timelineFingerprint(timeline));
  const stickToBottom = useRef(true);
  const permissionRequest = isPermissionRequest(extensionUiRequest) ? extensionUiRequest : null;
  const permissionRequestKey = permissionRequest?.id || permissionRequest?.requestId || permissionRequest?.title || '';
  const lastUserMessageId = useMemo(
    () => [...timeline].reverse().find((item) => item.kind === 'message' && item.message.role === 'user')?.id,
    [timeline],
  );
  const conversationAnchors = useMemo(
    () => timeline.flatMap((item) => item.kind === 'message' && item.message.role === 'user' ? [item.message] : []),
    [timeline],
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationPositions, setConversationPositions] = useState<Record<string, number>>({});

  const registerConversationNode = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) conversationNodes.current.set(id, node);
    else conversationNodes.current.delete(id);
  }, []);

  const updateConversationPositions = useCallback(() => {
    const container = containerRef.current;
    if (!container || !conversationAnchors.length) return;
    const scrollRange = Math.max(1, container.scrollHeight - 1);
    const next: Record<string, number> = {};
    for (const message of conversationAnchors) {
      const node = conversationNodes.current.get(message.id);
      if (!node) continue;
      next[message.id] = Math.min(1, Math.max(0, node.offsetTop / scrollRange));
    }
    setConversationPositions((current) => {
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      if (
        currentKeys.length === nextKeys.length &&
        nextKeys.every((id) => Math.abs((current[id] ?? -1) - next[id]!) < 0.001)
      ) return current;
      return next;
    });
  }, [conversationAnchors]);

  // Keep scroll stable across session switches / history replace.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fingerprint = timelineFingerprint(timeline);
    const prevFingerprint = previousFingerprint.current;
    const firstId = timeline[0]?.id || '';
    const prevFirst = prevFingerprint.split(':')[1] || '';
    const isFullReplace =
      fingerprint !== prevFingerprint &&
      (timeline.length === 0 || firstId !== prevFirst || timeline.length < previousCount.current);

    if (isFullReplace) {
      stickToBottom.current = true;
      setScrolledUp(false);
      setNewMessage(false);
      container.scrollTop = container.scrollHeight;
    } else if (stickToBottom.current) {
      container.scrollTop = container.scrollHeight;
    } else if (timeline.length > previousCount.current) {
      setNewMessage(true);
    }

    previousCount.current = timeline.length;
    previousFingerprint.current = fingerprint;
  }, [timeline]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !permissionRequestKey) return;
    stickToBottom.current = true;
    setScrolledUp(false);
    setNewMessage(false);
    container.scrollTop = container.scrollHeight;
  }, [permissionRequestKey]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = window.requestAnimationFrame(updateConversationPositions);
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateConversationPositions);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(container);
    for (const node of conversationNodes.current.values()) observer?.observe(node);
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [conversationAnchors, updateConversationPositions]);

  useEffect(() => {
    if (!conversationAnchors.length) {
      setActiveConversationId(null);
      return;
    }
    setActiveConversationId((current) =>
      conversationAnchors.some((message) => message.id === current)
        ? current
        : conversationAnchors[conversationAnchors.length - 1]?.id || null,
    );
  }, [conversationAnchors]);

  const scrollToConversation = (id: string) => {
    const container = containerRef.current;
    const target = conversationNodes.current.get(id);
    if (!container || !target) return;
    // The workspace header overlays the scroll area. Keep the selected user
    // message below it rather than pinning it underneath the header on upward jumps.
    const headerHeight = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--header-height'),
    ) || 58;
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - headerHeight - 20;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    stickToBottom.current = false;
    setScrolledUp(true);
    setNewMessage(false);
    setActiveConversationId(id);
  };

  return (
    <div className={`chat-messages-wrap${switching ? ' is-switching' : ''}`}>
      {switching ? (
        <div className="session-switch-bar" role="status" aria-live="polite">
          <span className="session-switch-spinner" aria-hidden="true" />
          <span>正在切换会话…</span>
        </div>
      ) : null}
      <div
        className="messages"
        id="messages"
        ref={containerRef}
        onScroll={() => {
          const container = containerRef.current;
          if (!container) return;
          const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
          const isUp = distance >= 120;
          stickToBottom.current = !isUp;
          setScrolledUp(isUp);
          if (!isUp) setNewMessage(false);
          const threshold = container.getBoundingClientRect().top + container.clientHeight * 0.32;
          let currentAnchor = conversationAnchors[0]?.id || null;
          for (const message of conversationAnchors) {
            const node = conversationNodes.current.get(message.id);
            if (node && node.getBoundingClientRect().top <= threshold) currentAnchor = message.id;
          }
          // Before the first anchor crosses the reading threshold (the common
          // case when scrolling all the way up), keep the first conversation
          // selected instead of leaving the previous lower conversation active.
          setActiveConversationId(currentAnchor);
        }}
      >
        {timeline.map((item) =>
          item.kind === 'message' ? (
            <MessageItem
              key={item.id}
              message={item.message}
              editable={item.id === lastUserMessageId && !streaming}
              onDelete={onDeleteMessage}
              onEdit={onEditMessage}
              onElementRef={item.message.role === 'user' ? (node) => registerConversationNode(item.message.id, node) : undefined}
            />
          ) : (
            <ToolCard key={item.id} tool={item.tool} />
          ),
        )}
        {permissionRequest && onRespondToExtension ? (
          <PermissionRequestCard request={permissionRequest} onRespond={onRespondToExtension} />
        ) : null}
      </div>
      {conversationAnchors.length > 1 ? (
        <nav className="conversation-minimap" aria-label="对话快速定位">
          {conversationAnchors.map((message, index) => (
            <button
              key={message.id}
              className={`conversation-marker${message.id === activeConversationId ? ' active' : ''}`}
              type="button"
              aria-label={conversationLabel(message, index)}
              aria-current={message.id === activeConversationId ? 'true' : undefined}
              style={{ top: `${4 + (conversationPositions[message.id] ?? (index + 0.5) / conversationAnchors.length) * 92}%` }}
              onClick={() => scrollToConversation(message.id)}
            >
              <span className="conversation-marker-line" aria-hidden="true" />
              <span className="conversation-marker-tooltip" role="tooltip">{conversationPreview(message)}</span>
            </button>
          ))}
        </nav>
      ) : null}
      <button
        className={`scroll-bottom-btn${scrolledUp ? '' : ' hidden'}`}
        type="button"
        aria-label="滚动到底部"
        onClick={() => {
          const container = containerRef.current;
          if (container) {
            stickToBottom.current = true;
            container.scrollTop = container.scrollHeight;
          }
          setScrolledUp(false);
          setNewMessage(false);
        }}
      >
        <span className={`scroll-bottom-badge${newMessage ? '' : ' hidden'}`}>有新消息</span>
        <span className="scroll-bottom-icon"><Icon name="arrow-down" /></span>
      </button>
      <div className={`typing-indicator${streaming && !permissionRequest ? '' : ' hidden'}`} aria-hidden={!streaming || Boolean(permissionRequest)} />
    </div>
  );
}
