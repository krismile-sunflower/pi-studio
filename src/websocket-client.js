/**
 * Transport client for Pi events and commands.
 *
 * Browser/legacy Tau uses a WebSocket. Tauri desktop defaults to native Pi RPC
 * over the bundled child process stdin/stdout.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export class WebSocketClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.tauriListenersReady = false;
    this.tauriRpcListenersReady = false;
    this.unlisten = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = 'idle';
  }

  usesTauriRpc() {
    return Boolean(window.tauDesktop?.isTauri) && window.tauDesktop?.transport !== 'mirror';
  }

  usesTauriBridge() {
    return Boolean(window.tauDesktop?.isTauri) &&
      window.tauDesktop?.transport === 'mirror' &&
      !window.tauDesktop?.useNativeWebSocket;
  }

  currentPid() {
    return window.tauDesktop?.instanceId || null;
  }

  async connect() {
    if (this.usesTauriRpc()) {
      await this.connectTauriRpc();
      return;
    }

    if (this.usesTauriBridge()) {
      await this.connectTauri();
      return;
    }

    if (this.connectionState === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    this.clearReconnectTimer();
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.markConnected();
    };

    this.ws.onmessage = (event) => {
      try {
        this.handleMessage(JSON.parse(event.data));
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.connectionState = 'closed';
      this.dispatchEvent(new CustomEvent('disconnected'));
      if (!this.isIntentionallyClosed) this.attemptReconnect();
    };
  }

  async connectTauriRpc() {
    if (this.connectionState === 'connecting' || this.connectionState === 'open') return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    this.clearReconnectTimer();
    await this.ensureTauriRpcListeners();

    try {
      await invoke('pi_rpc_connect', { request: { pid: this.currentPid() } });
      if (this.connectionState === 'connecting') this.markConnected();
    } catch (error) {
      console.error('[RPC] Tauri RPC failed:', error);
      this.connectionState = 'closed';
      if (String(error).includes('No active bundled Pi session')) {
        window.tauDesktop?.setInstanceId?.(null);
        this.dispatchEvent(new CustomEvent('needsPiSession'));
        return;
      }
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      if (!this.isIntentionallyClosed) this.attemptReconnect();
    }
  }

  async ensureTauriRpcListeners() {
    if (this.tauriRpcListenersReady) return;
    this.tauriRpcListenersReady = true;

    this.unlisten.push(await listen('pi-rpc-status', (event) => {
      if (!this.matchesDesktopInstance(event.payload?.pid)) return;
      if (event.payload?.status === 'connected') {
        console.log('[RPC] Connected through Tauri RPC');
        this.markConnected();
      } else if (event.payload?.status === 'disconnected') {
        console.log('[RPC] Tauri RPC disconnected');
        this.connectionState = 'closed';
        this.ws = { readyState: WebSocket.CLOSED };
        this.dispatchEvent(new CustomEvent('disconnected'));
        if (!this.isIntentionallyClosed) this.attemptReconnect();
      }
    }));

    this.unlisten.push(await listen('pi-rpc-message', (event) => {
      if (!this.matchesDesktopInstance(event.payload?.pid)) return;
      this.routeTauriRpcMessage(event.payload?.message);
    }));

    this.unlisten.push(await listen('pi-rpc-error', (event) => {
      if (!this.matchesDesktopInstance(event.payload?.pid)) return;
      console.error('[RPC] Tauri RPC error:', event.payload?.error);
      this.dispatchEvent(new CustomEvent('error', { detail: event.payload?.error }));
    }));
  }

  async connectTauri() {
    if (this.connectionState === 'connecting' || this.connectionState === 'open') return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    this.clearReconnectTimer();
    await this.ensureTauriListeners();

    try {
      const bridgeUrl = (this.url?.startsWith('ws://') || this.url?.startsWith('wss://'))
        ? this.url
        : null;
      await invoke('ws_connect', { request: { url: bridgeUrl } });
    } catch (error) {
      console.error('[WS] Tauri bridge failed:', error);
      this.connectionState = 'closed';
      if (
        String(error).includes('No active bundled Pi session') ||
        String(error).includes('Incompatible Tau mirror')
      ) {
        window.tauDesktop?.setInstancePort?.(null);
        this.dispatchEvent(new CustomEvent('needsPiSession'));
        return;
      }
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      if (!this.isIntentionallyClosed) this.attemptReconnect();
    }
  }

  async ensureTauriListeners() {
    if (this.tauriListenersReady) return;
    this.tauriListenersReady = true;

    this.unlisten.push(await listen('tau-ws-status', (event) => {
      if (event.payload === 'connected') {
        console.log('[WS] Connected through Tauri bridge');
        this.markConnected();
      } else if (event.payload === 'disconnected') {
        console.log('[WS] Tauri bridge disconnected');
        this.connectionState = 'closed';
        this.ws = { readyState: WebSocket.CLOSED };
        this.dispatchEvent(new CustomEvent('disconnected'));
        if (!this.isIntentionallyClosed) this.attemptReconnect();
      }
    }));

    this.unlisten.push(await listen('tau-ws-message', (event) => {
      try {
        this.handleMessage(JSON.parse(event.payload));
      } catch (error) {
        console.error('[WS] Failed to parse Tauri bridge message:', error);
      }
    }));

    this.unlisten.push(await listen('tau-ws-error', (event) => {
      console.error('[WS] Tauri bridge error:', event.payload);
      this.dispatchEvent(new CustomEvent('error', { detail: event.payload }));
    }));
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = 'closed';
    this.clearReconnectTimer();
    if (!this.ws) return;

    if (this.usesTauriRpc()) {
      invoke('pi_rpc_disconnect').catch(() => {});
    } else if (this.usesTauriBridge()) {
      invoke('ws_disconnect').catch(() => {});
    } else {
      this.ws.close();
    }
  }

  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = 'closed';
    this.clearReconnectTimer();

    if (this.usesTauriRpc()) {
      invoke('pi_rpc_disconnect').catch(() => {}).finally(() => this.connect());
      return;
    }
    if (this.usesTauriBridge()) {
      invoke('ws_disconnect').catch(() => {}).finally(() => this.connect());
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(1000, 'force reconnect'); } catch {}
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data) {
    if (this.usesTauriRpc()) {
      invoke('pi_rpc_send', {
        request: {
          pid: this.currentPid(),
          message: JSON.stringify(data),
        },
      }).catch((error) => {
        console.error('[RPC] Tauri RPC send failed:', error);
        this.dispatchEvent(new CustomEvent('serverError', {
          detail: { message: `pi-studio RPC send failed: ${error}` },
        }));
      });
      return true;
    }

    if (this.usesTauriBridge()) {
      invoke('ws_send', { request: { message: JSON.stringify(data) } })
        .catch((error) => {
          console.error('[WS] Tauri bridge send failed:', error);
          this.dispatchEvent(new CustomEvent('serverError', {
            detail: { message: `pi-studio WebSocket send failed: ${error}` },
          }));
        });
      return true;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }

    console.error('[WS] Cannot send, not connected');
    return false;
  }

  matchesDesktopInstance(pid) {
    const current = this.currentPid();
    return !current || !pid || Number(current) === Number(pid);
  }

  markConnected() {
    this.reconnectAttempts = 0;
    this.connectionState = 'open';
    this.ws = { readyState: WebSocket.OPEN };
    this.dispatchEvent(new CustomEvent('connected'));
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  routeTauriRpcMessage(message) {
    if (!message) return;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch (error) {
        console.error('[RPC] Failed to parse Tauri RPC message:', error);
        return;
      }
    }

    if (message.type === 'response') return;
    if (message.type === 'mirror_sync') {
      this.handleMessage(message);
      return;
    }
    this.handleMessage({ type: 'event', event: message });
  }

  handleMessage(message) {
    switch (message.type) {
      case 'event':
        this.dispatchEvent(new CustomEvent('rpcEvent', { detail: message.event }));
        break;
      case 'state':
        this.dispatchEvent(new CustomEvent('stateUpdate', { detail: message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('serverError', { detail: message }));
        break;
      case 'session_switch':
        this.dispatchEvent(new CustomEvent('sessionSwitch'));
        break;
      case 'mirror_sync':
        this.dispatchEvent(new CustomEvent('mirrorSync', { detail: message }));
        break;
      case 'response':
        break;
      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  }
}
