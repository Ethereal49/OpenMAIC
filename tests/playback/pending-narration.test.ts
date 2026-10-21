import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioPlayer } from '@/lib/utils/audio-player';
import { PlaybackEngine } from '@/lib/playback/engine';
import type { ActionEngine } from '@/lib/action/engine';
import type { Scene } from '@/lib/types/stage';

const bytes = vi.hoisted(() => vi.fn());
vi.mock('@/lib/media/resolve-audio-bytes', () => ({ resolveAudioBlob: bytes }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
class Media {
  static last: Media | undefined;
  static pending: Promise<void> | undefined;
  src = '';
  paused = true;
  ended = false;
  currentTime = 0;
  onended: (() => void) | null = null;
  constructor() {
    Media.last = this;
  }
  play = vi.fn(async () => {
    await Media.pending;
    this.paused = false;
  });
  pause() {
    this.paused = true;
  }
  removeAttribute() {
    this.src = '';
  }
  load() {}
}
beforeEach(() => {
  bytes.mockReset();
  Media.last = undefined;
  Media.pending = undefined;
  vi.stubGlobal('Audio', Media);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['bytes', 'fetch', 'play'])(
  'parks pending %s in the real AudioPlayer and retries the same speech',
  async (stage) => {
    const loading = deferred<Blob | null>();
    const fetching = deferred<Response>();
    const playing = deferred<void>();
    const blob = new Blob(['narration']);
    bytes.mockReturnValue(
      stage === 'bytes' ? loading.promise : Promise.resolve(stage === 'fetch' ? null : blob),
    );
    const fetch = vi.fn(() => fetching.promise);
    vi.stubGlobal('fetch', fetch);
    if (stage === 'play') Media.pending = playing.promise;
    const player = new AudioPlayer();
    const onSpeechStart = vi.fn();
    const engine = new PlaybackEngine(
      [
        {
          id: 's',
          actions: [
            {
              id: 'first',
              type: 'speech',
              text: 'First line',
              audioId: 'first',
              audioUrl: 'https://example.test/a.wav',
            },
            { id: 'second', type: 'speech', text: 'Second line', audioId: 'second' },
          ],
        },
      ] as unknown as Scene[],
      { clearEffects: vi.fn() } as unknown as ActionEngine,
      player,
      { onSpeechStart },
    );
    engine.start();
    await vi.waitFor(() => {
      if (stage === 'fetch') expect(fetch).toHaveBeenCalledOnce();
      else if (stage === 'play') expect(Media.last?.play).toHaveBeenCalledOnce();
      else expect(bytes).toHaveBeenCalledOnce();
    });
    expect(engine.isNarrating()).toBe(true);
    engine.pause();
    expect(engine.isNarrating()).toBe(false);
    expect(engine.getSnapshot().actionIndex).toBe(0);
    if (stage === 'fetch')
      expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
        true,
      );
    loading.resolve(blob);
    fetching.resolve(new Response(blob));
    playing.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(player.isPlaying()).toBe(false);
    bytes.mockResolvedValue(blob);
    Media.pending = undefined;
    await engine.resume();
    await vi.waitFor(() => expect(player.isPlaying()).toBe(true));
    expect(bytes).toHaveBeenLastCalledWith('first');
    expect(engine.getSnapshot().actionIndex).toBe(1);
    expect(onSpeechStart.mock.calls).toEqual([
      ['First line', 0],
      ['First line', 0],
    ]);
    engine.stop();
  },
);

it('resumes the reading fallback after rejected narration is paused for frame media', async () => {
  vi.useFakeTimers();
  const playing = deferred<void>();
  Media.pending = playing.promise;
  bytes.mockResolvedValue(new Blob(['invalid narration']));
  const player = new AudioPlayer();
  const onComplete = vi.fn();
  const engine = new PlaybackEngine(
    [
      { id: 's', actions: [{ id: 'line', type: 'speech', text: 'First line', audioId: 'line' }] },
    ] as Scene[],
    { clearEffects: vi.fn() } as unknown as ActionEngine,
    player,
    { beforeSpeech: async () => true, onComplete },
  );
  try {
    engine.start();
    await vi.waitFor(() => expect(Media.last?.play).toHaveBeenCalledOnce());
    playing.reject(new Error('Narration decode failed'));
    await vi.advanceTimersByTimeAsync(250);
    expect(engine.isNarrating()).toBe(true);
    engine.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onComplete).not.toHaveBeenCalled();
    await engine.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(engine.getMode()).toBe('idle');
    expect(Media.last!.play).toHaveBeenCalledOnce();
  } finally {
    engine.stop();
  }
});
