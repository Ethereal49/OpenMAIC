import { expect, test } from '@playwright/test';
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
const activity = `<button id="audio" onclick="document.querySelector('audio').play()">Frame audio</button><audio id="a" src="${audio}" loop></audio>
<button id="video" onclick="document.querySelector('video').play()">Frame video</button><video id="v" src="${audio}" loop></video>
<button id="detached" onclick="detached.play()">Detached audio</button>
<button id="context" onclick="if(!window.ctx){ctx=new AudioContext();let o=ctx.createOscillator();o.connect(ctx.destination);o.start()}ctx.resume()">WebAudio</button>
<script>window.detached=new Audio(${JSON.stringify(audio)});detached.loop=true;</script>`;
const hostPath = 'components/scene-renderers/InteractiveIframeHost.tsx';
const playbackPath = 'components/edit/PlaybackChromeRoot.tsx';

function bundle(surface: 'app' | 'standalone'): string {
  return buildSync({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useCallback,useLayoutEffect,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {patchHtmlForIframe} from './lib/utils/iframe';
import {createInteractiveMediaSession,mediaDocumentId,MEDIA_CONTROL} from './lib/interactive/media-bridge';
const NativeAudio=window.Audio;window.audios=[];window.Audio=function(...args){const a=new NativeAudio(...args);window.audios.push(a);return a;};
const html=${JSON.stringify(patchHtmlForIframe(activity, undefined, 'current'))};
${
  surface === 'standalone'
    ? `
import {usePlayback} from './lib/standalone-player/playback/use-playback';
import {InteractiveScene} from './lib/standalone-player/scenes/InteractiveScene';
const scenes=[{type:'interactive',order:0,actions:[{id:'speech',type:'speech',text:'Narration',audioRef:'narration'}],content:{type:'interactive'}},{type:'interactive',order:1,actions:[],content:{type:'interactive'}}];
function App(){const [index,setIndex]=useState(0);const p=usePlayback(scenes,index,setIndex);window.mode=()=>p.state.mode;
return <><button onClick={p.play}>Narrate</button><button onClick={p.pause}>Pause</button><button onClick={()=>setIndex(index?0:1)}>Navigate</button>{index===0&&<InteractiveScene html={html} strings={{}} title="test" widgets={p.widgets}/>}</>}
`
    : `
import {PlaybackEngine} from './lib/playback/engine';
import {useWidgetIframeStore} from './lib/store/widget-iframe';
import {GENUI_LOGICAL_WIDTH,GENUI_LOGICAL_HEIGHT,fitGenUiViewport} from './lib/interactive/logical-viewport';
import {intersectClientBoxes} from './lib/edit/visible-client-rect';
const useI18n=()=>({t:k=>k});const useCanvasStore={use:{pickTarget:()=>null}};const useElementRefsStore={use:{refs:()=>[]}};
const runtime={errors:{},clearScene(){}};const useSceneRuntimeErrors=Object.assign(s=>s(runtime),{getState:()=>runtime});
const InteractiveRuntimeErrorBanner=()=>null;const resolveInteractivePickerMode=()=>null;const createObservationSession=()=>null;
${sourceFunction(hostPath, 'PooledIframe')}
const n=new Audio(${JSON.stringify(audio)});n.loop=true;
const currentScene={id:'s',type:'interactive',actions:[{id:'speech',type:'speech',text:'Narration',audioId:'narration'}],content:{type:'interactive'}};
const setEngineMode=()=>{};const lectureSessionIdRef={current:null};const chatAreaRef={current:null};const discussionTTS={pause(){}};const setIsDiscussionPaused=()=>{};
const engineRef={current:new PlaybackEngine([currentScene],{clearEffects(){},execute(){}},{play:async()=>{await n.play();return true},pause:()=>n.pause(),resume:()=>n.play(),stop:()=>n.pause(),isPlaying:()=>!n.paused,hasActiveAudio:()=>true,onEnded(){}},{beforeSpeech:async()=> (await useWidgetIframeStore.getState().sendMessageByScene.s?.(MEDIA_CONTROL,{}))!==false,onModeChange:${sourceFunction(playbackPath, 'onModeChange')}})};
const onMediaPlay=${sourceFunction(playbackPath, 'pauseForInteractiveMedia')};window.mode=()=>engineRef.current.getMode();
function App(){const [visible,setVisible]=useState(true);return <><button onClick={()=>engineRef.current.getMode()==='idle'?engineRef.current.start():engineRef.current.resume()}>Narrate</button><button onClick={()=>engineRef.current.pause()}>Pause</button><button onClick={()=>{engineRef.current.stop();setVisible(!visible)}}>Navigate</button><PooledIframe onMediaPlay={onMediaPlay} sceneId="s" entry={{srcDoc:html,rect:{left:0,top:100,width:1280,height:720},clip:{left:0,top:100,width:1280,height:720},owner:'o'}} visible={visible} playbackArmed={false}/></>}
`
}
window.narrationPaused=()=>window.audios[0].paused;
createRoot(document.getElementById('app')).render(<App/>);
`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    // Isolate only the engine's unrelated presentation/settings dependencies.
    alias:
      surface === 'app'
        ? {
            '@/lib/store/canvas': './e2e/fixtures/media-stubs.ts',
            '@/lib/store/settings': './e2e/fixtures/media-stubs.ts',
            '@/lib/audio/tts-selection': './e2e/fixtures/media-stubs.ts',
          }
        : {},
    define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text;
}

for (const surface of ['app', 'standalone'] as const) {
  test.describe(surface, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.route('http://localhost/media-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>.relative{position:relative;width:1280px;height:720px}.absolute{position:absolute}.inset-0{inset:100px 0 0}</style></head><body><script id="openmaic-media" type="application/json">${JSON.stringify({ narration: { src: audio } })}</script><div id="app"></div></body></html>`,
        }),
      );
      await page.goto('http://localhost/media-test');
      await page.addScriptTag({ content: bundle(surface) });
      await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
    });

    for (const media of ['audio', 'video', 'detached', 'context']) {
      test(`${media} pauses narration; resuming narration pauses frame media`, async ({ page }) => {
        const frame = page.frameLocator('iframe');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await frame.locator(`#${media}`).click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
        const state = () =>
          page
            .frames()[1]
            .evaluate(
              (media) =>
                media === 'context'
                  ? (window as unknown as { ctx: AudioContext }).ctx.state
                  : media === 'detached'
                    ? (window as unknown as { detached: HTMLAudioElement }).detached.paused
                    : (document.querySelector(media) as HTMLMediaElement).paused,
              media,
            );
        await expect.poll(state).toBe(media === 'context' ? 'running' : false);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(state).toBe(media === 'context' ? 'suspended' : true);
        await expect.poll(() => page.evaluate('mode()')).toBe('playing');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await expect.poll(state).toBe(media === 'context' ? 'suspended' : true);
      });
    }

    test('waits for asynchronous WebAudio silence before resuming narration', async ({ page }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
      const child = page.frames()[1];
      await child.evaluate(() => {
        const w = window as unknown as { ctx: AudioContext; releaseSuspension: () => void };
        const suspend = w.ctx.suspend.bind(w.ctx);
        w.ctx.suspend = () =>
          new Promise<void>((resolve) => {
            w.releaseSuspension = () => {
              void suspend().then(resolve);
            };
          });
      });
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect
        .poll(() =>
          child.evaluate(
            () => typeof (window as unknown as { releaseSuspension?: unknown }).releaseSuspension,
          ),
        )
        .toBe('function');
      expect(await page.evaluate('narrationPaused()')).toBe(true);
      expect(
        await child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state),
      ).toBe('running');
      await child.evaluate(() =>
        (window as unknown as { releaseSuspension: () => void }).releaseSuspension(),
      );
      await expect
        .poll(() => child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state))
        .toBe('suspended');
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
    });

    test('navigation silences the old frame and leaves it paused on return', async ({ page }) => {
      await page.frameLocator('iframe').locator('#audio').click();
      const old = page.frames()[1];
      await page.getByRole('button', { name: 'Navigate', exact: true }).click();
      if (surface === 'app') {
        await expect
          .poll(() => old.locator('audio').evaluate((x: HTMLAudioElement) => x.paused))
          .toBe(true);
        // A hidden keep-alive page trying to restart itself must stay silent.
        await old.locator('audio').evaluate((x: HTMLAudioElement) => x.play().catch(() => {}));
        await expect
          .poll(() => old.locator('audio').evaluate((x: HTMLAudioElement) => x.paused))
          .toBe(true);
      } else await expect.poll(() => old.isDetached()).toBe(true);
      await page.getByRole('button', { name: 'Navigate', exact: true }).click();
      await expect
        .poll(() =>
          page
            .frames()[1]
            .locator('audio')
            .evaluate((x: HTMLAudioElement) => x.paused),
        )
        .toBe(true);
    });

    test('ignores spoofed/stale messages and keeps an opaque origin', async ({ page }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await page.evaluate(() =>
        window.postMessage(
          { type: 'maic:media:state:v1', documentId: 'current', playing: true },
          '*',
        ),
      );
      await page.frames()[1].evaluate(() => {
        parent.postMessage({ type: 'maic:media:state:v1', documentId: 'old', playing: true }, '*');
        parent.postMessage(
          { type: 'maic:media:state:v1', documentId: 'current', playing: 'true' },
          '*',
        );
      });
      await expect.poll(() => page.evaluate('mode()')).toBe('playing');
      expect(await page.locator('iframe').getAttribute('sandbox')).not.toContain(
        'allow-same-origin',
      );
      expect(
        await page.frames()[1].evaluate(() => {
          try {
            void parent.document.body;
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
    });
  });
}
