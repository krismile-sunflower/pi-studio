import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  AppSnapshot,
  ExtensionUiRequest,
  FileAttachment,
  ImageAttachment,
  ModelInfo,
  SlashCommand,
  ToastMessage,
} from '../lib/types';
import { isInteractiveExtensionRequest, isPermissionRequest } from '../lib/extension-ui';
import {
  basename,
  extensionOf,
  formatTokens,
  imageExtensions,
  parseImagePaths,
  shortModelName,
  totalContextTokens,
  uniqueId,
} from '../lib/utils';
import {
  applySlashCompletion,
  fuzzyFilterCommands,
  matchSlashCommand,
} from '../lib/slash-commands';
import { controller } from '../app/controller';
import { apiJson } from '../lib/desktop';
import { Icon, type IconName } from './Icon';

const thinkingLabels: Record<string, string> = {
  off: '关闭',
  minimal: '极简',
  low: '较低',
  medium: '中等',
  high: '较高',
  xhigh: '最高',
  max: '最高',
};

interface HeaderProps {
  snapshot: AppSnapshot;
  onOpenSidebar(): void;
  fileOpen: boolean;
  onToggleFiles(): void;
}

export function Header({ snapshot, onOpenSidebar, fileOpen, onToggleFiles }: HeaderProps) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [metricsOpen, setMetricsOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const metricsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!modelRef.current?.contains(event.target as Node)) setModelsOpen(false);
      if (!metricsRef.current?.contains(event.target as Node)) setMetricsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    const openPicker = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string }>).detail;
      setModelQuery(detail?.query || '');
      setModelsOpen(true);
      setMetricsOpen(false);
    };
    window.addEventListener('pi-studio:open-model-picker', openPicker);
    return () => window.removeEventListener('pi-studio:open-model-picker', openPicker);
  }, []);

  const currentProvider = snapshot.currentModelProvider && snapshot.currentModelProvider !== 'unknown'
    ? snapshot.currentModelProvider
    : snapshot.defaultProvider;
  const models = snapshot.models.filter((model) => {
    const query = modelQuery.trim().toLowerCase();
    if (!currentProvider || model.provider !== currentProvider) return false;
    return !query || `${model.id} ${model.name || ''}`.toLowerCase().includes(query);
  });
  const usage = snapshot.lastUsage;
  const latestContextTokens = totalContextTokens(usage);
  const hasReportedContext = snapshot.contextUsage !== undefined;
  const reportedTokens = snapshot.contextUsage?.tokens;
  const contextKnown = reportedTokens != null || (!hasReportedContext && latestContextTokens > 0);
  const used = reportedTokens ?? (hasReportedContext ? 0 : latestContextTokens);
  const total = snapshot.contextUsage?.contextWindow || snapshot.contextWindowSize;
  const percent = total > 0 && contextKnown
    ? Math.round((used / total) * 100)
    : snapshot.contextUsage?.percent != null
      ? Math.round(snapshot.contextUsage.percent)
      : 0;
  const workspaceTitle = snapshot.workspace.noFolder
    ? 'PiCode 专属目录'
    : snapshot.workspace.path || '工作区';
  const connectionText = snapshot.isStreaming
    ? 'Pi 正在处理…'
    : ({ connected: '已连接', connecting: '正在启动 Pi…', disconnected: '连接已断开', idle: '未打开项目' } as const)[snapshot.connection];
  const currentModelLabel = shortModelName(snapshot.currentModelId) || '模型';
  const detailSegments = usage
    ? [
        { key: 'cache', label: '缓存读取', tokens: usage.cacheRead || 0 },
        { key: 'messages', label: '输入', tokens: usage.input || 0 },
        { key: 'output', label: '输出', tokens: usage.output || 0 },
        { key: 'cache-write', label: '缓存写入', tokens: usage.cacheWrite || 0 },
      ].filter((segment) => segment.tokens > 0)
    : [];
  const detailedTokens = detailSegments.reduce((sum, segment) => sum + segment.tokens, 0);
  const canShowDetails = detailedTokens > 0 && detailedTokens <= used;
  const estimatedTokens = canShowDetails ? Math.max(0, used - detailedTokens) : used;
  const segments = contextKnown && total
    ? [
        ...(canShowDetails ? detailSegments : []),
        ...(estimatedTokens > 0
          ? [{ key: 'estimated', label: canShowDetails ? '会话增量（估算）' : '已用（估算）', tokens: estimatedTokens }]
          : []),
        { key: 'free', label: '可用', tokens: Math.max(0, total - used) },
      ]
    : [];

  const selectModel = async (model: ModelInfo) => {
    setModelsOpen(false);
    setModelQuery('');
    await controller.setModel(model);
  };

  return (
    <header className="header">
      <div className="header-left">
        <button className="sidebar-toggle mobile-sidebar-toggle" type="button" title="打开会话栏" aria-label="打开会话栏" onClick={onOpenSidebar}>
          <Icon name="bars" width={18} height={18} />
        </button>
        <div className="header-context">
          <span className="header-workspace" title={workspaceTitle}>{workspaceTitle}</span>
          <strong className="header-session">{snapshot.selectedSessionTitle || '新会话'}</strong>
        </div>
        <div className="status" title={snapshot.connection === 'idle' ? '打开一个项目以启动 Pi' : 'Pi 连接状态'}>
          <span className={`status-indicator ${snapshot.isStreaming ? 'streaming' : snapshot.connection}`} />
          <span className="status-text">{connectionText}</span>
        </div>
      </div>
      <div className="header-right">
        <div className={`model-dropdown${modelsOpen ? ' open' : ''}`} ref={modelRef}>
          <button className="model-dropdown-btn" type="button" title="切换模型" aria-haspopup="listbox" aria-expanded={modelsOpen} onClick={() => setModelsOpen((value) => !value)}>
            <span className="model-dropdown-label">{currentModelLabel}</span>
            <svg className="model-dropdown-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1 5 5 9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          {modelsOpen ? (
            <div className="model-dropdown-menu" role="listbox" aria-label="选择模型">
              <div className="model-dropdown-head">
                <span>选择模型</span>
                <span className="model-dropdown-provider">{currentProvider || '未选择供应商'}</span>
              </div>
              <input className="model-dropdown-search" type="search" aria-label="搜索模型" placeholder={currentProvider ? `在 ${currentProvider} 中搜索…` : '搜索模型…'} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} autoFocus />
              <div className="model-dropdown-items">
                {models.length ? models.map((model) => {
                  const active = model.id === snapshot.currentModelId && model.provider === currentProvider;
                  const context = model.contextWindow || model.context_window || 0;
                  return (
                    <button className={`model-dropdown-item${active ? ' active' : ''}`} type="button" role="option" aria-selected={active} title={model.id} key={`${model.provider || ''}:${model.id}`} onClick={() => void selectModel(model)}>
                      <span className="model-dropdown-item-main">
                        <span className="model-dropdown-item-name">{shortModelName(model.id)}</span>
                        {model.name && model.name !== model.id ? <span className="model-dropdown-item-detail">{model.name}</span> : null}
                      </span>
                      <span className="model-dropdown-item-meta">
                        {context ? <span className="model-dropdown-item-ctx">{Math.round(context / 1000)}k</span> : null}
                        {active ? <Icon name="check" width={13} height={13} /> : null}
                      </span>
                    </button>
                  );
                }) : <div className="model-dropdown-item empty">当前供应商没有可用模型</div>}
              </div>
            </div>
          ) : null}
        </div>
        <button className={`thinking-tag${snapshot.thinkingLevel === 'off' || !snapshot.thinkingSupported ? ' off' : ''}`} type="button" disabled={!snapshot.thinkingSupported} title={snapshot.thinkingSupported ? '切换新回复的思考级别' : '当前模型不支持 Pi 思考级别'} onClick={() => void controller.cycleThinking()}>
          思考：{snapshot.thinkingSupported ? thinkingLabels[snapshot.thinkingLevel] || snapshot.thinkingLevel : '不可用'}
        </button>
        <div className="session-metrics" ref={metricsRef}>
          <button className="session-metrics-trigger" type="button" title="查看会话上下文" onClick={() => setMetricsOpen((value) => !value)}>
            <Icon name="chart" />
            {contextKnown && used > 0 ? <span className={`pill token-usage visible${percent >= 80 ? ' critical' : percent >= 60 ? ' warning' : ''}`}>{total ? (percent === 0 ? '<1%' : `${percent}%`) : formatTokens(used)}</span> : null}
            {snapshot.sessionTotalCost > 0 ? <span className="pill session-cost visible">${snapshot.sessionTotalCost.toFixed(4)}</span> : null}
          </button>
          {metricsOpen ? (
            <div className="context-viz">
              <div className="context-viz-title">会话上下文</div>
              {segments.length ? (
                <>
                  <div className="context-bar">{segments.filter((segment) => segment.tokens > 0).map((segment) => <div className={`context-bar-segment ${segment.key}`} style={{ width: `${Math.min(100, (segment.tokens / total) * 100)}%` }} title={`${segment.label}: ${formatTokens(segment.tokens)}`} key={segment.key} />)}</div>
                  <div className="context-legend">{segments.map((segment) => <div className="context-legend-item" key={segment.key}><span className="context-legend-left"><span className={`context-legend-dot ${segment.key}`} />{segment.label}</span><span className="context-legend-value">{formatTokens(segment.tokens)}</span></div>)}</div>
                  <div className="context-viz-footer"><span>已使用 {percent}%</span><span>{formatTokens(used)} / {formatTokens(total)}</span></div>
                  {percent >= 80 ? <button className="compact-btn" type="button" onClick={() => void controller.compact()}>压缩上下文</button> : null}
                </>
              ) : <div className="context-viz-footer"><span>{hasReportedContext && reportedTokens == null ? '压缩后等待下一次回复确认' : '尚无用量数据'}</span></div>}
            </div>
          ) : null}
        </div>
        <button id="file-sidebar-toggle" className={`icon-btn${fileOpen ? ' active' : ''}`} type="button" title="打开文件栏" aria-label="打开文件栏" aria-expanded={fileOpen} onClick={onToggleFiles}><Icon name="folder" width={17} height={17} /></button>
      </div>
    </header>
  );
}

