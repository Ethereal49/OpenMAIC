import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import ts from 'typescript';
import { patchHtmlForIframe } from '../../lib/utils/iframe';

// Exercise the real iframe component and playback callbacks, isolating unrelated
// classroom UI, persistence and providers (as in interactive-observation-http).
function sourceFunction(path: string, name: string): string {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let result = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(file);
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      result = node.initializer.arguments[0].getText(file);
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === name &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    )
      result = node.initializer.expression.getText(file);
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === name)
      result = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!result) throw new Error(`Missing production function: ${name}`);
  return result;
}

function wav(): string {
  const bytes = Buffer.alloc(44 + 8000 * 20);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 44; i < bytes.length; i++)
    bytes[i] = 128 + Math.round(32 * Math.sin(((i - 44) * 2 * Math.PI * 440) / 8000));
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}
const audio = wav();
const activity = `<button id="audio" onclick="document.querySelector('audio').play()">Audio</button><audio src="${audio}" loop></audio>
<button id="video" onclick="document.querySelector('video').play()">Video</button><video src="${audio}" loop></video>
<button id="detached" onclick="detached.play()">Detached Audio</button>
<button id="autoplay" onclick="detached.autoplay=true;detached.src='${audio}'">Native autoplay</button>
<button id="context" onclick="playContext('oscillator',false)">WebAudio</button>
<button id="short-oscillator" onclick="playContext('oscillator',true)">Short oscillator</button>
<button id="short-buffer" onclick="playContext('buffer',true)">Short buffer</button>
<button id="silent" onclick="window.silentClicks=(window.silentClicks||0)+1">Silent button</button><input id="silent-key">
<form action="http://localhost/without-media-bridge"><button id="navigate">Navigate</button></form>
<script>window.playContext=(kind,short)=>{
  if(!window.ctx){window.ctx=new AudioContext();ctx.resume()}
  const source=kind==='buffer'?ctx.createBufferSource():ctx.createOscillator();
  if(kind==='buffer'){
    source.buffer=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*.1),ctx.sampleRate);
    const samples=source.buffer.getChannelData(0);
    for(let i=0;i<samples.length;i++)samples[i]=.25*Math.sin(i*2*Math.PI*440/ctx.sampleRate);
  }
  source.connect(ctx.destination);
  source.onended=()=>{window.sourceEnds=(window.sourceEnds||0)+1};
  window.sourceStarts=(window.sourceStarts||0)+1;
  if(kind==='buffer')source.start(0,0,.05);
  else {source.start();if(short)source.stop(ctx.currentTime+.05)}
};window.detached=new Audio(${JSON.stringify(audio)});detached.loop=true;window.explicitPlayCalls=0;const originalPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){explicitPlayCalls++;return originalPlay.apply(this,arguments)};</script>`;
const playbackPath = 'components/edit/PlaybackChromeRoot.tsx';
const hostPath = 'components/scene-renderers/InteractiveIframeHost.tsx';
function bundle(surface: 'app' | 'standalone'): string {
  return buildSync({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useCallback,useLayoutEffect,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createInteractiveMediaSession,mediaDocumentId,MEDIA_CONTROL} from './lib/interactive/media-bridge';
const NativeAudio=window.Audio;window.audios=[];window.Audio=function(...args){const a=new NativeAudio(...args);window.audios.push(a);return a;};
const html=${JSON.stringify(patchHtmlForIframe(activity, undefined, 'current'))};
${
  surface === 'standalone'
    ? `
import {usePlayback} from './lib/standalone-player/playback/use-playback';
import {InteractiveScene} from './lib/standalone-player/scenes/InteractiveScene';
const speech=[{id:'first',type:'speech',text:'First narration',audioRef:'narration'},{id:'second',type:'speech',text:'Second narration',audioRef:'narration'}];
const scenes=[{type:'interactive',order:0,actions:speech,content:{type:'interactive'}},{type:'interactive',order:1,actions:speech,content:{type:'interactive'}}];
function App(){const [index,setIndex]=useState(0);const p=usePlayback(scenes,index,setIndex);window.readingOnly=()=>speech.forEach(action=>delete action.audioRef);window.navigateScene=()=>setIndex(index?0:1);window.mode=()=>p.state.mode;window.caption=()=>p.state.view.caption;return <><button onClick={p.play}>Narrate</button><button onClick={p.pause}>Pause</button><button onClick={p.toggle}>Toggle</button><button onClick={()=>setIndex(index?0:1)}>Navigate scene</button>{index===0&&<InteractiveScene html={html} strings={{}} title="test" widgets={p.widgets}/>}</>}
`
    : `
import {PlaybackEngine} from './lib/playback/engine';
import {AudioPlayer} from './lib/utils/audio-player';
import {useWidgetIframeStore} from './lib/store/widget-iframe';
import {GENUI_LOGICAL_WIDTH,GENUI_LOGICAL_HEIGHT,fitGenUiViewport} from './lib/interactive/logical-viewport';
import {intersectClientBoxes} from './lib/edit/visible-client-rect';
const useI18n=()=>({t:k=>k});const useCanvasStore={use:{pickTarget:()=>null}};const useElementRefsStore={use:{refs:()=>[]}};
const runtime={errors:{},clearScene(){}};const useSceneRuntimeErrors=Object.assign(s=>s(runtime),{getState:()=>runtime});
const InteractiveRuntimeErrorBanner=()=>null;const resolveInteractivePickerMode=()=>null;const createObservationSession=()=>null;
${sourceFunction(hostPath, 'PooledIframe')}
const lectureSessionIdRef={current:'lecture'};const chatAreaRef={current:{pauseBuffer(){window.bufferPauses=(window.bufferPauses||0)+1}}};
const pauseInteractiveMedia=${sourceFunction(playbackPath, 'pauseInteractiveMedia')};
const scene={id:'s',actions:[{id:'first',type:'speech',text:'First narration',audioId:'first'},{id:'second',type:'speech',text:'Second narration',audioId:'second'}]};
window.readingOnly=()=>scene.actions.forEach(action=>delete action.audioId);window.deferRetainedFrame=()=>{const unregister=useWidgetIframeStore.getState().registerIframe('retained',()=>new Promise(resolve=>{window.releaseRetainedFrame=()=>{unregister();resolve(true)}}))};
const engine=new PlaybackEngine([scene],{clearEffects(){},execute(){}},new AudioPlayer(),{beforeSpeech:pauseInteractiveMedia,onSpeechStart:text=>window.speech=text});const engineRef={current:engine};
const onMediaPlay=${sourceFunction(playbackPath, 'pauseForInteractiveMedia')};window.mode=()=>engine.getMode();window.caption=()=>window.speech;
function App(){const [visible,setVisible]=useState(true);return <><button onClick={()=>engine.getMode()==='idle'?engine.start():engine.resume()}>Narrate</button><button onClick={()=>engine.pause()}>Pause</button><button onClick={()=>{engine.stop();setVisible(!visible)}}>Navigate scene</button><PooledIframe onMediaPlay={onMediaPlay} sceneId="s" entry={{srcDoc:html,rect:{left:0,top:100,width:1280,height:720},clip:{left:0,top:100,width:1280,height:720},owner:'o'}} visible={visible} playbackArmed={false}/></>}
`
}
window.narrating=()=>window.audios.some(a=>a.duration>10&&!a.paused&&a.currentTime>0);
createRoot(document.getElementById('app')).render(<App/>);
`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    alias:
      surface === 'app'
        ? {
            '@/lib/store/canvas': './e2e/fixtures/media-stubs.ts',
            '@/lib/store/settings': './e2e/fixtures/media-stubs.ts',
            '@/lib/audio/tts-selection': './e2e/fixtures/media-stubs.ts',
            '@/lib/media/resolve-audio-bytes': './e2e/fixtures/media-stubs.ts',
          }
        : {},
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.LOG_LEVEL': 'undefined',
      'process.env.LOG_FORMAT': 'undefined',
    },
  }).outputFiles[0].text;
}
async function narrate(page: Page) {
  await page.getByRole('button', { name: 'Narrate', exact: true }).click();
  await expect.poll(() => page.evaluate('narrating()')).toBe(true);
}
for (const surface of ['app', 'standalone'] as const) {
  test.describe(surface, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.route('http://localhost/narration.wav', (route) =>
        route.fulfill({
          contentType: 'audio/wav',
          body: Buffer.from(audio.split(',')[1], 'base64'),
        }),
      );
      await page.route(/^http:\/\/localhost\/without-media-bridge(?:\?.*)?$/, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p id="no-bridge">New document</p>' }),
      );
      await page.route('http://localhost/media-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>.relative{position:relative;width:1280px;height:720px}.absolute{position:absolute}.inset-0{inset:100px 0 0}</style></head><body><script id="openmaic-media" type="application/json">${JSON.stringify({ narration: { src: audio } })}</script><div id="app"></div></body></html>`,
        }),
      );
      await page.goto('http://localhost/media-test');
      await page.evaluate(`{
        window.holdPauseACK=false;
        window.addEventListener('message',event=>{
          if(window.holdPauseACK && event.data?.type==='maic:media:state:v1' && event.data.requestId>0){
            event.stopImmediatePropagation();
            window.releasePauseACK=()=>new Promise(resolve=>{
              window.holdPauseACK=false;
              const frame=document.querySelector('iframe');
              const accepted=answer=>{
                if(answer.source===frame.contentWindow && answer.data?.type===event.data.type && answer.data.requestId===event.data.requestId){window.removeEventListener('message',accepted);resolve();}
              };
              window.addEventListener('message',accepted);
              frame.contentWindow.postMessage({type:'maic:media:control:v1',documentId:event.data.documentId,generation:event.data.generation,action:'pause',requestId:event.data.requestId},'*');
            });
          }
        },true);
      }`);
      await page.addScriptTag({ content: bundle(surface) });
      await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
    });
    test('initializing an empty context leaves narration playing until its source starts', async ({
      page,
    }) => {
      await narrate(page);
      await page.evaluate(`{
        window.contextReady=false;
        window.addEventListener('message',event=>{
          if(event.data?.type==='test:context-ready')window.contextReady=true;
        });
      }`);
      const frame = page.frames()[1];
      await frame.evaluate(`{
        const init=document.createElement('button');init.id='init-only';init.textContent='Initialize context';
        init.onclick=async()=>{window.idleContext=new AudioContext();await idleContext.resume();parent.postMessage({type:'test:context-ready'},'*')};
        const sound=document.createElement('button');sound.id='start-idle';sound.textContent='Start sound';
        sound.onclick=()=>{const source=idleContext.createOscillator();source.connect(idleContext.destination);source.start()};
        document.body.prepend(init,sound);
      }`);
      await page.frameLocator('iframe').locator('#init-only').click();
      await expect.poll(() => page.evaluate('contextReady')).toBe(true);
      expect(await page.evaluate('mode()')).toBe('playing');
      expect(await page.evaluate('narrating()')).toBe(true);
      await page.frameLocator('iframe').locator('#start-idle').click();
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
    });
    test('persistent gain-only sources use explicit context resume', async ({ page }) => {
      await narrate(page);
      const frame = page.frames()[1];
      await frame.evaluate(`{
        const start=document.createElement('button');start.id='persistent-start';start.textContent='Start graph';
        start.onclick=()=>{
          window.persistent=new AudioContext();window.gain=persistent.createGain();gain.gain.value=0;
          const source=persistent.createOscillator();source.connect(gain);gain.connect(persistent.destination);source.start();window.sourceCount=1;
        };
        const volume=document.createElement('button');volume.id='gain-only';volume.textContent='Raise gain';volume.onclick=()=>{gain.gain.value=.2};
        const resume=document.createElement('button');resume.id='resume-graph';resume.textContent='Resume graph';resume.onclick=()=>persistent.resume();
        document.body.prepend(start,volume,resume);
      }`);
      await page.frameLocator('iframe').locator('#persistent-start').click();
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await narrate(page);
      expect(await frame.evaluate('persistent.state')).toBe('suspended');
      await page.frameLocator('iframe').locator('#gain-only').click();
      expect(await frame.evaluate('persistent.state')).toBe('suspended');
      expect(await page.evaluate('narrating()')).toBe(true);
      await page.frameLocator('iframe').locator('#resume-graph').click();
      await expect.poll(() => frame.evaluate('persistent.state')).toBe('running');
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      expect(await frame.evaluate('sourceCount')).toBe(1);
    });
    test('holds reading progress when frame media starts during resume', async ({ page }) => {
      await page.evaluate('readingOnly()');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('caption()')).toBe('First narration');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      expect(await page.evaluate('mode()')).toBe('paused');
      await page.evaluate(`{
        window.silentACK=false;window.mediaStarted=false;
        window.addEventListener('message',event=>{
          if(event.data?.type!=='maic:media:state:v1')return;
          if(event.data.requestId>0&&event.data.playing===false)window.silentACK=true;
          if(event.data.requestId===0&&event.data.playing===true)window.mediaStarted=true;
        });
        ${surface === 'app' ? 'deferRetainedFrame();' : ''}
      }`);
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('silentACK')).toBe(true);
      await page.frameLocator('iframe').locator('#audio').click();
      await expect.poll(() => page.evaluate('mediaStarted')).toBe(true);
      if (surface === 'app') await page.evaluate('releaseRetainedFrame()');
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.waitForTimeout(2200);
      expect(await page.evaluate('caption()')).toBe('First narration');
      if (surface === 'app') expect(await page.evaluate('bufferPauses')).toBe(1);
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
    });
    for (const kind of ['audio', 'video', 'detached', 'autoplay', 'context']) {
      test(`coordinates ${kind} with real narration in both directions`, async ({ page }) => {
        await narrate(page);
        const frame = page.frames()[1];
        await page
          .frameLocator('iframe')
          .locator('#' + kind)
          .click();
        const active =
          kind === 'context'
            ? 'ctx.state === "running"'
            : kind === 'detached' || kind === 'autoplay'
              ? '!detached.paused'
              : `!document.querySelector('${kind}').paused`;
        await expect.poll(() => frame.evaluate(active)).toBe(true);
        if (kind === 'autoplay') expect(await frame.evaluate('explicitPlayCalls')).toBe(0);
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect.poll(() => page.evaluate('narrating()')).toBe(false);
        await narrate(page);
        await expect
          .poll(() =>
            frame.evaluate(
              kind === 'context'
                ? 'ctx.state'
                : kind === 'detached' || kind === 'autoplay'
                  ? 'detached.paused'
                  : `document.querySelector('${kind}').paused`,
            ),
          )
          .toBe(kind === 'context' ? 'suspended' : true);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await narrate(page);
        expect(await frame.evaluate(active)).toBe(false);
      });
    }
    for (const factory of [true, false]) {
      test(`restores already-playing media connected through ${factory ? 'factory' : 'constructor'}`, async ({
        page,
      }) => {
        const frame = page.frames()[1];
        await page.frameLocator('iframe').locator('#context').click();
        await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
        await narrate(page);
        await expect.poll(() => frame.evaluate('ctx.state')).toBe('suspended');
        await frame.evaluate(`
          document.getElementById('audio').onclick=async()=>{
            const element=document.querySelector('audio');
            await element.play();
            window.playedBeforeConnect=!element.paused;
            window.stateBeforeConnect=ctx.state;
            const source=${factory ? 'ctx.createMediaElementSource(element)' : 'new MediaElementAudioSourceNode(ctx,{mediaElement:element})'};
            source.connect(ctx.destination);
          };
        `);
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => frame.evaluate('window.playedBeforeConnect')).toBe(true);
        expect(await frame.evaluate('window.stateBeforeConnect')).toBe('suspended');
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      });
    }
    for (const kind of ['audio', 'video', 'detached']) {
      for (const factory of [true, false]) {
        test(`restores routed ${kind} through ${factory ? 'factory' : 'constructor'} on playback`, async ({
          page,
        }) => {
          const frame = page.frames()[1];
          await frame.evaluate(`{
            const element=${kind === 'detached' ? 'detached' : `document.querySelector('${kind}')`};
            document.getElementById('${kind}').onclick=()=>{
              if(!window.routedContext){
                window.routedContext=new AudioContext();
                const source=${factory ? 'routedContext.createMediaElementSource(element)' : 'new MediaElementAudioSourceNode(routedContext,{mediaElement:element})'};
                source.connect(routedContext.destination);
              }
              element.play();
            };
          }`);
          await narrate(page);
          await page
            .frameLocator('iframe')
            .locator('#' + kind)
            .click();
          await expect.poll(() => frame.evaluate('routedContext.state')).toBe('running');
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          await narrate(page);
          expect(await frame.evaluate('routedContext.state')).toBe('suspended');
          await page.frameLocator('iframe').locator('#silent').click();
          expect(await frame.evaluate('routedContext.state')).toBe('suspended');
          expect(await page.evaluate('narrating()')).toBe(true);
          await page
            .frameLocator('iframe')
            .locator('#' + kind)
            .click();
          await expect.poll(() => frame.evaluate('routedContext.state')).toBe('running');
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        });
      }
    }
    test('resumes bridge-suspended WebAudio only when a new source starts', async ({ page }) => {
      await page.frameLocator('iframe').locator('#context').click();
      const frame = page.frames()[1];
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await narrate(page);
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('suspended');
      // The authored handler creates once and has no resume call on subsequent clicks.
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await frame.evaluate('ctx.suspend()');
      await page.frameLocator('iframe').locator('#context').click();
      expect(await frame.evaluate('ctx.state')).toBe('suspended');
    });
    test('retries a rejected automatic WebAudio resume on the next playback click', async ({
      page,
    }) => {
      const frame = page.frames()[1];
      // Inject one rejection while retaining native context state and subsequent resumes.
      await frame.evaluate(`
        const nativeResume=AudioContext.prototype.resume;
        window.resumeAttempts=0;
        AudioContext.prototype.resume=function(){
          resumeAttempts++;
          if(window.rejectNextResume){
            window.rejectNextResume=false;
            return Promise.reject(new Error('Injected resume rejection'));
          }
          return nativeResume.apply(this,arguments);
        };
      `);
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await narrate(page);
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('suspended');
      await frame.evaluate('window.rejectNextResume=true');
      await page.frameLocator('iframe').locator('#context').click();
      expect(await frame.evaluate('resumeAttempts')).toBe(2);
      expect(await frame.evaluate('ctx.state')).toBe('suspended');
      expect(await page.evaluate('narrating()')).toBe(true);
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      expect(await frame.evaluate('resumeAttempts')).toBe(3);
    });
    test('blocks narration when WebAudio restarts during a delayed pause acknowledgement', async ({
      page,
    }) => {
      const frame = page.frames()[1];
      // Drop initial play reports, then deliver real reports during an intentionally delayed suspend.
      await page.evaluate(`
        window.allowPlayReports=false;window.pendingPlayReports=0;
        window.addEventListener('message',event=>{
          if(event.data?.type!=='maic:media:state:v1'||event.data.requestId!==0||!event.data.playing)return;
          if(!window.allowPlayReports)event.stopImmediatePropagation();
          else window.pendingPlayReports++;
        },true);
      `);
      await frame.evaluate(`
        const nativeSuspend=AudioContext.prototype.suspend;
        AudioContext.prototype.suspend=function(){
          if(!window.delaySuspend)return nativeSuspend.call(this);
          return new Promise(resolve=>{window.releaseSuspend=()=>nativeSuspend.call(this).then(resolve)});
        };
      `);
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await frame.evaluate('window.delaySuspend=true');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await frame.waitForFunction("typeof window.releaseSuspend==='function'");
      await page.evaluate('window.allowPlayReports=true');
      await frame.evaluate("playContext('oscillator',false)");
      await page.waitForFunction('window.pendingPlayReports>0');
      // Let the real one-second timeout expire; standalone has not started its controller yet.
      await page.waitForTimeout(1100);
      expect(await page.evaluate('mode()')).toBe(surface === 'app' ? 'paused' : 'idle');
      expect(await frame.evaluate('ctx.state')).toBe('running');
      expect(await page.evaluate('narrating()')).toBe(false);
      await frame.evaluate('window.delaySuspend=false;window.releaseSuspend()');
      await narrate(page);
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('suspended');
    });
    for (const kind of ['oscillator', 'buffer']) {
      test(`silent input after a short ${kind} does not interrupt narration`, async ({ page }) => {
        await narrate(page);
        const frame = page.frames()[1];
        await page
          .frameLocator('iframe')
          .locator('#short-' + kind)
          .click();
        await frame.waitForFunction('window.sourceEnds===1');
        // A finished source leaves a native context running; state alone is not audible output.
        expect(await frame.evaluate('ctx.state')).toBe('running');
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await narrate(page);
        expect(await frame.evaluate('ctx.state')).toBe('suspended');
        await page.frameLocator('iframe').locator('#silent').click();
        expect(await frame.evaluate('ctx.state')).toBe('suspended');
        expect(await page.evaluate('narrating()')).toBe(true);
        await page.frameLocator('iframe').locator('#silent-key').press('a');
        expect(await frame.evaluate('ctx.state')).toBe('suspended');
        expect(await frame.evaluate('sourceStarts')).toBe(1);
        expect(await page.evaluate('narrating()')).toBe(true);
        await page
          .frameLocator('iframe')
          .locator('#short-' + kind)
          .click();
        await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      });
    }
    test('fails open after self-navigation and continues later lines without restoring srcdoc', async ({
      page,
    }) => {
      await page.frameLocator('iframe').locator('#context').click();
      const frame = page.frames()[1];
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await page.frameLocator('iframe').locator('#navigate').click();
      await expect(page.frameLocator('iframe').locator('#no-bridge')).toBeVisible();
      await narrate(page);
      await page.evaluate('audios[0].pause();audios[0].dispatchEvent(new Event("ended"))');
      await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
      await expect.poll(() => page.evaluate('narrating()')).toBe(true);
      await expect(page.frameLocator('iframe').locator('#no-bridge')).toBeVisible();
    });
    test('silences media on scene navigation, including a retained hidden app frame', async ({
      page,
    }) => {
      await page.frameLocator('iframe').locator('#context').click();
      const frame = page.frames()[1];
      await expect.poll(() => frame.evaluate('ctx.state')).toBe('running');
      await page.getByRole('button', { name: 'Navigate scene', exact: true }).click();
      if (surface === 'app') await expect.poll(() => frame.evaluate('ctx.state')).toBe('suspended');
      else await expect.poll(() => frame.isDetached()).toBe(true);
      await narrate(page);
      if (surface === 'app') {
        await frame.evaluate('ctx.resume()');
        await expect.poll(() => frame.evaluate('ctx.state')).toBe('suspended');
        await expect.poll(() => page.evaluate('narrating()')).toBe(true);
      }
    });
    if (surface === 'standalone')
      test('continues narration after navigating away during a pending silence acknowledgement', async ({
        page,
      }) => {
        await narrate(page);
        const frame = page.frames()[1];
        // End the first fixture clip explicitly, holding the next speech's ACK.
        await page.evaluate(
          'window.holdPauseACK=true;audios[0].pause();audios[0].dispatchEvent(new Event("ended"))',
        );
        await expect.poll(() => page.evaluate('typeof releasePauseACK')).toBe('function');
        // Navigate outside a discrete React event so passive effects can be deferred.
        await page.evaluate('navigateScene()');
        await expect.poll(() => frame.isDetached()).toBe(true);
        await expect.poll(() => page.evaluate('caption()')).toBe('First narration');
        await expect.poll(() => page.evaluate('mode()')).toBe('playing');
        await expect.poll(() => page.evaluate('narrating()')).toBe(true);
      });
    if (surface === 'standalone')
      test('a second toggle cancels the pending silence acknowledgement', async ({ page }) => {
        await page.evaluate('window.holdPauseACK=true');
        await page.getByRole('button', { name: 'Toggle', exact: true }).click();
        await expect.poll(() => page.evaluate('typeof releasePauseACK')).toBe('function');
        expect(await page.evaluate('mode()')).toBe('idle');
        await page.getByRole('button', { name: 'Toggle', exact: true }).click();
        await page.evaluate('(async()=>{await releasePauseACK();await Promise.resolve();})()');
        expect(await page.evaluate('mode()')).toBe('idle');
        expect(await page.evaluate('narrating()')).toBe(false);
      });
    if (surface === 'app') {
      test('resumes reading after narration decode failure and a frame-media pause', async ({
        page,
      }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.route('http://localhost/narration.wav', (route) =>
          route.fulfill({ contentType: 'audio/wav', body: 'invalid narration bytes' }),
        );
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('audios.some(audio=>audio.error!==null)')).toBe(true);
        expect(pageErrors).toEqual([]);
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
        expect(pageErrors).toEqual([]);
      });

      test('cancels a loading real AudioPlayer clip when frame media starts', async ({ page }) => {
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        let requested = false;
        await page.route('http://localhost/narration.wav', async (route) => {
          requested = true;
          await waiting;
          await route.fulfill({
            contentType: 'audio/wav',
            body: Buffer.from(audio.split(',')[1], 'base64'),
          });
        });
        try {
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect.poll(() => requested).toBe(true);
          await page.frameLocator('iframe').locator('#audio').click();
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          release();
          await expect.poll(() => page.evaluate('narrating()')).toBe(false);
          await narrate(page);
          expect(await page.evaluate('caption()')).toBe('First narration');
        } finally {
          release();
        }
      });
    }
  });
}
