/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { SessionSidebar } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { Launcher } from './launcher.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';


// Initialize components
const desktopPort = window.tauDesktop?.instancePort;
const wsUrl = desktopPort
  ? `ws://127.0.0.1:${desktopPort}/ws`
  : (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const isDesktop = Boolean(window.tauDesktop?.isTauri);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
const dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const sessionSearchInput = document.getElementById('session-search-input');
const typingIndicator = document.getElementById('typing-indicator');

const sessionCostEl = document.getElementById('session-cost');
const tokenUsageEl = document.getElementById('token-usage');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const messagesContainer = document.getElementById('messages');
const workspaceChip = document.getElementById('workspace-chip');
const workspaceName = document.getElementById('workspace-name');
const workspacePath = document.getElementById('workspace-path');
const workspaceNoFolderBtn = document.getElementById('workspace-no-folder');

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let pendingLocalPrompts = [];
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let selectedSessionFile = null; // Session selected in the sidebar, if any
let selectedSessionTitle = '';
let selectedSessionLiveOnly = false;
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Tau instances [{port, sessionFile, cwd}]
let desktopHasActivePiSession = Boolean(desktopPort);
let sessionRefreshTimer = null;
let currentWorkspace = { path: '', noFolder: false };

// File browser
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarToggle = document.getElementById('file-sidebar-toggle');
const fileSidebarClose = document.getElementById('file-sidebar-close');
const fileSidebarUp = document.getElementById('file-sidebar-up');
const fileList = document.getElementById('file-list');
const fileSidebarPath = document.getElementById('file-sidebar-path');
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext });
  renderAttachmentPreviews();
});

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder').title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder').addEventListener('click', () => {
  if (fileBrowser.currentPath) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    wsClient.ws?.readyState !== WebSocket.OPEN &&
    (!isDesktop || desktopHasActivePiSession)
  ) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  desktopHasActivePiSession = true;
  updateConnectionStatus('connected');
  refreshWorkspaceFromHealth();
  refreshSessionsSoon(300);
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);

});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  messageRenderer.renderError(e.detail.message);
});

wsClient.addEventListener('error', (e) => {
  const message = typeof e.detail === 'string' ? e.detail : e.detail?.message || String(e.detail || 'Unknown WebSocket error');
  if (message.includes('No active bundled Pi session')) return;
  messageRenderer.renderError(message);
});

wsClient.addEventListener('needsPiSession', () => {
  desktopHasActivePiSession = false;
  updateConnectionStatus('idle');
  showLauncher();
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function handleAgentStart() {
  if (pendingLocalPrompts.length > 0) {
    pendingLocalPrompts[0].confirmed = true;
  }
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  pendingLocalPrompts = [];
  updateUI();

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // In mirror mode, user messages from TUI appear via events
    // Only render if we didn't just send this message ourselves
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
    markPendingPromptConfirmed(getMessageText(message));
  }
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function getMessageThinking(message) {
  if (Array.isArray(message?.content)) {
    return message.content.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n');
  }
  return '';
}

function markPendingPromptConfirmed(text) {
  const normalized = normalizeMessageText(text);
  pendingLocalPrompts = pendingLocalPrompts.map(prompt => {
    if (normalizeMessageText(prompt.message) === normalized) {
      return { ...prompt, confirmed: true };
    }
    return prompt;
  });
}

function normalizeMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function ensureAssistantStreamingElement(seedMessage = null) {
  if (currentStreamingElement) return;
  currentStreamingText = getMessageText(seedMessage);
  currentStreamingThinking = getMessageThinking(seedMessage);
  currentStreamingElement = messageRenderer.renderAssistantMessage(
    { content: currentStreamingText || '' },
    true
  );
  if (currentStreamingThinking) {
    messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
  }
}

function rememberAssistantUsage(usage) {
  if (!usage) return;
  if (usage.cost?.total) {
    sessionTotalCost += usage.cost.total;
  }
  if (usage.input) {
    lastInputTokens = usage.input + (usage.cacheRead || 0);
    lastUsage = usage;
  }
  updateCostDisplay();
  updateTokenUsage();
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent } = event;
  ensureAssistantStreamingElement(assistantMessageEvent.partial || event.message || null);

  if (assistantMessageEvent.type === 'thinking_delta') {
    currentStreamingThinking = getMessageThinking(assistantMessageEvent.partial) || (currentStreamingThinking + assistantMessageEvent.delta);
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'thinking_end') {
    currentStreamingThinking = assistantMessageEvent.content || getMessageThinking(assistantMessageEvent.partial) || currentStreamingThinking;
    if (currentStreamingElement && currentStreamingThinking) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'text_delta') {
    currentStreamingText = getMessageText(assistantMessageEvent.partial) || (currentStreamingText + assistantMessageEvent.delta);
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  } else if (assistantMessageEvent.type === 'text_end') {
    currentStreamingText = assistantMessageEvent.content || getMessageText(assistantMessageEvent.partial) || currentStreamingText;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  }
}

function handleMessageEnd(message) {
  if (message?.role === 'assistant' && !currentStreamingElement) {
    messageRenderer.renderAssistantMessage(message, false);
    rememberAssistantUsage(message?.usage || null);
    showNewMessageBadge();
    refreshSessionsSoon(800);
    return;
  }

  if (currentStreamingElement) {
    // Pass usage info for cost display
    const usage = message?.usage || null;
    currentStreamingText = getMessageText(message) || currentStreamingText;
    currentStreamingThinking = getMessageThinking(message) || currentStreamingThinking;
    if (currentStreamingText) {
      messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
    }
    if (currentStreamingThinking) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';

    rememberAssistantUsage(usage);
    showNewMessageBadge();
  }
  refreshSessionsSoon(800);
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(event);
      break;
    case 'confirm':
      dialogHandler.showConfirm(event);
      break;
    case 'input':
      dialogHandler.showInput(event);
      break;
    case 'editor':
      dialogHandler.showEditor(event);
      break;
    case 'notify':
      dialogHandler.showNotification(event);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return '';

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviews = document.getElementById('image-previews');

let pendingImages = [];     // { data: base64, mimeType }
let pendingFilePaths = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      thumb.src = `/api/file/preview?path=${encodeURIComponent(fp.path)}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue = [];

async function sendPromptCommand(cmd) {
  if (selectedSessionFile && selectedSessionFile !== mirrorActiveSessionFile && !selectedSessionLiveOnly) {
    await resumePiSession(selectedSessionFile);
  }

  const request = {
    ...cmd,
    id: cmd.id || `tau-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    streamingBehavior: cmd.streamingBehavior || 'followUp',
  };
  if (!wsClient.send(request)) {
    throw new Error('pi-studio WebSocket is not connected yet');
  }
  return { success: true };
}

