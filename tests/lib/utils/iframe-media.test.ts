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

function fixture(html?: string) {
  const frame = document.createElement('iframe');
  if (html) frame.srcdoc = html;
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

function bridgeFixture(unobservable = false, documentId = 'test', globals = {}) {
  const observers: Array<(records: Array<{ addedNodes: EventTarget[] }>) => void> = [];
  const observedRoots: unknown[] = [];
  class Observer {
    constructor(callback: (records: Array<{ addedNodes: EventTarget[] }>) => void) {
      observers.push(callback);
    }
    observe(root: unknown) {
      observedRoots.push(root);
    }
  }
  const sets: Set<unknown>[] = [];
  class TrackedSet extends Set<unknown> {
    constructor(values?: Iterable<unknown>) {
      super(values);
      sets.push(this);
    }
  }
  class FrameNode extends EventTarget {
    cloneNode(_deep?: boolean) {
      return new (this.constructor as typeof FrameNode)();
    }
  }
  class Media extends FrameNode {
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
  class Utterance extends EventTarget {}
  class Synthesis {
    speaking = false;
    pending = false;
    paused = false;
    refuseCancel = false;
    queue: Utterance[] = [];
    speak(utterance: Utterance) {
      if (!(utterance instanceof Utterance)) throw new TypeError('invalid utterance');
      this.queue.push(utterance);
      this.pending = this.paused || this.queue.length > 1;
      if (!this.paused) this.speaking = true;
    }
    cancel() {
      if (this.refuseCancel) return;
      this.queue = [];
      this.speaking = false;
      this.pending = false;
    }
    pause() {
      this.paused = true;
      this.queue[0]?.dispatchEvent(new Event('pause'));
    }
    resume() {
      this.paused = false;
      this.speaking = this.queue.length > 0;
      this.queue[0]?.dispatchEvent(new Event('resume'));
    }
    finish(type: string) {
      const utterance = this.queue.shift()!;
      this.speaking = this.queue.length > 0;
      this.pending = this.queue.length > 1;
      utterance.dispatchEvent(new Event(type));
    }
  }
  const synthesis = new Synthesis();
  const nativeSpeak = vi.spyOn(Synthesis.prototype, 'speak');
  function NativeAudio(src = ''): Media {
    return Object.assign(Reflect.construct(Media, [], new.target || NativeAudio), { src });
  }
  NativeAudio.prototype = Media.prototype;
  let constructionRoot: FrameElement | null = null;
  class FrameElement extends FrameNode {
    style = { cssText: '', width: '', height: '' };
    hidden = false;
    isConnected = false;
    childNodes: FrameElement[] = [];
    private attributes = new Map<string, string>();
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    getRootNode(): FrameElement {
      return constructionRoot ?? this.parentNode?.getRootNode() ?? this;
    }
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    insertBefore(node: FrameElement, before: FrameElement | null) {
      node.parentNode = this;
      const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(index, 0, node);
      return node;
    }
    remove() {
      if (this.parentNode)
        this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
      this.parentNode = null;
    }
    parentNode: FrameElement | null = null;
    elements: Media[] = [];
    hosts: FrameElement[] = [];
    frames: FrameDocument['frames'] = [];
    shadowRoot: FrameElement | null = null;
    private attached = false;
    attachShadow(options: { mode: 'open' | 'closed'; clonable?: boolean } = { mode: 'open' }) {
      if (this.attached) throw new Error('already attached');
      this.attached = true;
      const root = new FrameShadowRoot(this, options.mode, options.clonable ?? false);
      if (options.mode === 'open') this.shadowRoot = root;
      return root;
    }
    private html = '';
    get innerHTML() {
      return this.html;
    }
    set innerHTML(html: string) {
      if (html === 'invalid') throw new TypeError('invalid HTML');
      this.html = html;
      this.elements = [new Media()];
    }
    setHTML(html: unknown, _options?: unknown) {
      if (String(html) === 'invalid') throw new TypeError('invalid HTML');
      this.elements = [new Media()];
    }
    setHTMLUnsafe(html: unknown, _options?: unknown) {
      if (String(html) === 'invalid') throw new TypeError('invalid HTML');
      this.elements = [new Media()];
    }
    get outerHTML() {
      return this.html;
    }
    set outerHTML(html: string) {
      if (html === 'invalid') throw new TypeError('invalid HTML');
      if (this.parentNode) this.parentNode.elements = [new Media()];
    }
    querySelectorAll(selector?: string) {
      if (selector === 'iframe') return this.frames;
      if (selector === '*') return this.hosts;
      return this.elements;
    }
    insertAdjacentHTML(position: string, html: string) {
      if (html === 'invalid') throw new TypeError('invalid HTML');
      if (!['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(position))
        throw new SyntaxError('invalid position');
      const target = ['beforebegin', 'afterend'].includes(position) ? this.parentNode : this;
      if (!target) throw new Error('no parent');
      target.elements.push(new Media());
    }
  }
  class FrameShadowRoot extends FrameElement {
    constructor(
      readonly host: FrameElement,
      readonly mode = 'closed',
      readonly clonable = false,
    ) {
      super();
    }
  }
  const definitions = new Map<string, new () => FrameElement & { connectedCallback(): void }>();
  const customElements = {
    define: (name: string, element: new () => FrameElement & { connectedCallback(): void }) =>
      definitions.set(name, element),
  };
  class Parser {
    parseFromString() {
      const root = new FrameElement();
      root.elements = [new Media()];
      return root;
    }
  }
  class FrameRange {
    commonAncestorContainer = new FrameElement();
    cloneContents() {
      const root = new FrameElement();
      root.elements = [new Media()];
      return root;
    }
  }
  class FrameDocument extends FrameNode {
    static parseHTML(html: unknown) {
      if (String(html) === 'invalid') throw new TypeError('invalid HTML');
      const root = new FrameElement();
      root.elements = [new Media()];
      return root;
    }
    static parseHTMLUnsafe(html: unknown) {
      if (String(html) === 'invalid') throw new TypeError('invalid HTML');
      const root = new FrameElement();
      root.elements = [new Media()];
      return root;
    }
    importNode(node: FrameNode) {
      return node.cloneNode();
    }
    frames: Array<{
      contentWindow: object;
      getAttribute: (name: string) => string | null;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }> = [];
    hosts: FrameElement[] = [];
    querySelectorAll(selector?: string) {
      return selector === '*' ? this.hosts : this.frames;
    }
    createElement(name: string, _options?: unknown): EventTarget {
      if (name === 'template') return document.createElement('template');
      const Defined = definitions.get(name);
      return Defined
        ? new Defined()
        : ['audio', 'video'].includes(name.toLowerCase())
          ? new Media()
          : new FrameElement();
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
  Object.assign(frameWindow, {
    AudioContext: Context,
    Audio: NativeAudio,
    SpeechSynthesis: Synthesis,
    ...globals,
  });
  const getSynthesis = vi.fn(() => synthesis);
  Object.defineProperty(frameWindow, 'speechSynthesis', { get: getSynthesis });
  const script = mediaBridgeScript(documentId, unobservable).replace(
    /^<script[^>]*>|<\/script>$/g,
    '',
  );
  const frameDocument = new FrameDocument();
  const nativePlay = vi.spyOn(frameDocument, 'addEventListener');
  const nativeInsert = vi.spyOn(FrameElement.prototype, 'insertAdjacentHTML');
  const nativeClone = vi.spyOn(FrameNode.prototype, 'cloneNode');
  runInNewContext(script, {
    window: frameWindow,
    document: frameDocument,
    HTMLMediaElement: Media,
    Document: FrameDocument,
    Node: FrameNode,
    Element: FrameElement,
    HTMLElement: FrameElement,
    ShadowRoot: FrameShadowRoot,
    customElements,
    DOMParser: Parser,
    Range: FrameRange,
    MutationObserver: Observer,
    Set: TrackedSet,
    setTimeout,
    clearTimeout,
  });
  const control = (payload: Record<string, unknown>) =>
    frameWindow.dispatchEvent(
      new MessageEvent('message', {
        source: frameWindow.parent as unknown as Window,
        data: { type: MEDIA_CONTROL, documentId, generation: 1, ...payload },
      }),
    );
  control({ action: 'sync', enabled: true });
  return {
    Media,
    FrameNode,
    FrameElement,
    FrameShadowRoot,
    definitions,
    nativeInsert,
    nativeClone,
    constructMarker: (root: FrameShadowRoot) => {
      constructionRoot = root;
      try {
        const Marker = definitions.get('maic-media-root-' + documentId.toLowerCase())!;
        return new Marker();
      } finally {
        constructionRoot = null;
      }
    },
    Parser,
    FrameRange,
    FrameDocument,
    frameDocument,
    observedRoots,
    added: (...elements: EventTarget[]) =>
      observers.forEach((callback) => callback([{ addedNodes: elements }])),
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
    synthesis,
    Utterance,
    nativeSpeak,
    getSynthesis,
    nativePlay: (element: Media) =>
      (nativePlay.mock.calls.find(([type]) => type === 'play')![1] as EventListener)({
        target: element,
      } as unknown as Event),
  };
}

describe('injected media lifetime', () => {
  it('registers media in a cloned closed root during marker upgrade before connection', () => {
    const { FrameElement, FrameShadowRoot, Media, constructMarker, frameWindow } = bridgeFixture();
    const root = new FrameShadowRoot(new FrameElement(), 'closed', true);
    const audio = new Media();
    root.elements.push(audio);
    expect(root.host.isConnected).toBe(false);
    constructMarker(root);
    audio.paused = false;
    audio.dispatchEvent(new Event('play'));
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
  });
  it('seeds native closed-root cloning temporarily and restores the source even on native errors', () => {
    const { FrameElement, nativeClone } = bridgeFixture();
    const host = new FrameElement();
    const root = host.attachShadow({ mode: 'closed', clonable: true });
    const fail = new TypeError('native cloning failure');
    nativeClone.mockImplementationOnce(() => {
      expect(root.childNodes).toHaveLength(1);
      return new FrameElement();
    });
    host.cloneNode(true);
    expect(root.childNodes).toHaveLength(0);
    nativeClone.mockImplementationOnce(() => {
      expect(root.childNodes).toHaveLength(1);
      throw fail;
    });
    expect(() => host.cloneNode(true)).toThrow(fail);
    expect(root.childNodes).toHaveLength(0);
  });
  it('observes detached replacements made through native outerHTML and their later reuse', async () => {
    const { FrameElement, Media, frameWindow, control, media } = bridgeFixture();
    const parent = new FrameElement();
    const replaced = new FrameElement();
    replaced.parentNode = parent;
    replaced.outerHTML = '<audio autoplay></audio>';
    const element = parent.elements[0];
    expect(element).toBeInstanceOf(Media);
    element.paused = false;
    element.dispatchEvent(new Event('play'));
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    control({ action: 'pause', requestId: 88 });
    await Promise.resolve();
    await Promise.resolve();
    expect(element.paused).toBe(true);
    expect(media.size).toBe(0);
    element.paused = false;
    element.dispatchEvent(new Event('play'));
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    expect(() => {
      replaced.outerHTML = 'invalid';
    }).toThrow('invalid HTML');
  });
  it('preserves valid document ids that resemble bridge placeholders', async () => {
    const { control, frameWindow } = bridgeFixture(false, '__UNOBSERVABLE__');
    control({ action: 'pause', requestId: 89 });
    await Promise.resolve();
    await Promise.resolve();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentId: '__UNOBSERVABLE__', requestId: 89, playing: false }),
      '*',
    );
  });
  it('never acknowledges silence for a scoped registry whose closed root cannot be observed', async () => {
    const { control, frameWindow } = bridgeFixture(true);
    control({ action: 'pause', requestId: 90 });
    await Promise.resolve();
    await Promise.resolve();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 90, playing: true }),
      '*',
    );
    expect(
      patchHtmlForIframe(
        '<div><template shadowrootmode="closed" shadowrootcustomelementregistry><audio autoplay></audio></template></div>',
        undefined,
        'root',
      ),
    ).toContain('})("root", true);');
  });
  it.each(['setHTMLUnsafe', 'setHTML'] as const)(
    'refuses silence after %s can create an inaccessible declarative root',
    async (method) => {
      const { FrameElement, FrameShadowRoot, control, frameWindow } = bridgeFixture();
      const receiver = new FrameShadowRoot(new FrameElement());
      receiver[method](
        '<template><div><template shadowrootmode="clo&#115;ed"><audio autoplay></audio></template></div></template>',
      );
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
      control({ action: 'pause', requestId: 91 });
      await Promise.resolve();
      await Promise.resolve();
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 91, playing: true }),
        '*',
      );
    },
  );
  it.each([
    '<p>Ordinary markup</p>',
    '<div><template shadowrootmode="open"><audio></audio></template></div>',
    '<!-- <template shadowrootmode="closed"> -->',
    '<script>const example = \'<template shadowrootmode="closed">\';</script>',
    '&lt;template shadowrootmode="closed">',
    '<template shadowrootmode="invalid"></template>',
  ])('keeps observable parser input confirmable: %s', async (html) => {
    const { FrameElement, control, frameWindow } = bridgeFixture();
    new FrameElement().setHTMLUnsafe(html);
    control({ action: 'pause', requestId: 92 });
    await Promise.resolve();
    await Promise.resolve();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 92, playing: false }),
      '*',
    );
  });
  it.each(['setHTMLUnsafe', 'setHTML'] as const)(
    'does not coerce opaque %s input twice',
    (method) => {
      const { FrameElement, frameWindow } = bridgeFixture();
      const toString = vi.fn(() => '<div><template shadowrootmode="closed"></template></div>');
      expect(new FrameElement()[method]({ toString })).toBeUndefined();
      expect(toString).toHaveBeenCalledTimes(1);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
    },
  );
  it('does not invoke a default policy to inspect unsafe parser input again', () => {
    const createHTML = vi.fn();
    const { FrameElement, frameWindow } = bridgeFixture(false, 'test', {
      trustedTypes: { defaultPolicy: { createHTML } },
    });
    new FrameElement().setHTMLUnsafe('<p>Policy may transform this input</p>');
    expect(createHTML).not.toHaveBeenCalled();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
  });
  it('keeps safe parser inspection away from TrustedTypes sinks', () => {
    const { FrameElement, frameWindow } = bridgeFixture(false, 'test', { trustedTypes: {} });
    new FrameElement().setHTML('<div><template shadowrootmode="clo&#115;ed"></template></div>');
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
  });
  it.each(['parseHTMLUnsafe', 'parseHTML'] as const)(
    'refuses silence after Document.%s returns a closed-root document',
    async (method) => {
      const { FrameDocument, FrameElement, frameWindow, control } = bridgeFixture();
      const result = FrameDocument[method](
        '<div><template shadowrootmode="closed"><audio autoplay></audio></template></div>',
      );
      expect(result).toBeInstanceOf(FrameElement);
      expect(() => FrameDocument[method]('invalid')).toThrow('invalid HTML');
      control({ action: 'pause', requestId: 93 });
      await Promise.resolve();
      await Promise.resolve();
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 93, playing: true }),
        '*',
      );
    },
  );
  it('registers native declarative roots through a self-removing marker', () => {
    const { FrameElement, FrameShadowRoot, frameDocument, definitions, observedRoots, control } =
      bridgeFixture();
    const host = new FrameElement();
    frameDocument.hosts.push(host);
    const root = new FrameShadowRoot(host);
    const postMessage = vi.fn();
    root.frames.push({
      contentWindow: { postMessage },
      getAttribute: (name) => (name === 'srcdoc' ? mediaBridgeScript('declarative-child') : null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const Marker = definitions.get('maic-media-root-test')!;
    expect(Marker).toBeDefined();
    const remove = vi.fn();
    const marker = Object.assign(new Marker(), { getRootNode: () => root, remove });
    marker.connectedCallback();
    control({ action: 'sync', enabled: true });
    expect(host.shadowRoot).toBeNull();
    expect(remove).toHaveBeenCalledOnce();
    expect(observedRoots).toContain(root);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'declarative-child' }),
      '*',
    );
  });
  it('inserts markers only into native declarative templates, without rewriting authored bytes', () => {
    const html = `<div><template SHADOWROOTMODE="CLOSED" data-keep=exact><p>Closed</p><div><template shadowrootmode=open><p>Open</p></template></div></template></div><template><audio autoplay></audio></template><template shadowrootmode=" closed "><p>Invalid</p></template><script>const example='<template shadowrootmode="closed">';</script>`;
    const patched = patchHtmlForIframe(html, undefined, 'Doc_A');
    expect(
      patched.match(/<maic-media-root-doc_a data-maic-shadow-root><\/maic-media-root-doc_a>/g),
    ).toHaveLength(2);
    expect(
      patched.replaceAll(
        '<maic-media-root-doc_a data-maic-shadow-root></maic-media-root-doc_a>',
        '',
      ),
    ).toContain(html);
    expect(patchHtmlForIframe(html)).toContain(html);
  });
  it('discovers frames in a closed root returned by native attachShadow', () => {
    const { frameDocument, FrameElement, control } = bridgeFixture();
    const host = new FrameElement();
    frameDocument.hosts.push(host);
    const root = host.attachShadow({ mode: 'closed' });
    expect(host.shadowRoot).toBeNull();
    const postMessage = vi.fn();
    root.frames.push({
      contentWindow: { postMessage },
      getAttribute: (name) => (name === 'srcdoc' ? mediaBridgeScript('closed-child') : null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    control({ action: 'sync', enabled: true });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'closed-child', action: 'sync' }),
      '*',
    );
  });
  it('does not initialize native synthesis in frames that never use it', () => {
    const { getSynthesis, synthesis, Utterance, frameWindow } = bridgeFixture();
    expect(getSynthesis).not.toHaveBeenCalled();
    synthesis.speak(new Utterance());
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
  });
  it('reports native synthesis start, pause, resume, end and error without retaining idle utterances', () => {
    const { synthesis, Utterance, frameWindow, nativeSpeak } = bridgeFixture();
    const utterance = new Utterance();
    const authoredEnd = vi.fn();
    utterance.addEventListener('end', authoredEnd);
    expect(synthesis.speak(utterance)).toBeUndefined();
    expect(nativeSpeak.mock.contexts[0]).toBe(synthesis);
    expect(nativeSpeak.mock.calls[0]).toEqual([utterance]);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    synthesis.pause();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false }),
      '*',
    );
    synthesis.resume();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    synthesis.finish('end');
    expect(authoredEnd).toHaveBeenCalledOnce();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false }),
      '*',
    );
    frameWindow.parent.postMessage.mockClear();
    utterance.dispatchEvent(new Event('start'));
    expect(frameWindow.parent.postMessage).not.toHaveBeenCalled();
    synthesis.speak(utterance);
    synthesis.finish('error');
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false }),
      '*',
    );
    expect(() => synthesis.speak(null as unknown as InstanceType<typeof Utterance>)).toThrow(
      TypeError,
    );
  });

  it('cancels active and queued native synthesis before acknowledging silence', async () => {
    const { synthesis, Utterance, control, frameWindow } = bridgeFixture();
    synthesis.speak(new Utterance());
    synthesis.speak(new Utterance());
    expect(synthesis.pending).toBe(true);
    control({ action: 'pause', requestId: 7 });
    await Promise.resolve();
    expect(synthesis.queue).toHaveLength(0);
    expect(synthesis.speaking).toBe(false);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 7, playing: false }),
      '*',
    );
  });

  it('keeps hidden synthesis silent and does not revive a cancelled paused queue', () => {
    const { synthesis, Utterance, control, frameWindow } = bridgeFixture();
    synthesis.pause();
    synthesis.speak(new Utterance());
    control({ action: 'sync', enabled: false });
    expect(synthesis.queue).toHaveLength(0);
    expect(synthesis.paused).toBe(true);
    control({ action: 'sync', enabled: true });
    synthesis.resume();
    expect(synthesis.speaking).toBe(false);
    control({ action: 'sync', enabled: false });
    synthesis.speak(new Utterance());
    expect(synthesis.speaking).toBe(false);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false }),
      '*',
    );
  });

  it('does not acknowledge silence if native synthesis cancellation leaves speech running', async () => {
    const { synthesis, Utterance, control, frameWindow } = bridgeFixture();
    synthesis.speak(new Utterance());
    synthesis.refuseCancel = true;
    control({ action: 'pause', requestId: 8 });
    await Promise.resolve();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 8, playing: true }),
      '*',
    );
  });

  it('discovers nested frames in existing open shadow roots', () => {
    const { frameDocument, FrameElement, control } = bridgeFixture();
    const host = new FrameElement();
    const root = host.attachShadow();
    const nestedHost = new FrameElement();
    const nestedRoot = nestedHost.attachShadow();
    root.hosts.push(nestedHost);
    frameDocument.hosts.push(host);
    const postMessage = vi.fn();
    nestedRoot.frames.push({
      contentWindow: { postMessage },
      getAttribute: (name) => (name === 'srcdoc' ? mediaBridgeScript('shadow-child') : null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    control({ action: 'sync', enabled: true });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'shadow-child', action: 'sync' }),
      '*',
    );
  });

  it('observes a newly attached shadow root before its children are inserted', () => {
    const { FrameElement, observedRoots } = bridgeFixture();
    const host = new FrameElement();
    const root = host.attachShadow();
    expect(host.shadowRoot).toBe(root);
    expect(observedRoots).toContain(root);
    expect(() => host.attachShadow()).toThrow('already attached');
  });

  it('restores an unresponsive nested source once and accepts its new generation', async () => {
    vi.useFakeTimers();
    const { frameDocument, frameWindow, control } = bridgeFixture();
    const source = mediaBridgeScript('child');
    const reset = vi.fn();
    const postMessage = vi.fn();
    const addEventListener = vi.fn();
    const frame = {
      isConnected: true,
      contentWindow: { postMessage },
      getAttribute: (name: string) => (name === 'srcdoc' ? source : null),
      addEventListener,
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(frame, 'srcdoc', { set: reset });
    frameDocument.frames.push(frame);
    control({ action: 'sync', enabled: true });
    const loaded = addEventListener.mock.calls.find(([type]) => type === 'load')![1];
    loaded();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reset).toHaveBeenCalledExactlyOnceWith(source);
    loaded();
    const generation = postMessage.mock.calls.at(-1)![0].generation;
    frameWindow.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow as unknown as Window,
        data: {
          type: 'maic:media:state:v1',
          documentId: 'child',
          generation,
          requestId: 0,
          playing: false,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: false }),
      '*',
    );
  });

  it.each(['beforebegin', 'afterbegin', 'beforeend', 'afterend'])(
    'observes detached insertAdjacentHTML media at %s without changing native semantics',
    async (position) => {
      const { FrameElement, nativeInsert, media, control } = bridgeFixture();
      const parent = new FrameElement();
      const element = new FrameElement();
      element.parentNode = ['beforebegin', 'afterend'].includes(position) ? parent : null;
      const target = element.parentNode ?? element;
      expect(element.insertAdjacentHTML(position, '<audio>')).toBeUndefined();
      expect(nativeInsert.mock.contexts[0]).toBe(element);
      expect(nativeInsert.mock.calls[0]).toEqual([position, '<audio>']);
      expect(media.size).toBe(0);
      const audio = target.elements[0];
      audio.paused = false;
      audio.dispatchEvent(new Event('play'));
      expect(media.has(audio)).toBe(true);
      control({ action: 'pause', requestId: 1 });
      await Promise.resolve();
      expect(audio.paused).toBe(true);
      expect(media.size).toBe(0);
      let error: unknown;
      try {
        element.insertAdjacentHTML(position, 'invalid');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBe(nativeInsert.mock.results[1].value);
      expect(error).toBeInstanceOf(TypeError);
    },
  );

  it('observes parser-added media removed before its first native play', async () => {
    const { Media, FrameElement, added, media, control, frameWindow } = bridgeFixture();
    const element = new Media();
    const subtree = new FrameElement();
    subtree.elements = [element];
    added(subtree);
    expect(media.size).toBe(0);
    for (let i = 0; i < 2; i++) {
      element.paused = false;
      element.dispatchEvent(new Event('play'));
      expect(media.has(element)).toBe(true);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
      control({ action: 'pause', requestId: i + 1 });
      await Promise.resolve();
      expect(element.paused).toBe(true);
      expect(media.size).toBe(0);
    }
  });

  it('holds narration after a nested load that cannot acknowledge the current pause', async () => {
    vi.useFakeTimers();
    const { frameDocument, frameWindow, control } = bridgeFixture();
    const addEventListener = vi.fn();
    frameDocument.frames.push({
      contentWindow: { postMessage: vi.fn() },
      getAttribute: (name) =>
        name === 'srcdoc' ? '<script data-maic-media-document="child">' : null,
      addEventListener,
      removeEventListener: vi.fn(),
    });
    control({ action: 'sync', enabled: true });
    addEventListener.mock.calls.find(([type]) => type === 'load')![1]();
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    control({ action: 'pause', requestId: 77 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 77, playing: true }),
      '*',
    );
  });

  it('keeps parser-discovered media observable after release and detached native reuse', async () => {
    const { Media, media, nativePlay, control, frameWindow } = bridgeFixture();
    const element = new Media();
    element.paused = false;
    nativePlay(element);
    expect(media.has(element)).toBe(true);
    element.pause();
    expect(media.size).toBe(0);
    frameWindow.parent.postMessage.mockClear();
    element.paused = false;
    element.dispatchEvent(new Event('play'));
    expect(media.has(element)).toBe(true);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    control({ action: 'pause', requestId: 1 });
    await Promise.resolve();
    expect(element.paused).toBe(true);
    expect(media.size).toBe(0);
  });

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

  it('patches deeply nested ordinary HTML without consuming the JavaScript call stack', () => {
    const html = '<div>'.repeat(8000) + 'deep leaf' + '</div>'.repeat(8000);
    expect(patchHtmlForIframe(html)).toContain(html);
    expect(patchHtmlForIframe(html, undefined, 'deep')).toContain(html);
  });

  it('bounds nested document instrumentation at four levels while preserving the remaining document', () => {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    let html = '<p>deepest document</p>';
    for (let i = 0; i < 6; i++) html = `<iframe srcdoc="${escape(html)}"></iframe>`;
    let current = patchHtmlForIframe(html, undefined, 'root');
    for (let depth = 1; depth <= 6; depth++) {
      current = new DOMParser()
        .parseFromString(current, 'text/html')
        .querySelector('iframe')!
        .getAttribute('srcdoc')!;
      expect(Boolean(mediaDocumentId(current))).toBe(depth <= 4);
    }
    expect(current).toContain('deepest document');
  });

  it.each(['', 'allow-forms'])(
    'does not advertise an executable bridge inside sandbox="%s"',
    (sandbox) => {
      const patched = patchHtmlForIframe(
        `<iframe sandbox="${sandbox}" srcdoc="<audio controls></audio>"></iframe>`,
        undefined,
        'root',
      );
      const frame = new DOMParser().parseFromString(patched, 'text/html').querySelector('iframe')!;
      expect(frame.getAttribute('sandbox')).toBe(sandbox);
      expect(mediaDocumentId(frame.getAttribute('srcdoc')!)).toBeUndefined();
      expect(frame.getAttribute('srcdoc')).toContain('<audio controls>');
    },
  );

  it.each([
    ['', false],
    ['allow-forms', false],
    ['allow-scripts', true],
    ['ALLOW-SCRIPTS', true],
    ['allow-forms\tallow-scripts', true],
    ['allow-scriptsr', false],
    ['allow-forms\u00a0allow-scripts', false],
  ] as const)(
    'registers nested controls only for valid script sandbox tokens: %s',
    (sandbox, allowed) => {
      const { frameWindow, frameDocument } = bridgeFixture();
      const postMessage = vi.fn();
      const source = { postMessage };
      const frame = {
        contentWindow: source,
        getAttribute: (name: string) =>
          name === 'sandbox'
            ? sandbox
            : name === 'srcdoc'
              ? '<script data-maic-media-document="child">'
              : null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        style: { cssText: '' },
      };
      frameDocument.frames.push(frame);
      frameWindow.dispatchEvent(
        new MessageEvent('message', {
          source: source as unknown as Window,
          data: {
            type: 'maic:media:state:v1',
            documentId: 'child',
            generation: 0,
            requestId: 0,
            playing: false,
          },
        }),
      );
      expect(postMessage.mock.calls.some(([data]) => data.action === 'sync')).toBe(allowed);
    },
  );

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
  it.each(['DOMParser', 'innerHTML', 'setHTMLUnsafe', 'setHTML', 'cloneContents'])(
    'observes detached parser media from %s without explicit play',
    (factory) => {
      const { FrameElement, Parser, FrameRange, media, frameWindow, control } = bridgeFixture();
      const root =
        factory === 'DOMParser'
          ? new Parser().parseFromString()
          : factory === 'cloneContents'
            ? new FrameRange().cloneContents()
            : new FrameElement();
      if (factory === 'innerHTML') {
        root.innerHTML = '<audio></audio>';
        expect(root.innerHTML).toBe('<audio></audio>');
        expect(() => {
          root.innerHTML = 'invalid';
        }).toThrow('invalid HTML');
      }
      if (factory === 'setHTMLUnsafe' || factory === 'setHTML') {
        expect(root[factory]('<audio></audio>', {})).toBeUndefined();
        expect(() => root[factory]('invalid')).toThrow('invalid HTML');
      }
      expect(media.size).toBe(0);
      const element = root.elements[0];
      element.paused = false;
      element.dispatchEvent(new Event('play'));
      expect(media.size).toBe(1);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
      control({ action: 'pause', requestId: 1 });
      expect(element.paused).toBe(true);
      expect(media.size).toBe(0);
    },
  );

  it('observes media in a cloned template content tree without retaining idle originals', () => {
    const { FrameNode, Media, media, frameWindow } = bridgeFixture();
    class Template extends FrameNode {
      tagName = 'TEMPLATE';
      element = new Media();
      content = { querySelectorAll: () => [this.element] };
    }
    const source = new Template();
    expect(media.size).toBe(0);
    const clone = source.cloneNode() as Template;
    expect(media.size).toBe(0);
    clone.element.paused = false;
    clone.element.dispatchEvent(new Event('play'));
    expect(media.size).toBe(1);
    expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true }),
      '*',
    );
    clone.element.pause();
    expect(media.size).toBe(0);
  });

  it.each(['cloneNode', 'importNode'] as const)(
    'observes detached native autoplay via %s',
    async (factory) => {
      const { frameDocument, control, media, frameWindow } = bridgeFixture();
      const original = frameDocument.createElement('audio') as unknown as {
        cloneNode(): EventTarget;
      };
      const element = (
        factory === 'cloneNode' ? original.cloneNode() : frameDocument.importNode(original as never)
      ) as EventTarget & { paused: boolean };
      expect(media.size).toBe(0);
      element.paused = false;
      element.dispatchEvent(new Event('play'));
      expect(media.size).toBe(1);
      expect(frameWindow.parent.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ playing: true }),
        '*',
      );
      control({ action: 'pause', requestId: 1 });
      await Promise.resolve();
      expect(element.paused).toBe(true);
      expect(media.size).toBe(0);
    },
  );

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
  it('keeps an in-flight pause through load and requires its new-generation acknowledgement', async () => {
    const { session, post, message } = fixture();
    const pause = session.pause();
    const id = post.mock.calls.at(-1)![0].requestId;
    const oldGeneration = post.mock.calls.at(-1)![0].generation;
    const ready = session.loaded();
    let result: boolean | undefined;
    void pause.then((value) => {
      result = value;
    });
    message({ ...playing, generation: oldGeneration, requestId: id, playing: false });
    await Promise.resolve();
    expect(result).toBeUndefined();
    message({ ...playing, requestId: id, playing: false });
    await expect(pause).resolves.toBe(true);
    await expect(ready).resolves.toBe(true);
  });

  it('does not restore an obsolete source or accept an old load acknowledgement', async () => {
    vi.useFakeTimers();
    const { frame, session, message, post } = fixture(mediaBridgeScript('current'));
    const reset = vi.spyOn(frame, 'srcdoc', 'set').mockImplementation(() => {});
    const first = session.loaded();
    const oldGeneration = post.mock.calls.at(-1)![0].generation;
    const current = session.loaded();
    await expect(first).resolves.toBe(false);
    message({ ...playing, generation: oldGeneration, playing: false });
    frame.setAttribute('srcdoc', mediaBridgeScript('current') + '<p>Replacement</p>');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(current).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('restores the managed source after an unresponsive navigation without looping', async () => {
    vi.useFakeTimers();
    const source = mediaBridgeScript('current');
    const { frame, session } = fixture(source);
    const reset = vi.spyOn(frame, 'srcdoc', 'set').mockImplementation(() => {});
    session.loaded();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reset).toHaveBeenCalledExactlyOnceWith(source);
    session.loaded();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('keeps a healthy document and cancels navigation recovery on disposal', async () => {
    vi.useFakeTimers();
    const { frame, session, message } = fixture(mediaBridgeScript('current'));
    const reset = vi.spyOn(frame, 'srcdoc', 'set').mockImplementation(() => {});
    session.loaded();
    message({ ...playing, playing: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reset).not.toHaveBeenCalled();
    session.loaded();
    session.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reset).not.toHaveBeenCalled();
  });

  it('rejects a pause when the loaded document never bootstraps its bridge', async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    session.loaded();
    const silent = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(silent).resolves.toBe(false);
  });

  it('requires a current acknowledgement even from a previously silent frame', async () => {
    vi.useFakeTimers();
    const { session, message } = fixture();
    message({ ...playing, playing: false });
    const silent = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(silent).resolves.toBe(false);
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
    await expect(old).resolves.toBe(false);
    played.mockClear();
    message({ ...playing, generation: oldGeneration });
    message({ ...playing, generation: oldGeneration, requestId: oldId });
    expect(played).not.toHaveBeenCalled();
    const next = session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBe(false);
    message({ ...playing, playing: false });
    const confirmed = session.pause();
    message({ ...playing, requestId: post.mock.calls.at(-1)![0].requestId, playing: false });
    await expect(confirmed).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('pauses narration on a subsequent document load, but not on the first load', () => {
    const { session, played } = fixture();
    session.loaded();
    expect(played).not.toHaveBeenCalled();
    session.loaded();
    expect(played).toHaveBeenCalledOnce();
    session.loaded(false);
    expect(played).toHaveBeenCalledOnce();
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

  it('reissues a pending pause when a caller retries after the frame becomes responsive', async () => {
    vi.useFakeTimers();
    const { session, post, message } = fixture();
    let responsive = false;
    post.mockImplementation((data) => {
      if (responsive && data.action === 'pause')
        message({ ...playing, requestId: data.requestId, playing: false });
    });
    const first = session.pause();
    responsive = true;
    const retry = session.pause();
    expect(retry).toBe(first);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(retry).resolves.toBe(true);
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
