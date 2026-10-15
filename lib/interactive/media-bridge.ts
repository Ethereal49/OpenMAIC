/** Cooperative signals can be forged by hostile code in the same frame; keep the opaque sandbox. */
export const MEDIA_CONTROL = 'maic:media:control:v1';
const MEDIA_STATE = 'maic:media:state:v1';
let nextPauseRequestId = 0;

/** Runs ahead of authored scripts; a literal avoids bundler helpers leaking into the sandbox. */
const MEDIA_BRIDGE = String.raw`(function (documentId) {
  var media = new Set();
  var contexts = new Set();
  var enabled = true;
  function report(requestId) {
    window.parent.postMessage({
      type: 'maic:media:state:v1', documentId: documentId, requestId: requestId || 0,
      playing: Array.from(media).some(function (element) { return !element.paused && !element.ended; }) ||
        Array.from(contexts).some(function (context) { return context.state === 'running'; })
    }, '*');
  }
  function pause() {
    media.forEach(function (element) { element.pause(); });
    return Promise.all(Array.from(contexts).map(function (context) {
      return context.state === 'running' ? context.suspend().catch(function () {}) : Promise.resolve();
    }));
  }
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
  // Native/autoplay starts and detached new Audio() elements both participate.
  document.addEventListener('play', function (event) {
    if (event.target instanceof HTMLMediaElement) {
      if (!event.target.paused && !event.target.ended && !event.target.error) watch(event.target);
      changed();
    }
  }, true);
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
        contexts.add(context);
        context.addEventListener('statechange', function () {
          if (context.state === 'closed') contexts.delete(context);
          changed();
        });
        changed();
        return context;
      }
    });
  });
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'maic:media:control:v1' || data.documentId !== documentId) return;
    if (data.action === 'pause' && Number.isSafeInteger(data.requestId) && data.requestId > 0) {
      pause().then(function () { report(data.requestId); });
    }
    else if (data.action === 'sync' && typeof data.enabled === 'boolean') {
      enabled = data.enabled;
      changed();
    }
  });
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
  let pendingPause: {
    id: number;
    promise: Promise<boolean>;
    finish: (silent: boolean) => void;
  } | null = null;
  const post = (payload: Record<string, unknown>) => {
    frame.contentWindow?.postMessage({ type: MEDIA_CONTROL, documentId, ...payload }, '*');
  };
  const pause = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (pendingPause) return pendingPause.promise;
    const id = ++nextPauseRequestId;
    let finish!: (silent: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), 1000);
      finish = (silent) => {
        clearTimeout(timer);
        pendingPause = null;
        resolve(silent);
      };
    });
    pendingPause = { id, promise, finish };
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
    // A queued play report must not re-pause narration just resumed by the host.
    if (pendingPause) {
      if (data.requestId !== pendingPause.id) return;
      pendingPause.finish(!data.playing);
    } else if (data.requestId !== 0) return;
    if (data.playing) {
      if (enabled) onPlay();
      else pause();
    }
  };
  window.addEventListener('message', onMessage);
  return {
    pause,
    sync(nextEnabled = enabled) {
      enabled = nextEnabled;
      post({ action: 'sync', enabled });
      if (pendingPause) post({ action: 'pause', requestId: pendingPause.id });
    },
    dispose() {
      disposed = true;
      pendingPause?.finish(false);
      post({ action: 'sync', enabled: false });
      window.removeEventListener('message', onMessage);
    },
  };
}
