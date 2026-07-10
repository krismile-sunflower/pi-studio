/**
 * Dialogs — extension UI dialogs with keyboard and focus management.
 * Response payloads remain compatible with the existing extension protocol.
 */

export class DialogHandler {
  constructor(container, wsClient) {
    this.container = container;
    this.wsClient = wsClient;
    this.currentDialog = null;
    this.timeoutId = null;
    this.previousFocus = null;
    this.keydownHandler = null;
  }

  showSelect(request) {
    this.clearCurrentDialog();
    const { id, title, options, timeout } = request;
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '请选择')}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions"><button type="button" id="dialog-cancel">取消</button></div>`;

    const optionsContainer = dialog.querySelector('#dialog-options');
    (options || []).forEach((option) => {
      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'dialog-option';
      optionButton.textContent = option;
      optionButton.addEventListener('click', () => this.respond(id, { value: option }));
      optionsContainer.appendChild(optionButton);
    });
    dialog.querySelector('#dialog-cancel').addEventListener('click', () => this.respond(id, { cancelled: true }));
    this.showDialog(dialog, timeout, id);
  }

  showConfirm(request) {
    this.clearCurrentDialog();
    const { id, title, message, timeout, destructive } = request;
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '确认操作')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button type="button" id="dialog-no">取消</button>
        <button type="button" id="dialog-yes" class="${destructive ? 'danger' : 'primary'}">确认</button>
      </div>`;
    dialog.querySelector('#dialog-yes').addEventListener('click', () => this.respond(id, { confirmed: true }));
    dialog.querySelector('#dialog-no').addEventListener('click', () => this.respond(id, { confirmed: false }));
    this.showDialog(dialog, timeout, id, () => dialog.querySelector('#dialog-yes')?.click());
  }

  showInput(request) {
    this.clearCurrentDialog();
    const { id, title, placeholder, timeout } = request;
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '输入内容')}</div>
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}">
      <div class="dialog-actions"><button type="button" id="dialog-cancel">取消</button><button type="button" id="dialog-submit" class="primary">提交</button></div>`;
    const input = dialog.querySelector('#dialog-input');
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true });
    };
    dialog.querySelector('#dialog-submit').addEventListener('click', submit);
    dialog.querySelector('#dialog-cancel').addEventListener('click', () => this.respond(id, { cancelled: true }));
    this.showDialog(dialog, timeout, id, submit, input);
  }

  showEditor(request) {
    this.clearCurrentDialog();
    const { id, title, prefill, timeout } = request;
    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog-editor';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || '编辑内容')}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions"><button type="button" id="dialog-cancel">取消</button><button type="button" id="dialog-save" class="primary">保存</button></div>`;
    const textarea = dialog.querySelector('#dialog-textarea');
    const save = () => this.respond(id, textarea.value ? { value: textarea.value } : { cancelled: true });
    dialog.querySelector('#dialog-save').addEventListener('click', save);
    dialog.querySelector('#dialog-cancel').addEventListener('click', () => this.respond(id, { cancelled: true }));
    this.showDialog(dialog, timeout, id, null, textarea);
  }

  showNotification(request) {
    const { message, notifyType } = request;
    window.dispatchEvent(new CustomEvent('pi-studio:toast', {
      detail: {
        title: notifyType === 'error' ? '扩展执行失败' : notifyType === 'warning' ? '扩展提醒' : '扩展通知',
        message,
        type: notifyType === 'error' ? 'error' : notifyType === 'warning' ? 'warning' : 'info',
      },
    }));
  }

  showDialog(dialogElement, timeout, requestId, onEnter = null, preferredFocus = null) {
    this.previousFocus = document.activeElement;
    this.currentDialog = dialogElement;
    dialogElement.setAttribute('role', 'dialog');
    dialogElement.setAttribute('aria-modal', 'true');
    this.container.replaceChildren(dialogElement);
    this.container.classList.remove('hidden');

    this.keydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.respond(requestId, { cancelled: true });
        return;
      }
      if (event.key === 'Enter' && onEnter && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        onEnter();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialogElement.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', this.keydownHandler, true);
    requestAnimationFrame(() => (preferredFocus || dialogElement.querySelector('button, input, textarea'))?.focus());

    if (timeout) {
      this.timeoutId = setTimeout(() => this.respond(requestId, { cancelled: true }), timeout);
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    if (this.keydownHandler) document.removeEventListener('keydown', this.keydownHandler, true);
    this.timeoutId = null;
    this.keydownHandler = null;
    this.container.replaceChildren();
    this.container.classList.add('hidden');
    this.currentDialog = null;
    this.previousFocus?.focus?.();
    this.previousFocus = null;
  }

  respond(id, response) {
    this.clearCurrentDialog();
    this.wsClient.send({ type: 'extension_ui_response', id, ...response });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