async function resumePiSession(sessionFile) {
  const result = await rpcCommand({ type: 'switch_session', sessionFile }, '正在切换会话...');
  if (!result?.success || result.data?.cancelled) {
    throw new Error(result?.error || result?.data?.error || 'Pi 未能恢复该会话');
  }

  const resumedFile = result.data?.sessionFile || sessionFile;
  selectedSessionFile = resumedFile;
  selectedSessionLiveOnly = false;
  mirrorActiveSessionFile = resumedFile;
  viewingActiveSession = true;
  updateMirrorInputState();

  if (Array.isArray(result.data?.entries) && result.data.entries.length > 0) {
    messageRenderer.clear();
    renderSessionHistory(result.data.entries);
  } else {
    wsClient.send({ type: 'mirror_sync_request' });
  }

  return result.data;
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';

  const cmd = { type: 'prompt', message: message || '(see attached image)' };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  pendingLocalPrompts.push({
    message,
    createdAt: Date.now(),
    confirmed: false,
  });
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  try {
    await sendPromptCommand(cmd);
  } catch (error) {
    pendingLocalPrompts = pendingLocalPrompts.filter(prompt => prompt.message !== message);
    messageRenderer.renderError(`Send failed: ${error}`);
    wsClient.forceReconnect();
  }
}

const queuedMessagesEl = document.getElementById('queued-messages');

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    const cmd = messageQueue.shift();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    pendingLocalPrompts.push({
      message: cmd.message,
      createdAt: Date.now(),
      confirmed: false,
    });
    renderQueuedMessages();
    try {
      await sendPromptCommand(cmd);
    } catch (error) {
      pendingLocalPrompts = pendingLocalPrompts.filter(prompt => prompt.message !== cmd.message);
      messageRenderer.renderError(`Send failed: ${error}`);
      wsClient.forceReconnect();
    }
  }
}

