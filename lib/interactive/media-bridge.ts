/** Cooperative signals can be forged by hostile code in the same frame; keep the opaque sandbox. */
export const MEDIA_CONTROL = 'maic:media:control:v1';
const MEDIA_STATE = 'maic:media:state:v1';
let nextPauseRequestId = 0;
let nextMediaGeneration = 0;

/** Runs ahead of authored scripts; a literal avoids bundler helpers leaking into the sandbox. */
const MEDIA_BRIDGE = String.raw`(function (documentId, unobservable) {
  var media = new Set();
  var contexts = new Set();
  var suspended = new Set();
  var contextState = new WeakMap();
  var Synthesis = window.SpeechSynthesis;
  // Unused child instances can disrupt WebKit's native speech events; capture only authored use.
  var synthesis;
  var cancelSynthesis = Synthesis && Synthesis.prototype.cancel;
  var enabled = true;
  var generation = 0;
  var children = new Map();
  var uninstrumented = new Map();
  var childGeneration = 0;
  var childRequest = 0;
  var observer;
  var shadowRoots = new WeakMap();
  var cloneSeeds = new WeakSet();
  var trustedTypes = window.trustedTypes;
  var isTrustedHTML = trustedTypes && trustedTypes.isHTML;
  var trustedHTMLString = window.TrustedHTML && window.TrustedHTML.prototype.toString;
  var templatePrototype = document.createElement('template');
  var templateHTML;
  while (templatePrototype && !templateHTML) {
    templateHTML = Object.getOwnPropertyDescriptor(templatePrototype, 'innerHTML');
    templatePrototype = Object.getPrototypeOf(templatePrototype);
  }
  var rootMarkerName = 'maic-media-root-' + documentId.toLowerCase();
  var observation = { childList: true, subtree: true, attributes: true, attributeFilter: ['srcdoc', 'sandbox'] };
  function observeRoot(root) {
    if (observer) observer.observe(root, observation);
    observe(root);
    return root;
  }
  function syncChild(child) {
    child.frame.contentWindow.postMessage({ type: 'maic:media:control:v1', documentId: child.id, generation: child.generation, action: 'sync', enabled: enabled }, '*');
    if (child.pending) child.frame.contentWindow.postMessage({ type: 'maic:media:control:v1', documentId: child.id, generation: child.generation, action: 'pause', requestId: child.pending.id }, '*');
  }
  function childDocumentId(frame) {
    var sandbox = frame.getAttribute('sandbox');
    if (sandbox !== null && !/(?:^|[\t\n\f\r ])allow-scripts(?:[\t\n\f\r ]|$)/i.test(sandbox)) return null;
    var match = (frame.getAttribute('srcdoc') || '').match(/<script data-maic-media-document="([a-zA-Z0-9_-]+)">/);
    return match ? match[1] : null;
  }
  function parkChild(child) {
    child.active = false;
    child.button.disabled = !enabled;
    if (child.frame.parentNode) child.frame.parentNode.replaceChild(child.button, child.frame);
  }
  function guardUninstrumented(frame) {
    var button = document.createElement('button');
    button.type = 'button';
    button.id = frame.id;
    button.className = frame.className;
    button.style.cssText = frame.style.cssText;
    if (!button.style.width) button.style.width = (frame.offsetWidth || 300) + 'px';
    if (!button.style.height) button.style.height = (frame.offsetHeight || 150) + 'px';
    button.textContent = (frame.title || 'Embedded page') + ' — open (pauses narration; reloads after resume)';
    var child = { frame: frame, button: button, active: false };
    child.open = function () {
      if (!enabled || !button.parentNode) return;
      // shortcut: opaque children reload; preserve state when they can acknowledge media controls.
      report(0, true);
      child.active = true;
      button.parentNode.replaceChild(frame, button);
    };
    button.addEventListener('click', child.open);
    uninstrumented.set(frame, child);
    parkChild(child);
  }
  function scanChildren() {
    var frames = new Set();
    function scan(root) {
      root.querySelectorAll('iframe,object,embed').forEach(function (frame) { frames.add(frame); });
      root.querySelectorAll('*').forEach(function (element) {
        var shadow = element.shadowRoot || shadowRoots.get(element);
        if (shadow) scan(observeRoot(shadow));
      });
    }
    scan(document);
    uninstrumented.forEach(function (child, frame) {
      if (frame.isConnected && !child.active) parkChild(child);
      child.button.disabled = !enabled;
      if (!child.button.isConnected && !frame.isConnected) {
        child.button.removeEventListener('click', child.open);
        uninstrumented.delete(frame);
      }
    });
    children.forEach(function (child, frame) {
      var id = childDocumentId(frame);
      if (!frames.has(frame) || id !== child.id) {
        clearTimeout(child.recoveryTimer);
        frame.removeEventListener('load', child.load);
        children.delete(frame);
        if (child.pending) child.pending.finish(true);
      }
    });
    frames.forEach(function (frame) {
      if (children.has(frame) || uninstrumented.has(frame)) return;
      if (frame.localName === 'object' || frame.localName === 'embed') { guardUninstrumented(frame); return; }
      if (!frame.contentWindow) return;
      var id = childDocumentId(frame);
      if (!id) { guardUninstrumented(frame); return; }
      var child = { frame: frame, id: id, generation: ++childGeneration, playing: false, pending: null };
      child.load = function () {
        clearTimeout(child.recoveryTimer);
        var restored = child.restoring;
        child.restoring = false;
        child.generation = ++childGeneration;
        child.playing = true;
        var source = frame.getAttribute('srcdoc');
        var loadGeneration = child.generation;
        if (!restored && source) child.recoveryTimer = setTimeout(function () {
          if (children.get(frame) !== child || child.generation !== loadGeneration || !frame.isConnected || frame.getAttribute('srcdoc') !== source) return;
          child.restoring = true;
          frame.srcdoc = source;
        }, 1000);
        syncChild(child);
        report();
      };
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
      var timer = setTimeout(function () { pending.finish(false); }, 1000);
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
      playing: unobservable || !!unsilenced || !!(synthesis && !synthesis.paused && (synthesis.speaking || synthesis.pending)) ||
        Array.from(media).some(function (element) { return !element.paused && !element.ended; }) ||
        Array.from(contexts).some(function (context) { return context.state === 'running'; }) ||
        Array.from(children.values()).some(function (child) { return child.playing; }) ||
        Array.from(uninstrumented.values()).some(function (child) { return child.frame.isConnected; })
    }, '*');
  }
  function pause() {
    scanChildren();
    uninstrumented.forEach(parkChild);
    media.forEach(function (element) { element.pause(); });
    if (synthesis && (synthesis.speaking || synthesis.pending)) cancelSynthesis.call(synthesis);
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
  window.addEventListener('pagehide', function () { report(0, true); });
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
      observe(event.target);
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
    if (element.querySelectorAll) element.querySelectorAll('audio,video,template').forEach(observe);
    if (element.tagName === 'TEMPLATE') observe(element.content);
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
  function visitShadowRoots(node, visit) {
    var pending = [node];
    while (pending.length) {
      var current = pending.pop();
      if (!current || !current.querySelectorAll) continue;
      [current].concat(Array.from(current.querySelectorAll('*'))).forEach(function (host) {
        var root = host.shadowRoot || shadowRoots.get(host);
        if (root && visit(root) !== false) pending.push(root);
      });
    }
  }
  function prepareClone(node) {
    var seeds = [];
    if (!(node instanceof Node) || node instanceof ShadowRoot) return seeds;
    visitShadowRoots(node, function (root) {
      if (!root.clonable) return false;
      var marker = document.createElement(rootMarkerName);
      marker.hidden = true;
      marker.setAttribute('data-maic-shadow-root', '');
      cloneSeeds.add(marker);
      root.insertBefore(marker, root.firstChild);
      seeds.push(marker);
    });
    return seeds;
  }
  [[Node.prototype, 'cloneNode'], [Document.prototype, 'importNode'],
    [Document, 'parseHTMLUnsafe'], [Document, 'parseHTML'],
    [typeof DOMParser === 'undefined' ? {} : DOMParser.prototype, 'parseFromString'],
    [typeof Range === 'undefined' ? {} : Range.prototype, 'createContextualFragment'],
    [typeof Range === 'undefined' ? {} : Range.prototype, 'cloneContents']
  ].forEach(function (entry) {
    var native = entry[0][entry[1]];
    if (native) entry[0][entry[1]] = new Proxy(native, {
      apply: function (target, receiver, args) {
        var rangeClone = entry[1] === 'cloneContents';
        var cloning = rangeClone || entry[1] === 'cloneNode' || entry[1] === 'importNode';
        var parsing = entry[0] === Document;
        var source = rangeClone ? (receiver instanceof Range ? receiver.commonAncestorContainer : null) : entry[1] === 'cloneNode' ? receiver : args[0];
        var seeds = cloning && !(entry[1] === 'importNode' && source instanceof Document) ? prepareClone(source) : [];
        try {
          var result = observe(Reflect.apply(target, receiver, args));
          if (cloning || parsing) visitShadowRoots(result, observeRoot);
          if (parsing) guardParsedRoots(args[0], entry[1] === 'parseHTML');
          return result;
        } finally {
          seeds.forEach(function (marker) { marker.remove(); cloneSeeds.delete(marker); });
        }
      }
    });
  });
  function mayHideParsedRoot(input, safe) {
    try {
      // A policy or opaque coercion can change the parsed input; never invoke either twice.
      if (!safe && trustedTypes && trustedTypes.defaultPolicy) return true;
      var html = input;
      if (typeof html !== 'string') {
        if (safe || !isTrustedHTML || !isTrustedHTML.call(trustedTypes, input) || !trustedHTMLString) return true;
        html = trustedHTMLString.call(input);
      }
      if (!/<template[\t\n\f\r />]/i.test(html)) return false;
      // setHTML accepts plain strings even under TrustedTypes; do not probe a protected sink.
      if (safe && trustedTypes) return /shadowrootmode[\t\n\f\r ]*=[\t\n\f\r ]*(?:"(?:closed|[^"]*&)[^"]*"|'(?:closed|[^']*&)[^']*'|(?:closed|[^\t\n\f\r >]*&)[^\t\n\f\r >]*)/i.test(html);
      var template = document.createElement('template');
      Reflect.apply(templateHTML.set, template, [input]);
      var pending = [template.content];
      while (pending.length) {
        var templates = pending.pop().querySelectorAll('template');
        for (var i = 0; i < templates.length; i++) {
          var declaration = templates[i];
          if ((declaration.getAttribute('shadowrootmode') || '').toLowerCase() === 'closed') return true;
          if (declaration.content) pending.push(declaration.content);
        }
      }
      return false;
    } catch (_) { return true; }
  }
  function guardParsedRoots(input, safe) {
    // shortcut: unverifiable parser input refuses silence until the document reloads.
    if (!unobservable && mayHideParsedRoot(input, safe)) {
      unobservable = true;
      changed();
    }
  }
  ['write', 'writeln'].forEach(function (name) {
    var native = Document.prototype[name];
    if (native) Document.prototype[name] = new Proxy(native, {
      apply: function (target, receiver, args) {
        var result = Reflect.apply(target, receiver, args);
        // Streaming writes can finish tags begun by other writes or the main parser.
        if (!unobservable) { unobservable = true; changed(); }
        return result;
      }
    });
  });
  [typeof Element === 'undefined' ? {} : Element.prototype,
    typeof ShadowRoot === 'undefined' ? {} : ShadowRoot.prototype
  ].forEach(function (prototype) {
    ['setHTMLUnsafe', 'setHTML'].forEach(function (name) {
      var native = prototype[name];
      if (native) prototype[name] = new Proxy(native, {
        apply: function (target, receiver, args) {
          var result = Reflect.apply(target, receiver, args);
          observe(receiver);
          visitShadowRoots(receiver, observeRoot);
          guardParsedRoots(args[0], name === 'setHTML');
          return result;
        }
      });
    });
    ['innerHTML', 'outerHTML'].forEach(function (name) {
      var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor && descriptor.set) Object.defineProperty(prototype, name, Object.assign({}, descriptor, {
        set: function (html) {
          // outerHTML removes the receiver, so retain its parent before the native replacement.
          var root = name === 'outerHTML' ? this.parentNode : this;
          Reflect.apply(descriptor.set, this, [html]);
          observe(root || this);
        }
      }));
    });
  });
  var insertAdjacentHTML = typeof Element !== 'undefined' && Element.prototype.insertAdjacentHTML;
  if (insertAdjacentHTML) Element.prototype.insertAdjacentHTML = new Proxy(insertAdjacentHTML, {
    apply: function (target, receiver, args) {
      var result = Reflect.apply(target, receiver, args);
      observe(receiver.parentNode || receiver);
      return result;
    }
  });
  function registerRoot(root) {
    if (!(root instanceof ShadowRoot)) return false;
    shadowRoots.set(root.host, observeRoot(root));
    return true;
  }
  // Upgrade reactions run after native cloning builds the root, even before the clone connects.
  if (typeof customElements !== 'undefined') customElements.define(rootMarkerName, class extends HTMLElement {
    constructor() {
      super();
      if (registerRoot(this.getRootNode())) this.remove();
    }
    connectedCallback() {
      if (cloneSeeds.has(this)) return;
      registerRoot(this.getRootNode());
      scanChildren();
      this.remove();
    }
  });
  var attachShadow = typeof Element !== 'undefined' && Element.prototype.attachShadow;
  if (attachShadow) Element.prototype.attachShadow = new Proxy(attachShadow, {
    apply: function (target, receiver, args) {
      var root = Reflect.apply(target, receiver, args);
      shadowRoots.set(receiver, root);
      return observeRoot(root);
    }
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
  function speechEnded(event) {
    ['start', 'pause', 'resume'].forEach(function (type) { event.target.removeEventListener(type, changed); });
    ['end', 'error'].forEach(function (type) { event.target.removeEventListener(type, speechEnded); });
    changed();
  }
  if (Synthesis) {
    Synthesis.prototype.speak = new Proxy(Synthesis.prototype.speak, {
      apply: function (target, receiver, args) {
        var result = Reflect.apply(target, receiver, args);
        if (receiver instanceof Synthesis) {
          synthesis = receiver;
          ['start', 'pause', 'resume'].forEach(function (type) { args[0].addEventListener(type, changed); });
          ['end', 'error'].forEach(function (type) { args[0].addEventListener(type, speechEnded); });
          changed();
        }
        return result;
      }
    });
    ['pause', 'resume', 'cancel'].forEach(function (method) {
      Synthesis.prototype[method] = new Proxy(Synthesis.prototype[method], {
        apply: function (target, receiver, args) {
          var result = Reflect.apply(target, receiver, args);
          if (receiver instanceof Synthesis) { synthesis = receiver; changed(); }
          return result;
        }
      });
    });
  }
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
        if (data.requestId === 0 || (child.pending && data.requestId === child.pending.id)) clearTimeout(child.recoveryTimer);
        if (child.pending) {
          if (data.requestId !== child.pending.id) {
            if (data.requestId === 0 && data.playing) { child.playing = true; report(); }
            return;
          }
          child.pending.finish(!data.playing);
        } else if (data.requestId !== 0) return;
        var wasPlaying = child.playing;
        child.playing = data.playing;
        if (!enabled && data.requestId === 0 && child.playing && !wasPlaying) pause();
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
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(function (records) {
    records.forEach(function (record) { record.addedNodes.forEach(observe); });
    scanChildren();
    });
  }
  observeRoot(document);
  scanChildren();
  report();
})(__DOCUMENT_ID__, __UNOBSERVABLE__);`;

