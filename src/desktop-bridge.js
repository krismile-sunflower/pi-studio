import { invoke } from '@tauri-apps/api/core';

const isTauri = Boolean(window.__TAURI_INTERNALS__);
const urlParams = new URLSearchParams(window.location.search);
let instancePort = urlParams.get('tauPort') ? Number(urlParams.get('tauPort')) : null;
let instanceId = urlParams.get('piPid') ? Number(urlParams.get('piPid')) : null;
let transport = urlParams.get('transport') || (instancePort ? 'mirror' : 'rpc');

window.tauDesktop = {
  isTauri,
  invoke: isTauri ? invoke : null,
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

function headersToObject(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

async function bodyToText(body) {
  if (body == null || typeof body === 'string') return body ?? null;
  if (body instanceof Blob) return body.text();
  if (body instanceof FormData) return JSON.stringify(Object.fromEntries(body.entries()));
  return JSON.stringify(body);
}

if (isTauri) {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);

    if (!url.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    const method = (init.method || 'GET').toUpperCase();
    const response = await invoke('api_request', {
      request: {
        path: `${url.pathname}${url.search}`,
        method,
        body: await bodyToText(init.body),
        headers: headersToObject(init.headers),
        instancePort: window.tauDesktop.instancePort || instancePort,
        instanceId: window.tauDesktop.instanceId || instanceId,
      },
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': response.contentType || 'application/json',
      },
    });
  };
}
