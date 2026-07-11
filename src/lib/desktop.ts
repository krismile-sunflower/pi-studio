import { invoke } from '@tauri-apps/api/core';
import type { TransportKind } from './types';

interface NativeApiResponse {
  status: number;
  contentType?: string;
  body: string;
}

const urlParams = new URLSearchParams(window.location.search);
const detectedDesktop = Boolean(window.__TAURI_INTERNALS__);
let instancePort = urlParams.get('tauPort') ? Number(urlParams.get('tauPort')) : null;
let instanceId = urlParams.get('piPid') ? Number(urlParams.get('piPid')) : null;
let transport: TransportKind =
  urlParams.get('transport') === 'mirror' || instancePort || !detectedDesktop ? 'mirror' : 'rpc';

export const isDesktop = detectedDesktop;

export function initializeDesktopBridge(): void {
  window.tauDesktop = {
    isTauri: isDesktop,
    instancePort,
    instanceId,
    transport,
    useNativeWebSocket: transport === 'mirror',
    setInstancePort(port) {
      instancePort = port ? Number(port) : null;
      this.instancePort = instancePort;
      if (instancePort) this.setTransport('mirror');
    },
    setInstanceId(pid) {
      instanceId = pid ? Number(pid) : null;
      this.instanceId = instanceId;
      if (instanceId) this.setTransport('rpc');
    },
    setTransport(nextTransport) {
      transport = nextTransport || 'rpc';
      this.transport = transport;
      this.useNativeWebSocket = transport === 'mirror';
    },
  };
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

async function bodyToText(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null || typeof body === 'string') return body ?? null;
  if (body instanceof Blob) return body.text();
  if (body instanceof FormData) return JSON.stringify(Object.fromEntries(body.entries()));
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

export async function apiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), window.location.href);
  if (!isDesktop || !url.pathname.startsWith('/api/')) {
    return window.fetch(url, init);
  }

  const response = await invoke<NativeApiResponse>('api_request', {
    request: {
      path: `${url.pathname}${url.search}`,
      method: (init.method || 'GET').toUpperCase(),
      body: await bodyToText(init.body),
      headers: headersToObject(init.headers),
      instancePort: window.tauDesktop.instancePort,
      instanceId: window.tauDesktop.instanceId,
    },
  });

  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': response.contentType || 'application/json' },
  });
}

export async function apiJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(input, init);
  const raw = await response.text();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error(`API endpoint is unavailable: ${new URL(input, window.location.href).pathname}`);
    }
    data = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const message =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

initializeDesktopBridge();
