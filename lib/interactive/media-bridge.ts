/** Cooperative signals are not a security boundary; keep the opaque sandbox. */
export const MEDIA_CONTROL = 'maic:media:control:v1';
const MEDIA_STATE = 'maic:media:state:v1';
let nextPauseRequestId = 0;
let nextMediaGeneration = 0;

/** Install before authored scripts; a literal cannot leak bundler helpers into the frame. */
const MEDIA_BRIDGE = String.raw`(function (documentId) {
  var media = new Set();
  var contexts = new Set();
  var suspended = new Set();
  var contextState = new WeakMap();
  var mediaContexts = new WeakMap();
  var enabled = true;
  var generation = 0;
  function report(requestId) {
    suspended.forEach(function (ref) { if (!ref.deref()) suspended.delete(ref); });
    window.parent.postMessage({
      type: 'maic:media:state:v1', documentId: documentId, generation: generation, requestId: requestId || 0,
      playing: Array.from(media).some(function (element) { return !element.paused && !element.ended && !element.error; }) ||
        Array.from(contexts).some(function (context) { return context.state === 'running'; })
    }, '*');
  }
  function pause() {
    media.forEach(function (element) { element.pause(); });
    return Promise.all(Array.from(contexts).map(function (context) {
      if (context.state !== 'running') return Promise.resolve();
      var state = contextState.get(context);
      if (state.pending) return state.pending;
      forget(context);
      var ref = new WeakRef(context);
      state.suspended = ref;
      suspended.add(ref);
      state.pending = state.suspend.call(context).catch(function () {}).then(function () {
        state.pending = null;
        if (!enabled && context.state === 'running') return state.suspend.call(context).catch(function () {});
        if (state.suspended === ref && state.resumeRequested && enabled) return soundStarted(context);
      });
      return state.pending;
    }));
  }
  function forget(context) {
    var state = contextState.get(context);
    if (state.suspended) suspended.delete(state.suspended);
    state.suspended = null;
    state.resumeRequested = false;
  }
  function soundStarted(context) {
    var state = contextState.get(context);
    if (!state) return;
    state.started = true;
    if (context.state === 'running') contexts.add(context);
    if (!enabled || !state.suspended) return;
    if (context.state === 'closed') { forget(context); return; }
    state.resumeRequested = true;
    var ref = state.suspended;
    // Resume on playback; retry if an overlapping suspend settles later.
    return state.resume.call(context).then(function () {
      if (state.suspended === ref && !state.pending && context.state === 'running') forget(context);
    }).catch(function () {});
  }
  ['AudioScheduledSourceNode', 'AudioBufferSourceNode'].forEach(function (name) {
    var Source = window[name];
    if (!Source) return;
    var start = Source.prototype.start;
    Source.prototype.start = function () {
      var result = start.apply(this, arguments);
      soundStarted(this.context);
      changed();
      return result;
    };
  });
  var AudioNode = window.AudioNode;
  var MediaSource = window.MediaElementAudioSourceNode;
  if (AudioNode && MediaSource) {
    var connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function () {
      var result = connect.apply(this, arguments);
      // Both factory and constructor-created media sources use this routing entry.
      if (this instanceof MediaSource) mediaContexts.set(this.mediaElement, new WeakRef(this.context));
      return result;
    };
  }
  function changed() {
    if (!enabled) pause();
    report();
  }
  function release(element) {
    if (!element.paused && !element.ended && !element.error) return;
    media.delete(element);
    element.removeEventListener('play', started);
    ['pause', 'ended', 'emptied', 'error'].forEach(function (type) {
      element.removeEventListener(type, stopped);
    });
  }
  function stopped(event) {
    release(event.target);
    changed();
  }
  function watch(element) {
    if (media.has(element)) return;
    media.add(element);
    element.addEventListener('play', started);
    ['pause', 'ended', 'emptied', 'error'].forEach(function (type) {
      element.addEventListener(type, stopped);
    });
  }
  function started(event) {
    if (event.target instanceof HTMLMediaElement) {
      observe(event.target);
      if (!event.target.paused && !event.target.ended && !event.target.error) {
        watch(event.target);
        var ref = mediaContexts.get(event.target);
        if (ref) soundStarted(ref.deref());
      }
      changed();
    }
  }
  document.addEventListener('play', started, true);
  function untrackedPlay(event) {
    if (!media.has(event.target)) started(event);
  }
  function observe(element) {
    // Element-owned listeners survive reuse without retaining idle media globally.
    if (element instanceof HTMLMediaElement) element.addEventListener('play', untrackedPlay);
    return element;
  }
  var Audio = window.Audio;
  if (Audio) window.Audio = new Proxy(Audio, {
    apply: function (target, receiver, args) {
      return observe(Reflect.apply(target, receiver, args));
    },
    construct: function (target, args, newTarget) {
      return observe(Reflect.construct(target, args, newTarget));
    }
  });
  var play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    var element = this;
    watch(element);
    function failed(error) { release(element); changed(); throw error; }
    try { return play.call(element).catch(failed); }
    catch (error) { return failed(error); }
  };
  var contextConstructors = new WeakMap();
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Native = window[name];
    if (!Native) return;
    if (contextConstructors.has(Native)) { window[name] = contextConstructors.get(Native); return; }
    var Tracked = new Proxy(Native, {
      construct: function (target, args, newTarget) {
        var context = Reflect.construct(target, args, newTarget);
        var state = { suspend: context.suspend, resume: context.resume, suspended: null, pending: null, resumeRequested: false, started: false };
        contextState.set(context, state);
        ['suspend', 'resume', 'close'].forEach(function (method) {
          var native = context[method];
          context[method] = function () { if (contextState.has(this)) forget(this); return native.apply(this, arguments); };
        });
        context.addEventListener('statechange', function () {
          if (context.state === 'running' && state.started) contexts.add(context);
          else contexts.delete(context);
          if (context.state === 'closed') forget(context);
          changed();
        });
        changed();
        return context;
      }
    });
    contextConstructors.set(Native, Tracked);
    Object.defineProperty(Native.prototype, 'constructor', Object.assign({}, Object.getOwnPropertyDescriptor(Native.prototype, 'constructor'), { value: Tracked }));
    window[name] = Tracked;
  });
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'maic:media:control:v1' || data.documentId !== documentId || !Number.isSafeInteger(data.generation) || data.generation <= 0) return;
    if (data.action === 'sync' && typeof data.enabled === 'boolean') {
      if (data.generation < generation) return;
      generation = data.generation;
      enabled = data.enabled;
      if (!enabled) suspended.forEach(function (ref) {
        var context = ref.deref();
        if (context) contextState.get(context).resumeRequested = false;
        else suspended.delete(ref);
      });
      changed();
    } else if (data.generation === generation && data.action === 'pause' && Number.isSafeInteger(data.requestId) && data.requestId > 0) {
      var requestGeneration = generation;
      pause().then(function () { if (requestGeneration === generation) report(data.requestId); });
    }
  });
  report();
})(__DOCUMENT_ID__);`;

