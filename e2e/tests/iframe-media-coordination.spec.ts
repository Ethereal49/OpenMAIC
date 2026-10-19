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
// Model a temporarily unresponsive frame before its bridge receives commands.
const dropControls = `<script>const add=window.addEventListener;window.addEventListener=function(type,listener,options){if(type==='message'){add.call(this,type,function(event){if(window.blockMediaControls&&event.data?.type==='maic:media:control:v1'){if(event.data.action==='pause')window.blockedPauses=(window.blockedPauses||0)+1;if(window.playOnBlockedPause&&event.data.action==='pause')document.querySelector('audio').play();return}listener.call(this,event)},options);window.addEventListener=add}else add.call(this,type,listener,options)};</script>`;
const escapeAttribute = (html: string) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const nestedMedia = `<button id="audio" onclick="document.querySelector('audio').play()">Nested audio</button><audio preload="none" src="${audio}" loop></audio><button id="video" onclick="document.querySelector('video').play()">Nested video</button><video preload="none" src="${audio}" loop></video>
<button id="context" onclick="if(!window.ctx){ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start()}ctx.resume()">Nested context</button><form action="http://localhost/without-media-bridge"><button id="navigate-nested">Navigate nested</button></form>`;
const activity = `<button id="audio" onclick="document.querySelector('audio').play()">Frame audio</button><audio id="a" src="${audio}" loop></audio>
<button id="synthesis" onclick="window.utterance=new SpeechSynthesisUtterance('This is a native interactive speech activity. '.repeat(30));utterance.onstart=()=>window.synthesisStarted=true;speechSynthesis.speak(utterance)">Frame synthesis</button>
<button id="video" onclick="document.querySelector('video').play()">Frame video</button><video id="v" src="${audio}" loop></video>
<button id="detached" onclick="detached.play()">Detached audio</button>
<button id="autoplay" onclick="startAutoplay()">Detached autoplay</button>
<button id="autoplay-createElement-audio" onclick="startAutoplay('audio','createElement')">DOM audio</button>
<button id="autoplay-createElement-video" onclick="startAutoplay('video','createElement')">DOM video</button>
<button id="autoplay-createElementNS-audio" onclick="startAutoplay('audio','createElementNS')">DOM NS audio</button>
<button id="autoplay-createElementNS-video" onclick="startAutoplay('video','createElementNS')">DOM NS video</button>
${['setHTML', 'setHTMLUnsafe', 'cloneContents', 'insertAdjacentHTML', 'outerHTML', 'parser-first', 'parser', 'cloneNode', 'importNode', 'createContextualFragment', 'innerHTML'].flatMap((method) => ['audio', 'video'].map((tag) => `<button id="autoplay-${method}-${tag}" onclick="startAutoplay('${tag}','${method}')">${method} ${tag}</button>`)).join('')}
<button id="context" onclick="if(!window.ctx){ctx=new AudioContext();let o=ctx.createOscillator();o.connect(ctx.destination);o.start()}ctx.resume()">WebAudio</button>
${['audio', 'video'].map((tag) => `<button id="prime-parser-${tag}" onclick="primeParserMedia('${tag}')">Prime parser ${tag}</button><${tag} id="parser-${tag}" src="${audio}" loop></${tag}>`).join('')}
<audio id="unplayed-audio" loop></audio><video id="unplayed-video" loop></video><script>window.unplayed={audio:document.getElementById('unplayed-audio'),video:document.getElementById('unplayed-video')};unplayed.audio.remove();unplayed.video.remove();</script>
<button id="reuse-context" onclick="if(!window.ctx){ctx=new AudioContext();let o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()}">Reuse WebAudio</button>
<iframe id="nested" style="display:none" srcdoc="${escapeAttribute(`<iframe id="inner" srcdoc="${escapeAttribute(nestedMedia)}"></iframe>`)}"></iframe>
<form action="http://localhost/without-media-bridge"><button id="self-navigate">Navigate frame</button></form>
<script>window.detached=new Audio(${JSON.stringify(audio)});detached.loop=true;
window.widgetValues=[];window.addEventListener('message',event=>{if(event.data?.type==='SET_WIDGET_STATE')widgetValues.push(event.data.value)});window.autoplayEvents=0;window.explicitPlayCalls=0;window.primeParserMedia=async(tag)=>{window.parserMedia=document.getElementById('parser-'+tag);parserMedia.src=${JSON.stringify(audio)};await parserMedia.play();parserMedia.pause();parserMedia.remove();window.parserPrimed=true};
window.startAutoplay=(tag,method)=>{if(!window.autoplayAudio){const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){window.explicitPlayCalls++;return play.apply(this,arguments)};const original=tag?document.createElement(tag):null;let parsed;if(method==='innerHTML'||method==='insertAdjacentHTML'||method==='outerHTML'||(method==='setHTMLUnsafe'||method==='setHTML')||method==='cloneContents'){const container=document.createElement('div');if((method==='setHTMLUnsafe'||method==='setHTML'))container[method]('<'+tag+'></'+tag+'>');else if(method==='innerHTML'||method==='cloneContents')container.innerHTML='<'+tag+'></'+tag+'>';else if(method==='outerHTML'){container.append(document.createElement('span'));container.firstChild.outerHTML='<'+tag+'></'+tag+'>'}else container.insertAdjacentHTML('beforeend','<'+tag+'></'+tag+'>');if(method==='cloneContents'){const range=document.createRange();range.selectNodeContents(container);parsed=range.cloneContents().firstChild}else parsed=container.firstChild;}window.autoplayAudio=method==='parser-first'?window.unplayed[tag]:method==='parser'?window.parserMedia:!tag?new Audio():(method==='innerHTML'||method==='insertAdjacentHTML'||method==='outerHTML'||(method==='setHTMLUnsafe'||method==='setHTML')||method==='cloneContents')?parsed:method==='cloneNode'?original.cloneNode(true):method==='importNode'?document.importNode(original,true):method==='createContextualFragment'?document.createRange().createContextualFragment('<'+tag+'></'+tag+'>').firstChild:method==='createElementNS'?document.createElementNS('http://www.w3.org/1999/xhtml',tag):original;if(tag==='video')autoplayAudio.playsInline=true;autoplayAudio.addEventListener('playing',()=>{window.autoplayEvents++;document.body.dataset.autoplayPlaying='true'});['pause','ended','emptied'].forEach(type=>autoplayAudio.addEventListener(type,()=>document.body.dataset.autoplayPlaying='false'));autoplayAudio.autoplay=true;}autoplayAudio.src=${JSON.stringify(audio)};};</script>`;
type DeclarativeFixture = {
  kind: 'audio' | 'video' | 'iframe' | 'raw';
  mode: 'open' | 'closed';
  scoped?: boolean;
  clonable?: boolean;
  stream?: 'write' | 'writeln' | 'split';
};
function declarativeActivity({
  kind,
  mode,
  scoped = false,
  clonable = false,
  stream,
}: DeclarativeFixture): string {
  const content =
    kind === 'iframe'
      ? `<iframe name="declarative-child" srcdoc="${escapeAttribute(nestedMedia)}"></iframe>`
      : kind === 'raw'
        ? '<iframe name="declarative-raw" title="Declarative activity" sandbox="allow-scripts" src="http://external.test/declarative"></iframe>'
        : `<${kind} id="declarative-media" autoplay loop playsinline></${kind}>`;
  const markup = `<div id="declarative-host"><template shadowrootmode="${mode}"${scoped ? ' shadowrootcustomelementregistry' : ''}${clonable ? ' shadowrootclonable' : ''}><div><template shadowrootmode="${mode}"${scoped ? ' shadowrootcustomelementregistry' : ''}${clonable ? ' shadowrootclonable' : ''}>${scoped ? '<svg onload="window.declarativeRoot=this.getRootNode();this.remove()"></svg>' : '<native-dsd-probe></native-dsd-probe>'}${content}</template></div></template></div>`;
  const cut = markup.indexOf('shadowrootmode') + 6;
  const emitted = !stream
    ? markup
    : `<script>${stream === 'split' ? `document.write(${JSON.stringify(markup.slice(0, cut))});document.write(${JSON.stringify(markup.slice(cut))});` : `document.${stream}(${JSON.stringify(markup)});`}</script>`;
  return `<script>
window.nativeAttachCalls=0;const nativeAttach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(){nativeAttachCalls++;return nativeAttach.apply(this,arguments)};
window.declarativePlayCalls=0;const nativePlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){declarativePlayCalls++;return nativePlay.apply(this,arguments)};
window.documentPlayEvents=0;document.addEventListener('play',()=>documentPlayEvents++,true);
customElements.define('native-dsd-probe',class extends HTMLElement{constructor(){super();const root=this.getRootNode();if(root instanceof ShadowRoot)window.clonedRoot=root}connectedCallback(){window.declarativeRoot=this.getRootNode();if(declarativeRoot.clonable)this.hidden=true;else this.remove()}});
</script>${emitted}
<button id="start-declarative" onclick="declarativeRoot.querySelector('audio,video').src=${escapeAttribute(JSON.stringify(audio))}">Start declarative autoplay</button>`;
}
const hostPath = 'components/scene-renderers/InteractiveIframeHost.tsx';
const playbackPath = 'components/edit/PlaybackChromeRoot.tsx';

