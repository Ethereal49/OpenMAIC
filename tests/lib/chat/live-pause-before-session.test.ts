// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSessions } from '@/components/chat/use-chat-sessions';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import { ActionEngine } from '@/lib/action/engine';

const mocks = vi.hoisted(() => ({ capabilities: vi.fn() }));
vi.mock('@/lib/model-settings/capabilities', () => ({
  loadModelCapabilities: mocks.capabilities,
  classroomChatUsable: () => true,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let chat: ReturnType<typeof useChatSessions>;
let pending: Promise<void> | undefined;
let container: HTMLDivElement;
const buffers: StreamBuffer[] = [];
const speech = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  buffers.length = 0;
  mocks.capabilities.mockReset();
  speech.mockClear();
  pending = undefined;
  const start = StreamBuffer.prototype.start;
  vi.spyOn(StreamBuffer.prototype, 'start').mockImplementation(function (this: StreamBuffer) {
    buffers.push(this);
    start.call(this);
  });
  vi.spyOn(ActionEngine.prototype, 'execute').mockResolvedValue(undefined);
  const events = [
    { type: 'agent_start', data: { messageId: 'm', agentId: 'default-1', agentName: 'Teacher' } },
    { type: 'text_delta', data: { messageId: 'm', content: 'Later speech.' } },
    {
      type: 'action',
      data: { messageId: 'm', actionId: 'a', actionName: 'whiteboard_clear', params: {} },
    },
    { type: 'agent_end', data: { messageId: 'm', agentId: 'default-1' } },
    { type: 'done', data: { totalAgents: 1, agentHadContent: true } },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          status: 200,
        }),
    ),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const value = useChatSessions({ onLiveSpeech: speech });
    useLayoutEffect(() => {
      chat = value;
    }, [value]);
    return null;
  }
  act(() => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => {
    await chat.endActiveSession();
    await pending;
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['discussion', 'qa'] as const)(
  'preserves pause before the delayed %s session and freezes text and actions',
  async (type) => {
    let release!: (value: object) => void;
    mocks.capabilities.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await act(async () => {
      pending =
        type === 'discussion' ? chat.startDiscussion({ topic: 'test' }) : chat.sendMessage('test');
    });
    expect(mocks.capabilities).toHaveBeenCalled();
    expect(chat.sessions).toHaveLength(0);
    act(() => {
      expect(chat.pauseActiveLiveBuffer(true)).toBe(false);
    });
    await act(async () => {
      release({});
      await vi.waitFor(() => expect(buffers).toHaveLength(1));
    });
    expect(buffers[0].paused).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(speech.mock.calls.some(([text]) => text)).toBe(false);
    expect(ActionEngine.prototype.execute).not.toHaveBeenCalled();
    await act(async () => {
      chat.resumeActiveLiveBuffer();
      await vi.advanceTimersByTimeAsync(6000);
      await pending;
    });
    expect(speech.mock.calls.some(([text]) => text === 'Later speech.')).toBe(true);
    expect(ActionEngine.prototype.execute).toHaveBeenCalledOnce();
  },
);

it('clears a pre-session pause when resumed before the first buffer arrives', async () => {
  let release!: (value: object) => void;
  mocks.capabilities.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await act(async () => {
    pending = chat.startDiscussion({ topic: 'test' });
  });
  act(() => {
    chat.pauseActiveLiveBuffer(true);
    chat.resumeActiveLiveBuffer();
  });
  await act(async () => {
    release({});
    await vi.waitFor(() => expect(buffers).toHaveLength(1));
  });
  expect(buffers[0].paused).toBe(false);
});

it('does not carry an idle media event into a later QA session', async () => {
  act(() => {
    expect(chat.pauseActiveLiveBuffer()).toBe(false);
  });
  mocks.capabilities.mockResolvedValue({});
  await act(async () => {
    pending = chat.sendMessage('new question');
    await vi.waitFor(() => expect(buffers).toHaveLength(1));
  });
  expect(buffers[0].paused).toBe(false);
});

it('preserves a new discussion pause while retiring the previous live session', async () => {
  await act(async () => {
    await chat.createSession('qa', 'Previous');
  });
  let release!: (value: object) => void;
  mocks.capabilities.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await act(async () => {
    pending = chat.startDiscussion({ topic: 'Replacement' });
  });
  act(() => {
    chat.pauseActiveLiveBuffer(true);
  });
  await act(async () => {
    release({});
    await vi.waitFor(() => expect(buffers).toHaveLength(1));
  });
  expect(buffers[0].paused).toBe(true);
  await act(async () => {
    await chat.endActiveSession();
    await pending;
  });
  mocks.capabilities.mockResolvedValue({});
  await act(async () => {
    pending = chat.sendMessage('After manual stop');
    await vi.waitFor(() => expect(buffers).toHaveLength(2));
  });
  expect(buffers[1].paused).toBe(false);
});
