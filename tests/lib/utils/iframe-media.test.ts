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
  it('retains playback reported during a pause when the acknowledgement misses the timeout', async () => {
    vi.useFakeTimers();
    const { session, message, post, played } = fixture();
    const paused = session.pause();
    const id = post.mock.calls.at(-1)![0].requestId;
    message(playing);
    message({ ...playing, playing: false });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(paused).resolves.toBe(false);
    expect(played).not.toHaveBeenCalled();
    const count = post.mock.calls.length;
    const retry = session.pause();
    expect(post.mock.calls.length).toBeGreaterThan(count);
    message({ ...playing, requestId: id, playing: false });
    let settled = false;
    void retry.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    message({ ...playing, requestId: post.mock.calls.at(-1)![0].requestId, playing: false });
    await expect(retry).resolves.toBe(true);
    message(playing);
    expect(played).toHaveBeenCalledOnce();
  });
  it('lets the matching silent acknowledgement override a queued positive report', async () => {
    vi.useFakeTimers();
    const { session, message, post, played } = fixture();
    const paused = session.pause();
    message(playing);
    message({ ...playing, requestId: post.mock.calls.at(-1)![0].requestId, playing: false });
    await expect(paused).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(played).not.toHaveBeenCalled();
    message(playing);
    expect(played).toHaveBeenCalledOnce();
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
    createMediaElementSource(mediaElement: Media) {
      return new ElementSource(this, { mediaElement });
    }
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
  class Node {
    constructor(readonly context: Context) {}
    connect(destination: object) {
      if (!(this instanceof Node)) throw new TypeError('Invalid node');
      return destination;
    }
  }
  class ElementSource extends Node {
    readonly mediaElement: Media;
    constructor(context: Context, options: { mediaElement: Media }) {
      super(context);
      this.mediaElement = options.mediaElement;
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
    AudioNode: Node,
    MediaElementAudioSourceNode: ElementSource,
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
    ElementSource,
    Node,
    Audio: win.Audio,
    control,
    gesture: (trusted = true) => listeners.pointerdown?.({ isTrusted: trusted }),
    media: sets[0],
    contexts: sets[1],
    parent,
  };
}

describe('main-document bridge', () => {
  it('keeps empty contexts silent until a source actually starts', async () => {
    const { Context, Source, contexts, control, parent } = bridgeFixture();
    const context = new Context();
    expect(contexts.has(context)).toBe(false);
    expect(parent.postMessage.mock.calls.at(-1)![0].playing).toBe(false);
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(context.state).toBe('running');
    new Source(context).start();
    expect(contexts.has(context)).toBe(true);
    expect(parent.postMessage.mock.calls.at(-1)![0].playing).toBe(true);
  });

  it.each(['factory', 'constructor'] as const)(
    'restores routed media created by %s without resuming unrelated or authored suspensions',
    async (kind) => {
      const { Context, Audio, ElementSource, Node, Source, control } = bridgeFixture();
      const context = new Context();
      const other = new Context();
      new Source(other).start();
      const sound = new Audio();
      const source =
        kind === 'factory'
          ? context.createMediaElementSource(sound)
          : new ElementSource(context, { mediaElement: sound });
      const destination = {};
      expect(source.connect(destination)).toBe(destination);
      expect(() =>
        Node.prototype.connect.call({} as InstanceType<typeof Node>, destination),
      ).toThrow(TypeError);
      await sound.play();
      control({ action: 'pause', requestId: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(context.state).toBe('suspended');
      await sound.play();
      expect(context.state).toBe('running');
      expect(other.state).toBe('suspended');
      control({ action: 'sync', enabled: false });
      await Promise.resolve();
      await Promise.resolve();
      await sound.play();
      expect(context.state).toBe('suspended');
      expect(sound.paused).toBe(true);
      control({ action: 'sync', enabled: true });
      await sound.play();
      expect(context.state).toBe('running');
      sound.pause();
      await context.suspend();
      await sound.play();
      expect(context.state).toBe('suspended');
    },
  );
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
    new Source(sound).start();
    new Source(other).start();
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
      new Node(sound).start();
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
      new Source(sound).start();
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
    new Source(sound).start();
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
    const { Context, Source, contexts, control } = bridgeFixture();
    expect(Object.getOwnPropertyDescriptor(Context.prototype, 'constructor')).toMatchObject({
      value: Context,
      enumerable: false,
    });
    const Alias = Context.prototype.constructor as typeof Context;
    class Derived extends Context {}
    const sound = new Alias();
    const derived = new Derived();
    expect(derived.constructor).toBe(Derived);
    new Source(sound).start();
    new Source(derived).start();
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
    new Source(sound).start();
    control({ action: 'pause', requestId: 1 });
    new Source(sound).start();
    resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(sound.state).toBe('running');
  });
  it.each(['settled', 'pending'] as const)(
    'retries a rejected automatic resume after a %s bridge suspend',
    async (suspension) => {
      const { Context, NativeContext, Source, control } = bridgeFixture();
      const nativeResume = NativeContext.prototype.resume;
      const resume = vi.spyOn(NativeContext.prototype, 'resume');
      let finish!: () => void;
      if (suspension === 'pending') {
        NativeContext.pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        resume.mockImplementationOnce(nativeResume);
      }
      resume.mockRejectedValueOnce(new Error('Resume denied'));
      const sound = new Context();
      new Source(sound).start();
      control({ action: 'pause', requestId: 1 });
      if (suspension === 'settled') await new Promise((done) => setTimeout(done, 0));
      new Source(sound).start();
      if (suspension === 'pending') finish();
      await new Promise((done) => setTimeout(done, 0));
      expect(sound.state).toBe('suspended');
      new Source(sound).start();
      await new Promise((done) => setTimeout(done, 0));
      expect(sound.state).toBe('running');
      expect(resume).toHaveBeenCalledTimes(suspension === 'pending' ? 3 : 2);
    },
  );
  it.each(['suspend', 'close'] as const)(
    'does not reclaim an authored %s after an automatic resume rejects',
    async (method) => {
      const { Context, NativeContext, Source, control } = bridgeFixture();
      let reject!: (error: Error) => void;
      const resume = vi.spyOn(NativeContext.prototype, 'resume').mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      );
      const sound = new Context();
      new Source(sound).start();
      control({ action: 'pause', requestId: 1 });
      await new Promise((done) => setTimeout(done, 0));
      new Source(sound).start();
      await sound[method]();
      reject(new Error('Resume denied'));
      await new Promise((done) => setTimeout(done, 0));
      new Source(sound).start();
      expect(sound.state).toBe(method === 'close' ? 'closed' : 'suspended');
      expect(resume).toHaveBeenCalledOnce();
    },
  );
  it('rejects controls from another source or a stale generation', async () => {
    const { Context, Source, control } = bridgeFixture();
    const sound = new Context();
    new Source(sound).start();
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