const maxImageDimension = 2048;
const validMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

async function processImage(file: File): Promise<ImageAttachment> {
  const inputMime = validMimeTypes.has(file.type) ? file.type : 'image/png';
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('解析图片失败'));
    element.src = dataUrl;
  });
  let width = image.width;
  let height = image.height;
  if (width > maxImageDimension || height > maxImageDimension) {
    const scale = maxImageDimension / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片处理');
  context.drawImage(image, 0, 0, width, height);
  const mimeType = inputMime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const encoded = canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.85 : undefined);
  const data = encoded.split(',')[1];
  if (!data) throw new Error('图片编码失败');
  return { data, mimeType };
}

interface FileContentPayload {
  kind: string;
  name: string;
  mimeType: string;
  content?: string;
  reason?: string;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || imageExtensions.has(extensionOf(file.name));
}

// `items` and `files` overlap in most engines, but neither is reliable on its own inside
// WKWebView (a Finder copy often exposes only one of them), so read both and de-duplicate.
function collectImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  const seen = new Set<string>();
  const push = (file: File | null) => {
    if (!file || !isImageFile(file)) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  for (const item of Array.from(data.items || [])) {
    if (item.kind === 'file') push(item.getAsFile());
  }
  for (const file of Array.from(data.files || [])) push(file);
  return files;
}

