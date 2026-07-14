import { useCallback, useEffect, useRef, useState } from 'react';
import { applyTheme, getCurrentTheme } from '../lib/theme';
import type { FileAttachment, ImageAttachment } from '../lib/types';
import { controller } from './controller';
import { useAppSnapshot } from './store';
import { FileSidebar } from '../components/FileSidebar';
import { MessageList } from '../components/MessageList';
import { Sidebar } from '../components/Sidebar';
import { ChangesView, ExtensionsView, ProjectsView, SettingsView } from '../components/Views';
import {
  CommandPalette,
  Composer,
  ExtensionDialog,
  Header,
  ToastRegion,
} from '../components/WorkbenchChrome';

function isMobile(): boolean {
  return window.innerWidth <= 720;
}

function usePanelResize(
  ref: React.RefObject<HTMLDivElement | null>,
  options: {
    cssVariable: string;
    storageKey: string;
    min: number;
    max: number;
    fallback: number;
    direction?: 1 | -1;
  },
): void {
  useEffect(() => {
    const handle = ref.current;
    if (!handle) return;
    const clamp = (value: string | number) => {
      const parsed = Number.parseInt(String(value), 10);
      return Number.isFinite(parsed)
        ? Math.min(options.max, Math.max(options.min, parsed))
        : options.fallback;
    };
    const initial = clamp(localStorage.getItem(options.storageKey) || options.fallback);
    document.documentElement.style.setProperty(options.cssVariable, `${initial}px`);
    handle.setAttribute('aria-valuemin', String(options.min));
    handle.setAttribute('aria-valuemax', String(options.max));
    handle.setAttribute('aria-valuenow', String(initial));

    const reset = () => {
      document.documentElement.style.setProperty(options.cssVariable, `${options.fallback}px`);
      localStorage.setItem(options.storageKey, String(options.fallback));
      handle.setAttribute('aria-valuenow', String(options.fallback));
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = clamp(
        getComputedStyle(document.documentElement).getPropertyValue(options.cssVariable),
      );
      document.body.classList.add('is-resizing');
      handle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const width = clamp(
          startWidth +
            (moveEvent.clientX - startX) * (options.direction ?? 1),
        );
        document.documentElement.style.setProperty(options.cssVariable, `${width}px`);
        handle.setAttribute('aria-valuenow', String(width));
      };
      const end = () => {
        const width = clamp(
          getComputedStyle(document.documentElement).getPropertyValue(options.cssVariable),
        );
        localStorage.setItem(options.storageKey, String(width));
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    };
    handle.addEventListener('dblclick', reset);
    handle.addEventListener('pointerdown', pointerDown);
    return () => {
      handle.removeEventListener('dblclick', reset);
      handle.removeEventListener('pointerdown', pointerDown);
    };
  }, [options.cssVariable, options.direction, options.fallback, options.max, options.min, options.storageKey, ref]);
}

