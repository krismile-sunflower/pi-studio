import '@testing-library/jest-dom/vitest';

Object.defineProperty(window, 'tauDesktop', {
  configurable: true,
  writable: true,
  value: {
    isTauri: false,
    instancePort: null,
    instanceId: null,
    transport: 'mirror',
    useNativeWebSocket: true,
    setInstancePort(port: number | null) {
      this.instancePort = port;
    },
    setInstanceId(pid: number | null) {
      this.instanceId = pid;
    },
    setTransport(transport: 'rpc' | 'mirror') {
      this.transport = transport;
      this.useNativeWebSocket = transport === 'mirror';
    },
  },
});

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
});

window.HTMLElement.prototype.scrollTo = vi.fn();