function bundle(
  surface: 'app' | 'standalone',
  restart = false,
  url = false,
  untrusted?: 'audio' | 'video' | 'url',
  declarative?: DeclarativeFixture,
): string {
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
const NativeAudio=window.Audio;window.audios=[];document.body.dataset.narrationPlaying='false';window.Audio=function(...args){const a=new NativeAudio(...args);if(!window.audios.length)['playing','pause','ended','emptied'].forEach(type=>a.addEventListener(type,()=>document.body.dataset.narrationPlaying=String(type==='playing')));window.audios.push(a);return a;};
const html=${JSON.stringify(patchHtmlForIframe(activity + (declarative ? declarativeActivity(declarative) : '') + (untrusted === 'url' ? '<iframe id="untrusted" name="untrusted" title="External activity" src="http://external.test/nested"></iframe>' : untrusted ? `<iframe id="untrusted" name="untrusted" title="Native ${untrusted}" sandbox="allow-forms" srcdoc="${escapeAttribute(`<${untrusted} controls preload="auto" src="${audio}"></${untrusted}><script>window.untrustedScriptRan=true</script>`)}"></iframe>` : ''), undefined, 'current').replace('<script data-maic-media-document', dropControls + '<script data-maic-media-document'))};
${
  surface === 'standalone'
    ? `
import {usePlayback} from './lib/standalone-player/playback/use-playback';
import {InteractiveScene} from './lib/standalone-player/scenes/InteractiveScene';
const speech=[{id:'speech',type:'speech',text:'Narration',audioRef:'narration'},{id:'second',type:'speech',text:'Second narration',audioRef:'narration'}];
const scenes=[{type:'interactive',order:0,actions:speech,content:{type:'interactive'}},{type:'interactive',order:1,actions:${restart ? 'speech' : '[]'},content:{type:'interactive'}}];
function App(){const [index,setIndex]=useState(${restart ? 1 : 0});const p=usePlayback(scenes,index,setIndex);window.mode=()=>p.state.mode;window.caption=()=>p.state.view.caption;window.sceneIndex=()=>index;window.sendWidget=value=>p.widgets.send('SET_WIDGET_STATE',{value});
return <><button onClick={p.play}>Narrate</button><button onClick={p.pause}>Pause</button><button onClick={()=>setIndex(index?0:1)}>Navigate</button>{index===${restart ? 1 : 0}&&<InteractiveScene html={html} strings={{}} title="test" widgets={p.widgets}/>}</>}
`
    : `
import {PlaybackEngine} from './lib/playback/engine';
import {AudioPlayer} from './lib/utils/audio-player';
import {StreamBuffer} from './lib/buffer/stream-buffer';
import {shouldAutoResumeLecture} from './lib/playback/auto-resume';
import {useWidgetIframeStore} from './lib/store/widget-iframe';
import {GENUI_LOGICAL_WIDTH,GENUI_LOGICAL_HEIGHT,fitGenUiViewport} from './lib/interactive/logical-viewport';
import {intersectClientBoxes} from './lib/edit/visible-client-rect';
const useI18n=()=>({t:k=>k});const useCanvasStore={use:{pickTarget:()=>null}};const useElementRefsStore={use:{refs:()=>[]}};
const runtime={errors:{},clearScene(){}};const useSceneRuntimeErrors=Object.assign(s=>s(runtime),{getState:()=>runtime});
const InteractiveRuntimeErrorBanner=()=>null;const resolveInteractivePickerMode=()=>null;const createObservationSession=()=>null;
${sourceFunction(hostPath, 'PooledIframe')}
const currentScene={id:'s',type:'interactive',actions:[{id:'speech',type:'speech',text:'Narration',audioId:'narration'},{id:'second',type:'speech',text:'Second narration',audioId:'narration'}],content:{type:'interactive'}};
const sceneEpochRef={current:0};const livePauseVersionRef={current:0};const setLectureSpeech=()=>{};const setActiveBubbleId=()=>{};const setEngineMode=()=>{};const lectureSessionIdRef={current:null};const chatAreaRef={current:null};const discussionTTS={pause(){}};const setIsDiscussionPaused=()=>{};
window.proactive=null;window.joined=false;window.joinedText='';window.joinedActions=0;const pickStudentAgent=()=> 'teacher';const setDiscussionTrigger=trigger=>window.proactive=trigger?.id??null;chatAreaRef.current={pauseActiveLiveBuffer(){window.joinedBuffer?.pause();return !!window.joinedBuffer}};
let currentSceneId='s';const pauseInteractiveMedia=${sourceFunction(playbackPath, 'pauseInteractiveMedia')};
const engine=new PlaybackEngine([currentScene],{clearEffects(){},execute(){}},new AudioPlayer(),{beforeSpeech:pauseInteractiveMedia,onModeChange:${sourceFunction(playbackPath, 'onModeChange')},onSpeechStart:${sourceFunction(playbackPath, 'onSpeechStart')},onPlaybackReadyChange:${sourceFunction(playbackPath, 'onPlaybackReadyChange')},onProactiveShow:${sourceFunction(playbackPath, 'onProactiveShow')},onProactiveHide:${sourceFunction(playbackPath, 'onProactiveHide')},onDiscussionConfirmed:()=>{window.joined=true;const callbacks={onAgentStart(){},onAgentEnd(){},onTextReveal(_id,_part,text){window.joinedText=text},onActionReady(){window.joinedActions++},onLiveSpeech(){},onSpeechProgress(){},onThinking(){},onCueUser(){},onDone(){},onError(message){throw new Error(message)}};const buffer=new StreamBuffer(callbacks,{charsPerTick:100});window.joinedBuffer=buffer;buffer.start();buffer.pushText('join','Joined response');buffer.pushAction({messageId:'join',actionId:'join-action',actionName:'spotlight',params:{},agentId:'teacher'});}});const engineRef={current:engine};
const onJoin=${sourceFunction(playbackPath, 'onDiscussionStart')};const onMediaPlay=${sourceFunction(playbackPath, 'pauseForInteractiveMedia')};window.mode=()=>engineRef.current.getMode();
window.cursor=()=>engineRef.current.getSnapshot().actionIndex;window.widgetReady=()=>useWidgetIframeStore.getState().readyByScene.s;window.sendWidget=value=>useWidgetIframeStore.getState().getSendMessage('s')?.('SET_WIDGET_STATE',{value});window.pendingWidgets=()=>useWidgetIframeStore.getState().pendingMessagesByScene.s?.filter(m=>m.type==='SET_WIDGET_STATE').length||0;
window.prepareDiscussion=()=>currentScene.actions.unshift({id:'delayed',type:'discussion',topic:'Question',prompt:'Discuss'});
window.skipDiscussion=()=>engineRef.current.skipDiscussion();
window.finishInterruption=()=>{engineRef.current.handleUserInterrupt('A question');engineRef.current.handleEndDiscussion();};
const playbackCompleted=false;const doSessionCleanup=()=>engineRef.current.handleEndDiscussion();
const autoResumeLecture=${sourceFunction(playbackPath, 'handleSessionStop')};
window.prepareLiveLecture=(prepaused=false)=>{
  window.lectureText='';window.lectureActions=0;
  const callbacks={onAgentStart(){},onAgentEnd(){},onTextReveal(_id,_part,text){window.lectureText=text},onActionReady(){window.lectureActions++},onLiveSpeech(){},onSpeechProgress(){},onThinking(){},onCueUser(){},onDone(){},onError(message){throw new Error(message)}};
  const lecture=new StreamBuffer(callbacks,{charsPerTick:100});lecture.start();
  const live=new StreamBuffer(callbacks);lectureSessionIdRef.current='lecture';
  chatAreaRef.current={startLecture:async()=> 'lecture',addLectureMessage(){},getLectureMessageId(){},resumeBuffer(){lecture.resume()},pauseBuffer(){lecture.pause()},pauseActiveLiveBuffer(){live.pause();return true}};
  if(prepaused){lecture.pause();if(engineRef.current.getMode()==='playing')engineRef.current.pause();}
  window.liveBufferPaused=()=>live.paused;
  engineRef.current.handleUserInterrupt('A question');
  window.returnFromLive=async()=>{live.resume();await autoResumeLecture({source:'soft_close_timeout',endReason:'user_done'});lecture.pushText('lecture','Continued lecture text');lecture.pushAction({messageId:'lecture',actionId:'continued',actionName:'spotlight',params:{},agentId:'teacher'});};
};
function App(){const [visible,setVisible]=useState(true);window.departForNarration=()=>{engineRef.current.stop();currentSceneId='destination';engineRef.current=new PlaybackEngine([{...currentScene,id:currentSceneId}],{clearEffects(){}},new AudioPlayer(),{beforeSpeech:pauseInteractiveMedia,onSpeechStart:()=>{window.destinationSpeechStarted=true}});setVisible(false);};useLayoutEffect(()=>{if(!visible&&currentSceneId==='destination')engineRef.current.start();},[visible]);return <><button onClick={()=>window.departForNarration()}>Next scene</button><button onClick={()=>engineRef.current.getMode()==='idle'?engineRef.current.start():engineRef.current.resume()}>Narrate</button><button onClick={()=>engineRef.current.continuePlayback()}>Continue lecture</button><button onClick={()=>{window.joinPending=Promise.resolve(onJoin())}}>Join discussion</button><button onClick={()=>window.returnFromLive()}>Return from Q&A</button><button onClick={()=>engineRef.current.pause()}>Pause</button><button onClick={()=>{engineRef.current.stop();setVisible(!visible)}}>Navigate</button><PooledIframe onMediaPlay={onMediaPlay} sceneId="s" entry={{${url ? 'src:"http://external.test/activity"' : 'srcDoc:html'},rect:{left:0,top:100,width:1280,height:720},clip:{left:0,top:100,width:1280,height:720},owner:'o'}} visible={visible} playbackArmed={false}/></>}
`
}
window.narrationPaused=()=>window.audios[0]?.paused??true;
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
            '@/lib/media/resolve-audio-bytes': './e2e/fixtures/media-stubs.ts',
          }
        : {},
    define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text;
}

async function finishNarration(page: Page) {
  // Priming also clears paused; wait for the actual narration before seeding completion.
  await expect
    .poll(() =>
      page.evaluate('audios[0].duration > 1 && !audios[0].paused && audios[0].currentTime > 0'),
    )
    .toBe(true);
  await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
}

