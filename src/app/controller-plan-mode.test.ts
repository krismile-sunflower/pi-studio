import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanSessionState, SessionEntry } from '../lib/types';

vi.hoisted(() => {
  // Node 22 can expose its incomplete localStorage implementation to jsdom
  // when no storage file is configured. The application only needs the
  // browser Storage surface during module initialization.
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { PiStudioController } from './controller';
import { appStore } from './store';

const buildPlan: PlanSessionState = {
  phase: 'build',
  goal: '',
  steps: [],
  updatedAt: '2026-07-30T00:00:00.000Z',
};

const reviewPlan: PlanSessionState = {
  phase: 'review',
  goal: 'Ship the plan workflow',
  steps: [
    { id: 'one', title: 'Persist plan state', status: 'pending' },
    { id: 'two', title: 'Render execution progress', status: 'pending' },
  ],
  updatedAt: '2026-07-30T00:00:00.000Z',
};

function persistedPlan(plan: PlanSessionState): SessionEntry[] {
  return [{ type: 'custom', customType: 'plan-mode', data: plan }];
}

describe('controller plan-mode transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.tauDesktop.setTransport('mirror');
    appStore.update({
      isStreaming: false,
      sessionSwitching: false,
      selectedSessionFile: null,
      activeSessionFile: null,
      plan: buildPlan,
    });
  });

  it('keeps native RPC controls on the prompt channel after a snapshot envelope', async () => {
    window.tauDesktop.setTransport('rpc');
    const instance = new PiStudioController();
    const internal = instance as unknown as {
      handleMirrorSync(snapshot: { type: 'mirror_sync'; entries: SessionEntry[] }): void;
      refreshSessionsSoon(delay: number): void;
    };
    vi.spyOn(internal, 'refreshSessionsSoon').mockImplementation(() => undefined);
    internal.handleMirrorSync({ type: 'mirror_sync', entries: [] });

    const rpcCommand = vi.spyOn(instance, 'rpcCommand').mockImplementation(async (command) => {
      if (command.type === 'get_entries') {
        return { success: true, data: { entries: persistedPlan({ ...buildPlan, phase: 'plan' }) } } as never;
      }
      return { success: true } as never;
    });
    const sendReliable = vi.spyOn(instance.transport, 'sendReliable');

    await instance.enterPlan();

    expect(rpcCommand).toHaveBeenCalledWith(
      { type: 'prompt', message: '/pi-plan enter', streamingBehavior: 'followUp' },
      '',
      true,
    );
    expect(sendReliable).not.toHaveBeenCalled();
  });

  it('re-sends Build even when the local snapshot already says Build', async () => {
    window.tauDesktop.setTransport('rpc');
    const instance = new PiStudioController();
    const rpcCommand = vi.spyOn(instance, 'rpcCommand').mockImplementation(async (command) => {
      if (command.type === 'get_entries') return { success: true, data: { entries: persistedPlan(buildPlan) } } as never;
      return { success: true } as never;
    });

    await instance.enterBuild();

    expect(rpcCommand).toHaveBeenCalledWith(
      { type: 'prompt', message: '/pi-plan build', streamingBehavior: 'followUp' },
      '',
      true,
    );
  });

  it('marks the first pending step before sending the execution command', async () => {
    const instance = new PiStudioController();
    const internal = instance as unknown as {
      sendPrompt(command: Record<string, unknown>): Promise<void>;
      syncCurrentHistory(): Promise<void>;
    };
    const sendPrompt = vi.spyOn(internal, 'sendPrompt').mockResolvedValue(undefined);
    vi.spyOn(internal, 'syncCurrentHistory').mockResolvedValue(undefined);
    vi.spyOn(window, 'setTimeout').mockImplementation((handler) => {
      if (typeof handler === 'function') handler();
      return 0 as unknown as number;
    });
    appStore.update({ plan: reviewPlan });

    await instance.executePlan();

    expect(appStore.getSnapshot().plan).toMatchObject({
      phase: 'executing',
      steps: [{ status: 'in_progress' }, { status: 'pending' }],
    });
    expect(sendPrompt).toHaveBeenCalledWith({ type: 'pi_plan_command', command: '/pi-plan execute' });
  });

  it('restores the reviewed plan when starting execution fails', async () => {
    const instance = new PiStudioController();
    const internal = instance as unknown as { sendPrompt(command: Record<string, unknown>): Promise<void> };
    vi.spyOn(internal, 'sendPrompt').mockRejectedValue(new Error('offline'));
    vi.spyOn(instance.transport, 'forceReconnect').mockImplementation(() => undefined);
    appStore.update({ plan: reviewPlan });

    await instance.executePlan();

    expect(appStore.getSnapshot().plan).toEqual(reviewPlan);
  });
});