abortBtn.addEventListener('click', () => {
  rpcCommand({ type: 'abort' }).catch(() => wsClient.send({ type: 'abort' }));
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');

const commands = [
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },

];

function openCommandPalette() {
  commandList.innerHTML = '';
  commands.forEach(cmd => {
    const el = document.createElement('div');
    el.className = 'command-item';
    el.innerHTML = `
      <div class="command-icon">${cmd.icon}</div>
      <div>
        <div class="command-label">${cmd.label}</div>
        <div class="command-desc">${cmd.desc}</div>
      </div>
    `;
    el.addEventListener('click', () => {
      closeCommandPalette();
      cmd.action();
    });
    commandList.appendChild(el);
  });
  commandPalette.classList.remove('hidden');
  commandPaletteOverlay.classList.remove('hidden');
}

function closeCommandPalette() {
  commandPalette.classList.add('hidden');
  commandPaletteOverlay.classList.add('hidden');
}

commandBtn.addEventListener('click', openCommandPalette);
commandPaletteOverlay.addEventListener('click', closeCommandPalette);

async function rpcCommand(cmd, statusMsg) {
  try {
    if (statusMsg) statusText.textContent = statusMsg;
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const raw = await resp.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { success: false, error: raw || `HTTP ${resp.status}` };
    }
    if (!resp.ok && !data.error) {
      data.error = `HTTP ${resp.status}`;
    }
    if (data.success) {
      statusText.textContent = 'Done';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
    } else {
      statusText.textContent = data.error || 'Failed';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    }
    return data;
  } catch (e) {
    const message = e?.message || String(e);
    statusText.textContent = 'Error';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    return { success: false, error: message };
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    statusText.textContent = `Exported: ${data.data.path}`;
    setTimeout(() => { statusText.textContent = 'Connected'; }, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
const thinkingBtn = document.getElementById('thinking-btn');
function updateThinkingBtn() {
  thinkingBtn.textContent = currentThinkingLevel;
  thinkingBtn.classList.toggle('off', currentThinkingLevel === 'off');
}
let currentModelId = '';
let availableModels = [];
let currentThinkingLevel = 'off';

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models' }) }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state' }) }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      updateModelLabel();

      const model = availableModels.find(m => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      updateThinkingBtn();
    }
  } catch (e) {
    // ignore
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  modelDropdownLabel.textContent = shortName || 'model';
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains('hidden');
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  modelDropdownMenu.innerHTML = '';

  // Search input
  const search = document.createElement('input');
  search.className = 'model-dropdown-search';
  search.placeholder = 'Search models…';
  search.type = 'text';
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'model-dropdown-items';
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.innerHTML = '';
    const query = (filter || '').toLowerCase();
    availableModels.forEach(m => {
      const shortName = m.id.replace(/-\d{8}$/, '');
      const providerStr = m.provider || '';
      if (query && !shortName.toLowerCase().includes(query) && !providerStr.toLowerCase().includes(query)) return;

      const el = document.createElement('div');
      el.className = `model-dropdown-item${m.id === currentModelId ? ' active' : ''}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : '';
      const providerLabel = m.provider && m.provider !== 'anthropic' ? `<span class="model-dropdown-item-provider">${m.provider}</span>` : '';
      el.innerHTML = `<span>${shortName}${providerLabel}</span><span class="model-dropdown-item-ctx">${ctxK}</span>`;
      el.addEventListener('click', async () => {
        closeModelDropdown();
        const display = m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        await rpcCommand({ type: 'set_model', provider: m.provider, modelId: m.id }, `Switching to ${display}...`);
        currentModelId = m.id;
        updateModelLabel();
        if (m.contextWindow) {
          contextWindowSize = m.contextWindow;
          updateTokenUsage();
        }
      });
      itemsContainer.appendChild(el);
    });
  }

  renderItems('');

  search.addEventListener('input', () => renderItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelDropdown(); e.stopPropagation(); }
    if (e.key === 'Enter') {
      const first = itemsContainer.querySelector('.model-dropdown-item');
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
}

modelDropdownBtn.addEventListener('click', toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
});

// Thinking level button — cycles through levels
thinkingBtn.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' }, 'Cycling thinking...');
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains('hidden')) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains('hidden')) {
      closeModelDropdown();
      return;
    }

    if (state.isStreaming) {
      wsClient.send({ type: 'abort' });
      messageRenderer.renderError('Aborted by user');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn');
newSessionBtn.addEventListener('click', () => {
  newSession().catch((error) => {
    console.error('[App] Failed to create new session:', error);
    messageRenderer.renderError(`Failed to create session: ${error.message || error}`);
  });
});

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();

  if (isMirrorMode || desktopHasActivePiSession) {
    const result = await rpcCommand({ type: 'new_session' }, '正在创建新会话...');
    if (!result?.success || result.data?.cancelled) {
      throw new Error(result?.error || result?.data?.error || 'Pi 未能创建新会话');
    }

    const sessionFile = result.data?.sessionFile || null;
    selectedSessionFile = sessionFile;
    selectedSessionLiveOnly = false;
    mirrorActiveSessionFile = sessionFile;
    selectedSessionTitle = '新会话';
    viewingActiveSession = true;

    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();
    const entries = result.data?.entries || [];
    if (entries.length > 0) {
      renderSessionHistory(entries);
    } else {
      messageRenderer.renderWelcome();
    }
    updateMirrorInputState();
    renderSelectedSessionStrip();
    wsClient.send({ type: 'mirror_sync_request' });
    refreshSessionsSoon(300);
  } else {
    await switchSession(null);
    setSelectedSessionState(null, null);
  }

  sidebar.clearActive();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleSessionSelect(session, project) {
  sidebar.setActive(session.filePath);
  setSelectedSessionState(session, project);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    selectedSessionFile = sessionFile || null;
    // Clear any streaming state from previous session to prevent bleed
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();

    const canLoadHistoryFile = sessionFile && session && (!session.live || session.fileExists !== false);
    if (canLoadHistoryFile) {
      messageRenderer.renderSystemMessage('正在加载会话...');

      const dirName = project?.dirName;
      const file = session.file;
      console.log('[App] Loading history:', { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const res = await fetch(`/api/sessions/${dirName}/${file}`);
          console.log('[App] History fetch status:', res.status);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const data = await res.json();
          console.log('[App] History entries:', data.entries?.length || 0);

          messageRenderer.clear();
          const entries = data.entries || [];
          if (entries.length > 0) {
            renderSessionHistory(entries);
          } else {
            messageRenderer.renderSystemMessage('这个会话文件里还没有可显示的消息。');
          }
        } catch (e) {
          console.error('[App] History fetch error:', e);
          messageRenderer.clear();
          messageRenderer.renderError(`会话加载失败：${e.message || e}`);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
        messageRenderer.clear();
        messageRenderer.renderError('会话加载失败：缺少会话文件路径。');
      }
    } else if (sessionFile && session?.live) {
      messageRenderer.renderWelcome();
    } else {
      messageRenderer.renderWelcome();
    }

    // In mirror mode, check if this session is live on any instance
    if (isMirrorMode) {
      // Check if this session is live on a different instance
      const otherInstance = liveInstances.find(i => i.sessionFile === sessionFile && i.port !== new URL(wsClient.url).port * 1);
      if (otherInstance) {
        // Reconnect to the other instance
        const protocol = document.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const newUrl = `${protocol}//${location.hostname}:${otherInstance.port}/ws`;
        console.log(`[App] Switching to instance on port ${otherInstance.port}`);
        window.tauDesktop?.setInstancePort?.(otherInstance.port);
        wsClient.disconnect();
        wsClient.url = newUrl;
        wsClient.forceReconnect();
        mirrorActiveSessionFile = sessionFile;
        viewingActiveSession = true;
        updateMirrorInputState();
        return;
      }

      // Check if this is the active session on the current instance
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      updateMirrorInputState();

      if (session?.live && session.fileExists === false) {
        mirrorActiveSessionFile = sessionFile;
        selectedSessionFile = sessionFile;
        selectedSessionLiveOnly = true;
        viewingActiveSession = true;
        updateMirrorInputState();
        wsClient.send({ type: 'mirror_sync_request' });
        return;
      }

      if (viewingActiveSession) {
        // Re-request live state from the extension
        wsClient.send({ type: 'mirror_sync_request' });
      } else if (sessionFile) {
        await resumePiSession(sessionFile);
      }
    } else {
      const res = await fetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        messageRenderer.renderError(`Failed to switch session: ${err.error}`);
      }
    }
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError(`Failed to switch session: ${error.message || error}`);
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  isMirrorMode = true;

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  selectedSessionFile = selectedSessionFile || mirrorActiveSessionFile;
  if (selectedSessionFile === mirrorActiveSessionFile) selectedSessionLiveOnly = false;
  viewingActiveSession = !selectedSessionFile || selectedSessionFile === mirrorActiveSessionFile;
  updateMirrorInputState();
  updateMirrorLiveIndicator();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
    updateModelLabel();
    if (data.model.contextWindow) {
      contextWindowSize = data.model.contextWindow;
    }
  }

  // Update thinking level
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    updateThinkingBtn();
  }

  // Clear and render message history
  sessionTotalCost = 0;
  lastInputTokens = 0;

  const entries = data.entries || [];
  const hasUnconfirmedLocalPrompt = pendingLocalPrompts.some(prompt =>
    !mirrorEntriesContainText(entries, prompt.message) &&
    Date.now() - prompt.createdAt < 60000
  );

  if (!hasUnconfirmedLocalPrompt) {
    pendingLocalPrompts = pendingLocalPrompts.filter(prompt =>
      !mirrorEntriesContainText(entries, prompt.message) &&
      Date.now() - prompt.createdAt < 60000
    );
  }

  if (hasUnconfirmedLocalPrompt) {
    console.log('[Mirror] Preserving local pending message during stale sync');
  } else if (entries.length > 0) {
    messageRenderer.clear();
    renderSessionHistory(entries);
  } else if (!lastSentMessage && !state.isStreaming && !currentStreamingElement) {
    messageRenderer.clear();
    messageRenderer.renderWelcome();
  } else {
    console.log('[Mirror] Preserving local pending message during empty sync');
  }

  updateCostDisplay();
  updateTokenUsage();
  refreshSessionsSoon(300);
}

