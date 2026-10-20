// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  createInteractiveMediaSession,
  mediaBridgeScript,
  mediaDocumentId,
} from '@/lib/interactive/media-bridge';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

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
  const message = (data: object, source: MessageEventSource | null = frame.contentWindow) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: { generation: post.mock.calls.at(-1)![0].generation, ...data },
      }),
    );
  return { frame, played, post, session, message };
}
const playing = { type: 'maic:media:state:v1', documentId: 'current', requestId: 0, playing: true };

describe('interactive media session', () => {
  it('fails open once per unresponsive document, without restoring its old srcdoc', async () => {
    vi.useFakeTimers();
    const { frame, session, post } = fixture();
    frame.srcdoc = mediaBridgeScript('current');
    const restore = vi.spyOn(frame, 'srcdoc', 'set');
    session.loaded();
    const pause = session.pause();
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pause.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pause).resolves.toBe(true);
    const count = post.mock.calls.length;
    await expect(session.pause()).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(count);
    expect(restore).not.toHaveBeenCalled();
  });
  it('blocks only when this generation reported playing, and forgets that evidence on navigation', async () => {
    vi.useFakeTimers();
    const { session, message, post, played } = fixture();
    message(playing);
    expect(played).toHaveBeenCalledOnce();
    const oldGeneration = post.mock.calls.at(-1)![0].generation;
    const blocked = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(blocked).resolves.toBe(false);
    session.loaded();
    message({ ...playing, generation: oldGeneration });
    const next = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBe(true);
    expect(played).toHaveBeenCalledOnce();
    message(playing);
    expect(played).toHaveBeenCalledTimes(2);
    const reconnected = session.pause();
    message({ ...playing, requestId: post.mock.calls.at(-1)![0].requestId, playing: false });
    await expect(reconnected).resolves.toBe(true);
  });
  it('coalesces requests and rejects old sources, documents, generations and acknowledgements', async () => {
    const { session, message, post, played } = fixture();
    const first = session.pause();
    expect(session.pause()).toBe(first);
    const id = post.mock.calls.at(-1)![0].requestId;
    const generation = post.mock.calls.at(-1)![0].generation;
    session.loaded();
    for (const bad of [
      { ...playing, requestId: id, generation },
      { ...playing, requestId: id + 1, playing: false },
      { ...playing, requestId: id, documentId: 'old', playing: false },
      { ...playing, requestId: id, playing: 'false' },
      { ...playing, requestId: -1 },
    ])
      message(bad);
    message({ ...playing, requestId: id, playing: false }, window);
    let result: boolean | undefined;
    void first.then((value) => {
      result = value;
    });
    await Promise.resolve();
    expect(result).toBeUndefined();
    expect(played).not.toHaveBeenCalled();
    message({ ...playing, requestId: id, playing: false });
    await expect(first).resolves.toBe(true);
    message(playing);
    expect(played).toHaveBeenCalledOnce();
  });
  it('resynchronizes an early bridge without accepting its initial generation as playback', () => {
    const { session, message, played, post } = fixture();
    message({ ...playing, generation: 0 });
    expect(played).not.toHaveBeenCalled();
    expect(post.mock.calls.at(-1)![0].action).toBe('sync');
    session.sync(false);
    message(playing);
    expect(played).not.toHaveBeenCalled();
    expect(post.mock.calls.at(-1)![0].action).toBe('pause');
    const count = post.mock.calls.length;
    message({ ...playing, requestId: post.mock.calls.at(-1)![0].requestId });
    expect(post).toHaveBeenCalledTimes(count);
    session.dispose();
    message(playing);
    expect(post.mock.calls.at(-1)![0]).toMatchObject({ action: 'sync', enabled: false });
  });
  it('injects only the main document, before authored scripts, with a validated identity', () => {
    const html =
      '<html><head><script>new AudioContext()</script></head><body><iframe src="https://example.test"></iframe></body></html>';
    const patched = patchHtmlForIframe(html, undefined, 'current');
    expect(mediaDocumentId(patched)).toBe('current');
    expect(patched.indexOf('data-maic-media-document')).toBeLessThan(
      patched.indexOf('new AudioContext()'),
    );
    expect(patched).toContain('<iframe src="https://example.test"></iframe>');
    expect(mediaDocumentId(patchHtmlForIframe(html))).toBeUndefined();
    expect(() => mediaBridgeScript('x"><script>')).toThrow('Invalid media document id');
  });
});

