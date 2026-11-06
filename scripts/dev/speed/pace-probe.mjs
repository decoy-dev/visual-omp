// Live omp 18.17 + production SessionHost + real encrypted collab + app renderer.
// Usage: node scripts/dev/speed/pace-probe.mjs --seconds 30 --repeats 2 --output /tmp/vomp-pace/evidence.json
import { build } from 'esbuild';
import Module from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { initializeFixture } from '../../live-preview-fixture/environment.mjs';
import { prepareScenario, checkout } from './scenario.mjs';
const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const seconds = Number(value('--seconds', 30));
const repeats = Number(value('--repeats', 2));
const burstMs = Number(value('--burst-ms', 600));
const burstChars = Number(value('--burst-chars', 140));
const output = resolve(value('--output', '/tmp/vomp-pace/evidence.json'));
const selectedBin = value('--omp', process.env.OMP_BIN);
const bin = resolve(selectedBin ?? execFileSync('which',['omp'],{encoding:'utf8'}).trim());
if (![seconds, repeats, burstMs, burstChars].every(n => Number.isFinite(n) && n > 0) || !Number.isInteger(repeats)) throw Error('Positive durations/counts required');
await mkdir(dirname(output), { recursive: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'vomp-pace-probe-')));
const report = { startedAt: new Date().toISOString(), root, seconds, repeats, burstMs, burstChars, trials: [], limitations: ['Development React/StrictMode renderer, no production CPU claim.', 'Visible cadence samples the actual paced data-streaming DOM on requestAnimationFrame; headless Chrome cannot establish subjective smoothness on a physical display.', 'Electron IPC is replaced with a private loopback WebSocket; real SessionHost publication, TSP parser, native extension, encrypted collab, GuestClient, controller/store and app renderers remain in use.', 'Source frames mean SSE content deltas emitted by the loopback provider, not inferred model tokens.', 'Text-only replies; no assertion about thinking, tool-argument reveal, open semantic overlays or reduced-motion behavior.'] };
const sourceRoot = args.includes('--source') ? await realpath(resolve(value('--source'))) : join(root,'source');
if (!args.includes('--source')) await cp(join(checkout,'src'),join(sourceRoot,'src'),{recursive:true});
report.sourceRoot = sourceRoot;
report.command = process.argv;
report.protocolSources = {
  appHello: 'src/main/omp/tsp/session.ts:235-238: features:[]; probe changes only its in-memory bundle',
  appPublication: 'src/main/omp/host.ts:496-518: 16ms publication and real host:tsp-patch',
  engineHello: '/tmp/omp-src-18.17/packages/tui/src/native/backend.ts:572-578: setNativePacing(hello feature pace)',
  enginePaceContract: '/tmp/omp-src-18.17/packages/tui/src/native/state.ts:44-59: terminal owns streaming md reveal',
  engineReveal: '/tmp/omp-src-18.17/packages/coding-agent/src/modes/controllers/event-controller.ts:377-384: !nativePacing() gates smooth reveal',
  engineBypass: '/tmp/omp-src-18.17/packages/coding-agent/src/modes/controllers/streaming-reveal.ts:328-341: stop timer, update full content',
  collabSource: '/tmp/omp-src-18.17/packages/coding-agent/src/collab/host.ts:476-479,715-723: session events, keyed sendLatest coalescing',
  visiblePacing: 'src/renderer/src/chat/transcript/pace.ts:4-16,152-166,368-384: independent app playout',
};
let host, vite, chrome, page, provider, eventsServer, eventSockets, profile;
let source = [];
let native = [];
let ipc = [];
let origin = 0;
let capture = false;
let providerDone = false;
let expectedText = '';
let providerFailure;
const h = globalThis.__paceProbe = { features: [], env: {}, bin, onNative(message) { if (capture) native.push({ at: Date.now() - origin, verb: message.verb }); }, broadcast(channel, ...args) { if (capture) ipc.push({ at: Date.now() - origin, channel }); for (const socket of eventSockets?.clients ?? []) if (socket.readyState === 1) socket.send(JSON.stringify({ channel, args })); } };
h.onWrite = data => { if(data.includes('"r":"hello"')) h.helloWire=data; };
const mocks = new Map([
  ['src/main/env.ts', 'export const userEnv=async()=>globalThis.__paceProbe.env; export const ptyEnv=env=>env;'],
  ['src/main/ipc.ts', 'export const broadcast=(...args)=>globalThis.__paceProbe.broadcast(...args);'],
  ['src/main/prefs.ts', 'export const getPrefs=()=>({theme:"light",reducedMotion:"off",classicPresentation:false});'],
  ['src/main/omp/locate.ts', 'export const ompPath=async()=>globalThis.__paceProbe.bin;'],
  ['src/main/omp/refused.ts', 'export const ompStartError=error=>error;'],
  ['src/main/omp/paths.ts', 'export const agentDir=()=>globalThis.__paceProbe.env.PI_CODING_AGENT_DIR; export const sessionsDir=()=>agentDir()+"/sessions";'],
  ['src/main/omp/sessions.ts', 'export const findSessionFile=async()=>null; export const onSessionsChanged=()=>()=>{};'],
  ['src/main/services/diagnostics/events.ts', 'export const writeDiagnostic=()=>{};'],
]);
const bundled = await build({ entryPoints: [join(checkout, 'scripts/dev/speed/pace-probe-backend.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': join(checkout, 'src/shared') }, plugins: [{ name: 'pace-desktop-boundary', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'probe' }));
  b.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ contents: 'export const BrowserWindow={getAllWindows:()=>[],getFocusedWindow:()=>null}; export const dialog={showMessageBox:async()=>({response:0})}; export const nativeTheme={on(){},removeListener(){},shouldUseDarkColors:false}; export const systemPreferences={getAnimationSettings:()=>({prefersReducedMotion:false})};', loader: 'js' }));
  b.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
    const relative = path.slice(checkout.length + 1);
    if (mocks.has(relative)) return { contents: mocks.get(relative), loader: 'ts' };
    if (relative !== 'src/main/omp/tsp/session.ts') return;
    let contents = await readFile(path, 'utf8');
    const hello = 'kinds: TSP_KINDS, features: []';
    const receive = 'receive(message: TspMessage): void {';
    const writer = 'this.#write = options.write;';
    if (!contents.includes(hello) || !contents.includes(receive) || !contents.includes(writer)) throw Error('TspSession probe anchors changed');
    contents = contents.replace(hello, 'kinds: TSP_KINDS, features: globalThis.__paceProbe.features')
      .replace(receive, receive + '\n globalThis.__paceProbe.onNative(message);')
      .replace(writer, 'this.#write = data => { globalThis.__paceProbe.onWrite(data); return options.write(data); };');
    return { contents, loader: 'ts' };
  });
} }] });
const backendModule = new Module(join(checkout, 'scripts/dev/speed/pace-probe.runtime.cjs'));
backendModule.filename = join(checkout, 'scripts/dev/speed/pace-probe.runtime.cjs');
backendModule.paths = Module._nodeModulePaths(checkout);
backendModule._compile(bundled.outputFiles[0].text, backendModule.filename);
const { SessionHost, setAppRendererUrl } = backendModule.exports;
function percentile(values, p) { const sorted = values.toSorted((a,b)=>a-b); return sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] ?? null; }
async function until(predicate, label, timeout = 60000) { const end = Date.now()+timeout; while (!await predicate()) { if (Date.now()>end) throw Error(`Timed out: ${label}`); await sleep(50); } }
async function connect(url) {
  const socket = new WebSocket(url); await once(socket, 'open'); let id=0; const pending=new Map();
  socket.on('message', bytes=>{ const message=JSON.parse(String(bytes)); const request=pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result); });
  return { close:()=>socket.close(), send(method,params={}) { const request=Promise.withResolvers(); const key=++id; const timer=setTimeout(()=>{pending.delete(key);request.reject(Error(`CDP timeout ${method}`));},60000); pending.set(key,{...request,timer});socket.send(JSON.stringify({id:key,method,params}));return request.promise; }, async evaluate(expression) { const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value; } };
}
const metrics = async()=>Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
const cpuSeconds = pid => { try { const text=execFileSync('ps',['-p',String(pid),'-o','time='],{encoding:'utf8'}).trim(); return text.split(':').reduce((sum,part)=>sum*60+Number(part),0); } catch { return null; } };
async function cleanupHost() {
  if (!host) return;
  const current=host; host=null; const pid=current.state.pid;
  const stopped=current.stop();
  const clean=await Promise.race([stopped.then(()=>true),sleep(10000,false)]);
  if(!clean && current.state.pid) { try { process.kill(current.state.pid,'SIGTERM'); } catch {} await Promise.race([stopped,sleep(5000)]); }
  if(current.state.phase!=='exited') throw Error(`Owned omp did not exit: ${current.state.pid}`);
  (report.cleanup??=[]).push({pid,phase:current.state.phase,exitCode:current.state.exitCode});
}
try {
  const versionEnv = await initializeFixture(join(root,'version'),'http://127.0.0.1:1/v1');
  report.omp = execFileSync(bin,['--version'],{env:versionEnv,encoding:'utf8'}).trim();
  if(report.omp!=='omp/18.17.0') throw Error(`Expected omp/18.17.0, received ${report.omp}`);
  provider=createServer(async(request,response)=>{
    try {
      if(request.method!=='POST'||request.url!=='/v1/chat/completions') { response.writeHead(404).end();return; }
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      if(body.model!=='preview')throw Error(`Unexpected model ${body.model}`);
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      const send=(delta,finish_reason=null)=>response.write(`data: ${JSON.stringify({id:'pace-fixture',object:'chat.completion.chunk',created:1793952000,model:'preview',choices:[{index:0,delta,finish_reason}]})}\n\n`);
      send({role:'assistant',content:''});
      const started=Date.now();const count=Math.ceil(seconds*1000/burstMs);
      expectedText='';providerDone=false;
      for(let index=0;index<count;index++) {
        await sleep(Math.max(0,started+index*burstMs-Date.now()));
        if(response.destroyed)return;
        const text=`Pace segment ${String(index).padStart(4,'0')}. The visible reply should keep making steady progress between provider bursts. `.padEnd(burstChars,'x').slice(0,burstChars);
        expectedText+=text;source.push({at:Date.now()-origin,index,chars:text.length});send({content:text});
      }
      await sleep(Math.max(0,started+seconds*1000-Date.now()));
      send({},'stop');response.end('data: [DONE]\n\n');providerDone=true;
    }catch(error){providerFailure=error.stack;if(!response.headersSent)response.writeHead(500);response.end(String(error));}
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const providerUrl=`http://127.0.0.1:${provider.address().port}/v1`;
  eventsServer=createServer((req,res)=>res.writeHead(404).end());eventSockets=new WebSocketServer({server:eventsServer});await new Promise(r=>eventsServer.listen(0,'127.0.0.1',r));
  const eventUrl=`ws://127.0.0.1:${eventsServer.address().port}`;
  await mkdir(join(root,'renderer'),{recursive:true});
  const data=await prepareScenario(join(root,'renderer'));
  data.entries=[];data.light=[];data.helpers=[];
  const { createServer:createVite }=await import('vite');const {default:react}=await import('@vitejs/plugin-react');const {default:tailwindcss}=await import('@tailwindcss/vite');
  profile=await mkdtemp(join(tmpdir(),'vomp-pace-chrome-'));
  vite=await createVite({
    configFile:false,root:join(sourceRoot,'src/renderer'),cacheDir:join(profile,'vite-cache'),
    plugins:[{
      name:'pace-only-instrumentation',enforce:'pre',
      async resolveId(id,importer) {
        if(importer&&!id.startsWith('.')&&!id.startsWith('/')&&!id.startsWith('\0')&&!id.startsWith('@shared/')&&!id.startsWith('@/')) {
          return this.resolve(id,join(checkout,'src/renderer/src/main.tsx'),{skipSelf:true});
        }
      },
      configureServer(server) {
        server.middlewares.use('/@pace-probe-renderer',async(req,res)=>{
          res.setHeader('content-type','text/javascript');
          res.end(await readFile(new URL('./pace-probe-renderer.js',import.meta.url),'utf8'));
        });
      },
      transform(code,id) {
        if(!id.endsWith('/collab/lib/client.ts'))return;
        const anchor='this.#socket.onFrame = frame => this.#applyFrameSafe(frame);';
        if(!code.includes(anchor))throw Error('GuestClient instrumentation anchor changed');
        return code.replace(anchor,'this.#socket.onFrame = frame => { window.__pace?.collab(frame); this.#applyFrameSafe(frame); };');
      },
    },react(),tailwindcss()],
    resolve:{alias:{
      '@shared':join(sourceRoot,'src/shared'),'@':join(sourceRoot,'src/renderer/src'),
      '@oh-my-pi/pi-wire':join(sourceRoot,'src/renderer/src/collab/wire/index.ts'),
      '@oh-my-pi/pi-utils/marked':'marked',
      '@oh-my-pi/pi-utils/math-delimiters':join(sourceRoot,'src/renderer/src/collab/math-delimiters.ts'),
      'tailwindcss':join(checkout,'node_modules/tailwindcss/index.css'),
      '@fontsource-variable/geist':join(checkout,'node_modules/@fontsource-variable/geist/index.css'),
      '@fontsource-variable/geist-mono':join(checkout,'node_modules/@fontsource-variable/geist-mono/index.css'),
    }},
    server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[sourceRoot,checkout,await realpath(join(checkout,'node_modules'))]}},
  });
  await vite.listen();const url=vite.resolvedUrls.local[0];setAppRendererUrl(url);
  chrome=spawn(process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const ready=Promise.withResolvers();let chromeLog='';chrome.stderr.on('data',bytes=>{chromeLog+=bytes;const match=chromeLog.match(/DevTools listening on (ws:\/\/\S+)/);if(match)ready.resolve(new URL(match[1]));});chrome.once('error',ready.reject);
  const endpoint=await Promise.race([ready.promise,sleep(20000).then(()=>{throw Error('Chrome startup timed out')})]);
  const target=await fetch(`http://${endpoint.host}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());page=await connect(target.webSocketDebuggerUrl);
  report.browser=await page.send('Browser.getVersion');await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Performance.enable');await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  const preload=await readFile(new URL('./preload.js',import.meta.url),'utf8');
  const bridge=`(()=>{
    const handlers=new Map();
    const oldOn=window.vomp.on;
    window.vomp.on=(channel,callback)=>{
      const set=handlers.get(channel)||new Set();handlers.set(channel,set);set.add(callback);
      const off=oldOn(channel,callback);return()=>{set.delete(callback);off();};
    };
    const invoke=window.vomp.invoke;
    window.vomp.invoke=async(channel,...args)=>{
      if(channel==='omp:status')return {found:true,supported:true,version:'18.17.0',path:${JSON.stringify(bin)}};
      if(channel==='host:tsp-snapshot')return window.__paceSnapshot??null;
      if(['host:tsp-questions','host:tsp-resize','host:resize'].includes(channel))return;
      return invoke(channel,...args);
    };
    const socket=new WebSocket(${JSON.stringify(eventUrl)});
    socket.onopen=()=>window.__paceBridgeReady=true;
    socket.onmessage=event=>{
      const {channel,args}=JSON.parse(event.data);
      for(const callback of handlers.get(channel)||[])callback(...args);
    };
  })();`;
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__speedScenario=${JSON.stringify(data)};${preload}\n${bridge}`});
  for(let index=0;index<repeats*2;index++) {
    // ABBA balances both arms against warming and drift when repeats=2.
    const pace=Math.floor(index/2)%2===0 ? index%2===1 : index%2===0;
    const label=`${String(index+1).padStart(2,'0')}-${pace?'pace':'empty'}`;
    const trialRoot=join(root,label);h.env=await initializeFixture(trialRoot,providerUrl);h.features=pace?['pace']:[];
    await page.send('Page.navigate',{url});await until(()=>page.evaluate("!!document.querySelector('[role=log]') && window.__paceBridgeReady"),'app boot');await page.evaluate("import('/@pace-probe-renderer')");
    host=new SessionHost({cwd:join(trialRoot,'work'),extraArgs:['--no-extensions','--no-skills','--no-rules','--no-context-files','--no-lsp','--no-title','--model','fixture/preview','--thinking','off']});
    await host.start();await until(()=>{if(host.state.phase==='exited')throw Error(host.state.error??'omp exited');return host.state.phase==='live'&&!!host.state.link&&host.tspSnapshot()?.availability.available;},'live host');
    await page.evaluate(`window.__paceSnapshot=${JSON.stringify(host.publishedTspSnapshot())};window.__pace.attach(${JSON.stringify(host.state)})`);
    await until(()=>page.evaluate("window.__pace.state().hasGuest && window.__pace.state().mode==='live' && window.__pace.state().guest==='live'"),'live renderer');
    await sleep(1000);
    source=[];native=[];ipc=[];providerDone=false;providerFailure=null;expectedText='';origin=Date.now();capture=true;
    await page.evaluate('window.__pace.reset()');
    const before=await metrics();let previous=before;let previousWall=Date.now();const cpuBefore=cpuSeconds(host.state.pid);let previousCpu=cpuBefore;
    const perSecond=[];
    let submissionFailure;
    const submission=host.submit('Write the isolated pace measurement reply.').catch(error=>{submissionFailure=error;});
    const deadline=Date.now()+(seconds+30)*1000;
    while(!providerDone) {
      if(submissionFailure)throw submissionFailure;
      if(providerFailure)throw Error(providerFailure);
      if(Date.now()>deadline)throw Error('Provider capture timed out');
      await sleep(1000);const next=await metrics();const now=Date.now();const cpu=cpuSeconds(host.state.pid);const span=(now-previousWall)/1000;
      perSecond.push({at:now-origin,wallMs:now-previousWall,mainThreadBusyPercent:100*(next.TaskDuration-previous.TaskDuration)/span,scriptMsPerSecond:1000*(next.ScriptDuration-previous.ScriptDuration)/span,layoutMsPerSecond:1000*(next.LayoutDuration-previous.LayoutDuration)/span,ompCpuPercent:cpu!==null&&previousCpu!==null?100*(cpu-previousCpu)/span:null});previous=next;previousWall=now;previousCpu=cpu;
    }
    await submission;if(submissionFailure)throw submissionFailure;await sleep(1500);
    const after=await metrics();const raw=await page.evaluate('window.__pace.read()');const cpuAfter=cpuSeconds(host.state.pid);capture=false;await page.evaluate('window.__pace.stop()');
    const duration=(Date.now()-origin)/1000;
    const frameTimes=raw.frames.map(row=>row.ms);const gaps=raw.changes.map(row=>row.gapMs).filter(value=>value!==null);
    const text=await page.evaluate(`document.querySelector('[role="log"]')?.innerText??''`);
    const finalPresent=text.includes(expectedText);
    const steadyChanges=raw.changes.filter(row=>row.at>=2000&&row.at<=seconds*1000);
    const nativeFrames=native.filter(row=>row.verb==='f');const collabUpdates=raw.collab.filter(row=>row.kind==='message_update');
    for(const row of perSecond) {
      const from=row.at-row.wallMs,to=row.at;
      const within=items=>items.filter(item=>item.at>=from&&item.at<to);
      row.sourceFrames=within(source).length;
      row.nativeTspFrames=within(nativeFrames).length;
      row.collabFrames=within(raw.collab).length;
      row.collabMessageUpdates=within(collabUpdates).length;
      const visible=within(raw.changes);
      row.visibleChanges=visible.length;
      row.visibleChars=raw.changes.findLast(item=>item.at<to)?.chars??0;
      row.visibleGapP95Ms=percentile(visible.map(item=>item.gapMs).filter(value=>value!==null),.95);
      row.frameP95Ms=percentile(within(raw.frames).map(item=>item.ms),.95);
    }
    const trial={label,features:h.features,root:trialRoot,pid:host.state.pid,durationSeconds:duration,sourceFrames:source.length,sourceChars:expectedText.length,nativeTspFrames:nativeFrames.length,collabFrames:raw.collab.length,collabMessageUpdates:collabUpdates.length,tspPatches:ipc.filter(row=>row.channel==='host:tsp-patch').length,mainThreadBusyPercent:100*(after.TaskDuration-before.TaskDuration)/duration,ompCpuPercent:cpuAfter!==null&&cpuBefore!==null?100*(cpuAfter-cpuBefore)/duration:null,frameP50Ms:percentile(frameTimes,.5),frameP95Ms:percentile(frameTimes,.95),frameMaxMs:Math.max(...frameTimes),visibleChanges:raw.changes.length,steadyVisibleChangesPerSecond:steadyChanges.length/Math.max(1,seconds-2),visibleGapP95Ms:percentile(gaps,.95),visibleGapMaxMs:Math.max(...gaps),finalTextMatches:finalPresent,expectedChars:expectedText.length,viewportVisibleChanges:raw.changes.filter(row=>row.inViewport).length,raw,source,native,ipc,perSecond,screenReadAttempts:host.screenReadAttempts()};
    trial.helloWire=h.helloWire;
    trial.screenshot=output.replace(/\.json$/,'')+`-${label}.png`;await writeFile(trial.screenshot,Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    report.trials.push(trial);await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...trial,raw:undefined,source:undefined,native:undefined,ipc:undefined,perSecond:undefined}));
    if(!finalPresent||!raw.changes.length||!nativeFrames.length||!collabUpdates.length||raw.current?.visibility!=='visible')throw Error('Capture missing real protocol, visible stream or exact settled text');
    await cleanupHost();
  }
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);if(page)report.failureContext=await page.evaluate('({text:document.body.innerText.slice(-8000),pace:window.__pace?.state(),unhandled:[...(window.__speedUnhandled??[])]})').catch(()=>null);}
finally {
  capture=false;
  await cleanupHost().catch(error=>{report.cleanupFailure=error.stack;process.exitCode=1;});
  page?.close();for(const socket of eventSockets?.clients??[])socket.terminate();eventSockets?.close();eventsServer?.close();provider?.closeAllConnections();provider?.close();
  if(chrome&&chrome.exitCode===null){const exit=once(chrome,'exit');chrome.kill();if(!await Promise.race([exit.then(()=>true),sleep(3000,false)])){chrome.kill('SIGKILL');await exit;}report.chromeStopped=true;}
  await vite?.close();if(profile)await rm(profile,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');
}
process.exit(process.exitCode??0);
