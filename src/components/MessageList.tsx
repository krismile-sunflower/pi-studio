import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RenderedMessage, TimelineItem, ToolExecution, Usage } from '../lib/types';
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
      <span className="eyebrow">PI-STUDIO</span>
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

function ErrorMessage({ content }: { content: string }) {
  return (
    <div className="message assistant assistant-error-message">
      <div className="assistant-error-card" role="alert">
        <span className="assistant-error-icon" aria-hidden="true">!</span>
        <div className="assistant-error-body">
          <strong className="assistant-error-title">操作失败</strong>
          <p className="assistant-error-summary">{content}</p>
        </div>
      </div>
    </div>
  );
}

function MessageItem({ message }: { message: RenderedMessage }) {
  if (message.role === 'system' && message.content === '__PI_STUDIO_WELCOME__') return <Welcome />;
  if (message.role === 'error') return <ErrorMessage content={message.content} />;
  if (message.role === 'system') return <div className="system-message">{message.content}</div>;

  const hasUsage = Boolean(usageText(message.usage));
  return (
    <div className={`message ${message.role}${message.history ? ' history' : ''}`} data-message-id={message.id}>
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
        {message.role === 'assistant' && !message.streaming ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <span className={message.streaming ? 'streaming-text' : undefined}>{message.content}</span>
        )}
      </div>
      {message.role === 'assistant' && !message.streaming ? (
        <CopyMessageButton text={message.content} />
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

function ToolCard({ tool }: { tool: ToolExecution }) {
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
    <div className={`tool-card${tool.history ? ' history' : ''}`} data-tool-call-id={tool.toolCallId}>
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
        {!isEdit && Object.keys(tool.args).length ? (
          <div className="tool-args">{JSON.stringify(tool.args, null, 2)}</div>
        ) : null}
        <div className="tool-output-wrapper">
          <div className="tool-output">{tool.output}</div>
        </div>
      </div>
    </div>
  );
}

function timelineFingerprint(timeline: TimelineItem[]): string {
  if (!timeline.length) return 'empty';
  return `${timeline.length}:${timeline[0]?.id || ''}:${timeline[timeline.length - 1]?.id || ''}`;
}

export function MessageList({
  timeline,
  streaming,
  switching = false,
}: {
  timeline: TimelineItem[];
  streaming: boolean;
  switching?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [newMessage, setNewMessage] = useState(false);
  const previousCount = useRef(timeline.length);
  const previousFingerprint = useRef(timelineFingerprint(timeline));
  const stickToBottom = useRef(true);

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
        }}
      >
        {timeline.map((item) =>
          item.kind === 'message' ? (
            <MessageItem key={item.id} message={item.message} />
          ) : (
            <ToolCard key={item.id} tool={item.tool} />
          ),
        )}
      </div>
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
      <div className={`typing-indicator${streaming ? '' : ' hidden'}`} aria-hidden={!streaming} />
    </div>
  );
}
