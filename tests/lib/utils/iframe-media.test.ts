// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInteractiveMediaSession,
  mediaBridgeScript,
  mediaDocumentId,
  MEDIA_CONTROL,
} from '@/lib/interactive/media-bridge';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { runInNewContext } from 'node:vm';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function fixture() {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const played = vi.fn();
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const session = createInteractiveMediaSession(frame, 'current', played);
  session.sync();
  cleanups.push(() => session.dispose());
  const message = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data:
          data && typeof data === 'object'
            ? { generation: post.mock.calls.at(-1)![0].generation, ...data }
            : data,
      }),
    );
  return { frame, played, post, session, message };
}
const playing = { type: 'maic:media:state:v1', documentId: 'current', requestId: 0, playing: true };

function bridgeFixture() {
  const sets: Set<unknown>[] = [];
  class TrackedSet extends Set<unknown> {
    constructor(values?: Iterable<unknown>) {
      super(values);
      sets.push(this);
    }
  }
  class Media extends EventTarget {
    paused = true;
    ended = false;
    error: { code: number } | null = null;
    playError: 'reject' | 'throw' | null = null;
    play(): Promise<void> {
      if (this.playError === 'throw') throw new Error('invalid playback');
      if (this.playError === 'reject') return Promise.reject(new Error('refused'));
      this.paused = false;
      this.ended = false;
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }
  class Context extends EventTarget {
    static pendingSuspend: Promise<void> | undefined;
    state = 'running';
    suspend() {
      const finish = () => {
        this.state = 'suspended';
        this.dispatchEvent(new Event('statechange'));
      };
      if (Context.pendingSuspend) return Context.pendingSuspend.then(finish);
      finish();
      return Promise.resolve();
    }
    resume() {
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      this.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    }
  }
  function NativeAudio(src = ''): Media {
    return Object.assign(Reflect.construct(Media, [], new.target || NativeAudio), { src });
  }
  NativeAudio.prototype = Media.prototype;
  class FrameDocument extends EventTarget {
    frames: Array<{
      contentWindow: object;
      getAttribute: (name: string) => string | null;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }> = [];
    querySelectorAll() {
      return this.frames;
    }
    createElement(name: string, _options?: unknown): EventTarget {
      return ['audio', 'video'].includes(name.toLowerCase()) ? new Media() : new EventTarget();
    }
    createElementNS(namespace: string, name: string, _options?: unknown): EventTarget {
      return namespace === 'http://www.w3.org/1999/xhtml'
        ? this.createElement(name)
        : new EventTarget();
    }
  }
  type AudioFactory = { (src?: string): Media; new (src?: string): Media; prototype: Media };
  const frameWindow = new EventTarget() as EventTarget & {
    parent: { postMessage: ReturnType<typeof vi.fn> };
  };
  frameWindow.parent = { postMessage: vi.fn() };
  Object.assign(frameWindow, { AudioContext: Context, Audio: NativeAudio });
  const script = mediaBridgeScript('test').replace(/^<script[^>]*>|<\/script>$/g, '');
  const frameDocument = new FrameDocument();
  const nativePlay = vi.spyOn(frameDocument, 'addEventListener');
  runInNewContext(script, {
    window: frameWindow,
    document: frameDocument,
    HTMLMediaElement: Media,
    Document: FrameDocument,
    Set: TrackedSet,
    setTimeout,
    clearTimeout,
  });
  const control = (payload: Record<string, unknown>) =>
    frameWindow.dispatchEvent(
      new MessageEvent('message', {
        source: frameWindow.parent as unknown as Window,
        data: { type: MEDIA_CONTROL, documentId: 'test', generation: 1, ...payload },
      }),
    );
  control({ action: 'sync', enabled: true });
  return {
    Media,
    frameDocument,
    Audio: (frameWindow as unknown as { Audio: AudioFactory }).Audio,
    Context: (frameWindow as unknown as { AudioContext: typeof Context }).AudioContext,
    contextSet: sets[1],
    control,
    gesture: () =>
      (
        nativePlay.mock.calls.find(([type]) => type === 'pointerdown')?.[1] as
          | EventListener
          | undefined
      )?.({ isTrusted: true } as Event),
    media: sets[0],
    frameWindow,
    nativePlay: (element: Media) =>
      (nativePlay.mock.calls.find(([type]) => type === 'play')![1] as EventListener)({
        target: element,
      } as unknown as Event),
  };
}

describe('injected media lifetime', () => {
  it('aggregates nested media only from its registered source, document and generation', async () => {
    vi.useFakeTimers();
    const { frameWindow, frameDocument, control } = bridgeFixture();
    const postMessage = vi.fn();
    const source = { postMessage };
    frameDocument.frames.push({
      contentWindow: source,
      getAttribute: (name) =>
        name === 'srcdoc' ? '<script data-maic-media-document="child">' : null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const message = (data: Record<string, unknown>, from = source) =>
      frameWindow.dispatchEvent(
        new MessageEvent('message', {
          source: from as unknown as Window,
          data: {
            type: 'maic:media:state:v1',
            documentId: 'child',
            generation: postMessage.mock.calls.at(-1)?.[0].generation ?? 0,
            requestId: 0,
            playing: true,
            ...data,
          },
        }),
      );
    message({ generation: 0 });
    frameWindow.parent.postMessage.mockClear();
    message({}, { postMessage: vi.fn() });
    message({ documentId: 'old' });
    message({ generation: -1 });
    expect(frameWindow.parent.postMessage.mock.calls.some(([data]) => data.playing)).toBe(false);
    message({});
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    control({ action: 'pause', requestId: 44 });
    const pause = postMessage.mock.calls.findLast(([data]) => data.action === 'pause')?.[0];
    expect(pause).toBeDefined();
    message({ requestId: pause.requestId + 1, playing: false });
    expect(frameWindow.parent.postMessage.mock.calls.some(([data]) => data.requestId === 44)).toBe(
      false,
    );
    message({ requestId: pause.requestId, playing: false });
    await vi.waitFor(() =>
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 44, playing: false }),
        '*',
      ),
    );
    control({ action: 'pause', requestId: 45 });
    const secondPause = postMessage.mock.calls.findLast(([data]) => data.action === 'pause')![0];
    message({ playing: true });
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 0, playing: true }),
      '*',
    );
    message({ requestId: secondPause.requestId, playing: true });
    await vi.waitFor(() =>
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 45, playing: true }),
        '*',
      ),
    );
    control({ action: 'pause', requestId: 46 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 46, playing: true }),
      '*',
    );
  });

  it('injects nested srcdoc bridges recursively without changing outer authored bytes', () => {
    const escape = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const leaf = '<button onclick="window.text=\'a&b\'">Nested</button>';
    const html = `<p data-keep='exact'>Before</p><iframe sandbox="allow-scripts" srcdoc="${escape(`<iframe srcdoc="${escape(leaf)}"></iframe>`)}"></iframe>`;
    const patched = patchHtmlForIframe(html, undefined, 'root');
    expect(patched).toContain("<p data-keep='exact'>Before</p>");
    let nested = new DOMParser().parseFromString(patched, 'text/html').querySelector('iframe')!;
    expect(nested.getAttribute('sandbox')).toBe('allow-scripts');
    const child = nested.getAttribute('srcdoc')!;
    expect(mediaDocumentId(child)).toBeTruthy();
    nested = new DOMParser().parseFromString(child, 'text/html').querySelector('iframe')!;
    const grandchild = nested.getAttribute('srcdoc')!;
    expect(mediaDocumentId(grandchild)).toBeTruthy();
    expect(grandchild).toContain(leaf);
  });
  it.each(
    ['audio', 'video'].flatMap((tag) =>
      ['createElement', 'createElementNS'].map((method) => [tag, method]),
    ),
  )('observes detached DOM autoplay for %s via %s', async (tag, method) => {
    const { frameDocument, media, control, frameWindow, Media: _Media } = bridgeFixture();
    const create = () =>
      (method === 'createElement'
        ? frameDocument.createElement(tag, { is: 'custom-media' })
        : frameDocument.createElementNS('http://www.w3.org/1999/xhtml', tag)) as InstanceType<
        typeof _Media
      >;
    for (let i = 0; i < 100; i++) create();
    expect(media.size).toBe(0);
    const element = create();
    for (let i = 0; i < 2; i++) {
      frameWindow.parent.postMessage.mockClear();
      element.paused = false;
      element.dispatchEvent(new Event('play'));
      expect(media.size).toBe(1);
      expect(
        frameWindow.parent.postMessage.mock.calls.filter(([data]) => data.playing),
      ).toHaveLength(1);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
      control({ action: 'pause', requestId: i + 1 });
      await Promise.resolve();
      expect(element.paused).toBe(true);
      expect(media.size).toBe(0);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: i + 1, playing: false }),
        '*',
      );
    }
    frameWindow.parent.postMessage.mockClear();
    await element.play();
    expect(frameWindow.parent.postMessage.mock.calls.filter(([data]) => data.playing)).toHaveLength(
      1,
    );
    element.pause();
  });
  it.each(['call', 'construct'] as const)(
    'observes detached native autoplay via Audio %s without retaining idle elements',
    async (creation) => {
      const { Audio, Media, media, control, frameWindow } = bridgeFixture();
      const create = () => (creation === 'call' ? Audio('sound.wav') : new Audio('sound.wav'));
      for (let i = 0; i < 100; i++) create();
      expect(media.size).toBe(0);
      expect(Audio.prototype).toBe(Media.prototype);
      const element = create();
      expect(element).toBeInstanceOf(Audio);
      class CustomAudio extends Audio {}
      expect(new CustomAudio()).toBeInstanceOf(CustomAudio);
      // Native autoplay dispatches play without calling the patched play() method.
      for (let i = 0; i < 2; i++) {
        element.paused = false;
        element.dispatchEvent(new Event('play'));
        expect(media.size).toBe(1);
        expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ playing: true }),
          '*',
        );
        control({ action: 'pause', requestId: i + 1 });
        await Promise.resolve();
        expect(element.paused).toBe(true);
        expect(media.size).toBe(0);
        expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ requestId: i + 1, playing: false }),
          '*',
        );
      }
      frameWindow.parent.postMessage.mockClear();
      await element.play();
      expect(
        frameWindow.parent.postMessage.mock.calls.filter(([data]) => data.playing),
      ).toHaveLength(1);
      element.pause();
      expect(media.size).toBe(0);
    },
  );
  it('releases errored media even when paused is false and ignores its stale play event', async () => {
    const { Media, media, nativePlay, frameWindow } = bridgeFixture();
    const element = new Media();
    await element.play();
    element.error = { code: 3 };
    element.dispatchEvent(new Event('error'));
    expect(media.size).toBe(0);
    nativePlay(element);
    expect(media.size).toBe(0);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false }),
      '*',
    );
  });
  it.each(['pause', 'ended', 'emptied', 'error'])(
    'releases detached audio after %s and observes reuse',
    async (type) => {
      const { Media, media, frameWindow } = bridgeFixture();
      let reused!: InstanceType<typeof Media>;
      for (let i = 0; i < 100; i++) {
        reused = new Media();
        await reused.play();
        expect(media.size).toBe(1);
        reused.paused = true;
        reused.dispatchEvent(new Event(type));
        expect(media.size).toBe(0);
      }
      await reused.play();
      expect(media.size).toBe(1);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
      frameWindow.dispatchEvent(
        new MessageEvent('message', {
          source: frameWindow.parent as unknown as Window,
          data: {
            type: MEDIA_CONTROL,
            documentId: 'test',
            generation: 1,
            action: 'sync',
            enabled: false,
          },
        }),
      );
      expect(reused.paused).toBe(true);
      expect(media.size).toBe(0);
    },
  );

  it.each(['reject', 'throw'] as const)(
    'releases an unsuccessful play attempt (%s)',
    async (failure) => {
      const { Media, media } = bridgeFixture();
      const element = new Media();
      element.playError = failure;
      try {
        await element.play();
      } catch {
        /* The authored caller owns the error. */
      }
      expect(media.size).toBe(0);
    },
  );
});

