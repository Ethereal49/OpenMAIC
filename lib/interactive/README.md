# Interactive media coordination

The classroom and standalone player coordinate media in the injected main document.
Successful scheduled-source `start()` calls and HTML media `play` events signal
playback. Initializing or unlocking an `AudioContext` before a source has started
does not interrupt narration.

Narration pauses frame media and suspends active WebAudio contexts. Only a context
suspended by the bridge is restored automatically on a new source start or routed
media playback; authored `suspend()` and `close()` remain under page control.

A persistent source started once and subsequently controlled only by gain is not
automatically restored by gain changes. Its actual Play control should explicitly
resume the context before raising gain:

```js
await context.resume();
gain.gain.value = 0.2;
```

The bridge observes playback intent, not acoustic output: starting a source at
zero gain still counts as playback. It does not inspect the audio graph or monitor
`AudioParam` automation. Silent initialization and volume adjustments therefore
do not act as implicit resume gestures.

These cooperative signals do not replace the iframe's opaque sandbox or CSP.