export function mediaBridgeScript(documentId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) throw new Error('Invalid media document id');
  return `<script data-maic-media-document="${documentId}">${MEDIA_BRIDGE.replace('__DOCUMENT_ID__', JSON.stringify(documentId))}</script>`;
}

export function mediaDocumentId(html: string | undefined): string | undefined {
  return html?.match(/<script data-maic-media-document="([a-zA-Z0-9_-]+)">/)?.[1];
}

export function createInteractiveMediaSession(
  frame: HTMLIFrameElement,
  documentId: string,
  onPlay: () => void,
) {
  let enabled = true;
  let reportedPlaying = false;
  let unresponsive = false;
  let disposed = false;
  let generation = ++nextMediaGeneration;
  let pendingPause: {
    id: number;
    promise: Promise<boolean>;
    finish: (silent: boolean) => void;
  } | null = null;
  const post = (payload: Record<string, unknown>) => {
    frame.contentWindow?.postMessage(
      { type: MEDIA_CONTROL, documentId, generation, ...payload },
      '*',
    );
  };
  const sync = (nextEnabled = enabled) => {
    enabled = nextEnabled;
    post({ action: 'sync', enabled });
    if (pendingPause) post({ action: 'pause', requestId: pendingPause.id });
  };
  const pause = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (pendingPause) return pendingPause.promise;
    // shortcut: an uninstrumented document is best effort; never stall every later sentence.
    if (unresponsive) return Promise.resolve(true);
    const id = ++nextPauseRequestId;
    let finish!: (silent: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        unresponsive = !reportedPlaying;
        finish(!reportedPlaying);
      }, 1000);
      finish = (silent) => {
        clearTimeout(timer);
        pendingPause = null;
        resolve(silent);
      };
    });
    pendingPause = { id, promise, finish };
    sync();
    return promise;
  };
  const onMessage = (event: MessageEvent) => {
    if (disposed || !frame.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (
      !data ||
      typeof data !== 'object' ||
      data.type !== MEDIA_STATE ||
      data.documentId !== documentId ||
      typeof data.playing !== 'boolean' ||
      !Number.isSafeInteger(data.requestId) ||
      data.requestId < 0
    )
      return;
    if (data.generation === 0 && data.requestId === 0) {
      sync();
      return;
    }
    if (data.generation !== generation) return;
    // The acknowledgement decides silence; keep positive evidence if it never arrives.
    if (pendingPause) {
      if (data.requestId !== pendingPause.id) {
        if (data.requestId === 0 && data.playing) reportedPlaying = true;
        return;
      }
      pendingPause.finish(!data.playing);
    } else if (data.requestId !== 0) return;
    unresponsive = false;
    const started = data.playing && !reportedPlaying;
    reportedPlaying = data.playing;
    if (data.playing) {
      if (enabled) onPlay();
      else if (data.requestId === 0 && started) void pause();
    }
  };
  window.addEventListener('message', onMessage);
  return {
    pause,
    sync,
    loaded(nextEnabled = enabled) {
      if (disposed) return;
      generation = ++nextMediaGeneration;
      reportedPlaying = false;
      unresponsive = false;
      sync(nextEnabled);
    },
    dispose() {
      disposed = true;
      pendingPause?.finish(false);
      post({ action: 'sync', enabled: false });
      window.removeEventListener('message', onMessage);
    },
  };
}
