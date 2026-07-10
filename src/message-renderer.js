/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;

    // Track scroll position for smart auto-scroll
    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
  }

  clear() {
    this.container.innerHTML = '';
  }

  /**
   * Render KaTeX math in the given element if the library is loaded.
   * Safe to call on streaming/escaped content — KaTeX only processes $...$ patterns.
   */
  _renderMath(element) {
    if (typeof renderMathInElement !== 'undefined') {
      try {
        renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) {
        // KaTeX not loaded or rendering failed — math stays as raw TeX
      }
    }
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-mark"><img src="icons/tau-192.png" alt="" class="tau-icon-welcome"></div>
        <span class="eyebrow">PI-STUDIO</span>
        <h1>从一个问题开始</h1>
        <p class="hint">与 Pi 协作理解代码、规划改动并完成任务。你也可以从左侧继续历史会话。</p>
        <div class="shortcuts-hint">
          <span><kbd>/</kbd> 聚焦输入框</span>
          <span><kbd>⌘K</kbd> 打开命令</span>
          <span><kbd>Esc</kbd> 停止生成</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    let imagesHtml = '';
    if (message.images && message.images.length > 0) {
      imagesHtml = '<div class="message-images">' +
        message.images.map(img => {
          const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
          return `<img class="message-image" src="${src}" alt="消息附件" />`;
        }).join('') +
        '</div>';
    }

    div.innerHTML = `
      <div class="message-content">${imagesHtml}${renderUserMarkdown(message.content)}</div>
      <button class="message-copy-btn" aria-label="复制消息"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    this._renderMath(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    if (!isStreaming && this.hasAssistantError(message)) {
      return this.renderAssistantError(message, isHistory);
    }

    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text);
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    usageHtml = this.formatUsageHtml(message.usage);

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="复制消息"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      this._setupCopyBtn(div);
    }
    this.container.appendChild(div);
    if (!isStreaming) this._renderMath(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  hasAssistantError(message) {
    return Boolean(
      message && (
        message.stopReason === 'error' ||
        message.stop_reason === 'error' ||
        message.errorMessage ||
        message.error_message ||
        message.error
      )
    );
  }

  renderAssistantError(message, isHistory = false, replaceElement = null) {
    const error = this.formatAssistantError(message);
    const div = document.createElement('div');
    div.className = `message assistant assistant-error-message${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message?.id || 'assistant-error';

    const detailsHtml = error.details
      ? `<details class="assistant-error-details"><summary>查看错误详情</summary><pre>${this.escapeHtml(error.details)}</pre></details>`
      : '';

    div.innerHTML = `
      <div class="assistant-error-card" role="alert">
        <span class="assistant-error-icon" aria-hidden="true">!</span>
        <div class="assistant-error-body">
          <strong class="assistant-error-title">${this.escapeHtml(error.title)}</strong>
          <p class="assistant-error-summary">${this.escapeHtml(error.summary)}</p>
          ${detailsHtml}
        </div>
      </div>
    `;

    if (replaceElement?.isConnected) {
      replaceElement.replaceWith(div);
    } else {
      this.container.appendChild(div);
    }
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  formatAssistantError(message) {
    const value = message?.errorMessage ?? message?.error_message ?? message?.error ?? '';
    const raw = typeof value === 'string' ? value.trim() : JSON.stringify(value, null, 2);
    const statusMatch = raw.match(/^(\d{3})\s*:\s*([\s\S]*)$/);
    const status = statusMatch?.[1] || '';
    const payloadText = statusMatch?.[2] || raw;
    let payload = null;

    try {
      payload = payloadText ? JSON.parse(payloadText) : null;
    } catch {
      payload = null;
    }

    const code = payload?.code || message?.errorCode || message?.error_code || '';
    const providerMessage = payload?.message || (payload ? '' : payloadText) || '模型服务未返回具体错误信息。';
    let title = '模型响应失败';
    let summary = providerMessage;

    if (code === 'system_cpu_overloaded') {
      title = '模型服务繁忙';
      summary = '模型服务当前负载过高，请稍后重试。';
    } else if (code === 'model_not_found') {
      title = '当前模型不可用';
    } else if (/rate.?limit|too_many_requests/i.test(code) || status === '429') {
      title = '请求过于频繁';
      summary = '模型服务已限制请求频率，请稍后重试。';
    } else if (/context|token.*limit/i.test(code)) {
      title = '上下文超出限制';
    } else if (/auth|unauthorized|invalid.?key/i.test(code) || status === '401' || status === '403') {
      title = '模型服务认证失败';
    } else if (status === '503') {
      title = '模型服务暂不可用';
    }

    const details = [
      status ? `HTTP 状态：${status}` : '',
      code ? `错误代码：${code}` : '',
      raw && raw !== summary ? `原始信息：${raw}` : '',
    ].filter(Boolean).join('\n');

    return { title, summary, details };
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> 思考过程</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> 思考过程</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      // Keep any thinking block, update only the text part
      const thinkingBlock = contentDiv.querySelector('.streaming-thinking');
      const escaped = this.escapeHtml(content);
      if (thinkingBlock) {
        // Remove everything after the thinking block and re-add text
        let textNode = contentDiv.querySelector('.streaming-text');
        if (!textNode) {
          textNode = document.createElement('div');
          textNode.className = 'streaming-text';
          contentDiv.appendChild(textNode);
        }
        textNode.innerHTML = escaped;
      } else {
        contentDiv.innerHTML = escaped;
      }
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '') {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      // Read only the assistant text. A thinking-only update must not leak its
      // disclosure label/content into the visible answer body.
      const streamingText = contentDiv.querySelector('.streaming-text');
      let rawText = streamingText?.textContent || '';
      if (!streamingText) {
        const textOnly = contentDiv.cloneNode(true);
        textOnly.querySelector('.streaming-thinking')?.remove();
        rawText = textOnly.textContent || '';
      }

      // Tool-only and aborted empty assistant turns may still emit a message
      // boundary. Do not leave an empty row or a misleading 0-token receipt.
      if (!rawText.trim() && !String(thinking || '').trim()) {
        messageElement.remove();
        return false;
      }

      // Rebuild with thinking block (if any) + markdown text
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += renderMarkdown(rawText);
      contentDiv.innerHTML = html;
      // Render math after markdown is applied
      this._renderMath(contentDiv);
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.setAttribute('aria-label', '复制消息');
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (this.hasMeaningfulUsage(usage)) {
      if (!messageElement.querySelector('.message-usage')) {
        const span = document.createElement('span');
        span.className = 'message-usage';
        span.textContent = this.formatUsageTextCn(usage);
        span.title = this.formatUsageTitleCn(usage);
        messageElement.appendChild(span);
      }
    }
    return true;
  }

  formatUsageHtml(usage) {
    if (!this.hasMeaningfulUsage(usage)) return '';
    const text = this.escapeHtml(this.formatUsageTextCn(usage));
    const title = this.escapeHtml(this.formatUsageTitleCn(usage));
    return `<span class="message-usage" title="${title}">${text}</span>`;
  }

  hasMeaningfulUsage(usage) {
    if (!usage) return false;
    return [
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.reasoning,
      usage.totalTokens,
      usage.cost?.total,
    ].some((value) => Number(value || 0) > 0);
  }

  formatUsageText(usage) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const total = usage.totalTokens ?? (input + output + cacheRead);
    const cost = usage.cost?.total ?? 0;
    const tokens = `in ${this.formatTokenCount(input + cacheRead)} / out ${this.formatTokenCount(output)}`;
    return cost > 0 ? `$${cost.toFixed(4)} · ${tokens}` : `${tokens} · total ${this.formatTokenCount(total)}`;
  }

  formatUsageTitle(usage) {
    const parts = [
      `Input: ${usage.input ?? 0}`,
      `Output: ${usage.output ?? 0}`,
      `Cache read: ${usage.cacheRead ?? 0}`,
      `Cache write: ${usage.cacheWrite ?? 0}`,
      `Reasoning: ${usage.reasoning ?? 0}`,
      `Total: ${usage.totalTokens ?? 0}`,
    ];
    return parts.join(' tokens · ');
  }

  formatTokenCount(value) {
    const n = Number(value || 0);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  formatUsageTextCn(usage) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const total = usage.totalTokens ?? (input + output + cacheRead + cacheWrite);
    const cost = usage.cost?.total ?? 0;
    const cache = cacheRead || cacheWrite ? ` / 缓存 ${this.formatTokenCount(cacheRead + cacheWrite)}` : '';
    const tokens = `输入 ${this.formatTokenCount(input + cacheRead)} / 输出 ${this.formatTokenCount(output)}${cache}`;
    return cost > 0 ? `$${cost.toFixed(4)} · ${tokens}` : `${tokens} / 总计 ${this.formatTokenCount(total)}`;
  }

  formatUsageTitleCn(usage) {
    return [
      `输入: ${usage.input ?? 0}`,
      `输出: ${usage.output ?? 0}`,
      `缓存读取: ${usage.cacheRead ?? 0}`,
      `缓存写入: ${usage.cacheWrite ?? 0}`,
      `推理: ${usage.reasoning ?? 0}`,
      `总计: ${usage.totalTokens ?? 0}`,
    ].join(' token · ');
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