type ParsedRootCase = {
  method: 'setHTMLUnsafe' | 'setHTML' | 'parseHTMLUnsafe' | 'parseHTML';
  mode: 'open' | 'closed';
  kind: 'audio' | 'iframe';
  input?: 'default-policy' | 'trusted' | 'coercion';
};
async function makeParsedRoot(page: Page, settings: ParsedRootCase) {
  const content =
    settings.kind === 'iframe'
      ? `<iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(nestedMedia)}"></iframe>`
      : '<audio autoplay loop></audio>';
  return page.frames()[1].evaluate(`(function(settings,content,src){
    const host=document.createElement('section');document.body.append(host);
    const parser=settings.method.startsWith('parseHTML')?Document:host;
    if(typeof parser[settings.method]!=='function'||(settings.input&&settings.input!=='coercion'&&!window.trustedTypes))return {supported:false};
    window.parserConstructors=0;window.parserCoercions=0;window.parserPolicies=0;window.parserViolations=0;window.parserClicks=0;window.parserEvents=[];
    document.addEventListener('securitypolicyviolation',()=>parserViolations++);
    customElements.define('dynamic-root-probe',class extends HTMLElement{constructor(){super();parserConstructors++}connectedCallback(){window.parsedRoot=this.getRootNode()}});
    const markup='<div><template shadowrootmode="'+settings.mode+'"><dynamic-root-probe hidden></dynamic-root-probe>'+content+'</template></div>';
    let input=markup;
    if(settings.input==='default-policy'){
      const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content="require-trusted-types-for 'script'";document.head.append(meta);
      trustedTypes.createPolicy('default',{createHTML(){parserPolicies++;return markup}});input='<p>Policy input</p>';
    }else if(settings.input==='trusted'){
      input=trustedTypes.createPolicy('parser-test',{createHTML(value){parserPolicies++;return value}}).createHTML(markup);
      TrustedHTML.prototype.toString=function(){parserCoercions++;return markup};
    }else if(settings.input==='coercion')input={toString(){parserCoercions++;return markup}};
    const options=settings.method==='setHTML'||settings.method==='parseHTML'?{sanitizer:{elements:['html','head','body','div','template','dynamic-root-probe','audio'],attributes:['shadowrootmode','hidden','autoplay','loop']}}:undefined;
    const result=parser[settings.method](input,options);
    if(parser===Document)host.append(...result.body.childNodes);
    const media=window.parsedRoot?.querySelector('audio');if(media)['play','playing','pause','error','canplay'].forEach(type=>media.addEventListener(type,()=>parserEvents.push(type)));
    const button=document.createElement('button');button.id='start-parsed';button.textContent='Start parsed media';button.onclick=event=>{parserClicks++;window.parserGesture={trusted:event.isTrusted,active:navigator.userActivation?.isActive};parsedRoot.querySelector('audio').src=src};document.body.append(button);
    return {supported:true,captured:!!window.parsedRoot,mode:window.parsedRoot?.mode,closed:!host.firstChild?.shadowRoot,result:typeof result,constructors:parserConstructors,coercions:parserCoercions,policies:parserPolicies};
  })(${JSON.stringify(settings)},${JSON.stringify(content)},${JSON.stringify(audio)})`);
}
async function parsedChild(page: Page) {
  const element = (
    await page.frames()[1].evaluateHandle('parsedRoot.querySelector("iframe")')
  ).asElement()!;
  await expect.poll(async () => !!(await element.contentFrame())).toBe(true);
  return (await element.contentFrame())!;
}
async function startParsedMedia(page: Page, kind: ParsedRootCase['kind']) {
  if (kind === 'audio') {
    await page.frameLocator('iframe').locator('#start-parsed').press('Enter');
    expect(await page.frames()[1].evaluate('parserClicks')).toBe(1);
    expect(await page.frames()[1].evaluate('parserGesture.trusted')).toBe(true);
  } else await (await parsedChild(page)).getByRole('button', { name: 'Nested context' }).click();
  try {
    await expect
      .poll(() =>
        kind === 'audio'
          ? page
              .frames()[1]
              .evaluate(
                '!parsedRoot.querySelector("audio").paused && parsedRoot.querySelector("audio").currentTime > 0',
              )
          : parsedChild(page).then((child) => child.evaluate('ctx.state === "running"')),
      )
      .toBe(true);
  } catch (error) {
    const state = await page
      .frames()[1]
      .evaluate(
        `(()=>{const media=window.parsedRoot?.querySelector('audio');return {clicks:window.parserClicks,gesture:window.parserGesture,events:window.parserEvents,media:media&&{paused:media.paused,time:media.currentTime,ready:media.readyState,network:media.networkState,source:!!media.getAttribute('src'),error:media.error?.code}}})()`,
      );
    await test.info().attach('native-parser-start', {
      body: JSON.stringify(state),
      contentType: 'application/json',
    });
    throw error;
  }
}
async function parsedRootControl(page: Page, settings: ParsedRootCase) {
  const native = await page.context().newPage();
  try {
    await native.setContent(
      '<iframe sandbox="allow-scripts" srcdoc="<p>Native control</p>"></iframe>',
    );
    const result = await makeParsedRoot(native, settings);
    if (!result.supported || !result.captured) return null;
    await startParsedMedia(native, settings.kind);
    return result;
  } finally {
    await native.close();
  }
}

async function nativeSynthesisStarts(page: Page): Promise<boolean> {
  const control = await page.context().newPage();
  try {
    const html = `<button onclick="if(!window.speechSynthesis||!window.SpeechSynthesisUtterance)return;window.u=new SpeechSynthesisUtterance('Native speech control. '.repeat(30));u.onstart=()=>window.started=true;speechSynthesis.speak(u)">Speak</button>`;
    await control.route('http://localhost/synthesis-control', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(html)}"></iframe>`,
      }),
    );
    await control.goto('http://localhost/synthesis-control');
    await control.frameLocator('iframe').getByRole('button').click();
    const frame = control.frames()[1];
    try {
      await expect
        .poll(
          () =>
            frame.evaluate(
              '!!window.started && speechSynthesis.speaking && !speechSynthesis.paused',
            ),
          { timeout: 5000 },
        )
        .toBe(true);
      return true;
    } catch {
      return false;
    }
  } finally {
    await control.frames()[1]?.evaluate(() => window.speechSynthesis?.cancel());
    await control.close();
  }
}

async function adjacentAutoplayStarts(
  page: Page,
  tag: string,
  method:
    | 'insertAdjacentHTML'
    | 'outerHTML'
    | 'setHTML'
    | 'setHTMLUnsafe'
    | 'cloneContents' = 'insertAdjacentHTML',
): Promise<boolean> {
  const control = await page.context().newPage();
  try {
    const html = `<button id="start">Start</button><script>document.querySelector('button').onclick=()=>{const container=document.createElement('div');${method === 'outerHTML' ? `container.append(document.createElement('span'));container.firstChild.outerHTML='<${tag}></${tag}>';` : method === 'setHTMLUnsafe' || method === 'setHTML' ? `if(!container.${method})return;container.${method}('<${tag}></${tag}>');` : method === 'cloneContents' ? `container.innerHTML='<${tag}></${tag}>';const range=document.createRange();range.selectNodeContents(container);window.rangeClone=range.cloneContents();` : `container.insertAdjacentHTML('beforeend','<${tag}></${tag}>');`}window.parserMedia=${method === 'cloneContents' ? 'rangeClone' : 'container'}.firstChild;parserMedia.playsInline=true;parserMedia.autoplay=true;parserMedia.src=${JSON.stringify(audio)}};</script>`;
    await control.route('http://localhost/parser-control', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<iframe sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escapeAttribute(html)}"></iframe>`,
      }),
    );
    await control.goto('http://localhost/parser-control');
    await control.frameLocator('iframe').locator('#start').click();
    const frame = control.frames()[1];
    try {
      await expect
        .poll(
          () =>
            frame.evaluate(
              'window.parserMedia && !parserMedia.paused && parserMedia.currentTime > 0',
            ),
          { timeout: 2000 },
        )
        .toBe(true);
      return true;
    } catch {
      return false;
    }
  } finally {
    await control.close();
  }
}

type CloneCase = {
  kind: 'audio' | 'iframe' | 'raw';
  imperative: boolean;
  method: 'cloneNode' | 'importNode' | 'cloneContents';
  detached: boolean;
};
async function makeClosedClone(page: Page, settings: CloneCase) {
  return page.frames()[1].evaluate(({ kind, imperative, method, detached }) => {
    const state = window as unknown as {
      declarativeRoot: ShadowRoot;
      clonedRoot?: ShadowRoot;
      clonedHost?: Element;
    };
    const parent = document.createElement('section');
    let original: Element;
    let sourceRoot: ShadowRoot;
    if (imperative) {
      original = document.createElement('div');
      sourceRoot = original.attachShadow({ mode: 'closed', clonable: true });
      sourceRoot.innerHTML =
        '<native-dsd-probe hidden></native-dsd-probe>' +
        (kind === 'raw'
          ? '<iframe name="original-raw" title="Clone activity" sandbox="allow-scripts" src="http://external.test/clone"></iframe>'
          : '<audio autoplay loop></audio>');
      parent.append(original);
    } else {
      original = document.querySelector('#declarative-host')!;
      sourceRoot = state.declarativeRoot;
      original.replaceWith(parent);
      parent.append(original);
    }
    if (!sourceRoot.clonable) return { supported: false, captured: false, sourceUnchanged: true };
    const before = sourceRoot.innerHTML;
    state.clonedRoot = undefined;
    const clone =
      method === 'cloneContents'
        ? (() => {
            const range = document.createRange();
            range.selectNodeContents(parent);
            return range.cloneContents();
          })()
        : method === 'cloneNode'
          ? parent.cloneNode(true)
          : document.importNode(parent, true);
    state.clonedHost = clone as Element;
    const root = state.clonedRoot;
    if (root) {
      const frame = root.querySelector('iframe');
      if (frame) frame.name = 'cloned-frame';
      state.declarativeRoot = root;
    }
    if (!detached) document.body.append(clone);
    return {
      supported: true,
      captured: !!root,
      sourceUnchanged: sourceRoot.innerHTML === before,
      mode: root?.mode,
      hidden: root?.host.shadowRoot === null,
      markers: root?.querySelectorAll('[data-maic-shadow-root]').length,
    };
  }, settings);
}
async function clonedFrame(page: Page) {
  const element = (
    await page.frames()[1].evaluateHandle('clonedRoot.querySelector("iframe")')
  ).asElement()!;
  await expect.poll(async () => !!(await element.contentFrame())).toBe(true);
  return (await element.contentFrame())!;
}
async function clonedAutoplayStarts(page: Page, settings: CloneCase) {
  const native = await page.context().newPage();
  try {
    await native.setContent(
      `<iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(declarativeActivity({ kind: 'audio', mode: 'closed', clonable: true }))}"></iframe>`,
    );
    const clone = await makeClosedClone(native, settings);
    if (!clone.supported || !clone.captured) return false;
    await native.frameLocator('iframe').locator('#start-declarative').click();
    try {
      await expect
        .poll(
          () =>
            native
              .frames()[1]
              .evaluate(
                '!clonedRoot.querySelector("audio").paused && clonedRoot.querySelector("audio").currentTime > 0',
              ),
          { timeout: 2000 },
        )
        .toBe(true);
      return true;
    } catch {
      return false;
    }
  } finally {
    await native.close();
  }
}

async function finishFrameLoad(page: Page) {
  const child = page.frames()[1];
  // A late load must not reset the deliberately unresponsive frame's playing report.
  await child.evaluate(() => {
    document.querySelectorAll<HTMLMediaElement>('audio,video').forEach((media) => {
      media.preload = 'none';
      media.removeAttribute('src');
      media.load();
    });
    const detached = (window as unknown as { detached: HTMLAudioElement }).detached;
    detached.removeAttribute('src');
    detached.load();
  });
  await expect.poll(() => child.evaluate('document.readyState')).toBe('complete');
  await child.evaluate((src) => {
    document.querySelector('audio')!.src = src;
  }, audio);
}