function fileFromBase64(data: string, mimeType: string, name: string): File {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: mimeType });
}

interface ComposerProps {
  snapshot: AppSnapshot;
  pendingFiles: FileAttachment[];
  editingMessage: { entryId: string; text: string; images?: ImageAttachment[] } | null;
  onRemoveFile(path: string): void;
  onCancelEditing(): void;
  onOpenCommands(): void;
}

export function Composer({ snapshot, pendingFiles, editingMessage, onRemoveFile, onCancelEditing, onOpenCommands }: ComposerProps) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [attachingCount, setAttachingCount] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<ImageAttachment | null>(null);
  const [recording, setRecording] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const planReadOnly = snapshot.plan.phase === 'plan' || snapshot.plan.phase === 'review';
  const knownFiles = useRef(new Set<string>());
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const slashCommands = snapshot.slashCommands;
  const slashMatch = useMemo(() => matchSlashCommand(text, text.length), [text]);
  const slashResults = useMemo(() => {
    if (!slashMatch) return [] as SlashCommand[];
    // Show the full filtered list (no hard cap) so every command remains discoverable.
    return fuzzyFilterCommands(slashCommands, slashMatch.query);
  }, [slashCommands, slashMatch]);

  useEffect(() => {
    if (slashMatch && slashResults.length) {
      setSlashOpen(true);
      setSlashIndex(0);
    } else {
      setSlashOpen(false);
    }
  }, [slashMatch, slashResults.length, slashMatch?.query]);

  useEffect(() => {
    if (!slashOpen) return;
    const list = slashListRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-slash-index="${slashIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashOpen, slashResults.length]);

  useEffect(() => {
    // Keep the active index in range if the filtered list shrinks.
    if (slashIndex >= slashResults.length) {
      setSlashIndex(Math.max(0, slashResults.length - 1));
    }
  }, [slashIndex, slashResults.length]);

  useEffect(() => {
    const added = pendingFiles.filter((file) => !knownFiles.current.has(file.path));
    if (added.length) {
      setText((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}${added.map((file) => file.path).join(' ')} `);
    }
    knownFiles.current = new Set(pendingFiles.map((file) => file.path));
  }, [pendingFiles]);

  useEffect(() => {
    const ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!ctor) return;
    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    let baseText = '';
    recognition.addEventListener('result', (event) => {
      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      baseText += finalText;
      setText(baseText + interimText);
    });
    recognition.addEventListener('end', () => setRecording(false));
    recognition.addEventListener('error', () => setRecording(false));
    recognitionRef.current = recognition;
    return () => {
      try { recognition.stop(); } catch { /* already stopped */ }
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [text]);

  useEffect(() => {
    const prefill = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (!prompt) return;
      setText(prompt);
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(prompt.length, prompt.length);
      });
    };
    window.addEventListener('pi-studio:prefill-composer', prefill);
    return () => window.removeEventListener('pi-studio:prefill-composer', prefill);
  }, []);

  useEffect(() => {
    if (!zoomedImage) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomedImage(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [zoomedImage]);

  useEffect(() => {
    if (!editingMessage) return;
    setText(editingMessage.text);
    setImages(editingMessage.images || []);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [editingMessage]);

  const reportAttachError = (title: string, error: unknown) => {
    window.dispatchEvent(new CustomEvent('pi-studio:toast', { detail: { title, message: String(error instanceof Error ? error.message : error), type: 'error' } }));
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(isImageFile);
    if (!list.length) return;
    setAttachingCount((count) => count + list.length);
    for (const file of list) {
      try {
        const processed = await processImage(file);
        setImages((current) => [...current, processed]);
      } catch (error) {
        reportAttachError('图片处理失败', error);
      } finally {
        setAttachingCount((count) => Math.max(0, count - 1));
      }
    }
  };

  // Pasting/dropping an image file from Finder often yields only its path, so read the
  // bytes back through the file API and attach them instead of littering the input.
  const addImagePaths = async (paths: string[]) => {
    setAttachingCount((count) => count + paths.length);
    for (const path of paths) {
      try {
        const payload = await apiJson<FileContentPayload>(`/api/file/content?path=${encodeURIComponent(path)}`);
        if (payload.kind !== 'image' || !payload.content) throw new Error(payload.reason || `无法读取图片：${path}`);
        const processed = await processImage(fileFromBase64(payload.content, payload.mimeType, payload.name || basename(path)));
        setImages((current) => [...current, processed]);
      } catch (error) {
        reportAttachError('读取图片失败', error);
      } finally {
        setAttachingCount((count) => Math.max(0, count - 1));
      }
    }
  };

  const applySlash = (command: SlashCommand) => {
    const cursor = textareaRef.current?.selectionStart ?? text.length;
    const next = applySlashCompletion(text, command.name, cursor);
    setText(next.text);
    setSlashOpen(false);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (slashOpen && slashResults[slashIndex]) {
      applySlash(slashResults[slashIndex]);
      return;
    }
    if (!text.trim() && images.length === 0) return;
    const message = text;
    const attachments = images;
    if (editingMessage) {
      const sent = await controller.resendLastUserMessage(editingMessage.entryId, message, attachments);
      if (!sent) return;
      onCancelEditing();
    } else {
      await controller.sendMessage(message, attachments);
    }
    setText('');
    setImages([]);
    setZoomedImage(null);
    setSlashOpen(false);
    pendingFiles.forEach((file) => onRemoveFile(file.path));
  };

  const removeFile = (file: FileAttachment) => {
    setText((value) => value.replace(`${file.path} `, '').replace(file.path, ''));
    onRemoveFile(file.path);
  };

  const clearAttachments = () => {
    setImages([]);
    setZoomedImage(null);
    pendingFiles.forEach(removeFile);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = collectImageFiles(clipboard);
    if (files.length) {
      // Without this the webview also drops the copied file's name/path into the textarea.
      event.preventDefault();
      void addFiles(files);
      return;
    }
    const paths = parseImagePaths(clipboard.getData('text/plain'));
    if (paths.length) {
      event.preventDefault();
      void addImagePaths(paths);
    }
  };

  const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const files = collectImageFiles(event.dataTransfer);
    if (files.length) {
      void addFiles(files);
      return;
    }
    const dropped = event.dataTransfer.getData('text/plain');
    const paths = parseImagePaths(dropped);
    if (paths.length) {
      void addImagePaths(paths);
      return;
    }
    if (dropped) setText((value) => `${value}${value ? ' ' : ''}${dropped} `);
  };

  const toggleRecording = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (recording) {
      try { recognition.stop(); } catch { /* already stopped */ }
      setRecording(false);
    } else {
      try {
        recognition.start();
        setRecording(true);
        textareaRef.current?.focus();
      } catch {
        setRecording(false);
      }
    }
  };

  const sourceLabel = (source?: string) => {
    if (source === 'extension') return '扩展';
    if (source === 'prompt') return '模板';
    if (source === 'skill') return '技能';
    return '内置';
  };

  return (
    <div className="input-area">
      {zoomedImage ? (
        <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label="附件预览" onClick={() => setZoomedImage(null)}>
          <img src={`data:${zoomedImage.mimeType};base64,${zoomedImage.data}`} alt="附件预览" />
          <button className="attachment-lightbox-close" type="button" aria-label="关闭预览"><Icon name="close" width={14} height={14} /></button>
        </div>
      ) : null}
      <div className="mobile-model-bar" />
      <div className="composer-shell">
        {planReadOnly ? (
          <div className="plan-readonly-guard" role="status">
            <Icon name="shield" width={13} height={13} />
            <span><strong>计划模式</strong> 只读分析中：可以探索与搜索，不能改动项目。</span>
          </div>
        ) : null}
        {editingMessage ? (
          <div className="composer-editing-banner">
            <span><Icon name="edit" width={13} height={13} /> 正在重新编辑最后一条消息</span>
            <button type="button" onClick={() => { setText(''); setImages([]); onCancelEditing(); }}>取消</button>
          </div>
        ) : null}
        {snapshot.queue.length ? (
          <div className="queued-messages">
            {snapshot.queue.map((item) => <div className="queued-msg" key={item.id}><span className="queued-msg-label">排队中</span><span className="queued-msg-text">{item.message}</span><button className="queued-msg-cancel" type="button" title="取消排队" onClick={() => controller.cancelQueuedMessage(item.id)}>×</button></div>)}
          </div>
        ) : null}
        {images.length || pendingFiles.length || attachingCount ? (
          <div className="composer-attachments">
            <div className="composer-attachments-head">
              <span className="composer-attachments-title">
                <Icon name="image" width={12} height={12} />
                附件 {images.length + pendingFiles.length}
                {attachingCount ? <em className="composer-attachments-busy">正在处理 {attachingCount}…</em> : null}
              </span>
              <button type="button" onClick={clearAttachments}>清空</button>
            </div>
            <div className="composer-attachment-list">
              {images.map((image, index) => (
                <div className="attachment-card" key={`${image.data.slice(0, 24)}-${index}`}>
                  <button className="attachment-thumb" type="button" title="点击查看大图" onClick={() => setZoomedImage(image)}>
                    <img src={`data:${image.mimeType};base64,${image.data}`} alt={`待发送图片 ${index + 1}`} />
                    <span className="attachment-zoom"><Icon name="eye" width={13} height={13} /></span>
                  </button>
                  <button className="attachment-remove" type="button" aria-label={`移除图片 ${index + 1}`} onClick={() => setImages((current) => current.filter((_, imageIndex) => imageIndex !== index))}><Icon name="close" width={9} height={9} /></button>
                </div>
              ))}
              {pendingFiles.map((file) => (
                <div className="attachment-card attachment-file" title={file.path} key={file.path}>
                  <span className="attachment-file-ext">{file.ext ? file.ext.slice(0, 4).toUpperCase() : 'FILE'}</span>
                  <span className="attachment-file-name">{file.name}</span>
                  <button className="attachment-remove" type="button" aria-label={`移除文件 ${file.name}`} onClick={() => removeFile(file)}><Icon name="close" width={9} height={9} /></button>
                </div>
              ))}
              {Array.from({ length: attachingCount }, (_, index) => <div className="attachment-card attachment-loading" key={`attaching-${index}`} aria-hidden="true" />)}
            </div>
          </div>
        ) : null}
        <form id="chat-form" onSubmit={(event) => void submit(event)}>
          {slashOpen && slashResults.length ? (
            <div className="slash-menu" role="listbox" aria-label="斜杠命令">
              <div className="slash-menu-header">命令 · {slashResults.length} 项</div>
              <div className="slash-menu-items" ref={slashListRef}>
                {slashResults.map((command, index) => (
                  <button
                    key={`${command.source || 'cmd'}:${command.name}`}
                    data-slash-index={index}
                    className={`slash-menu-item${index === slashIndex ? ' active' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => applySlash(command)}
                  >
                    <span className="slash-menu-item-main">
                      <span className="slash-menu-item-name">/{command.name}</span>
                      {command.argumentHint ? <span className="slash-menu-item-hint">{command.argumentHint}</span> : null}
                    </span>
                    <span className="slash-menu-item-desc">{command.description}</span>
                    <span className="slash-menu-item-source">{sourceLabel(command.source)}</span>
                  </button>
                ))}
              </div>
              <div className="slash-menu-footer"><span>↑↓ 选择</span><span>Tab/Enter 补全</span><span>Esc 关闭</span></div>
            </div>
          ) : null}
          <div className="input-bubble">
            <textarea
              id="message-input"
              ref={textareaRef}
              value={text}
              placeholder={snapshot.selectedSessionFile ? '在当前会话中向 Pi 发送消息… 输入 / 查看命令' : '向 Pi 发送消息… 输入 / 查看命令'}
              rows={2}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (slashOpen && slashResults.length) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSlashIndex((value) => Math.min(slashResults.length - 1, value + 1));
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSlashIndex((value) => Math.max(0, value - 1));
                    return;
                  }
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    const command = slashResults[slashIndex];
                    if (command) applySlash(command);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setSlashOpen(false);
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    const command = slashResults[slashIndex];
                    if (command) applySlash(command);
                    return;
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              onPaste={handlePaste}
            />
          </div>
          <div className="composer-toolbar">
            <div className="input-left-actions">
              <div className="composer-mode-switch" role="group" aria-label="Agent 工作模式">
                <button
                  className={planReadOnly ? 'active' : ''}
                  type="button"
                  aria-pressed={planReadOnly}
                  disabled={snapshot.isStreaming || snapshot.sessionSwitching}
                  onClick={() => void controller.enterPlan()}
                >计划</button>
                <button
                  className={!planReadOnly ? 'active' : ''}
                  type="button"
                  aria-pressed={!planReadOnly}
                  disabled={snapshot.isStreaming || snapshot.sessionSwitching}
                  onClick={() => void controller.enterBuild()}
                >构建</button>
              </div>
              <button className="input-icon-btn" type="button" title="命令（⌘K）" aria-label="打开命令" onClick={onOpenCommands}><span><Icon name="plus" /></span><span>命令</span></button>
              <button className="input-icon-btn" type="button" title="添加图片" aria-label="添加图片" onClick={() => imageInputRef.current?.click()}><Icon name="image" /><span>图片</span></button>
              <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; }} />
              {recognitionRef.current || window.SpeechRecognition || window.webkitSpeechRecognition ? <button className={`input-icon-btn input-mic-btn${recording ? ' recording' : ''}`} type="button" title={recording ? '停止录音' : '语音输入'} onClick={toggleRecording}><Icon name="mic" /><span>语音</span></button> : null}
            </div>
            <div className="composer-context">
              <button className="workspace-chip" type="button" title={snapshot.selectedSessionFile || '当前会话：新会话'}>
                <Icon name="file" className="workspace-chip-icon" width={13} height={13} />
                <span className="workspace-name">{snapshot.selectedSessionTitle || '新会话'}</span>
                <span className="workspace-path">{snapshot.selectedSessionFile || ''}</span>
              </button>
            </div>
            <div className="input-actions">
              {!snapshot.isStreaming ? <button id="send-btn" type="submit" title="发送消息" aria-label="发送消息"><Icon name="send" /></button> : <button id="abort-btn" type="button" title="停止生成（Esc）" aria-label="停止生成" onClick={() => controller.abort()}><Icon name="stop" width={13} height={13} /></button>}
            </div>
          </div>
        </form>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · / 斜杠命令 · 内容可能存在错误，请检查重要信息</div>
    </div>
  );
}

interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  onToggleSidebar(): void;
  onToggleFiles(): void;
}

interface CommandItem {
  icon: string;
  label: string;
  description: string;
  shortcut?: string;
  keywords: string;
  action(): void | Promise<void>;
}

export function CommandPalette({ open, onClose, onToggleSidebar, onToggleFiles }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo<CommandItem[]>(() => [
    { icon: '+', label: '新建会话', description: '在当前工作区创建一个新会话', shortcut: '⌘N', keywords: 'new session', action: () => controller.newSession() },
    { icon: 'C', label: '压缩上下文', description: '压缩当前会话以节省上下文空间', keywords: 'compact context', action: () => controller.compact() },
    { icon: 'H', label: '导出 HTML', description: '将当前会话导出为 HTML 文件', keywords: 'export html', action: () => controller.exportHtml() },
    { icon: 'S', label: '会话统计', description: '显示消息、工具调用和 Token 统计', keywords: 'stats token', action: () => controller.showSessionStats() },
    { icon: 'E', label: '展开全部工具', description: '展开消息中的所有工具执行卡片', keywords: 'expand tools', action: () => window.dispatchEvent(new CustomEvent('pi-studio:tool-expand', { detail: { expanded: true } })) },
    { icon: 'C', label: '折叠全部工具', description: '折叠消息中的所有工具执行卡片', keywords: 'collapse tools', action: () => window.dispatchEvent(new CustomEvent('pi-studio:tool-expand', { detail: { expanded: false } })) },
    { icon: 'B', label: '切换会话栏', description: '显示或隐藏左侧会话栏', shortcut: '⌘B', keywords: 'sidebar', action: onToggleSidebar },
    { icon: 'F', label: '切换文件栏', description: '显示或隐藏当前工作区文件', shortcut: '⌘⇧F', keywords: 'files', action: onToggleFiles },
    { icon: 'P', label: '打开项目', description: '查看并切换工作区项目', keywords: 'projects workspace', action: () => controller.setView('projects') },
    { icon: 'S', label: '打开设置', description: '管理外观、运行时和桌面行为', keywords: 'settings preferences', action: () => controller.setView('settings') },
  ], [onToggleFiles, onToggleSidebar]);
  const visible = commands.filter((command) => !query.trim() || `${command.label} ${command.description} ${command.keywords}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;
  const run = (index = activeIndex) => {
    const command = visible[index];
    if (!command) return;
    onClose();
    void Promise.resolve(command.action());
  };
  return (
    <>
      <div className="command-palette-overlay" onClick={onClose} />
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <label className="command-palette-search"><Icon name="search" width={17} height={17} /><input ref={inputRef} type="search" placeholder="搜索命令…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((value) => Math.min(visible.length - 1, value + 1)); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => Math.max(0, value - 1)); }
          if (event.key === 'Enter') { event.preventDefault(); run(); }
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        }} /><kbd>Esc</kbd></label>
        <div className="command-palette-header">可用命令</div>
        <div className="command-list">
          {visible.length ? visible.map((command, index) => <button className={`command-item${index === activeIndex ? ' active' : ''}`} type="button" key={command.label} onMouseEnter={() => setActiveIndex(index)} onClick={() => run(index)}><span className="command-icon">{command.icon}</span><span><span className="command-label">{command.label}</span><span className="command-desc">{command.description}</span></span>{command.shortcut ? <kbd className="command-shortcut">{command.shortcut}</kbd> : <span />}</button>) : <div className="command-empty">没有匹配的命令</div>}
        </div>
        <div className="command-palette-footer"><span>↑↓ 选择</span><span>Enter 执行</span></div>
      </div>
    </>
  );
}

export function ToastRegion() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<Omit<ToastMessage, 'id'>>).detail || { title: '提示' };
      const item: ToastMessage = { id: uniqueId('toast'), title: detail.title || '提示', message: detail.message, type: detail.type || 'info', duration: detail.duration ?? 3600 };
      setToasts((current) => [...current, item]);
      if ((item.duration || 0) > 0) window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== item.id)), item.duration);
    };
    window.addEventListener('pi-studio:toast', listener);
    return () => window.removeEventListener('pi-studio:toast', listener);
  }, []);
  const icons: Record<string, string> = { success: '✓', error: '!', warning: '△', info: 'i' };
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => <div className={`toast ${toast.type || 'info'}`} key={toast.id}><span className="toast-icon">{icons[toast.type || 'info']}</span><span><span className="toast-title">{toast.title}</span>{toast.message ? <span className="toast-message">{toast.message}</span> : null}</span><button className="toast-close" type="button" aria-label="关闭通知" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}>×</button></div>)}
    </div>
  );
}

function optionLabel(option: string | { label: string; value: unknown }): string {
  return typeof option === 'string' ? option : option.label;
}

function optionValue(option: string | { label: string; value: unknown }): unknown {
  return typeof option === 'string' ? option : option.value;
}

export function ExtensionDialog({ request }: { request: ExtensionUiRequest | null }) {
  const [value, setValue] = useState('');
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!request || !isInteractiveExtensionRequest(request)) return;
    setValue(String(request?.value || request?.defaultValue || request?.prefill || ''));
    const timeout = request.timeout ? window.setTimeout(() => controller.respondToExtension(request, { cancelled: true }), Number(request.timeout)) : null;
    window.requestAnimationFrame(() => fieldRef.current?.focus());
    return () => { if (timeout != null) window.clearTimeout(timeout); };
  }, [request]);
  if (!request || !isInteractiveExtensionRequest(request) || isPermissionRequest(request)) return null;
  const cancel = () => controller.respondToExtension(request, { cancelled: true });
  const title = request.title || ({ select: '请选择', confirm: '确认操作', input: '输入内容', editor: '编辑内容', notify: '扩展通知' } as Record<string, string>)[request.method] || '扩展请求';
  return (
    <div id="dialog-container" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div className={`dialog${request.method === 'editor' ? ' dialog-editor' : ''}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
        if (event.key === 'Enter' && request.method === 'input') { event.preventDefault(); controller.respondToExtension(request, value.trim() ? { value: value.trim() } : { cancelled: true }); }
      }}>
        <div className="dialog-title">{title}</div>
        {request.message ? <div className="dialog-message">{request.message}</div> : null}
        {request.method === 'select' ? <div className="dialog-options">{(request.options || []).map((option) => <button className="dialog-option" type="button" key={optionLabel(option)} onClick={() => controller.respondToExtension(request, { value: optionValue(option) })}>{optionLabel(option)}</button>)}</div> : null}
        {request.method === 'input' ? <input ref={fieldRef as React.RefObject<HTMLInputElement>} className="dialog-input" type="text" placeholder={String(request.placeholder || '')} value={value} onChange={(event) => setValue(event.target.value)} /> : null}
        {request.method === 'editor' ? <textarea ref={fieldRef as React.RefObject<HTMLTextAreaElement>} className="dialog-textarea" value={value} onChange={(event) => setValue(event.target.value)} /> : null}
        <div className="dialog-actions">
          {request.method !== 'notify' ? <button type="button" onClick={() => request.method === 'confirm' ? controller.respondToExtension(request, { confirmed: false }) : cancel()}>取消</button> : null}
          {request.method === 'confirm' ? <button className={request.destructive ? 'danger' : 'primary'} type="button" onClick={() => controller.respondToExtension(request, { confirmed: true })}>确认</button> : null}
          {request.method === 'input' || request.method === 'editor' ? <button className="primary" type="button" onClick={() => controller.respondToExtension(request, value ? { value } : { cancelled: true })}>{request.method === 'editor' ? '保存' : '提交'}</button> : null}
          {request.method === 'notify' ? <button className="primary" type="button" onClick={() => controller.respondToExtension(request, { acknowledged: true })}>知道了</button> : null}
        </div>
      </div>
    </div>
  );
}
