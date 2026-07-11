/// <reference types="vite/client" />

import type { TransportKind } from './lib/types';

declare global {
  interface TauDesktopBridge {
    isTauri: boolean;
    instancePort: number | null;
    instanceId: number | null;
    transport: TransportKind;
    useNativeWebSocket: boolean;
    setInstancePort(port: number | null): void;
    setInstanceId(pid: number | null): void;
    setTransport(transport: TransportKind): void;
  }

  interface SpeechRecognitionEventLike extends Event {
    resultIndex: number;
    results: ArrayLike<{
      isFinal: boolean;
      0: { transcript: string };
    }>;
  }

  interface SpeechRecognitionLike extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    addEventListener(type: 'result', listener: (event: SpeechRecognitionEventLike) => void): void;
    addEventListener(type: 'end', listener: () => void): void;
    addEventListener(type: 'error', listener: (event: Event & { error?: string }) => void): void;
  }

  interface Window {
    __TAURI_INTERNALS__?: unknown;
    tauDesktop: TauDesktopBridge;
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export {};