function mirrorEntriesContainText(entries, text) {
  const expected = normalizeMessageText(text);
  if (!expected) return false;

  return entries.some(entry => {
    if (entry.type !== 'message' || entry.message?.role !== 'user') return false;
    return normalizeMessageText(getMessageText(entry.message)) === expected;
  });
}

// Mark all live sessions in the sidebar with a green dot
function updateMirrorLiveIndicator() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current mirror session
  if (mirrorActiveSessionFile) liveFiles.add(mirrorActiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('mirror-live', liveFiles.has(el.dataset.filePath));
  });
}

function refreshSessionsSoon(delayMs = 500) {
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null;
    sidebar.loadSessions().then(() => {
      if (isMirrorMode) updateMirrorLiveIndicator();
    });
  }, delayMs);
}

// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch('/api/instances');
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      updateMirrorLiveIndicator();
    }
  } catch {}
}

// Poll every 5 seconds
setInterval(pollInstances, 5000);
pollInstances();

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  const inputArea = document.querySelector('.input-area');
  messageInput.disabled = false;
  messageInput.placeholder = selectedSessionFile ? '在当前会话中输入消息...' : '输入消息...';
  inputArea?.classList.remove('mirror-readonly');
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = (msg.content || []).filter((b) => b.type === 'text');
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === 'thinking');
      const toolCalls = (msg.content || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError
      );
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateCostDisplay();
  updateTokenUsage();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  const messagesEl = document.getElementById('messages');
  messagesEl.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle('hidden', !show);
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    tokenUsageEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to token usage in header
  tokenUsageEl.parentElement.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  } else if (status === 'idle') {
    statusText.textContent = 'No project';
    statusText.title = 'Open a project to start bundled Pi';
  } else if (status === 'connecting') {
    statusText.textContent = 'Starting Pi...';
    statusText.title = '';
  }
}

function setWorkspaceState({ path = '', noFolder = false } = {}) {
  currentWorkspace = { path, noFolder };
  renderSelectedSessionStrip();
}

function setSelectedSessionState(session, project) {
  selectedSessionFile = session?.filePath || null;
  selectedSessionLiveOnly = Boolean(session?.live && session.fileExists === false);
  selectedSessionTitle = session
    ? (session.name || session.firstMessage || session.file || '当前会话')
    : '';
  renderSelectedSessionStrip(project);
}

function renderSelectedSessionStrip(project = null) {
  if (!workspaceChip || !workspaceName || !workspacePath) return;

  workspaceChip.classList.toggle('no-folder', false);
  workspaceName.textContent = selectedSessionTitle || '新会话';
  workspacePath.textContent = selectedSessionFile
    ? (project?.path || selectedSessionFile)
    : '未选择历史会话，消息会进入当前新会话';
  workspaceChip.title = selectedSessionFile
    ? `当前会话：${selectedSessionTitle || selectedSessionFile}\n${selectedSessionFile}`
    : '当前会话：新会话';
  if (workspaceNoFolderBtn) {
    workspaceNoFolderBtn.classList.remove('active');
    workspaceNoFolderBtn.disabled = true;
  }
}

