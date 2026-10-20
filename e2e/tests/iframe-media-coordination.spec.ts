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
<button id="context" onclick="if(!window.ctx){ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()}">WebAudio</button>
<form action="http://localhost/without-media-bridge"><button id="navigate">Navigate</button></form>
<script>window.detached=new Audio(${JSON.stringify(audio)});detached.loop=true;window.explicitPlayCalls=0;const originalPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){explicitPlayCalls++;return originalPlay.apply(this,arguments)};</script>`;
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
function App(){const [index,setIndex]=useState(0);const p=usePlayback(scenes,index,setIndex);window.mode=()=>p.state.mode;window.caption=()=>p.state.view.caption;return <><button onClick={p.play}>Narrate</button><button onClick={p.pause}>Pause</button><button onClick={p.toggle}>Toggle</button><button onClick={()=>setIndex(index?0:1)}>Navigate scene</button>{index===0&&<InteractiveScene html={html} strings={{}} title="test" widgets={p.widgets}/>}</>}
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
const lectureSessionIdRef={current:null};const chatAreaRef={current:null};
const pauseInteractiveMedia=${sourceFunction(playbackPath, 'pauseInteractiveMedia')};
const scene={id:'s',actions:[{id:'first',type:'speech',text:'First narration',audioId:'first'},{id:'second',type:'speech',text:'Second narration',audioId:'second'}]};
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
    define: { 'process.env.NODE_ENV': '"production"' },
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
    test('resumes bridge-suspended WebAudio on a fresh trusted frame gesture', async ({ page }) => {
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
    if (surface === 'app')
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
  });
}