describe('bridge-owned AudioContext suspension', () => {
  it('restores only bridge-suspended contexts on a fresh gesture', async () => {
    const { Context, control, gesture } = bridgeFixture();
    const sound = new Context();
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(sound.state).toBe('suspended');
    gesture();
    await Promise.resolve();
    expect(sound.state).toBe('running');
    await sound.suspend();
    gesture();
    expect(sound.state).toBe('suspended');
    await sound.close();
    gesture();
    expect(sound.state).toBe('closed');
  });

  it.each(['suspend', 'close'] as const)(
    'respects authored %s after a bridge suspension',
    async (method) => {
      const { Context, control, gesture } = bridgeFixture();
      const sound = new Context();
      control({ action: 'pause', requestId: 1 });
      await Promise.resolve();
      await Promise.resolve();
      await sound[method]();
      gesture();
      expect(sound.state).toBe(method === 'close' ? 'closed' : 'suspended');
    },
  );

  it('does not strongly retain inactive contexts and re-registers authored resume', async () => {
    const { Context, contextSet, control } = bridgeFixture();
    const sound = new Context();
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(contextSet.size).toBe(0);
    await sound.resume();
    expect(contextSet.size).toBe(1);
    await sound.suspend();
    expect(contextSet.size).toBe(0);
  });

  it('requires a new gesture after a frame was hidden', async () => {
    const { Context, control, gesture } = bridgeFixture();
    const sound = new Context();
    control({ action: 'sync', enabled: false });
    await Promise.resolve();
    await Promise.resolve();
    gesture();
    expect(sound.state).toBe('suspended');
    control({ action: 'sync', enabled: true });
    expect(sound.state).toBe('suspended');
    gesture();
    expect(sound.state).toBe('running');
  });

  it('does not lose a gesture while the bridge suspend promise is pending', async () => {
    const { Context, control, gesture } = bridgeFixture();
    let release!: () => void;
    Context.pendingSuspend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sound = new Context();
    control({ action: 'pause', requestId: 1 });
    gesture();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sound.state).toBe('running');
  });
});