export function App() {
  const snapshot = useAppSnapshot();
  // Desktop always starts with the session sidebar open.
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile());
  const [fileOpen, setFileOpen] = useState(
    () => localStorage.getItem('tau-file-sidebar') === 'open',
  );
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [editingMessage, setEditingMessage] = useState<{ entryId: string; text: string; images?: ImageAttachment[] } | null>(null);
  const sidebarResizer = useRef<HTMLDivElement>(null);
  const fileResizer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEditingMessage(null);
  }, [snapshot.selectedSessionFile]);

  usePanelResize(sidebarResizer, {
    cssVariable: '--sidebar-width',
    storageKey: 'pi-studio-sidebar-width',
    min: 240,
    max: 360,
    fallback: 288,
  });
  usePanelResize(fileResizer, {
    cssVariable: '--file-sidebar-width',
    storageKey: 'pi-studio-file-width',
    min: 240,
    max: 420,
    fallback: 300,
    direction: -1,
  });

  useEffect(() => {
    applyTheme(getCurrentTheme(), Boolean(localStorage.getItem('tau-theme')));
    void controller.initialize();
    return () => {
      void controller.dispose();
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((value) => !value);
  }, []);

  const toggleFiles = useCallback(() => {
    setFileOpen((value) => {
      const next = !value;
      localStorage.setItem('tau-file-sidebar', next ? 'open' : 'closed');
      return next;
    });
  }, []);

  useEffect(() => {
    let wasMobile = isMobile();
    const resize = () => {
      const mobile = isMobile();
      if (mobile && !wasMobile) setSidebarOpen(false);
      if (!mobile && wasMobile) setSidebarOpen(true);
      wasMobile = mobile;
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || touch.clientX >= 20 || !isMobile() || sidebarOpen) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!tracking || !touch) return;
      if (Math.abs(touch.clientY - startY) > touch.clientX - startX) tracking = false;
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (tracking && touch && touch.clientX - startX > 60) setSidebarOpen(true);
      tracking = false;
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
    };
  }, [sidebarOpen]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const primary = event.metaKey || event.ctrlKey;
      if (primary && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandsOpen((value) => !value);
        return;
      }
      if (primary && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void controller.newSession();
        return;
      }
      if (primary && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (primary && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFiles();
        return;
      }
      if (event.key === 'Escape') {
        if (commandsOpen) setCommandsOpen(false);
        else if (snapshot.extensionUiRequest) {
          controller.respondToExtension(snapshot.extensionUiRequest, { cancelled: true });
        } else if (snapshot.view !== 'chat') controller.returnToChat();
        else if (fileOpen && window.innerWidth <= 960) setFileOpen(false);
        else if (snapshot.isStreaming) controller.abort();
        else if (sidebarOpen && isMobile()) setSidebarOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        Boolean(target?.isContentEditable);
      if (event.key === '/' && !isInput) {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>('#message-input')?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [commandsOpen, fileOpen, sidebarOpen, snapshot.extensionUiRequest, snapshot.isStreaming, snapshot.view, toggleFiles, toggleSidebar]);

  useEffect(() => {
    const visibility = () => {
      if (
        document.visibilityState === 'visible' &&
        !controller.transport.isOpen &&
        (!window.tauDesktop.isTauri || snapshot.hasActivePiSession)
      ) {
        controller.transport.forceReconnect();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [snapshot.hasActivePiSession]);

  const addPendingFile = (file: FileAttachment) => {
    setPendingFiles((current) =>
      current.some((item) => item.path === file.path) ? current : [...current, file],
    );
  };

  return (
    <>
      <div className="app-layout" data-view={snapshot.view}>
        <Sidebar
          snapshot={snapshot}
          open={sidebarOpen}
          onToggle={toggleSidebar}
          onClose={() => setSidebarOpen(false)}
        />
        <div
          ref={sidebarResizer}
          className="panel-resizer panel-resizer-left"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整会话栏宽度"
        />
        <main className="main">
          <Header
            snapshot={snapshot}
            onOpenSidebar={() => setSidebarOpen(true)}
            fileOpen={fileOpen}
            onToggleFiles={toggleFiles}
          />
          {snapshot.view === 'projects' ? <ProjectsView snapshot={snapshot} /> : null}
          {snapshot.view === 'changes' ? <ChangesView snapshot={snapshot} /> : null}
          {snapshot.view === 'settings' ? <SettingsView snapshot={snapshot} /> : null}
          {snapshot.view === 'extensions' ? <ExtensionsView snapshot={snapshot} /> : null}
          {snapshot.view === 'chat' ? (
            <div className="chat-panel">
              <MessageList
                timeline={snapshot.timeline}
                streaming={snapshot.isStreaming}
                switching={snapshot.sessionSwitching}
                extensionUiRequest={snapshot.extensionUiRequest}
                onDeleteMessage={(entryId) => controller.deleteSessionMessage(entryId)}
                onEditMessage={(message) => {
                  if (!message.sessionEntryId) return;
                  setEditingMessage({ entryId: message.sessionEntryId, text: message.content, images: message.images });
                }}
                onRespondToExtension={(request, response) => controller.respondToExtension(request, response)}
              />
              <Composer
                snapshot={snapshot}
                pendingFiles={pendingFiles}
                editingMessage={editingMessage}
                onCancelEditing={() => setEditingMessage(null)}
                onRemoveFile={(path) =>
                  setPendingFiles((current) => current.filter((file) => file.path !== path))
                }
                onOpenCommands={() => setCommandsOpen(true)}
              />
            </div>
          ) : null}
        </main>
        <div
          ref={fileResizer}
          className="panel-resizer panel-resizer-right"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整文件栏宽度"
        />
        <FileSidebar
          rootPath={snapshot.workspace.path}
          open={fileOpen}
          snapshot={snapshot}
          onClose={() => {
            setFileOpen(false);
            localStorage.setItem('tau-file-sidebar', 'closed');
          }}
          onInsert={addPendingFile}
        />
      </div>
      <CommandPalette
        open={commandsOpen}
        onClose={() => setCommandsOpen(false)}
        onToggleSidebar={toggleSidebar}
        onToggleFiles={toggleFiles}
      />
      <ExtensionDialog request={snapshot.extensionUiRequest} />
      <ToastRegion />
    </>
  );
}