function setWorkspaceFromInstance(instance) {
  if (!instance) return;
  updateWsUrlFromInstance(instance);
  setWorkspaceState({
    path: instance.projectPath || instance.project_path || '',
    noFolder: Boolean(instance.noFolder ?? instance.no_folder),
  });
}

function updateWsUrlFromInstance(instance) {
  const port = instance?.port;
  if (!port) return;
  window.tauDesktop?.setInstancePort?.(port);
  const nextUrl = `ws://127.0.0.1:${port}/ws`;
  if (wsClient.url === nextUrl) return;

  wsClient.url = nextUrl;
  if (wsClient.connectionState === 'open' || wsClient.connectionState === 'connecting') {
    wsClient.forceReconnect();
  }
}

async function refreshWorkspaceFromHealth() {
  if (!isDesktop) return;
  try {
    const data = await (await fetch('/api/health')).json();
    if (data.pi) setWorkspaceFromInstance(data.pi);
  } catch {}
}

function basename(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function updateUI() {
  const isStreaming = state.isStreaming;

  if (isStreaming) {
    statusIndicator.classList.add('streaming');
    statusIndicator.classList.remove('connected');
    statusText.textContent = 'Working...';
  } else {
    statusIndicator.classList.remove('streaming');
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Connected';
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const themeGrid = document.getElementById('theme-grid');
const extensionsPanel = document.getElementById('extensions-panel');
const extensionsClose = document.getElementById('extensions-close');
const extensionsRefresh = document.getElementById('extensions-refresh');
const extensionsSearch = document.getElementById('extensions-search');
const extensionsCategories = document.getElementById('extensions-categories');
const extensionsStatus = document.getElementById('extensions-status');
const extensionsList = document.getElementById('extensions-list');


const toggleAutoCompact = document.getElementById('toggle-auto-compact');
const btnThinkingLevel = document.getElementById('btn-thinking-level');
const toggleShowThinking = document.getElementById('toggle-show-thinking');
const toggleAutostart = document.getElementById('toggle-autostart');
const btnTauPort = document.getElementById('btn-tau-port');
const piRuntimeSource = document.getElementById('pi-runtime-source');
const piRuntimeVersion = document.getElementById('pi-runtime-version');
const piNodeVersion = document.getElementById('pi-node-version');
const piRuntimePlatform = document.getElementById('pi-runtime-platform');
const piRuntimeCommand = document.getElementById('pi-runtime-command');
const piRuntimeWarning = document.getElementById('pi-runtime-warning');

let extensionsCatalog = null;
let extensionCategory = 'All';
let extensionInstallingId = null;


function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  hideLauncher();
  hideExtensions(false);
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.welcome')?.remove();
  settingsPanel.classList.remove('hidden');

  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));

  if (isDesktop) {
    try {
      const [settings, autostartEnabled, piInfo] = await Promise.all([
        invoke('get_desktop_settings'),
        invoke('is_autostart_enabled').catch(() => false),
        invoke('get_pi_runtime_info').catch((error) => ({ error: String(error) })),
      ]);
      toggleAutostart.className = `settings-toggle${autostartEnabled ? ' on' : ''}`;
      btnTauPort.textContent = String(settings.tauPort || 3001);
      renderPiRuntimeInfo(piInfo);
    } catch (e) {
      console.warn('[Desktop] Failed to read desktop settings:', e);
      renderPiRuntimeInfo({ error: String(e) });
    }
  } else {
    renderPiRuntimeInfo({
      source: 'web',
      piVersion: 'Not available',
      nodeVersion: 'Not available',
      platform: navigator.platform || 'browser',
      command: '',
    });
  }

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state' }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      currentThinkingLevel = s.thinkingLevel || 'off';
      updateThinkingBtn();
      // Session name
      inputSessionName.value = s.sessionName || '';
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  if (isDesktop && !desktopHasActivePiSession) {
    showLauncher();
    return;
  }
  messagesContainer.style.display = '';
  document.querySelector('.input-area').style.display = '';

  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);

function renderPiRuntimeInfo(info = {}) {
  const source = info.source || (info.bundled ? 'bundled' : 'unknown');
  const sourceOk = info.bundled || source === 'system' || source === 'override';
  piRuntimeSource.textContent = info.bundled ? 'Bundled' : labelCase(source);
  piRuntimeSource.className = `settings-value ${sourceOk ? 'ok' : 'warn'}`;
  piRuntimeVersion.textContent = info.piVersion || 'Unavailable';
  piNodeVersion.textContent = info.nodeVersion || 'Unavailable';
  piRuntimePlatform.textContent = info.platform || 'Unknown';
  piRuntimeCommand.textContent = info.command || '';
  piRuntimeCommand.title = info.command || '';

  if (info.error) {
    piRuntimeWarning.textContent = info.error;
    piRuntimeWarning.classList.remove('hidden');
  } else {
    piRuntimeWarning.textContent = '';
    piRuntimeWarning.classList.add('hidden');
  }
}