describe('interactive media boundary', () => {
  it('allows narration after an unknown frame stops answering', async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    const silent = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(silent).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('forgets old playback on a document load and rejects its late reports', async () => {
    vi.useFakeTimers();
    const { session, message, post, played } = fixture();
    session.loaded();
    message(playing);
    const oldGeneration = post.mock.calls.at(-1)![0].generation;
    const old = session.pause();
    const oldId = post.mock.calls.at(-1)![0].requestId;
    session.loaded();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(old).resolves.toBe(true);
    played.mockClear();
    message({ ...playing, generation: oldGeneration });
    message({ ...playing, generation: oldGeneration, requestId: oldId });
    expect(played).not.toHaveBeenCalled();
    const next = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('resynchronizes a bridge that starts before iframe load without accepting its old state', () => {
    const { session, message, played, post } = fixture();
    message({ ...playing, generation: 0 });
    expect(played).not.toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'sync', generation: expect.any(Number) }),
      '*',
    );
    const firstGeneration = post.mock.calls.at(-1)![0].generation;
    message(playing);
    expect(played).toHaveBeenCalledOnce();
    session.loaded();
    expect(post.mock.calls.at(-1)![0].generation).not.toBe(firstGeneration);
    message({ ...playing, generation: firstGeneration });
    expect(played).toHaveBeenCalledOnce();
  });
  it('installs before authored scripts only for live playback consumers', () => {
    const html = '<html><head><script>new AudioContext()</script></head><body></body></html>';
    const patched = patchHtmlForIframe(html, undefined, 'current');
    expect(mediaDocumentId(patched)).toBe('current');
    expect(patched.indexOf('data-maic-media-document')).toBeLessThan(
      patched.indexOf('new AudioContext()'),
    );
    expect(mediaDocumentId(patchHtmlForIframe(html))).toBeUndefined();
    expect(() => mediaBridgeScript('x"><script>')).toThrow('Invalid media document id');
  });

  it('accepts only the current frame, document and boolean state', () => {
    const { message, played } = fixture();
    for (const data of [
      null,
      [],
      {},
      { ...playing, playing: 'true' },
      { ...playing, documentId: 'old' },
      { ...playing, type: 'other' },
    ])
      message(data);
    message(playing, window);
    message(playing, null);
    expect(played).not.toHaveBeenCalled();
    message({ ...playing, playing: false });
    expect(played).not.toHaveBeenCalled();
    message(playing);
    expect(played).toHaveBeenCalledOnce();
  });

  it('pauses hidden frames instead of allowing them to interrupt narration', () => {
    const { session, message, post, played } = fixture();
    session.sync(false);
    message(playing);
    expect(played).not.toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith(
      {
        type: MEDIA_CONTROL,
        documentId: 'current',
        generation: expect.any(Number),
        action: 'pause',
        requestId: expect.any(Number),
      },
      '*',
    );
    message({ ...playing, requestId: post.mock.calls.at(-1)![0].requestId, playing: false });
    session.sync(true);
    message(playing);
    expect(played).toHaveBeenCalledOnce();
  });

  it('coalesces pauses and ignores old reports until silence is acknowledged', async () => {
    const { session, message, played, post } = fixture();
    const first = session.pause();
    expect(session.pause()).toBe(first);
    const id = post.mock.calls.at(-1)![0].requestId;
    message(playing);
    message({ ...playing, requestId: id + 1, playing: false });
    expect(played).not.toHaveBeenCalled();
    message({ ...playing, requestId: id, playing: false });
    await expect(first).resolves.toBe(true);
    message(playing);
    expect(played).toHaveBeenCalledOnce();
    const next = session.pause();
    const nextId = post.mock.calls.at(-1)![0].requestId;
    expect(nextId).not.toBe(id);
    message({ ...playing, requestId: id, playing: false });
    message(playing);
    expect(played).toHaveBeenCalledOnce();
    message({ ...playing, requestId: nextId, playing: false });
    await expect(next).resolves.toBe(true);
  });

  it('fails closed when silence cannot be confirmed, including disposal', async () => {
    vi.useFakeTimers();
    const { session, message } = fixture();
    message(playing);
    const timedOut = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(timedOut).resolves.toBe(false);
    const cancelled = session.pause();
    session.dispose();
    await expect(cancelled).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('disposes the listener and disables media without ever resuming it', () => {
    const { session, message, post, played } = fixture();
    session.pause();
    expect(post).toHaveBeenLastCalledWith(
      {
        type: MEDIA_CONTROL,
        documentId: 'current',
        generation: expect.any(Number),
        action: 'pause',
        requestId: expect.any(Number),
      },
      '*',
    );
    session.dispose();
    message(playing);
    expect(played).not.toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith(
      {
        type: MEDIA_CONTROL,
        documentId: 'current',
        generation: expect.any(Number),
        action: 'sync',
        enabled: false,
      },
      '*',
    );
  });
});
