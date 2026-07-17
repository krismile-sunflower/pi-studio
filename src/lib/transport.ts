import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { RpcEvent, TransportEnvelope } from './types';

export interface TransportHandlers {
  onConnected(): void;
  onDisconnected(): void;
  onNeedsPiSession(): void;
  onRpcEvent(event: RpcEvent): void;
  onMirrorSync(snapshot: TransportEnvelope): void;
  onServerError(message: string): void;
}

export class PiTransport {
  url: string;
  connectionState: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';

  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectDelay = 1000;
  private readonly maxReconnectDelay = 10_000;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;
  private listenersReady = false;
  private unlisten: UnlistenFn[] = [];

  constructor(
    url: string,
    private readonly handlers: TransportHandlers,
  ) {
    this.url = url;
  }

  get isOpen(): boolean {
    return this.connectionState === 'open';
  }

  private usesTauriRpc(): boolean {
    return Boolean(window.tauDesktop?.isTauri) && window.tauDesktop.transport !== 'mirror';
  }

  private usesTauriBridge(): boolean {
    return (
      Boolean(window.tauDesktop?.isTauri) &&
      window.tauDesktop.transport === 'mirror' &&
      !window.tauDesktop.useNativeWebSocket
    );
  }

  async connect(): Promise<void> {
    if (this.connectionState === 'connecting' || this.connectionState === 'open') return;
    this.intentionallyClosed = false;
    this.connectionState = 'connecting';
    this.clearReconnectTimer();

    if (this.usesTauriRpc()) {
      await this.ensureTauriListeners();
      try {
        await invoke('pi_rpc_connect', { request: { pid: window.tauDesktop.instanceId } });
        if (this.connectionState === 'connecting') this.markConnected();
      } catch (error) {
        this.handleConnectError(error);
      }
      return;
    }

    if (this.usesTauriBridge()) {
      await this.ensureTauriListeners();
      try {
        await invoke('ws_connect', {
          request: { url: /^wss?:\/\//.test(this.url) ? this.url : null },
        });
      } catch (error) {
        this.handleConnectError(error);
      }
      return;
    }

    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('open', () => this.markConnected());
    this.socket.addEventListener('message', (event) => {
      try {
        this.route(JSON.parse(String(event.data)) as TransportEnvelope);
      } catch (error) {
        this.handlers.onServerError(`无法解析 Pi 消息：${String(error)}`);
      }
    });
    this.socket.addEventListener('error', () => this.handlers.onServerError('WebSocket 连接错误'));
    this.socket.addEventListener('close', () => {
      this.connectionState = 'closed';
      this.handlers.onDisconnected();
      if (!this.intentionallyClosed) this.attemptReconnect();
    });
  }

  send(data: Record<string, unknown>): boolean {
    if (this.usesTauriRpc()) {
      void invoke('pi_rpc_send', {
        request: {
          pid: window.tauDesktop.instanceId,
          message: JSON.stringify(data),
        },
      }).catch((error) => this.handlers.onServerError(`PiCode RPC 发送失败：${String(error)}`));
      return true;
    }

    if (this.usesTauriBridge()) {
      void invoke('ws_send', { request: { message: JSON.stringify(data) } }).catch((error) =>
        this.handlers.onServerError(`PiCode WebSocket 发送失败：${String(error)}`),
      );
      return true;
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  async disconnect(): Promise<void> {
    this.intentionallyClosed = true;
    this.connectionState = 'closed';
    this.clearReconnectTimer();
    if (this.usesTauriRpc()) await invoke('pi_rpc_disconnect').catch(() => undefined);
    else if (this.usesTauriBridge()) await invoke('ws_disconnect').catch(() => undefined);
    else this.socket?.close();
  }

  forceReconnect(): void {
    this.reconnectAttempts = 0;
    this.intentionallyClosed = false;
    this.connectionState = 'closed';
    this.clearReconnectTimer();
    void this.disconnectCurrent().finally(() => {
      this.intentionallyClosed = false;
      void this.connect();
    });
  }

  setTarget(url: string): void {
    if (this.url === url) return;
    this.url = url;
    if (this.connectionState === 'open' || this.connectionState === 'connecting') this.forceReconnect();
  }

  async dispose(): Promise<void> {
    await this.disconnect();
    for (const stop of this.unlisten) stop();
    this.unlisten = [];
    this.listenersReady = false;
  }

  private async disconnectCurrent(): Promise<void> {
    if (this.usesTauriRpc()) await invoke('pi_rpc_disconnect').catch(() => undefined);
    else if (this.usesTauriBridge()) await invoke('ws_disconnect').catch(() => undefined);
    else if (this.socket) {
      try {
        this.socket.close(1000, 'force reconnect');
      } catch {
        // The socket may already be closing.
      }
      this.socket = null;
    }
  }

  private async ensureTauriListeners(): Promise<void> {
    if (this.listenersReady) return;
    this.listenersReady = true;

    this.unlisten.push(
      await listen<{ pid?: number; status?: string }>('pi-rpc-status', ({ payload }) => {
        if (!this.matchesInstance(payload?.pid)) return;
        if (payload?.status === 'connected') this.markConnected();
        if (payload?.status === 'disconnected') this.markDisconnected();
      }),
      await listen<{ pid?: number; message?: TransportEnvelope | string }>('pi-rpc-message', ({ payload }) => {
        if (!this.matchesInstance(payload?.pid) || !payload?.message) return;
        let message = payload.message;
        if (typeof message === 'string') {
          try {
            message = JSON.parse(message) as TransportEnvelope;
          } catch (error) {
            this.handlers.onServerError(`无法解析 RPC 消息：${String(error)}`);
            return;
          }
        }
        if (message.type === 'response') return;
        this.route(message.type === 'mirror_sync' ? message : { type: 'event', event: message as RpcEvent });
      }),
      await listen<{ pid?: number; error?: string }>('pi-rpc-error', ({ payload }) => {
        if (this.matchesInstance(payload?.pid)) this.handlers.onServerError(payload?.error || 'Pi RPC 错误');
      }),
      await listen<string>('tau-ws-status', ({ payload }) => {
        if (payload === 'connected') this.markConnected();
        if (payload === 'disconnected') this.markDisconnected();
      }),
      await listen<string>('tau-ws-message', ({ payload }) => {
        try {
          this.route(JSON.parse(payload) as TransportEnvelope);
        } catch (error) {
          this.handlers.onServerError(`无法解析 mirror 消息：${String(error)}`);
        }
      }),
      await listen<string>('tau-ws-error', ({ payload }) => this.handlers.onServerError(payload)),
    );
  }

  private matchesInstance(pid?: number): boolean {
    const current = window.tauDesktop.instanceId;
    return !current || !pid || Number(current) === Number(pid);
  }

  private route(message: TransportEnvelope): void {
    if (message.type === 'event' && message.event) this.handlers.onRpcEvent(message.event);
    else if (message.type === 'mirror_sync') this.handlers.onMirrorSync(message);
    else if (message.type === 'error') this.handlers.onServerError(String(message.message || 'Pi 错误'));
  }

  private markConnected(): void {
    this.reconnectAttempts = 0;
    this.connectionState = 'open';
    this.handlers.onConnected();
  }

  private markDisconnected(): void {
    this.connectionState = 'closed';
    this.handlers.onDisconnected();
    if (!this.intentionallyClosed) this.attemptReconnect();
  }

  private handleConnectError(error: unknown): void {
    const message = String(error);
    this.connectionState = 'closed';
    if (message.includes('No active bundled Pi session') || message.includes('Incompatible Tau mirror')) {
      window.tauDesktop.setInstanceId(null);
      window.tauDesktop.setInstancePort(null);
      this.handlers.onNeedsPiSession();
      return;
    }
    this.handlers.onServerError(message);
    if (!this.intentionallyClosed) this.attemptReconnect();
  }

  private attemptReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.maxReconnectDelay,
      this.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer == null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export function initialTransportUrl(): string {
  const { instancePort, transport } = window.tauDesktop;
  if (transport === 'mirror' && instancePort) return `ws://127.0.0.1:${instancePort}/ws`;
  if (transport === 'mirror') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }
  return 'pi-rpc://desktop';
}