function labelCase(value) {
  return String(value || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function openExtensions() {
  hideLauncher();
  settingsPanel.classList.add('hidden');
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.welcome')?.remove();
  extensionsPanel.classList.remove('hidden');

  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link-extensions')?.classList.add('active');

  await loadPiExtensions();
}

function closeExtensions() {
  hideExtensions(false);
  if (isDesktop && !desktopHasActivePiSession) {
    showLauncher();
    return;
  }

  messagesContainer.style.display = '';
  document.querySelector('.input-area').style.display = '';
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

function hideExtensions(restoreChat = true) {
  extensionsPanel.classList.add('hidden');
  if (
    restoreChat &&
    settingsPanel.classList.contains('hidden') &&
    launcherEl?.classList.contains('hidden')
  ) {
    messagesContainer.style.display = '';
    document.querySelector('.input-area').style.display = '';
    document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.mode-link:first-child')?.classList.add('active');
  }
}

async function loadPiExtensions(force = false) {
  if (!isDesktop) {
    extensionsCatalog = { installDir: '', catalogRoots: [], extensions: [] };
    renderExtensions();
    extensionsStatus.textContent = 'Extensions are available in the desktop app.';
    return;
  }

  if (extensionsCatalog && !force) {
    renderExtensions();
    return;
  }

  extensionsStatus.className = 'extensions-status';
  extensionsStatus.textContent = 'Loading extensions...';
  extensionsList.innerHTML = '';

  try {
    extensionsCatalog = await invoke('list_pi_extensions');
    renderExtensionCategories();
    renderExtensions();
  } catch (error) {
    extensionsCatalog = { installDir: '', catalogRoots: [], extensions: [] };
    extensionsStatus.className = 'extensions-status error';
    extensionsStatus.textContent = `Failed to load extensions: ${error}`;
    extensionsList.innerHTML = '';
    renderExtensionCategories();
  }
}

function renderExtensionCategories() {
  if (!extensionsCategories) return;

  const extensions = extensionsCatalog?.extensions || [];
  const categories = [
    'All',
    'Installed',
    ...new Set(extensions.map(item => item.category).filter(category => category && category !== 'Installed')),
  ];
  extensionsCategories.innerHTML = '';

  for (const category of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `extensions-category${extensionCategory === category ? ' active' : ''}`;
    btn.textContent = category;
    btn.addEventListener('click', () => {
      extensionCategory = category;
      renderExtensionCategories();
      renderExtensions();
    });
    extensionsCategories.appendChild(btn);
  }
}

function renderExtensions() {
  const extensions = extensionsCatalog?.extensions || [];
  const query = (extensionsSearch?.value || '').trim().toLowerCase();

  const filtered = extensions.filter(item => {
    const matchesCategory =
      extensionCategory === 'All' ||
      (extensionCategory === 'Installed' && item.installed) ||
      item.category === extensionCategory;
    const haystack = `${item.name} ${item.id} ${item.description} ${item.category} ${item.source}`.toLowerCase();
    return matchesCategory && (!query || haystack.includes(query));
  });

  const rootCount = extensionsCatalog?.catalogRoots?.length || 0;
  if (extensions.length === 0) {
    extensionsStatus.className = 'extensions-status error';
    extensionsStatus.textContent = rootCount === 0
      ? 'No Pi extension catalog was found. Re-run the Pi vendor script or install Pi locally.'
      : 'No installable extensions were found in the Pi catalog.';
  } else {
    extensionsStatus.className = 'extensions-status';
    extensionsStatus.textContent = `${filtered.length} of ${extensions.length} extensions · installs to ${extensionsCatalog.installDir}`;
  }

  extensionsList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'extensions-empty';
    empty.textContent = 'No extensions match the current filter.';
    extensionsList.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    extensionsList.appendChild(renderExtensionRow(item));
  }
}

function renderExtensionRow(item) {
  const row = document.createElement('div');
  row.className = `extension-row${item.installed ? ' installed' : ''}`;

  const main = document.createElement('div');
  main.className = 'extension-main';

  const title = document.createElement('div');
  title.className = 'extension-title-row';

  const name = document.createElement('div');
  name.className = 'extension-name';
  name.textContent = item.name;
  title.appendChild(name);

  if (item.installed) title.appendChild(extensionTag('Installed', 'ok'));
  if (item.requiresDependencies) title.appendChild(extensionTag('npm deps'));

  const desc = document.createElement('div');
  desc.className = 'extension-description';
  desc.textContent = item.description || 'Pi extension';

  const meta = document.createElement('div');
  meta.className = 'extension-meta';
  meta.appendChild(extensionMeta(item.category));
  meta.appendChild(extensionMeta(item.kind === 'directory' ? 'folder' : 'file'));
  meta.appendChild(extensionMeta(item.source));
  if (item.installedPath) meta.appendChild(extensionMeta(shortenPath(item.installedPath)));

  main.appendChild(title);
  main.appendChild(desc);
  main.appendChild(meta);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'extension-install';
  action.disabled = item.installed || extensionInstallingId === item.id;
  action.title = item.installed ? 'Installed' : 'Install extension';
  action.innerHTML = item.installed
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Installed</span>'
    : extensionInstallingId === item.id
      ? '<span>Installing...</span>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Install</span>';
  action.addEventListener('click', () => installPiExtension(item.id));

  row.appendChild(main);
  row.appendChild(action);
  return row;
}

function extensionTag(text, tone = '') {
  const tag = document.createElement('span');
  tag.className = `extension-tag${tone ? ` ${tone}` : ''}`;
  tag.textContent = text;
  return tag;
}

function extensionMeta(text) {
  const item = document.createElement('span');
  item.className = 'extension-meta-item';
  item.textContent = text;
  item.title = text;
  return item;
}

function shortenPath(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path || '';
  return `...${path.includes('\\') ? '\\' : '/'}${parts.slice(-3).join(path.includes('\\') ? '\\' : '/')}`;
}

async function installPiExtension(id) {
  if (!isDesktop || extensionInstallingId) return;
  extensionInstallingId = id;
  renderExtensions();

  let statusClass = 'extensions-status';
  let statusText = '';
  try {
    const result = await invoke('install_pi_extension', { request: { id } });
    const index = extensionsCatalog.extensions.findIndex(item => item.id === id);
    if (index >= 0) {
      extensionsCatalog.extensions[index] = result.extension;
    }
    const dependency = result.dependencyStatus ? ` Dependencies: ${result.dependencyStatus}.` : '';
    statusClass = 'extensions-status ok';
    statusText = `${result.warning || 'Extension installed.'}${dependency}`;
  } catch (error) {
    statusClass = 'extensions-status error';
    statusText = `Install failed: ${error}`;
  } finally {
    extensionInstallingId = null;
    renderExtensionCategories();
    renderExtensions();
    if (statusText) {
      extensionsStatus.className = statusClass;
      extensionsStatus.textContent = statusText;
    }
  }
}

extensionsClose?.addEventListener('click', closeExtensions);
extensionsRefresh?.addEventListener('click', () => {
  extensionsCatalog = null;
  loadPiExtensions(true);
});
extensionsSearch?.addEventListener('input', renderExtensions);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', !isOn);
});