export function mediaBridgeScript(documentId: string, unobservable = false): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) throw new Error('Invalid media document id');
  return `<script data-maic-media-document="${documentId}">${MEDIA_BRIDGE.replace('__UNOBSERVABLE__', unobservable ? 'true' : 'false').replace('__DOCUMENT_ID__', JSON.stringify(documentId))}</script>`;
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
  let disposed = false;
  let generation = ++nextMediaGeneration;
  let hasLoaded = false;
  let restoring = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let finishLoading: ((ready: boolean) => void) | undefined;
  const settleLoad = (ready: boolean) => {
    clearTimeout(recoveryTimer);
    finishLoading?.(ready);
    finishLoading = undefined;
  };
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
    if (pendingPause) {
      const promise = pendingPause.promise;
      sync();
      return promise;
    }
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
    if (data.requestId === 0 || data.requestId === pendingPause?.id) settleLoad(true);
    // A queued play report must not re-pause narration just resumed by the host.
    if (pendingPause) {
      if (data.requestId !== pendingPause.id) {
        return;
      }
      pendingPause.finish(!data.playing);
    } else if (data.requestId !== 0) return;
    const started = data.playing && !reportedPlaying;
    reportedPlaying = data.playing;
    if (data.playing) {
      if (enabled) onPlay();
      // A failed acknowledgement is a result, not a new play transition.
      else if (data.requestId === 0 && started) void pause();
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
      if (disposed) return Promise.resolve(false);
      settleLoad(false);
      generation = ++nextMediaGeneration;
      reportedPlaying = false;
      const restored = restoring;
      restoring = false;
      const source = frame.getAttribute('srcdoc');
      const loadGeneration = generation;
      const promise = new Promise<boolean>((resolve) => {
        finishLoading = resolve;
      });
      recoveryTimer = setTimeout(() => {
        if (disposed || generation !== loadGeneration) return;
        settleLoad(false);
        if (!restored && source && mediaDocumentId(source) === documentId) {
          if (!frame.isConnected || frame.getAttribute('srcdoc') !== source) return;
          if (enabled) onPlay();
          restoring = true;
          frame.srcdoc = source;
        }
      }, 1000);
      sync(nextEnabled);
      if (hasLoaded && !restored && enabled) onPlay();
      hasLoaded = true;
      return promise;
    },
    dispose() {
      disposed = true;
      settleLoad(false);
      pendingPause?.finish(false);
      post({ action: 'sync', enabled: false });
      window.removeEventListener('message', onMessage);
    },
  };
}
