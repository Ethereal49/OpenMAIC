// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type { ChatSession } from '@/lib/types/chat';
import { ActionEngine } from '@/lib/action/engine';
import { PlaybackEngine } from '@/lib/playback/engine';
import { AudioPlayer } from '@/lib/utils/audio-player';
import * as audioBytes from '@/lib/media/resolve-audio-bytes';
import type { Scene } from '@/lib/types/stage';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { shouldAutoResumeLecture } from '@/lib/playback/auto-resume';

const fixture = vi.hoisted(() => ({
  capabilities: vi.fn(async () => ({})),
  modelUsable: true,
  state: {
    stage: { id: 'ephemeral-options', name: 'Cue replies', createdAt: 1, updatedAt: 1 },
    chats: [] as ChatSession[],
    scenes: [],
    outlines: [],
    currentSceneId: null,
    mode: 'playback',
    setChats(chats: ChatSession[]) {
      this.chats = chats;
    },
  },
}));
vi.mock('@/lib/store', () => ({
  useStageStore: Object.assign(
    (select: (state: typeof fixture.state) => unknown) => select(fixture.state),
    { getState: () => fixture.state },
  ),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/model-settings/capabilities', () => ({
  loadModelCapabilities: () => fixture.capabilities(),
  classroomChatUsable: () => fixture.modelUsable,
}));
vi.mock('@/components/chat/session-list', () => ({ SessionList: () => null }));
vi.mock('@/components/chat/lecture-notes-view', () => ({ LectureNotesView: () => null }));
afterEach(() => {
  fixture.modelUsable = true;
  fixture.capabilities.mockReset().mockResolvedValue({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ['speech', true],
  ['speech', false],
  ['discussion', true],
  ['discussion', false],
] as const)('gates retained %s lecture text after Q&A on silence=%s', async (kind, silent) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.state.chats = [];
  const root = createRoot(document.createElement('div'));
  const ref = createRef<ChatAreaRef>();
  let blocked = false;
  let holdRetry = false;
  let retryCalls = 0;
  let releaseRetry!: (silent: boolean) => void;
  const pendingRetry = new Promise<boolean>((resolve) => {
    releaseRetry = resolve;
  });
  let releaseGuard!: (silent: boolean) => void;
  const pendingGuard = new Promise<boolean>((resolve) => {
    releaseGuard = resolve;
  });
  let onSpeechStart = (_text: string, _index: number) => {};
  let onPlaybackReadyChange = (_ready: boolean) => {};
  const engine = new PlaybackEngine(
    [
      {
        id: 'scene',
        actions: [
          { id: 'line', type: 'speech', text: 'First line' },
          { id: 'discussion', type: 'discussion', topic: 'Question', prompt: 'Discuss' },
        ],
      },
    ] as Scene[],
    { clearEffects() {} } as unknown as ActionEngine,
    {
      play: async () => true,
      stop() {},
      pause() {},
      onEnded() {},
      isPlaying: () => false,
      hasActiveAudio: () => false,
    } as unknown as AudioPlayer,
    {
      beforeSpeech: () =>
        blocked
          ? pendingGuard
          : holdRetry && ++retryCalls === (kind === 'speech' ? 2 : 1)
            ? pendingRetry
            : Promise.resolve(true),
      onSpeechStart: (text, index) => onSpeechStart(text, index),
      onPlaybackReadyChange: (ready) => onPlaybackReadyChange(ready),
    },
  );
  try {
    await act(async () => root.render(createElement(ChatArea, { ref })));
    let sessionId = '';
    await act(async () => {
      sessionId = await ref.current!.startLecture('scene');
    });
    if (kind === 'discussion') {
      engine.restoreFromSnapshot({
        sceneIndex: 0,
        actionIndex: 1,
        consumedDiscussions: [],
        sceneId: 'scene',
      });
      engine.continuePlayback();
    } else engine.start();
    await Promise.resolve();
    engine.pause();
    await act(async () => {
      ref.current!.addLectureMessage(
        sessionId,
        { id: 'line', type: 'speech', text: 'First line' },
        0,
      );
    });
    ref.current!.pauseBuffer(sessionId);
    engine.handleUserInterrupt('A question');
    const file = ts.createSourceFile(
      'owner.tsx',
      readFileSync('components/edit/PlaybackChromeRoot.tsx', 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let callback = '';
    let speechCallback = '';
    let readyCallback = '';
    let manualCallback = '';
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(file) === 'handleSessionStop' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      )
        callback = node.initializer.arguments[0].getText(file);
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'onSpeechStart')
        speechCallback = node.initializer.getText(file);
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'onPlaybackReadyChange')
        readyCallback = node.initializer.getText(file);
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(file) === 'handlePlayPause' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      )
        manualCallback = node.initializer.arguments[0].getText(file);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(callback).not.toBe('');
    const handleStop = runInNewContext(
      ts.transpileModule('(' + callback + ')', {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        engineRef: { current: engine },
        doSessionCleanup: () => engine.handleEndDiscussion(),
        shouldAutoResumeLecture,
        playbackCompleted: false,
        chatAreaRef: ref,
        lectureSessionIdRef: { current: sessionId },
      },
    ) as (payload: { source: string; endReason: string }) => Promise<void>;
    onSpeechStart = runInNewContext(
      ts.transpileModule('(' + speechCallback + ')', {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        lectureSessionIdRef: { current: sessionId },
        chatAreaRef: ref,
        setLectureSpeech() {},
        setActiveBubbleId() {},
      },
    );
    onPlaybackReadyChange = runInNewContext(
      ts.transpileModule('(' + readyCallback + ')', {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        engine,
        engineRef: { current: engine },
        lectureSessionIdRef: { current: sessionId },
        chatAreaRef: ref,
      },
    );
    blocked = true;
    await act(async () => {
      await handleStop({ source: 'soft_close_timeout', endReason: 'user_done' });
      await vi.advanceTimersByTimeAsync(6000);
    });
    const texts = () =>
      fixture.state.chats
        .find((s) => s.id === sessionId)
        ?.messages[0].parts.filter((part) => part.type === 'text')
        .map((part) => part.text);
    expect(texts()).toEqual([]);
    await act(async () => {
      releaseGuard(silent);
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(texts()).toEqual(silent ? ['First line'] : []);
    if (!silent) {
      expect(engine.getMode()).toBe('paused');
      blocked = false;
      holdRetry = true;
      const manualResume = runInNewContext(
        ts.transpileModule('(' + manualCallback + ')', {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
          engineRef: { current: engine },
          livePauseVersionRef: { current: 0 },
          chatAreaRef: ref,
          lectureSessionIdRef: { current: sessionId },
        },
      ) as () => Promise<void>;
      let manual: Promise<void>;
      await act(async () => {
        manual = manualResume();
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(texts()).toEqual([]);
      await act(async () => {
        releaseRetry(true);
        await manual!;
        await vi.advanceTimersByTimeAsync(6000);
      });
    }

    expect(
      fixture.state.chats
        .find((s) => s.id === sessionId)
        ?.messages[0].parts.filter((part) => part.type === 'text')
        .map((part) => part.text),
    ).toEqual(['First line']);
  } finally {
    releaseRetry(false);
    releaseGuard(false);
    engine.stop();
    act(() => root.unmount());
  }
});

it('persists a pending lecture sentence once when the real player retries it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.state.chats = [];
  let release!: (blob: Blob) => void;
  const bytes = vi.spyOn(audioBytes, 'resolveAudioBlob').mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  class Media {
    src = '';
    paused = true;
    ended = false;
    currentTime = 0;
    onended: (() => void) | null = null;
    async play() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {
      this.src = '';
    }
    load() {}
  }
  vi.stubGlobal('Audio', Media);
  class BlobURL extends URL {}
  Object.assign(BlobURL, { createObjectURL: () => 'blob:lecture', revokeObjectURL() {} });
  vi.stubGlobal('URL', BlobURL);
  const root = createRoot(document.createElement('div'));
  const ref = createRef<ChatAreaRef>();
  let engine: PlaybackEngine | undefined;
  try {
    await act(async () => root.render(createElement(ChatArea, { ref })));
    let sessionId = '';
    await act(async () => {
      sessionId = await ref.current!.startLecture('scene');
    });
    const file = ts.createSourceFile(
      'PlaybackChromeRoot.tsx',
      readFileSync('components/edit/PlaybackChromeRoot.tsx', 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let callback = '';
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'onSpeechStart')
        callback = node.initializer.getText(file);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(callback).not.toBe('');
    // Run the production owner callback against the real ChatArea and StreamBuffer.
    const onSpeechStart = vi.fn(
      runInNewContext(
        ts.transpileModule('(' + callback + ')', {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
          lectureSessionIdRef: { current: sessionId },
          chatAreaRef: ref,
          lectureActionCounterRef: { current: 0 },
          setLectureSpeech() {},
          setActiveBubbleId() {},
        },
      ) as (text: string, actionIndex: number) => void,
    );
    engine = new PlaybackEngine(
      [
        {
          id: 'scene',
          actions: [{ id: 'line', type: 'speech', text: 'First line', audioId: 'line' }],
        },
      ] as Scene[],
      { clearEffects() {} } as unknown as ActionEngine,
      new AudioPlayer(),
      { onSpeechStart },
    );
    await act(async () => engine!.start());
    expect(bytes).toHaveBeenCalledOnce();
    await act(async () => {
      engine!.pause();
      ref.current!.pauseBuffer(sessionId);
      release(new Blob(['audio']));
      bytes.mockResolvedValue(new Blob(['audio']));
      await engine!.resume();
      ref.current!.resumeBuffer(sessionId);
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(onSpeechStart.mock.calls).toEqual([
      ['First line', 0],
      ['First line', 0],
    ]);
    const lecture = fixture.state.chats.find((s) => s.id === sessionId);
    expect(
      lecture?.messages[0].parts.filter((part) => part.type === 'text').map((part) => part.text),
    ).toEqual(['First line']);
  } finally {
    engine?.stop();
    act(() => root.unmount());
  }
});

it.each([
  [false, false],
  [true, false],
  [false, true],
] as const)(
  'keeps a late SSE buffer paused (stop=%s, capabilities pending=%s)',
  async (stop, pending) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    fixture.state.chats = [];
    let delivery!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        delivery = controller;
      },
    });
    const fetch = vi.fn(
      async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const execute = vi.spyOn(ActionEngine.prototype, 'execute').mockResolvedValue(undefined);
    const live = vi.fn();
    const root = createRoot(document.createElement('div'));
    const ref = createRef<ChatAreaRef>();
    try {
      await act(async () => root.render(createElement(ChatArea, { ref, onLiveSpeech: live })));
      let releaseCapabilities!: (value: object) => void;
      if (pending)
        fixture.capabilities.mockReturnValueOnce(
          new Promise((resolve) => {
            releaseCapabilities = resolve;
          }),
        );
      let run!: Promise<void>;
      await act(async () => {
        if (pending) ref.current!.pauseActiveLiveBuffer(true);
        run = ref.current!.sendMessage('Late response');
      });
      if (pending) {
        expect(fetch).not.toHaveBeenCalled();
        // The first silence check has completed, but the idle Q&A admission is still pending.
        act(() => ref.current!.resumeActiveLiveBuffer());
        expect(ref.current!.pauseActiveLiveBuffer(false)).toBe(true);
        await act(async () => releaseCapabilities({}));
      } else expect(ref.current!.pauseActiveLiveBuffer()).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
      if (stop) await act(async () => ref.current!.endActiveSession());
      await act(async () => {
        const events = [
          {
            type: 'agent_start',
            data: { messageId: 'late', agentId: 'default-1', agentName: 'Teacher' },
          },
          { type: 'text_delta', data: { messageId: 'late', content: 'Late buffered text.' } },
          {
            type: 'action',
            data: {
              messageId: 'late',
              actionId: 'late-action',
              actionName: 'spotlight',
              params: { elementId: 'target' },
            },
          },
          { type: 'agent_end', data: { messageId: 'late', agentId: 'default-1' } },
          { type: 'cue_user', data: { fromAgentId: 'default-1', prompt: 'Done?' } },
          { type: 'done', data: { totalAgents: 1, totalActions: 1, cueUserReceived: true } },
        ];
        delivery.enqueue(
          new TextEncoder().encode(
            events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''),
          ),
        );
        delivery.close();
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(execute).not.toHaveBeenCalled();
      expect(
        live.mock.calls.some(([text]) => typeof text === 'string' && text.includes('Late')),
      ).toBe(false);
      if (!stop) {
        await act(async () => {
          ref.current!.resumeActiveLiveBuffer();
          await vi.advanceTimersByTimeAsync(4000);
          await run;
        });
        expect(execute).toHaveBeenCalledOnce();
        expect(
          live.mock.calls.some(([text]) => typeof text === 'string' && text.includes('Late')),
        ).toBe(true);
      }
    } finally {
      act(() => root.unmount());
    }
  },
);

it.each(['rejected', 'unusable'] as const)(
  'clears pending live admission after capabilities are %s',
  async (failure) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.state.chats = [];
    const root = createRoot(document.createElement('div'));
    const ref = createRef<ChatAreaRef>();
    try {
      await act(async () => root.render(createElement(ChatArea, { ref })));
      if (failure === 'rejected')
        fixture.capabilities.mockRejectedValueOnce(new Error('capabilities unavailable'));
      else fixture.modelUsable = false;
      await act(async () => {
        const send = ref.current!.sendMessage('Admission fails');
        if (failure === 'rejected') await expect(send).rejects.toThrow('capabilities unavailable');
        else await send;
      });
      expect(fixture.state.chats).toHaveLength(0);
      expect(ref.current!.pauseActiveLiveBuffer(false)).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  },
);

it('carries string suggestions through real SSE without saving them and sends return-to-lesson as ordinary text', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.state.chats = [];
  const requests: Array<{ messages: ChatSession['messages'] }> = [];
  const options = ['Show an example', 'Back to the lesson'];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const n = requests.length;
    const events = [
      {
        type: 'agent_start',
        data: { messageId: 'question-' + n, agentId: 'default-1', agentName: 'Teacher' },
      },
      { type: 'text_delta', data: { messageId: 'question-' + n, content: 'Which example?' } },
      { type: 'agent_end', data: { messageId: 'question-' + n, agentId: 'default-1' } },
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1', prompt: 'Any more?', ...(n === 1 ? { options } : {}) },
      },
      {
        type: 'done',
        data: { totalActions: 0, totalAgents: 1, agentHadContent: true, cueUserReceived: true },
      },
    ];
    return new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const root = createRoot(document.createElement('div'));
  const ref = createRef<ChatAreaRef>();
  const onCueUser = vi.fn();
  try {
    await act(async () => root.render(createElement(ChatArea, { ref, onCueUser })));
    let first!: Promise<void>;
    await act(async () => {
      first = ref.current!.sendMessage('Explain');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await first;
    });
    expect(onCueUser).toHaveBeenCalledExactlyOnceWith('default-1', 'Any more?', options);
    expect(fixture.state.chats[0]?.status).toBe('active');
    expect(JSON.stringify(fixture.state.chats)).not.toContain('"options"');
    expect(JSON.stringify(fixture.state.chats)).not.toContain('waiting-user');
    let reply!: Promise<void>;
    await act(async () => {
      reply = ref.current!.sendMessage(options[1]!);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await reply;
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)?.parts).toEqual([
      { type: 'text', text: 'Back to the lesson' },
    ]);
    expect(onCueUser).toHaveBeenLastCalledWith('default-1', 'Any more?');
  } finally {
    act(() => root.unmount());
  }
});