toggleAutostart?.addEventListener('click', async () => {
  if (!isDesktop) return;
  const isOn = toggleAutostart.classList.contains('on');
  toggleAutostart.className = `settings-toggle${isOn ? '' : ' on'}`;
  try {
    const enabled = await invoke('set_autostart', { request: { enabled: !isOn } });
    toggleAutostart.className = `settings-toggle${enabled ? ' on' : ''}`;
  } catch (e) {
    toggleAutostart.className = `settings-toggle${isOn ? ' on' : ''}`;
    messageRenderer.renderError(`Autostart failed: ${e}`);
  }
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth');
const authSection = document.getElementById('settings-auth-section');

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz');
const contextBar = document.getElementById('context-bar');
const contextLegend = document.getElementById('context-legend');
const contextVizUsed = document.getElementById('context-viz-used');
const contextVizTotal = document.getElementById('context-viz-total');


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: 'Cached', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: 'Input', tokens: freshInput, color: 'messages' },
    { key: 'free', label: 'Available', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `${pct}% used`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// Voice Input
// ═══════════════════════════════════════

const micBtn = document.getElementById('mic-btn');
let recognition = null;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-AU';

  let finalTranscript = '';
  let interimTranscript = '';

  recognition.addEventListener('result', (e) => {
    interimTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }
    // Show live transcription in the input
    messageInput.value = finalTranscript + interimTranscript;
    messageInput.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  });

  recognition.addEventListener('error', (e) => {
    console.error('[Voice] Error:', e.error);
    stopRecording();
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    finalTranscript = messageInput.value; // Append to existing text
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = 'Stop recording';
    recognition.start();
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    try { recognition.stop(); } catch {}
    // Commit final transcript
    messageInput.value = finalTranscript;
    messageInput.dispatchEvent(new Event('input'));
    messageInput.focus();
  }
} else {
  // No speech recognition support — hide mic button
  micBtn.style.display = 'none';
}



// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, move cost + token usage above input
if (isMobile()) {
  sidebarEl.classList.add('collapsed');

  const mobileBar = document.getElementById('mobile-model-bar');
  const sessionCost = document.getElementById('session-cost');
  const tokenUsage = document.getElementById('token-usage');
  if (mobileBar && sessionCost && tokenUsage) {
    mobileBar.appendChild(sessionCost);
    mobileBar.appendChild(tokenUsage);
  }

  // Start collapsed
  mobileBar.classList.add('collapsed');

  // Toggle via chevron
  const contextToggle = document.getElementById('mobile-context-toggle');
  contextToggle.addEventListener('click', () => {
    mobileBar.classList.toggle('collapsed');
    contextToggle.classList.toggle('flipped', !mobileBar.classList.contains('collapsed'));
  });
}

// Launcher
const launcherEl = document.getElementById('launcher');
const launcher = new Launcher(launcherEl, async (projectPath) => {
  launcher.setBusy(projectPath);
  try {
    const res = await fetch('/api/projects/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    const data = await res.json();
    if (data.ok) {
      desktopHasActivePiSession = true;
      setWorkspaceFromInstance(data.instance);
      await launcher.load();
      hideLauncher();
      wsClient.forceReconnect();
      setTimeout(() => sidebar.loadSessions(), 1000);
      if (isDesktop) {
        invoke('notify_desktop', {
          request: { title: 'pi-studio', body: 'Pi is running and pi-studio is connected.' },
        }).catch(() => {});
      }
    } else {
      launcher.setError(data.error || 'Failed to launch Pi');
    }
  } catch (e) {
    console.error('[Launcher] Failed to launch:', e);
    launcher.setError(String(e));
  }
}, async () => {
  if (!isDesktop) return;
  try {
    const folder = await invoke('pick_project_folder');
    if (folder) {
      await launcher.load();
    }
  } catch (e) {
    launcher.setError(String(e));
  }
}, async (projectPath) => {
  if (!isDesktop) return;
  launcher.setBusy(projectPath);
  try {
    await invoke('open_project_window', { request: { path: projectPath } });
    await launcher.load();
  } catch (e) {
    launcher.setError(String(e));
  }
}, async () => {
  if (!isDesktop) return;
  launcher.setBusy('__no_folder__');
  try {
    const res = await fetch('/api/projects/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noFolder: true }),
    });
    const data = await res.json();
    if (data.ok) {
      desktopHasActivePiSession = true;
      setWorkspaceFromInstance(data.instance);
      await launcher.load();
      hideLauncher();
      wsClient.forceReconnect();
      setTimeout(() => sidebar.loadSessions(), 1000);
    } else {
      launcher.setError(data.error || 'Failed to launch Pi');
    }
  } catch (e) {
    console.error('[Launcher] Failed to launch no-folder mode:', e);
    launcher.setError(String(e));
  }
});

workspaceChip?.addEventListener('click', () => {
  if (selectedSessionFile) sidebar.setActive(selectedSessionFile);
});

workspaceNoFolderBtn?.addEventListener('click', () => {
  if (!currentWorkspace.noFolder) launcher.onNoFolder?.();
});

// Check if launcher should show (projects configured)
async function initLauncher() {
  if (isDesktop) addLauncherNav();
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    launcher.noFolderActive = Boolean(data.noFolderActive);
    if (data.projects && data.projects.length > 0) {
      launcher.projects = data.projects;
      launcher.render();
    }
  } catch {}
}

