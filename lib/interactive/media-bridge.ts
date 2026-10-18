/** Cooperative signals can be forged by hostile code in the same frame; keep the opaque sandbox. */
export const MEDIA_CONTROL = 'maic:media:control:v1';
const MEDIA_STATE = 'maic:media:state:v1';
let nextPauseRequestId = 0;
let nextMediaGeneration = 0;

/** Runs ahead of authored scripts; a literal avoids bundler helpers leaking into the sandbox. */
const MEDIA_BRIDGE = String.raw`(function (documentId) {
  var media = new Set();
  var contexts = new Set();
  var suspended = new Set();
  var contextState = new WeakMap();
  var enabled = true;
  var generation = 0;
  var children = new Map();
  var childGeneration = 0;
  var childRequest = 0;
  function syncChild(child) {
    child.frame.contentWindow.postMessage({ type: 'maic:media:control:v1', documentId: child.id, generation: child.generation, action: 'sync', enabled: enabled }, '*');
    if (child.pending) child.frame.contentWindow.postMessage({ type: 'maic:media:control:v1', documentId: child.id, generation: child.generation, action: 'pause', requestId: child.pending.id }, '*');
  }
  function scanChildren() {
    var frames = new Set(document.querySelectorAll('iframe[srcdoc]'));
    children.forEach(function (child, frame) {
      var match = (frame.getAttribute('srcdoc') || '').match(/<script data-maic-media-document="([a-zA-Z0-9_-]+)">/);
      if (!frames.has(frame) || !match || match[1] !== child.id) {
        frame.removeEventListener('load', child.load);
        children.delete(frame);
        if (child.pending) child.pending.finish(true);
      }
    });
    frames.forEach(function (frame) {
      if (children.has(frame) || !frame.contentWindow) return;
      var match = (frame.getAttribute('srcdoc') || '').match(/<script data-maic-media-document="([a-zA-Z0-9_-]+)">/);
      if (!match) return;
      var child = { frame: frame, id: match[1], generation: ++childGeneration, playing: false, pending: null };
      child.load = function () { child.generation = ++childGeneration; child.playing = false; syncChild(child); };
      children.set(frame, child);
      frame.addEventListener('load', child.load);
      syncChild(child);
    });
  }
  function pauseChild(child) {
    if (child.pending) return child.pending.promise;
    var id = ++childRequest;
    var pending = { id: id };
    pending.promise = new Promise(function (resolve) {
      var timer = setTimeout(function () { pending.finish(!child.playing); }, 1000);
      pending.finish = function (silent) { clearTimeout(timer); child.pending = null; resolve(silent); };
    });
    child.pending = pending;
    syncChild(child);
    return pending.promise;
  }
  function report(requestId, unsilenced) {
    suspended.forEach(function (ref) { if (!ref.deref()) suspended.delete(ref); });
    window.parent.postMessage({
      type: 'maic:media:state:v1', documentId: documentId, generation: generation, requestId: requestId || 0,
      playing: !!unsilenced || Array.from(media).some(function (element) { return !element.paused && !element.ended; }) ||
        Array.from(contexts).some(function (context) { return context.state === 'running'; }) ||
        Array.from(children.values()).some(function (child) { return child.playing; })
    }, '*');
  }
  function pause() {
    scanChildren();
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
        if (state.suspended === ref && state.resumeRequested && enabled) {
          forget(context);
          if (context.state !== 'closed') return state.resume.call(context).catch(function () {});
        }
      });
      return state.pending;
    }).concat(Array.from(children.values()).map(pauseChild)));
  }
  function forget(context) {
    var state = contextState.get(context);
    if (state.suspended) suspended.delete(state.suspended);
    state.suspended = null;
    state.resumeRequested = false;
  }
  function gesture(event) {
    if (!enabled || !event.isTrusted) return;
    suspended.forEach(function (ref) {
      var context = ref.deref();
      if (!context) { suspended.delete(ref); return; }
      var state = contextState.get(context);
      if (context.state === 'closed') { forget(context); return; }
      state.resumeRequested = true;
      if (!state.pending) forget(context);
      // Start in the user gesture; retry after an overlapping suspend settles.
      state.resume.call(context).catch(function () {});
    });
  }
  document.addEventListener('pointerdown', gesture, true);
  document.addEventListener('keydown', gesture, true);
  function changed() {
    if (!enabled) pause();
    report();
  }
  function release(element) {
    if (!element.paused && !element.ended && !element.error) return;
    media.delete(element);
    element.removeEventListener('play', changed);
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
    element.addEventListener('play', changed);
    ['pause', 'ended', 'emptied', 'error'].forEach(function (type) {
      element.addEventListener(type, stopped);
    });
  }
  function started(event) {
    if (event.target instanceof HTMLMediaElement) {
      if (!event.target.paused && !event.target.ended && !event.target.error) watch(event.target);
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
  ['createElement', 'createElementNS'].forEach(function (name) {
    var native = Document.prototype[name];
    Document.prototype[name] = new Proxy(native, {
      apply: function (target, receiver, args) {
        return observe(Reflect.apply(target, receiver, args));
      }
    });
  });
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
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Native = window[name];
    if (!Native) return;
    window[name] = new Proxy(Native, {
      construct: function (target, args, newTarget) {
        var context = Reflect.construct(target, args, newTarget);
        var state = { suspend: context.suspend, resume: context.resume, suspended: null, pending: null, resumeRequested: false };
        contextState.set(context, state);
        ['suspend', 'resume', 'close'].forEach(function (method) {
          var native = context[method];
          context[method] = function () { if (contextState.has(this)) forget(this); return native.apply(this, arguments); };
        });
        if (context.state === 'running') contexts.add(context);
        context.addEventListener('statechange', function () {
          if (context.state === 'running') contexts.add(context);
          else contexts.delete(context);
          if (context.state === 'closed') forget(context);
          changed();
        });
        changed();
        return context;
      }
    });
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent) {
      scanChildren();
      children.forEach(function (child) {
        if (event.source !== child.frame.contentWindow || !data || data.type !== 'maic:media:state:v1' || data.documentId !== child.id || typeof data.playing !== 'boolean' || !Number.isSafeInteger(data.requestId) || data.requestId < 0) return;
        if (data.generation === 0 && data.requestId === 0) { syncChild(child); return; }
        if (data.generation !== child.generation) return;
        if (child.pending) {
          if (data.requestId !== child.pending.id) {
            if (data.requestId === 0 && data.playing) { child.playing = true; report(); }
            return;
          }
          child.pending.finish(!data.playing);
        } else if (data.requestId !== 0) return;
        child.playing = data.playing;
        if (!enabled && child.playing) pause();
        report();
      });
      return;
    }
    if (!data || data.type !== 'maic:media:control:v1' || data.documentId !== documentId) return;
    if (data.action === 'pause' && data.generation === generation && Number.isSafeInteger(data.requestId) && data.requestId > 0) {
      pause().then(function (results) { report(data.requestId, results.some(function (silent) { return silent === false; })); });
    }
    else if (data.action === 'sync' && typeof data.enabled === 'boolean' && Number.isSafeInteger(data.generation) && data.generation > 0) {
      generation = data.generation;
      enabled = data.enabled;
      scanChildren();
      children.forEach(syncChild);
      if (!enabled) suspended.forEach(function (ref) {
        var context = ref.deref();
        if (context) contextState.get(context).resumeRequested = false;
        else suspended.delete(ref);
      });
      changed();
    }
  });
  if (typeof MutationObserver !== 'undefined') new MutationObserver(scanChildren).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['srcdoc'] });
  scanChildren();
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
  let disposed = false;
  let generation = ++nextMediaGeneration;
  let reportedPlaying = false;
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
  const pause = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (pendingPause) return pendingPause.promise;
    const id = ++nextPauseRequestId;
    let finish!: (silent: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(!reportedPlaying), 1000);
      finish = (silent) => {
        clearTimeout(timer);
        pendingPause = null;
        resolve(silent);
      };
    });
    pendingPause = { id, promise, finish };
    post({ action: 'sync', enabled });
    post({ action: 'pause', requestId: id });
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
    // A queued play report must not re-pause narration just resumed by the host.
    if (pendingPause) {
      if (data.requestId !== pendingPause.id) {
        if (data.requestId === 0 && data.playing) reportedPlaying = true;
        return;
      }
      pendingPause.finish(!data.playing);
    } else if (data.requestId !== 0) return;
    reportedPlaying = data.playing;
    if (data.playing) {
      if (enabled) onPlay();
      else pause();
    }
  };
  window.addEventListener('message', onMessage);
  const sync = (nextEnabled = enabled) => {
    enabled = nextEnabled;
    post({ action: 'sync', enabled });
    if (pendingPause) post({ action: 'pause', requestId: pendingPause.id });
  };
  return {
    pause,
    sync,
    loaded(nextEnabled = enabled) {
      generation = ++nextMediaGeneration;
      reportedPlaying = false;
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