async function startUnresponsiveFrame(page: Page) {
  const playing = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const listener = (event: MessageEvent) => {
          if (
            event.source === document.querySelector('iframe')?.contentWindow &&
            event.data?.type === 'maic:media:state:v1' &&
            event.data.generation > 0 &&
            event.data.playing
          ) {
            window.removeEventListener('message', listener);
            resolve();
          }
        };
        window.addEventListener('message', listener);
      }),
  );
  await page.frameLocator('iframe').locator('#audio').click();
  await playing;
  await page.frames()[1].evaluate(() => {
    (window as unknown as { blockMediaControls: boolean }).blockMediaControls = true;
  });
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
        route.fulfill({
          contentType: 'text/html',
          body: `<p id="no-bridge">Navigated document</p><button id="play" onclick="document.querySelector('audio').play()">Play</button><audio src="${audio}" loop></audio>`,
        }),
      );
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

    test('blocks auxiliary media windows outside the narration handshake', async ({ page }) => {
      await page.context().route('http://localhost/popup-media', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<button onclick="window.ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()">Popup audio</button>',
        }),
      );
      let popup: Page | undefined;
      const opened = (child: Page) => {
        popup = child;
      };
      page.on('popup', opened);
      try {
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        await page.frames()[1].evaluate(() => {
          const button = document.createElement('button');
          button.id = 'open-popup';
          button.textContent = 'Open popup';
          button.onclick = (event) => {
            Object.assign(window, { popupGesture: event.isTrusted });
            try {
              Object.assign(window, {
                popupBlocked: window.open('http://localhost/popup-media', '_blank') === null,
              });
            } catch (error) {
              if (
                !(error instanceof DOMException) ||
                !['SecurityError', 'InvalidAccessError'].includes(error.name)
              )
                throw error;
              Object.assign(window, { popupBlocked: true, popupException: error.name });
            }
          };
          document.body.append(button);
        });
        await page.frameLocator('iframe').locator('#open-popup').press('Enter');
        const blocked = await page.frames()[1].evaluate('window.popupBlocked');
        expect(await page.frames()[1].evaluate('window.popupGesture')).toBe(true);
        await test.info().attach('popup-result', {
          body: JSON.stringify(
            await page
              .frames()[1]
              .evaluate('({blocked:window.popupBlocked,exception:window.popupException})'),
          ),
          contentType: 'application/json',
        });
        if (!blocked) {
          await expect.poll(() => !!popup).toBe(true);
          await popup!.getByRole('button', { name: 'Popup audio' }).press('Enter');
          await expect.poll(() => popup!.evaluate('ctx.state')).toBe('running');
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        }
        expect(blocked).toBe(true);
        expect(popup).toBeUndefined();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      } finally {
        page.off('popup', opened);
        await popup?.close();
      }
    });

    for (const stream of ['write', 'writeln', 'split'] as const) {
      test(`refuses silence for streaming document markup (${stream})`, async ({ page }) => {
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({
          content: bundle(surface, false, false, undefined, {
            kind: 'audio',
            mode: 'closed',
            stream,
          }),
        });
        const outer = page.frameLocator('iframe');
        await expect(outer.locator('#start-declarative')).toBeVisible();
        const frame = page.frames()[1];
        await expect.poll(() => frame.evaluate('declarativeRoot.mode')).toBe('closed');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await outer.locator('#start-declarative').press('Enter');
        await expect
          .poll(() =>
            frame.evaluate(
              '!declarativeRoot.querySelector("audio").paused && declarativeRoot.querySelector("audio").currentTime > 0',
            ),
          )
          .toBe(true);
        expect(await frame.evaluate('declarativePlayCalls')).toBe(0);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
        // Unload the writer's document; a fresh ordinary activity can narrate again.
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({ content: bundle(surface) });
        await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      });
    }

    if (surface === 'app')
      for (const nested of [false, true]) {
        test(`bounds pause traffic for a permanently unsilenced hidden frame (nested=${nested})`, async ({
          page,
        }) => {
          if (!nested) {
            await page.goto('http://localhost/media-test');
            await page.addScriptTag({
              content: bundle('app', false, false, undefined, {
                kind: 'audio',
                mode: 'closed',
                stream: 'write',
              }),
            });
            await expect(page.frameLocator('iframe').locator('#start-declarative')).toBeVisible();
          } else await finishFrameLoad(page);
          const outer = page.frames()[1];
          const watched = [outer];
          if (nested) {
            const html = patchHtmlForIframe(
              declarativeActivity({ kind: 'audio', mode: 'closed', stream: 'write' }),
              undefined,
              'storm-child',
            );
            await outer.evaluate((srcdoc) => {
              const child = document.createElement('iframe');
              child.name = 'storm-child';
              child.sandbox.value = 'allow-scripts';
              child.srcdoc = srcdoc;
              document.body.append(child);
            }, html);
            await expect.poll(() => !!page.frame({ name: 'storm-child' })).toBe(true);
            watched.push(page.frame({ name: 'storm-child' })!);
          }
          for (const frame of watched) {
            await expect.poll(() => frame.evaluate('document.readyState')).toBe('complete');
            await frame.evaluate(() => {
              const state = { requests: 0, enabled: true };
              Object.assign(window, { hiddenMediaTraffic: state });
              window.addEventListener('message', (event) => {
                if (event.data?.type !== 'maic:media:control:v1') return;
                if (event.data.action === 'pause') state.requests++;
                if (event.data.action === 'sync') state.enabled = event.data.enabled;
              });
            });
          }
          await page.getByRole('button', { name: 'Navigate', exact: true }).click();
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          for (const frame of watched)
            await expect.poll(() => frame.evaluate('hiddenMediaTraffic.enabled')).toBe(false);
          await outer.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
          const before = await Promise.all(
            watched.map((frame) => frame.evaluate<number>('hiddenMediaTraffic.requests')),
          );
          await outer.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
          const after = await Promise.all(
            watched.map((frame) => frame.evaluate<number>('hiddenMediaTraffic.requests')),
          );
          await test.info().attach('hidden-media-traffic', {
            body: JSON.stringify({ before, after }),
            contentType: 'application/json',
          });
          expect(before.every((requests) => requests > 0 && requests <= 8)).toBe(true);
          expect(after).toEqual(before);
          await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
        });
      }

    for (const settings of [
      { method: 'setHTMLUnsafe', mode: 'open', kind: 'audio' },
      { method: 'setHTMLUnsafe', mode: 'closed', kind: 'audio' },
      { method: 'setHTMLUnsafe', mode: 'closed', kind: 'iframe' },
      { method: 'setHTML', mode: 'closed', kind: 'audio' },
      { method: 'setHTMLUnsafe', mode: 'closed', kind: 'audio', input: 'default-policy' },
      { method: 'setHTMLUnsafe', mode: 'open', kind: 'audio', input: 'trusted' },
      { method: 'setHTMLUnsafe', mode: 'closed', kind: 'audio', input: 'trusted' },
      { method: 'setHTMLUnsafe', mode: 'closed', kind: 'audio', input: 'coercion' },
      { method: 'parseHTMLUnsafe', mode: 'open', kind: 'audio' },
      { method: 'parseHTMLUnsafe', mode: 'closed', kind: 'audio' },
      { method: 'parseHTMLUnsafe', mode: 'closed', kind: 'iframe' },
      { method: 'parseHTML', mode: 'closed', kind: 'audio' },
      { method: 'parseHTMLUnsafe', mode: 'closed', kind: 'audio', input: 'default-policy' },
      { method: 'parseHTMLUnsafe', mode: 'open', kind: 'audio', input: 'trusted' },
    ] as const satisfies readonly ParsedRootCase[]) {
      test(`coordinates dynamic declarative ${settings.method} ${settings.mode} ${settings.kind} ${'input' in settings ? settings.input : 'string'}`, async ({
        page,
      }) => {
        const control = await parsedRootControl(page, settings);
        test.skip(!control, 'Native parser API, declarative roots or media start are unavailable.');
        expect(control).toMatchObject({ mode: settings.mode, constructors: 1 });
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        expect(await makeParsedRoot(page, settings)).toEqual(control);
        await startParsedMedia(page, settings.kind);
        expect(await page.frames()[1].evaluate('parserViolations')).toBe(0);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        if (settings.mode === 'open') {
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          await expect
            .poll(() => page.frames()[1].evaluate('parsedRoot.querySelector("audio").paused'))
            .toBe(true);
        } else {
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
          await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
          // Only a document reload can prove an inaccessible root and detached media are gone.
          await page.frames()[1].evaluate('document.body.dataset.parsedReload = "pending"');
          await page.locator('iframe').evaluate((element: HTMLIFrameElement) => {
            element.srcdoc = element.srcdoc;
          });
          await expect(page.frameLocator('iframe').locator('body')).not.toHaveAttribute(
            'data-parsed-reload',
            'pending',
          );
          await expect
            .poll(() => page.frames()[1].evaluate('typeof window.parsedRoot'))
            .toBe('undefined');
          await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
          await finishFrameLoad(page);
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        }
        expect(await page.frames()[1].evaluate('window.parserViolations || 0')).toBe(0);
      });
    }

    for (const media of ['audio', 'video'] as const) {
      test(`coordinates script-disabled nested native ${media} with a guarded reload`, async ({
        page,
        browserName,
      }) => {
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({ content: bundle(surface, false, false, media) });
        const outer = page.frameLocator('iframe');
        await expect(outer.locator('#audio')).toBeVisible();
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        await expect
          .poll(() =>
            page.evaluate(
              'audios[0]?.duration > 1 && !audios[0].paused && audios[0].currentTime > 0',
            ),
          )
          .toBe(true);
        const open = outer.getByRole('button', { name: new RegExp('Native ' + media + '.*open') });
        await expect(open).toBeVisible();
        await open.click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
        const element = outer.frameLocator('#untrusted').locator(media);
        await expect(element).toBeVisible();
        const native = page.frames().find((f) => f.name() === 'untrusted')!;
        await expect
          .poll(() =>
            native.evaluate(
              (kind) => document.querySelector<HTMLMediaElement>(kind)!.duration,
              media,
            ),
          )
          .toBeGreaterThan(1);
        expect(await native.evaluate('typeof window.untrustedScriptRan')).toBe('undefined');
        if (browserName !== 'webkit') {
          // Trusted native keyboard input; no authored script or play() call runs in this child.
          await element.press('Space');
          await expect
            .poll(() =>
              native.evaluate(
                (kind) => document.querySelector<HTMLMediaElement>(kind)!.paused,
                media,
              ),
            )
            .toBe(false);
          await expect
            .poll(() =>
              native.evaluate(
                (kind) => document.querySelector<HTMLMediaElement>(kind)!.currentTime,
                media,
              ),
            )
            .toBeGreaterThan(0);
        } else {
          // Native-control start is NOT_VALIDATED in the no-bridge WebKit control; test the reload guard.
          console.log('NOT_VALIDATED WebKit native control start:', surface, media);
        }
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page
          .frames()[1]
          .evaluate('window.savedNativeFrame=document.querySelector("#untrusted")');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(open).toBeVisible();
        if (surface === 'app' && media === 'audio')
          await page.screenshot({
            path: 'node_modules/.cache/openmaic-1846/r2-guarded-' + browserName + '.png',
          });
        expect(native.isDetached()).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        await page.frames()[1].evaluate('document.body.append(window.savedNativeFrame)');
        await expect(outer.locator('iframe#untrusted')).toHaveCount(0);
        await expect(open).toBeVisible();
        await open.click();
        await expect(outer.frameLocator('#untrusted').locator(media)).toBeVisible();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(
          await page
            .frames()
            .find((f) => f.name() === 'untrusted')!
            .evaluate((kind) => document.querySelector<HTMLMediaElement>(kind)!.paused, media),
        ).toBe(true);
      });
    }

    for (const tag of ['object', 'embed'] as const)
      for (const kind of ['html', 'audio'] as const)
        test(`guards opaque ${tag} ${kind} with an unload before narration resumes`, async ({
          page,
        }) => {
          const url = `http://external.test/opaque-${tag}-${kind}`;
          await page.context().route(url, (route) =>
            route.fulfill(
              kind === 'html'
                ? {
                    contentType: 'text/html',
                    body: '<button onclick="window.ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()">Embedded audio</button>',
                  }
                : { contentType: 'audio/wav', body: Buffer.from(audio.split(',')[1], 'base64') },
            ),
          );
          // Calibrate native resource support without the bridge in this same engine/sandbox.
          const control = await page.context().newPage();
          let supported = false;
          try {
            await control.setContent(
              `<iframe sandbox="allow-scripts allow-forms" srcdoc="${escapeAttribute(`<${tag} type="${kind === 'html' ? 'text/html' : 'audio/wav'}" ${tag === 'object' ? 'data' : 'src'}="${url}"></${tag}>`)}"></iframe>`,
            );
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
              const child = control.frames().find((frame) => frame.url() === url);
              if (child) {
                supported = kind === 'html' || (await child.locator('audio,video').count()) === 1;
                if (supported) break;
              }
              await control.waitForTimeout(50);
            }
          } finally {
            await control.close();
          }
          test.skip(!supported, 'The native no-bridge control cannot embed this resource.');
          await finishFrameLoad(page);
          const outer = page.frames()[1];
          const mount = () =>
            outer.evaluate(
              ({ tag, kind, url }) => {
                const embedded = document.createElement(tag);
                embedded.id = 'opaque-media';
                embedded.title = 'Opaque media';
                embedded.setAttribute('type', kind === 'html' ? 'text/html' : 'audio/wav');
                embedded.setAttribute(tag === 'object' ? 'data' : 'src', url);
                document.body.append(embedded);
                const image = document.createElement('img');
                image.id = 'ordinary-image';
                image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
                document.body.append(image);
              },
              { tag, kind, url },
            );
          const start = async () => {
            await expect.poll(() => page.frames().some((frame) => frame.url() === url)).toBe(true);
            const child = page.frames().find((frame) => frame.url() === url)!;
            if (kind === 'html') {
              await child.getByRole('button', { name: 'Embedded audio' }).press('Enter');
              await expect.poll(() => child.evaluate('window.ctx?.state')).toBe('running');
            } else {
              await child.evaluate(() => {
                const button = document.createElement('button');
                button.textContent = 'Native player';
                button.onclick = () =>
                  void document.querySelector<HTMLMediaElement>('audio,video')!.play();
                document.body.append(button);
              });
              await child.getByRole('button', { name: 'Native player' }).press('Enter');
              await expect
                .poll(() =>
                  child.evaluate(
                    '!document.querySelector("audio,video").paused && document.querySelector("audio,video").currentTime > 0',
                  ),
                )
                .toBe(true);
            }
            return child;
          };
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          await mount();
          const open = page
            .frameLocator('iframe')
            .getByRole('button', { name: /Opaque media.*open/ });
          await outer.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
          if (!(await open.count())) {
            await start();
            await test.info().attach('uncoordinated-embedded-media', {
              body: JSON.stringify({
                tag,
                kind,
                embeddedPlaying: true,
                narrationPlaying: await page.locator('body').getAttribute('data-narration-playing'),
              }),
              contentType: 'application/json',
            });
          }
          await expect(open).toBeVisible();
          await expect(page.frameLocator('iframe').locator('img#ordinary-image')).toHaveCount(1);
          await open.click();
          const child = await start();
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(open).toBeVisible();
          expect(child.isDetached()).toBe(true);
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          await open.click();
          await expect.poll(() => page.frames().some((frame) => frame.url() === url)).toBe(true);
          const reloaded = page.frames().find((frame) => frame.url() === url)!;
          if (kind === 'html')
            expect(await reloaded.evaluate('typeof window.ctx')).toBe('undefined');
          else
            expect(
              await reloaded
                .locator('audio,video')
                .evaluate((element) => (element as HTMLMediaElement).paused),
            ).toBe(true);
          await expect(page.frameLocator('iframe').locator('img#ordinary-image')).toHaveCount(1);
        });

    test('guards URL child media with an unload before narration resumes', async ({ page }) => {
      await page.route('http://external.test/nested', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<button id="play" onclick="document.querySelector('audio').play();window.ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()">Play</button><audio src="${audio}" loop></audio>`,
        }),
      );
      await page.goto('http://localhost/media-test');
      await page.addScriptTag({ content: bundle(surface, false, false, 'url') });
      const outer = page.frameLocator('iframe');
      const open = outer.getByRole('button', { name: /External activity.*open/ });
      await expect(open).toBeVisible();
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      await open.click();
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await outer.frameLocator('#untrusted').locator('#play').click();
      const child = page.frames().find((f) => f.url() === 'http://external.test/nested')!;
      await expect
        .poll(() =>
          child.evaluate(
            '!document.querySelector("audio").paused && document.querySelector("audio").currentTime > 0 && window.ctx.state === "running"',
          ),
        )
        .toBe(true);
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect(open).toBeVisible();
      expect(child.isDetached()).toBe(true);
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      await open.click();
      await expect(outer.frameLocator('#untrusted').locator('#play')).toBeVisible();
      expect(
        await page
          .frames()
          .find((f) => f.url() === 'http://external.test/nested')!
          .evaluate('document.querySelector("audio").paused && typeof window.ctx === "undefined"'),
      ).toBe(true);
    });

    test('restores the managed source after form navigation and unblocks narration', async ({
      page,
    }) => {
      await finishFrameLoad(page);
      let navigations = 0;
      await page.route(/^http:\/\/localhost\/without-media-bridge(?:\?.*)?$/, (route) => {
        navigations++;
        return route.fulfill({
          contentType: 'text/html',
          body: '<p id="no-bridge">Uninstrumented document</p>',
        });
      });
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(
            'audios[0]?.duration > 1 && !audios[0].paused && audios[0].currentTime > 0',
          ),
        )
        .toBe(true);
      await page.locator('iframe').evaluate((frame: HTMLIFrameElement) =>
        frame.addEventListener(
          'load',
          () => {
            (window as unknown as { sendWidget: (value: number) => void }).sendWidget(42);
          },
          { once: true },
        ),
      );
      await page.frameLocator('iframe').locator('#self-navigate').click();
      await expect.poll(() => navigations).toBe(1);
      await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
      await finishFrameLoad(page);
      await expect.poll(() => page.frames()[1].evaluate('window.widgetValues')).toEqual([42]);
      if (surface === 'app') {
        await page.getByRole('button', { name: 'Next scene', exact: true }).click();
        await expect.poll(() => page.evaluate('window.destinationSpeechStarted')).toBe(true);
        await expect.poll(() => page.evaluate('mode()')).toBe('playing');
      } else {
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await finishNarration(page);
        await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      }
    });

    test('restores a navigated nested source and resumes narration after a fresh acknowledgement', async ({
      page,
    }) => {
      await finishFrameLoad(page);
      await page.frames()[1].evaluate('document.querySelector("#nested").style.display="block"');
      const inner = page.frameLocator('iframe').frameLocator('#nested').frameLocator('#inner');
      await expect(inner.locator('#navigate-nested')).toBeVisible();
      let navigations = 0;
      await page.route(/^http:\/\/localhost\/without-media-bridge(?:\?.*)?$/, (route) => {
        navigations++;
        return route.fulfill({
          contentType: 'text/html',
          body: '<p>Uninstrumented nested document</p>',
        });
      });
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      await inner.locator('#navigate-nested').click();
      await expect.poll(() => navigations).toBe(1);
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await expect(inner.locator('#navigate-nested')).toBeVisible();
      await expect
        .poll(() => inner.locator('body').evaluate(() => document.readyState))
        .toBe('complete');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('mode()')).toBe('playing');
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
    });

    test('native synthesis pauses narration and is cancelled before narration resumes', async ({
      page,
    }) => {
      test.skip(
        !(await nativeSynthesisStarts(page)),
        'Native synthesis cannot start in the independent same-backend control',
      );
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      const child = page.frames()[1];
      await page.frameLocator('iframe').getByRole('button', { name: 'Frame synthesis' }).click();
      await expect
        .poll(() => child.evaluate('!!window.synthesisStarted && speechSynthesis.speaking'))
        .toBe(true);
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect
        .poll(() => child.evaluate('!speechSynthesis.speaking && !speechSynthesis.pending'))
        .toBe(true);
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      await page.frameLocator('iframe').getByRole('button', { name: 'Frame synthesis' }).click();
      await expect.poll(() => child.evaluate('speechSynthesis.speaking')).toBe(true);
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
    });

    test('cancels native synthesis and its queued utterance before starting narration', async ({
      page,
    }) => {
      test.skip(
        !(await nativeSynthesisStarts(page)),
        'Native synthesis cannot start in the independent same-backend control',
      );
      const child = page.frames()[1];
      const speak = page.frameLocator('iframe').getByRole('button', { name: 'Frame synthesis' });
      await speak.click();
      await expect
        .poll(() => child.evaluate('!!window.synthesisStarted && speechSynthesis.speaking'))
        .toBe(true);
      await speak.click();
      await expect.poll(() => child.evaluate('speechSynthesis.pending')).toBe(true);
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect
        .poll(() => child.evaluate('!speechSynthesis.speaking && !speechSynthesis.pending'))
        .toBe(true);
      await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
    });

    for (const settings of [
      { kind: 'audio', imperative: false, method: 'cloneNode', detached: false },
      { kind: 'iframe', imperative: false, method: 'importNode', detached: false },
      { kind: 'audio', imperative: true, method: 'cloneNode', detached: false },
      { kind: 'raw', imperative: true, method: 'importNode', detached: false },
      { kind: 'audio', imperative: false, method: 'cloneNode', detached: true },
      { kind: 'audio', imperative: true, method: 'cloneContents', detached: false },
      { kind: 'iframe', imperative: false, method: 'cloneContents', detached: false },
    ] satisfies CloneCase[]) {
      test(`coordinates clonable closed roots ${JSON.stringify(settings)}`, async ({ page }) => {
        if (settings.kind === 'audio')
          test.skip(
            !(await clonedAutoplayStarts(page, settings)),
            'Native cloned closed-root autoplay does not start in the independent same-engine control.',
          );
        await page.route('http://external.test/clone', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<button onclick="window.ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()">Clone context</button>',
          }),
        );
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({
          content: bundle(surface, false, false, undefined, {
            kind: settings.kind === 'iframe' ? 'iframe' : 'audio',
            mode: 'closed',
            clonable: true,
          }),
        });
        await expect(page.frameLocator('iframe').locator('#start-declarative')).toBeVisible();
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        const clone = await makeClosedClone(page, settings);
        test.skip(!clone.supported, 'Native clonable shadow roots are unavailable.');
        expect(clone).toMatchObject({
          captured: true,
          sourceUnchanged: true,
          mode: 'closed',
          hidden: true,
          markers: 0,
        });
        const frame = page.frames()[1];
        if (settings.kind === 'audio') {
          await page.frameLocator('iframe').locator('#start-declarative').click();
          await expect
            .poll(() =>
              frame.evaluate(
                '!clonedRoot.querySelector("audio").paused && clonedRoot.querySelector("audio").currentTime > 0',
              ),
            )
            .toBe(true);
          expect(await frame.evaluate('declarativePlayCalls')).toBe(0);
        } else if (settings.kind === 'iframe') {
          const child = await clonedFrame(page);
          await child.getByRole('button', { name: 'Nested context' }).click();
          await expect.poll(() => child.evaluate('ctx.state')).toBe('running');
        } else {
          await expect
            .poll(() =>
              frame.evaluate(
                '!!clonedRoot.querySelector("button") && !clonedRoot.querySelector("iframe")',
              ),
            )
            .toBe(true);
          const open = await frame.evaluateHandle(
            () =>
              (window as unknown as { clonedRoot: ShadowRoot }).clonedRoot.querySelector('button')!,
          );
          await open.click();
          const child = await clonedFrame(page);
          await child.getByRole('button', { name: 'Clone context' }).click();
          await expect.poll(() => child.evaluate('ctx.state')).toBe('running');
        }
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        if (settings.kind === 'audio')
          await expect
            .poll(() => frame.evaluate('clonedRoot.querySelector("audio").paused'))
            .toBe(true);
        else if (settings.kind === 'iframe')
          await expect
            .poll(async () => (await clonedFrame(page)).evaluate('ctx.state'))
            .toBe('suspended');
        else
          await expect
            .poll(() =>
              frame.evaluate(
                '!!clonedRoot.querySelector("button") && !clonedRoot.querySelector("iframe")',
              ),
            )
            .toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      });
    }

    test('fails closed for an unobservable scoped declarative registry', async ({ page }) => {
      await page.goto('http://localhost/media-test');
      await page.addScriptTag({
        content: bundle(surface, false, false, undefined, {
          kind: 'audio',
          mode: 'closed',
          scoped: true,
        }),
      });
      await expect(page.frameLocator('iframe').locator('#start-declarative')).toBeVisible();
      const frame = page.frames()[1];
      await expect.poll(() => frame.evaluate('!!window.declarativeRoot')).toBe(true);
      await page.frameLocator('iframe').locator('#start-declarative').click();
      await expect
        .poll(() =>
          frame.evaluate(
            '!declarativeRoot.querySelector("audio").paused && declarativeRoot.querySelector("audio").currentTime > 0',
          ),
        )
        .toBe(true);
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('mode()')).toBe(surface === 'app' ? 'paused' : 'idle');
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
    });

    for (const mode of ['open', 'closed'] as const) {
      for (const kind of ['audio', 'video'] as const) {
        for (const mediaFirst of [false, true]) {
          test(`coordinates declarative ${mode} ${kind} autoplay (mediaFirst=${mediaFirst})`, async ({
            page,
          }) => {
            const native = await page.context().newPage();
            try {
              const control = declarativeActivity({ kind, mode });
              await native.setContent(
                `<iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(control)}"></iframe>`,
              );
              await native
                .frameLocator('iframe')
                .getByRole('button', { name: 'Start declarative autoplay' })
                .click();
              await expect
                .poll(() =>
                  native.frames()[1].evaluate(() => {
                    const media = (
                      window as unknown as { declarativeRoot: ShadowRoot }
                    ).declarativeRoot.querySelector<HTMLMediaElement>('audio,video')!;
                    return !media.paused && media.currentTime > 0;
                  }),
                )
                .toBe(true);
              expect(await native.frames()[1].evaluate('nativeAttachCalls')).toBe(0);
            } finally {
              await native.close();
            }
            await page.goto('http://localhost/media-test');
            await page.addScriptTag({
              content: bundle(surface, false, false, undefined, { kind, mode }),
            });
            await expect(page.frameLocator('iframe').locator('#start-declarative')).toBeVisible();
            const frame = page.frames()[1];
            const state = () =>
              frame.evaluate(() => {
                const root = (window as unknown as { declarativeRoot: ShadowRoot }).declarativeRoot;
                const media = root.querySelector<HTMLMediaElement>('audio,video')!;
                return {
                  paused: media.paused,
                  time: media.currentTime,
                  mode: root.mode,
                  hidden: root.host.shadowRoot === null,
                  marker: !!root.querySelector('[data-maic-shadow-root]'),
                };
              });
            if (!mediaFirst) {
              await page.getByRole('button', { name: 'Narrate', exact: true }).click();
              await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
            }
            await page
              .frameLocator('iframe')
              .getByRole('button', { name: 'Start declarative autoplay' })
              .click();
            await expect
              .poll(async () => {
                const s = await state();
                return !s.paused && s.time > 0;
              })
              .toBe(true);
            expect(await frame.evaluate('declarativePlayCalls')).toBe(0);
            expect(await frame.evaluate('nativeAttachCalls')).toBe(0);
            expect(await state()).toMatchObject({ mode, hidden: mode === 'closed', marker: false });
            if (!mediaFirst) await expect.poll(() => page.evaluate('mode()')).toBe('paused');
            await page.getByRole('button', { name: 'Narrate', exact: true }).click();
            await expect.poll(async () => (await state()).paused).toBe(true);
            await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          });
        }
      }
      test(`coordinates an iframe in declarative ${mode} roots`, async ({ page }) => {
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({
          content: bundle(surface, false, false, undefined, { kind: 'iframe', mode }),
        });
        await expect(page.frameLocator('iframe').locator('#start-declarative')).toBeVisible();
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect
          .poll(() => page.frames().some((frame) => frame.name() === 'declarative-child'))
          .toBe(true);
        const child = page.frames().find((frame) => frame.name() === 'declarative-child')!;
        await child.getByRole('button', { name: 'Nested context' }).click();
        const state = () =>
          child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state);
        await expect.poll(state).toBe('running');
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(state).toBe('suspended');
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        expect(await page.frames()[1].evaluate('nativeAttachCalls')).toBe(0);
      });
      test(`guards an uninstrumented iframe in declarative ${mode} roots`, async ({ page }) => {
        await page.route('http://external.test/declarative', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<button onclick="window.ctx=new AudioContext();const o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()">Raw context</button>',
          }),
        );
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({
          content: bundle(surface, false, false, undefined, { kind: 'raw', mode }),
        });
        await expect(page.frameLocator('iframe').locator('#start-declarative')).toBeVisible();
        const activity = page.frames()[1];
        const guarded = () =>
          activity.evaluate(() => {
            const root = (window as unknown as { declarativeRoot: ShadowRoot }).declarativeRoot;
            return !!root.querySelector('button') && !root.querySelector('iframe');
          });
        await expect.poll(guarded).toBe(true);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        const open = await activity.evaluateHandle(
          () =>
            (window as unknown as { declarativeRoot: ShadowRoot }).declarativeRoot.querySelector(
              'button',
            )!,
        );
        await open.click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect
          .poll(() => page.frames().some((frame) => frame.name() === 'declarative-raw'))
          .toBe(true);
        const child = page.frames().find((frame) => frame.name() === 'declarative-raw')!;
        await child.getByRole('button', { name: 'Raw context' }).click();
        await expect
          .poll(() => child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state))
          .toBe('running');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(guarded).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      });
    }

    for (const mode of ['open', 'closed'] as const) {
      test(`coordinates nested native WebAudio in ${mode} shadow roots`, async ({ page }) => {
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        await page.frames()[1].evaluate((mode) => {
          const host = document.createElement('div');
          document.body.append(host);
          const root = host.attachShadow({ mode });
          const nestedHost = document.createElement('div');
          root.append(nestedHost);
          const nestedRoot = nestedHost.attachShadow({ mode });
          const frame = document.querySelector<HTMLIFrameElement>('#nested')!;
          frame.style.display = 'block';
          nestedRoot.append(frame);
        }, mode);
        await expect.poll(() => page.frames()[1].childFrames()[0]?.childFrames().length).toBe(1);
        const inner = page.frames()[1].childFrames()[0].childFrames()[0];
        await inner.getByRole('button', { name: 'Nested context' }).click();
        const state = () =>
          inner.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state);
        await expect.poll(state).toBe('running');
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(state).toBe('suspended');
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      });

      test(`guards an uninstrumented iframe inserted into a new ${mode} shadow root`, async ({
        page,
      }) => {
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        const activity = page.frames()[1];
        await activity.evaluate(async (mode) => {
          const host = document.createElement('div');
          document.body.append(host);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const root = host.attachShadow({ mode });
          (window as unknown as { shadowForTest: ShadowRoot }).shadowForTest = root;
          await new Promise((resolve) => setTimeout(resolve, 0));
          const frame = document.createElement('iframe');
          frame.title = 'Shadow activity';
          frame.name = 'shadow-raw';
          frame.sandbox.add('allow-scripts');
          frame.srcdoc =
            '<button onclick="window.ctx=new AudioContext();let o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()">Native context activity</button>';
          root.append(frame);
        }, mode);
        const button = () =>
          activity.evaluateHandle(
            () =>
              (window as unknown as { shadowForTest: ShadowRoot }).shadowForTest.querySelector(
                'button',
              )!,
          );
        await expect
          .poll(() =>
            activity.evaluate(
              () =>
                !!(window as unknown as { shadowForTest: ShadowRoot }).shadowForTest.querySelector(
                  'button',
                ),
            ),
          )
          .toBe(true);
        const open = await button();
        await open.click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect
          .poll(() => page.frames().some((frame) => frame.name() === 'shadow-raw'))
          .toBe(true);
        const child = page.frames().find((frame) => frame.name() === 'shadow-raw')!;
        await child.getByRole('button', { name: 'Native context activity' }).click();
        await expect
          .poll(() => child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state))
          .toBe('running');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect
          .poll(() =>
            activity.evaluate(() => {
              const root = (window as unknown as { shadowForTest: ShadowRoot }).shadowForTest;
              return !!root.querySelector('button') && !root.querySelector('iframe');
            }),
          )
          .toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      });
    }

    test('keeps source-less document access governed by the opaque sandbox', async ({ page }) => {
      const probe = () => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        try {
          frame.contentWindow!.document.write('<p id="authored">Authored content</p>');
          return { writable: true, error: null };
        } catch (error) {
          return { writable: false, error: (error as Error).name };
        } finally {
          frame.remove();
        }
      };
      expect(await page.frames()[1].evaluate(probe)).toEqual({
        writable: false,
        error: 'SecurityError',
      });
      const control = await page.context().newPage();
      try {
        for (const trusted of [false, true]) {
          await control.setContent(
            `<iframe sandbox="allow-scripts${trusted ? ' allow-same-origin' : ''}" srcdoc="<body>Native control</body>"></iframe>`,
          );
          expect(await control.frames()[1].evaluate(probe)).toEqual(
            trusted ? { writable: true, error: null } : { writable: false, error: 'SecurityError' },
          );
        }
      } finally {
        await control.close();
      }
    });

    test('restores bridge-suspended WebAudio on a later user gesture without authored resume', async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await page.frameLocator('iframe').locator('#reuse-context').click();
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      const child = page.frames()[1];
      const state = () =>
        child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state);
      await expect.poll(state).toBe('suspended');
      await page.frameLocator('iframe').locator('#reuse-context').click();
      await expect.poll(state).toBe('running');
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(state).toBe('suspended');
      await child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.suspend());
      await page.frameLocator('iframe').locator('#reuse-context').click();
      await expect.poll(state).toBe('suspended');
      expect(await page.evaluate('mode()')).toBe('playing');
    });

    for (const media of ['audio', 'video', 'context']) {
      test(`coordinates nested srcdoc ${media} across two levels`, async ({ page }) => {
        await finishFrameLoad(page);
        await page.frames()[1].evaluate(() => {
          document.querySelector<HTMLIFrameElement>('#nested')!.style.display = 'block';
        });
        const nested = page.frameLocator('iframe').frameLocator('#nested').frameLocator('#inner');
        const child = page
          .frames()
          .find((f) => f.parentFrame()?.parentFrame()?.parentFrame() === page.mainFrame());
        expect(child, 'nested media frame must attach').toBeDefined();
        const state = () =>
          child!.evaluate(
            (kind) =>
              kind === 'context'
                ? (window as unknown as { ctx: AudioContext }).ctx.state
                : document.querySelector<HTMLMediaElement>(kind)!.paused,
            media,
          );
        try {
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          await nested.locator('#' + media).click();
          await expect.poll(state).toBe(media === 'context' ? 'running' : false);
          if (media !== 'context')
            await expect
              .poll(() =>
                child!.evaluate(
                  (kind) => document.querySelector<HTMLMediaElement>(kind)!.currentTime,
                  media,
                ),
              )
              .toBeGreaterThan(0);
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect.poll(state).toBe(media === 'context' ? 'suspended' : true);
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        } finally {
          if (child && !child.isDetached())
            await child.evaluate(async () => {
              document
                .querySelectorAll<HTMLMediaElement>('audio,video')
                .forEach((element) => element.pause());
              await (window as unknown as { ctx?: AudioContext }).ctx?.close();
            });
        }
      });
    }

    if (surface === 'app') {
      test('queues widget actions while a URL frame is closed and flushes once after reopening', async ({
        page,
      }) => {
        await page.route('http://external.test/activity', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<p id="external">External widget</p><script>window.received=[];window.addEventListener("message",event=>{if(event.data?.type==="SET_WIDGET_STATE")received.push(event.data.value)});</script>',
          }),
        );
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({ content: bundle('app', false, true) });
        const open = page.getByRole('button', {
          name: 'chat.externalInteractive.open',
          exact: true,
        });
        await open.click();
        await expect(page.frameLocator('iframe').locator('#external')).toBeVisible();
        await expect.poll(() => page.evaluate('widgetReady()')).toBe(true);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('iframe')).toHaveCount(0);
        await page.evaluate('sendWidget(42)');
        expect(await page.evaluate('pendingWidgets()')).toBe(1);
        expect(await page.evaluate('widgetReady()')).toBe(false);
        await open.click();
        await expect(page.frameLocator('iframe').locator('#external')).toBeVisible();
        await expect.poll(() => page.frames()[1].evaluate('window.received')).toEqual([42]);
        expect(await page.evaluate('pendingWidgets()')).toBe(0);
        await page.getByRole('button', { name: 'Navigate', exact: true }).click();
        await expect(page.locator('iframe')).toHaveCount(0);
        await page.evaluate('sendWidget(43)');
        expect(await page.evaluate('pendingWidgets()')).toBe(1);
        await page.getByRole('button', { name: 'Navigate', exact: true }).click();
        await open.click();
        await expect(page.frameLocator('iframe').locator('#external')).toBeVisible();
        await expect.poll(() => page.frames()[1].evaluate('window.received')).toEqual([43]);
        expect(await page.evaluate('pendingWidgets()')).toBe(0);
      });

      for (const media of ['audio', 'context']) {
        test(`coordinates uninstrumented URL ${media} by unloading before narration and reopening explicitly`, async ({
          page,
        }) => {
          await page.route('http://external.test/activity', (route) =>
            route.fulfill({ contentType: 'text/html', body: nestedMedia }),
          );
          await page.goto('http://localhost/media-test');
          await page.addScriptTag({ content: bundle('app', false, true) });
          await expect(page.locator('iframe')).toHaveCount(0);
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          await page
            .getByRole('button', { name: 'chat.externalInteractive.open', exact: true })
            .click();
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
          const frame = page.frameLocator('iframe');
          await frame.locator('#' + media).click();
          const child = page.frames()[1];
          await expect
            .poll(() =>
              child.evaluate(
                (kind) =>
                  kind === 'context'
                    ? (window as unknown as { ctx: AudioContext }).ctx.state
                    : document.querySelector<HTMLMediaElement>('audio')!.currentTime > 0,
                media,
              ),
            )
            .toBe(media === 'context' ? 'running' : true);
          expect(await page.locator('iframe').getAttribute('sandbox')).not.toContain(
            'allow-same-origin',
          );
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(page.locator('iframe')).toHaveCount(0);
          expect(child.isDetached()).toBe(true);
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
          await page
            .getByRole('button', { name: 'chat.externalInteractive.open', exact: true })
            .click();
          await expect(frame.locator('#audio')).toBeVisible();
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          expect(await page.frames()[1].evaluate('typeof window.ctx')).toBe('undefined');
          expect(await page.frames()[1].evaluate('document.querySelector("audio").paused')).toBe(
            true,
          );
        });
      }
      test('unloads a hidden URL before destination narration starts', async ({ page }) => {
        await page.route('http://external.test/activity', (route) =>
          route.fulfill({ contentType: 'text/html', body: nestedMedia }),
        );
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({ content: bundle('app', false, true) });
        await page
          .getByRole('button', { name: 'chat.externalInteractive.open', exact: true })
          .click();
        await page.frameLocator('iframe').locator('#context').click();
        const oldFrame = page.frames()[1];
        await expect.poll(() => oldFrame.evaluate('ctx.state')).toBe('running');
        await page.getByRole('button', { name: 'Next scene', exact: true }).click();
        await expect(page.locator('iframe')).toHaveCount(0);
        expect(oldFrame.isDetached()).toBe(true);
        await expect.poll(() => page.evaluate('window.destinationSpeechStarted')).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
      });
      for (const blocked of [false, true]) {
        test(`recovers a retained lecture at a non-speech discussion cursor (blocked=${blocked})`, async ({
          page,
        }) => {
          await finishFrameLoad(page);
          await page.evaluate('prepareDiscussion()');
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect.poll(() => page.evaluate('cursor()')).toBe(1);
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          expect(await page.evaluate('cursor()')).toBe(0);
          if (blocked) await startUnresponsiveFrame(page);
          await page.evaluate('prepareLiveLecture(true)');
          await page.getByRole('button', { name: 'Return from Q&A', exact: true }).click();
          if (blocked) {
            await expect.poll(() => page.evaluate('mode()')).toBe('paused');
            expect(await page.evaluate('lectureText')).toBe('');
            expect(await page.evaluate('lectureActions')).toBe(0);
            await page.frames()[1].evaluate('window.blockMediaControls=false');
            await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          }
          await expect.poll(() => page.evaluate('lectureText')).toBe('Continued lecture text');
          await expect.poll(() => page.evaluate('lectureActions')).toBe(1);
          await expect.poll(() => page.evaluate('window.proactive')).toBe('delayed');
        });
      }

      test('holds retained lecture text and actions through failed Q&A recovery and resumes on retry', async ({
        page,
      }) => {
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        await startUnresponsiveFrame(page);
        await page.evaluate('prepareLiveLecture(true)');
        await page.getByRole('button', { name: 'Return from Q&A', exact: true }).click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(await page.evaluate('lectureText')).toBe('');
        expect(await page.evaluate('lectureActions')).toBe(0);
        await page.frames()[1].evaluate('window.blockMediaControls=false');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('lectureText')).toBe('Continued lecture text');
        await expect.poll(() => page.evaluate('lectureActions')).toBe(1);
        await expect.poll(() => page.evaluate('mode()')).toBe('playing');
      });
      test('waits for hidden pooled WebAudio while navigation completes', async ({ page }) => {
        const child = page.frames()[1];
        await child.evaluate(() => {
          const native = AudioContext.prototype.suspend;
          AudioContext.prototype.suspend = function () {
            return new Promise<void>((resolve) => {
              (window as unknown as { finishSuspend: () => void }).finishSuspend = () => {
                void native.call(this).then(resolve);
              };
            });
          };
        });
        await page.frameLocator('iframe').locator('#context').click();
        await expect.poll(() => child.evaluate('ctx.state')).toBe('running');
        await page.getByRole('button', { name: 'Next scene', exact: true }).click();
        await expect(page.locator('iframe')).toBeHidden();
        await expect.poll(() => child.evaluate('typeof window.finishSuspend')).toBe('function');
        expect(await page.evaluate('Boolean(window.destinationSpeechStarted)')).toBe(false);
        expect(await child.evaluate('ctx.state')).toBe('running');
        await child.evaluate('finishSuspend()');
        await expect
          .poll(() => page.evaluate('Boolean(window.destinationSpeechStarted)'))
          .toBe(true);
        expect(await child.evaluate('ctx.state')).toBe('suspended');
      });

      test('parks destination narration when hidden pooled media cannot acknowledge silence', async ({
        page,
      }) => {
        await finishFrameLoad(page);
        await startUnresponsiveFrame(page);
        await page.getByRole('button', { name: 'Next scene', exact: true }).click();
        await expect(page.locator('iframe')).toBeHidden();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(await page.evaluate('Boolean(window.destinationSpeechStarted)')).toBe(false);
        expect(await page.evaluate('cursor()')).toBe(0);
      });

      test('continues prepaused lecture text after Q&A automatically returns', async ({ page }) => {
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        await page.evaluate('prepareLiveLecture(true)');
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('liveBufferPaused()')).toBe(true);
        await page.getByRole('button', { name: 'Return from Q&A', exact: true }).click();
        await expect.poll(() => page.evaluate('lectureText')).toBe('Continued lecture text');
        await expect.poll(() => page.evaluate('lectureActions')).toBe(1);
      });

      test('keeps continued lecture text and actions flowing after iframe media pauses live Q&A', async ({
        page,
      }) => {
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.evaluate('prepareLiveLecture()');
        expect(await page.evaluate('mode()')).toBe('live');
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('liveBufferPaused()')).toBe(true);
        expect(await page.evaluate('mode()')).toBe('live');
        await page.getByRole('button', { name: 'Return from Q&A', exact: true }).click();
        await expect.poll(() => page.evaluate('lectureText')).toBe('Continued lecture text');
        await expect.poll(() => page.evaluate('lectureActions')).toBe(1);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      });

      test('restores the second speech after a composer interruption during frame silence preflight', async ({
        page,
      }) => {
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        const child = page.frames()[1];
        await child.evaluate('window.blockMediaControls=true');
        await finishNarration(page);
        await expect.poll(() => child.evaluate('window.blockedPauses||0')).toBe(1);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await page.evaluate('finishInterruption()');
        expect(await page.evaluate('cursor()')).toBe(1);
        await child.evaluate('window.blockMediaControls=false');
        await page.getByRole('button', { name: 'Continue lecture', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('cursor()')).toBe(2);
      });

      for (const blocked of [false, true]) {
        test(`waits for iframe silence before joining a visible proactive discussion (blocked=${blocked})`, async ({
          page,
        }) => {
          await finishFrameLoad(page);
          await page.evaluate('prepareDiscussion()');
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect.poll(() => page.evaluate('window.proactive')).toBe('delayed');
          if (blocked) await startUnresponsiveFrame(page);
          else await page.frameLocator('iframe').locator('#audio').click();
          await expect
            .poll(() => page.frames()[1].evaluate('!document.querySelector("audio").paused'))
            .toBe(true);
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          await page.getByRole('button', { name: 'Join discussion', exact: true }).click();
          await page.evaluate('window.joinPending');
          if (blocked) {
            if (await page.evaluate('window.joined'))
              await expect.poll(() => page.evaluate('window.joinedActions')).toBe(1);
            console.log(
              'Proactive Join state',
              await page.evaluate(
                '({mode:mode(),joined:window.joined,text:window.joinedText,actions:window.joinedActions})',
              ),
            );
            expect(await page.evaluate('window.joined')).toBe(false);
            expect(await page.evaluate('window.joinedText')).toBe('');
            expect(await page.evaluate('window.joinedActions')).toBe(0);
            expect(await page.frames()[1].evaluate('document.querySelector("audio").paused')).toBe(
              false,
            );
            await page.frames()[1].evaluate('window.blockMediaControls=false');
            await page.getByRole('button', { name: 'Join discussion', exact: true }).click();
            await page.evaluate('window.joinPending');
          }
          expect(await page.frames()[1].evaluate('document.querySelector("audio").paused')).toBe(
            true,
          );
          await expect.poll(() => page.evaluate('window.joinedText')).toBe('Joined response');
          await expect.poll(() => page.evaluate('window.joinedActions')).toBe(1);
          expect(await page.evaluate('mode()')).toBe('live');
        });
      }

      test('retains a delayed discussion when frame media pauses the engine', async ({ page }) => {
        await page.evaluate('prepareDiscussion()');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('proactive')).toBe('delayed');
        expect(await page.evaluate('narrationPaused()')).toBe(true);
        await page.evaluate('skipDiscussion()');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      });

      test('parks real AudioPlayer byte loading when frame media starts and retries the same line', async ({
        page,
      }) => {
        let release!: () => void;
        let requests = 0;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route('http://localhost/narration.wav', async (route) => {
          if (++requests === 1) await blocked;
          await route.fulfill({
            contentType: 'audio/wav',
            body: Buffer.from(audio.split(',')[1], 'base64'),
          });
        });
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => requests).toBe(1);
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(await page.evaluate('cursor()')).toBe(0);
        release();
        expect(await page.evaluate('narrationPaused()')).toBe(true);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => requests).toBe(2);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('cursor()')).toBe(1);
      });
    }

    if (surface === 'standalone') {
      test('restarts from the final iframe while it ignores silence controls', async ({ page }) => {
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({ content: bundle(surface, true) });
        await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await finishNarration(page);
        await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await finishNarration(page);
        await expect.poll(() => page.evaluate('mode()')).toBe('idle');
        await startUnresponsiveFrame(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('sceneIndex()')).toBe(0);
        await expect(page.locator('iframe')).toHaveCount(0);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('caption()')).toBe('Narration');
      });

      test('continues from holding while the departing frame ignores silence controls', async ({
        page,
      }) => {
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await finishNarration(page);
        await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await finishNarration(page);
        await expect.poll(() => page.evaluate('mode()')).toBe('holding');
        await startUnresponsiveFrame(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('iframe')).toHaveCount(0);
        await expect.poll(() => page.evaluate('mode()')).toBe('idle');
      });

      test('retains a second narration after a silence timeout and retries it on Play', async ({
        page,
      }) => {
        await page.frameLocator('iframe').locator('#audio').click();
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              'Number.isFinite(audios[0].duration) && audios[0].duration > 1 && !audios[0].paused',
            ),
          )
          .toBe(true);
        const child = page.frames()[1];
        await child.evaluate(() => {
          (window as unknown as { blockMediaControls: boolean }).blockMediaControls = true;
          (window as unknown as { playOnBlockedPause: boolean }).playOnBlockedPause = true;
        });
        // Seed clip completion: the local headless Firefox backend does not emit ended reliably.
        await finishNarration(page);
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(await page.evaluate('caption()')).toBe('Second narration');
        expect(await page.evaluate('narrationPaused()')).toBe(true);
        await child.evaluate(() => {
          (window as unknown as { blockMediaControls: boolean }).blockMediaControls = false;
        });
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('caption()')).toBe('Second narration');
        expect(await page.evaluate('mode()')).toBe('playing');
      });
    }

    test('preserves native safe HTML sanitization', async ({ page }) => {
      const source =
        '<p onclick="window.unsafeRan=true">Safe text</p><script>window.unsafeRan=true</script><audio controls data-safe="ok"></audio>';
      const parse = `(function(source){const container=document.createElement('div');if(typeof container.setHTML!=='function')return {supported:false};const result=container.setHTML(source);return {supported:true,html:container.innerHTML,result:typeof result,scripts:container.querySelectorAll('script').length,handler:container.querySelector('p').getAttribute('onclick')}})(${JSON.stringify(source)})`;
      const native = await page.context().newPage();
      try {
        await native.setContent(
          '<iframe sandbox="allow-scripts" srcdoc="<!doctype html><body></body>"></iframe>',
        );
        const control = await native.frames()[1].evaluate(parse);
        test.skip(!control.supported, 'Native safe HTML API is unavailable in this engine.');
        expect(control).toMatchObject({ scripts: 0, handler: null });
        expect(await page.frames()[1].evaluate(parse)).toEqual(control);
      } finally {
        await native.close();
      }
    });

    for (const creation of [
      'Audio',
      'createElement-audio',
      'createElement-video',
      'createElementNS-audio',
      'createElementNS-video',
      ...[
        'setHTML',
        'setHTMLUnsafe',
        'cloneContents',
        'insertAdjacentHTML',
        'outerHTML',
        'parser-first',
        'parser',
        'cloneNode',
        'importNode',
        'createContextualFragment',
        'innerHTML',
      ].flatMap((method) => ['audio', 'video'].map((tag) => `${method}-${tag}`)),
    ]) {
      test(`coordinates detached ${creation} playback and reuse`, async ({ page, browserName }) => {
        if (creation.startsWith('setHTML') || creation.startsWith('cloneContents')) {
          test.skip(
            !(await adjacentAutoplayStarts(
              page,
              creation.endsWith('video') ? 'video' : 'audio',
              creation.startsWith('setHTMLUnsafe')
                ? 'setHTMLUnsafe'
                : creation.startsWith('setHTML-')
                  ? 'setHTML'
                  : 'cloneContents',
            )),
            'Native API/autoplay does not start in the independent same-engine no-bridge control.',
          );
        }
        if (creation.startsWith('outerHTML')) {
          const starts = await adjacentAutoplayStarts(
            page,
            creation.endsWith('video') ? 'video' : 'audio',
            'outerHTML',
          );
          test.skip(
            !starts,
            'Detached outerHTML media does not start in the same-engine no-bridge native control.',
          );
        }
        if (creation.startsWith('insertAdjacentHTML') && browserName === 'chromium') {
          const starts = await adjacentAutoplayStarts(
            page,
            creation.endsWith('video') ? 'video' : 'audio',
          );
          test.skip(
            !starts,
            'Detached insertAdjacentHTML media does not start in the same-engine no-bridge native control.',
          );
        }
        test.skip(
          creation.startsWith('innerHTML') && browserName === 'chromium',
          'Detached parser-created media does not start in the Chromium no-bridge native control.',
        );
        await finishFrameLoad(page);
        const child = page.frames()[1];
        if (creation === 'parser-audio' || creation === 'parser-video') {
          await page
            .frameLocator('iframe')
            .locator('#prime-' + creation)
            .click();
          await expect.poll(() => child.evaluate('window.parserPrimed')).toBe(true);
        }
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        for (let i = 0; i < 2; i++) {
          const starts = await child.evaluate<number>('window.autoplayEvents');
          await page
            .frameLocator('iframe')
            .locator(creation === 'Audio' ? '#autoplay' : '#autoplay-' + creation)
            .click();
          // Confirm native playback actually started before asserting bridge behavior.
          await expect.poll(() => child.evaluate('window.autoplayEvents')).toBeGreaterThan(starts);
          await expect.poll(() => child.evaluate('autoplayAudio.currentTime')).toBeGreaterThan(0);
          expect(await child.evaluate('window.explicitPlayCalls')).toBe(0);
          expect(await child.evaluate('autoplayAudio.paused')).toBe(false);
          expect(await child.evaluate('autoplayAudio.isConnected')).toBe(false);
          await expect.poll(() => page.evaluate('mode()')).toBe('paused');
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'false');
          await page.getByRole('button', { name: 'Narrate', exact: true }).click();
          await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute(
            'data-autoplay-playing',
            'false',
          );
          await expect(page.locator('body')).toHaveAttribute('data-narration-playing', 'true');
        }
      });
    }

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
      const child = page.frames()[1];
      await child.evaluate(() => {
        const w = window as unknown as { releaseSuspension: () => void };
        const suspend = AudioContext.prototype.suspend;
        AudioContext.prototype.suspend = function () {
          const context = this;
          return new Promise<void>((resolve) => {
            w.releaseSuspension = () => {
              void suspend.call(context).then(resolve);
            };
          });
        };
      });
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
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
          .poll(() => old.locator('#a').evaluate((x: HTMLAudioElement) => x.paused))
          .toBe(true);
        // A hidden keep-alive page trying to restart itself must stay silent.
        await old.locator('#a').evaluate((x: HTMLAudioElement) => x.play().catch(() => {}));
        await expect
          .poll(() => old.locator('#a').evaluate((x: HTMLAudioElement) => x.paused))
          .toBe(true);
      } else await expect.poll(() => old.isDetached()).toBe(true);
      await page.getByRole('button', { name: 'Navigate', exact: true }).click();
      await expect
        .poll(() =>
          page
            .frames()[1]
            .locator('#a')
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