function bridgeFixture() {
  const sets: Set<unknown>[] = [];
  class TrackedSet extends Set<unknown> {
    constructor() {
      super();
      sets.push(this);
    }
  }
  class Media extends EventTarget {
    paused = true;
    ended = false;
    error = null;
    play() {
      this.paused = false;
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }
  class Context extends EventTarget {
    static pending: Promise<void> | undefined;
    state = 'running';
    suspend() {
      const finish = () => {
        this.state = 'suspended';
        this.dispatchEvent(new Event('statechange'));
      };
      if (Context.pending) return Context.pending.then(finish);
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
  class Source {
    started = false;
    args: unknown[] = [];
    constructor(readonly context: Context) {}
    start(...args: unknown[]): void {
      if (!(this instanceof Source)) throw new TypeError('Invalid source');
      if (this.started) throw new Error('Already started');
      if (typeof args[0] === 'number' && args[0] < 0) throw new RangeError('Invalid time');
      this.started = true;
      this.args = args;
    }
  }
  const nativeStart = Source.prototype.start;
  class BufferSource extends Source {
    start(...args: unknown[]): void {
      return nativeStart.apply(this, args);
    }
  }
  const parent = { postMessage: vi.fn() };
  const listeners: Record<string, (event: unknown) => void> = {};
  const doc = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
  };
  const win = {
    parent,
    Audio: Media,
    AudioContext: Context,
    webkitAudioContext: Context,
    AudioScheduledSourceNode: Source,
    AudioBufferSourceNode: BufferSource,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
  };
  runInNewContext(mediaBridgeScript('test').replace(/^<script[^>]*>|<\/script>$/g, ''), {
    window: win,
    document: doc,
    HTMLMediaElement: Media,
    Set: TrackedSet,
    WeakRef,
  });
  const control = (data: object, source: unknown = parent) =>
    listeners.message({
      source,
      data: { type: 'maic:media:control:v1', documentId: 'test', generation: 1, ...data },
    });
  control({ action: 'sync', enabled: true });
  return {
    Media,
    Context: win.AudioContext,
    NativeContext: Context,
    Source,
    BufferSource,
    Audio: win.Audio,
    control,
    gesture: (trusted = true) => listeners.pointerdown?.({ isTrusted: trusted }),
    media: sets[0],
    contexts: sets[1],
    parent,
  };
}

describe('main-document bridge', () => {
  it('tracks detached Audio(), pauses media and releases inactive elements', async () => {
    const { Audio, media, control, parent } = bridgeFixture();
    const sound = new Audio();
    await sound.play();
    expect(media.has(sound)).toBe(true);
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(sound.paused).toBe(true);
    expect(media.size).toBe(0);
    expect(parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({
      requestId: 1,
      playing: false,
    });
    await sound.play();
    expect(media.has(sound)).toBe(true);
    control({ action: 'sync', enabled: false });
    expect(sound.paused).toBe(true);
  });
  it('ignores silent gestures and resumes only the context whose source starts', async () => {
    const { Context, Source, control, gesture } = bridgeFixture();
    const sound = new Context();
    const other = new Context();
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    gesture();
    gesture(false);
    expect(sound.state).toBe('suspended');
    expect(other.state).toBe('suspended');
    new Source(sound).start();
    expect(sound.state).toBe('running');
    expect(other.state).toBe('suspended');
  });
  it.each(['source', 'buffer'] as const)(
    'restores bridge-owned %s starts but respects authored suspend/close',
    async (kind) => {
      const { Context, Source, BufferSource, control } = bridgeFixture();
      const Node = kind === 'buffer' ? BufferSource : Source;
      const sound = new Context();
      control({ action: 'pause', requestId: 1 });
      await Promise.resolve();
      await Promise.resolve();
      const node = new Node(sound);
      node.start(1, 2, 3);
      expect(node.args).toEqual([1, 2, 3]);
      expect(sound.state).toBe('running');
      await sound.suspend();
      new Node(sound).start();
      expect(sound.state).toBe('suspended');
      await sound.close();
      new Node(sound).start();
      expect(sound.state).toBe('closed');
    },
  );
  it.each(['suspend', 'close'] as const)(
    'respects authored %s while the bridge owns the suspension',
    async (method) => {
      const { Context, Source, control } = bridgeFixture();
      const sound = new Context();
      control({ action: 'pause', requestId: 1 });
      await Promise.resolve();
      await Promise.resolve();
      await sound[method]();
      new Source(sound).start();
      expect(sound.state).toBe(method === 'close' ? 'closed' : 'suspended');
    },
  );
  it('does not resume a hidden frame until a fresh source start after visibility returns', async () => {
    const { Context, Source, control } = bridgeFixture();
    const sound = new Context();
    control({ action: 'sync', enabled: false });
    await Promise.resolve();
    await Promise.resolve();
    new Source(sound).start();
    expect(sound.state).toBe('suspended');
    control({ action: 'sync', enabled: true });
    expect(sound.state).toBe('suspended');
    new Source(sound).start();
    expect(sound.state).toBe('running');
  });
  it('preserves native start validation and does not resume after a rejected start', async () => {
    const { Context, Source, control } = bridgeFixture();
    const sound = new Context();
    const used = new Source(sound);
    used.start();
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => used.start()).toThrow('Already started');
    expect(() => new Source(sound).start(-1)).toThrow(RangeError);
    expect(() => Source.prototype.start.call({} as InstanceType<typeof Source>)).toThrow(TypeError);
    expect(sound.state).toBe('suspended');
  });
  it('releases inactive contexts and tracks constructor aliases and subclasses', async () => {
    const { Context, contexts, control } = bridgeFixture();
    expect(Object.getOwnPropertyDescriptor(Context.prototype, 'constructor')).toMatchObject({
      value: Context,
      enumerable: false,
    });
    const Alias = Context.prototype.constructor as typeof Context;
    class Derived extends Context {}
    const sound = new Alias();
    const derived = new Derived();
    expect(derived.constructor).toBe(Derived);
    expect(contexts.size).toBe(2);
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(contexts.size).toBe(0);
    await sound.resume();
    expect(contexts.has(sound)).toBe(true);
    await derived.close();
    expect(contexts.has(derived)).toBe(false);
  });
  it('preserves a source start racing an asynchronous bridge suspend', async () => {
    const { Context, NativeContext, Source, control } = bridgeFixture();
    let resolve!: () => void;
    NativeContext.pending = new Promise<void>((done) => {
      resolve = done;
    });
    const sound = new Context();
    control({ action: 'pause', requestId: 1 });
    new Source(sound).start();
    resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(sound.state).toBe('running');
  });
  it('rejects controls from another source or a stale generation', async () => {
    const { Context, control } = bridgeFixture();
    const sound = new Context();
    control({ action: 'pause', requestId: 1 }, {});
    control({ action: 'pause', requestId: 1, generation: 0 });
    await Promise.resolve();
    expect(sound.state).toBe('running');
    control({ action: 'sync', generation: 2, enabled: false });
    await Promise.resolve();
    await Promise.resolve();
    control({ action: 'sync', generation: 1, enabled: true });
    expect(sound.state).toBe('suspended');
  });
});