async function getRunningInstances() {
  if (!isDesktop) return [];
  try {
    const res = await fetch('/api/instances');
    if (!res.ok) return [];
    const data = await res.json();
    return data.instances || [];
  } catch {
    return [];
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureDefaultPiSession() {
  if (!isDesktop || desktopPort) return null;
  updateConnectionStatus('connecting');
  setWorkspaceState({ path: '', noFolder: false });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const instances = await getRunningInstances();
    if (instances.length > 0) {
      desktopHasActivePiSession = true;
      liveInstances = instances;
      setWorkspaceFromInstance(instances[0]);
      return instances[0];
    }
    await delay(500);
  }

  const instance = await invoke('ensure_default_pi_session');
  desktopHasActivePiSession = true;
  liveInstances = instance ? [instance] : [];
  setWorkspaceFromInstance(instance);
  return instance;
}

function addLauncherNav() {
  const modeToggle = document.getElementById('mode-toggle');
  if (!modeToggle) return;

  if (!modeToggle.querySelector('.mode-link-launcher')) {
    const launcherLink = document.createElement('span');
    launcherLink.className = 'mode-link mode-link-launcher';
    launcherLink.title = 'Projects';
    launcherLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    launcherLink.addEventListener('click', () => {
      showLauncher();
    });
    modeToggle.appendChild(launcherLink);
  }

  if (!modeToggle.querySelector('.mode-link-extensions')) {
    const extensionsLink = document.createElement('span');
    extensionsLink.className = 'mode-link mode-link-extensions';
    extensionsLink.title = 'Extensions';
    extensionsLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v4h4v6h-4v8H9v-8H5V7h4V3Z"/><path d="M9 13h6"/></svg>';
    extensionsLink.addEventListener('click', () => {
      openExtensions();
    });
    modeToggle.appendChild(extensionsLink);
  }
}

function showLauncher() {
  settingsPanel.classList.add('hidden');
  hideExtensions(false);
  launcherEl.classList.remove('hidden');
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.welcome')?.remove();

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link-launcher')?.classList.add('active');

  launcher.load();
}

function hideLauncher() {
  launcherEl.classList.add('hidden');
  if (settingsPanel.classList.contains('hidden') && extensionsPanel.classList.contains('hidden')) {
    messagesContainer.style.display = '';
    document.querySelector('.input-area').style.display = '';
  }

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

// Make the tau icon in sidebar switch back to chat
document.querySelector('.mode-link:first-child')?.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
  hideExtensions(false);
  if (isDesktop && !desktopHasActivePiSession) {
    showLauncher();
    return;
  }
  hideLauncher();
});

if (isDesktop) {
  listen('pi-studio-command', (event) => {
    if (event.payload === 'show-launcher') showLauncher();
  }).catch(() => {});

  listen('tau-pi-status', (event) => {
    if (event.payload?.status === 'running') {
      desktopHasActivePiSession = true;
      if (event.payload.instance) {
        liveInstances = [event.payload.instance];
        setWorkspaceFromInstance(event.payload.instance);
      }
      updateConnectionStatus('connected');
      sidebar.loadSessions().then(() => {
        if (isMirrorMode) updateMirrorLiveIndicator();
      });
    } else if (event.payload?.status === 'error') {
      desktopHasActivePiSession = false;
      updateConnectionStatus('idle');
      showLauncher();
      launcher.setError(event.payload.error || 'Failed to auto-start Pi');
    } else if (event.payload?.status === 'exited') {
      desktopHasActivePiSession = false;
      updateConnectionStatus('disconnected');
      messageRenderer.renderError('Pi process exited. Open Projects to start it again.');
      showLauncher();
      launcher.load();
    }
  }).catch(() => {});
}

async function initApp() {
  await initLauncher();

  if (isDesktop && !desktopPort) {
    try {
      await ensureDefaultPiSession();
    } catch (error) {
      const message = `Failed to auto-start Pi: ${error}`;
      console.error('[Desktop] Failed to auto-start Pi:', error);
      desktopHasActivePiSession = false;
      updateConnectionStatus('idle');
      await sidebar.loadSessions();
      showLauncher();
      launcher.setError(message);
      return;
    }
  }

  messageRenderer.renderWelcome();
  wsClient.connect();
  sidebar.loadSessions().then(() => {
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
}

initApp();

// Register service worker for PWA
if (!window.tauDesktop?.isTauri && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('pi-studio initialized');
