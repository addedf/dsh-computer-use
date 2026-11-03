/** Real-model acceptance: one task, at most 120 seconds, through installed DSH.
 * Uses a temporary overlay and fixture; never modifies provider/home configuration.
 * Run: node verify-agent.mjs [evidence.json]; --prepare checks composition only.
 * --bridge [evidence.json] starts fixture + source-tool CLI bridge only; a
 * separately authorized connected DSH agent must perform the real model task.
 * Stop that bridge with: node <printed-client-path> __shutdown.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sourcePlugin from './index.js'

const cli = process.env.DSH_VERIFY_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const prepareOnly = process.argv.includes('--prepare')
const bridgeMode = process.argv.includes('--bridge')
const requestedOutput = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const root = requestedOutput ? dirname(resolve(requestedOutput)) : await mkdtemp(join(tmpdir(), 'dsh-agent-'))
await mkdir(root, { recursive: true })
const evidencePath = requestedOutput ? resolve(requestedOutput) : join(root, 'evidence.json')
const tracePath = join(root, 'tool-trace.jsonl')
const sourcePath = fileURLToPath(new URL('./index.js', import.meta.url))
const fixtureId = randomBytes(5).toString('hex')
const dispatchCode = `QA-${randomBytes(5).toString('hex').toUpperCase()}`
const confirmation = `CONF-${randomBytes(5).toString('hex').toUpperCase()}`
const fullName = `Acceptance ${fixtureId}`
const serverState = { pageReads: [], briefReads: 0, submissions: [], completed: false }
const evidence = { startedAt: new Date().toISOString(), environment: 'real installed DSH headless + current source plugin + real model + isolated Playwright browser', taskBudget: { tasks: 1, perTaskMs: 120000 }, fixtureId, sourcePath, server: serverState }
const html = (body) => `<!doctype html><meta charset="utf-8"><title>Browser acceptance</title><style>body{font:18px system-ui;max-width:700px;margin:40px}label,input,select{display:block;margin:12px 0}input,select,button{font-size:18px}a{display:block;margin:20px}</style>${body}`
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (req.method === 'GET' && path === '/') {
    serverState.pageReads.push('form')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html(`<h1>测试登记</h1><button id="start">开始登记</button><div id="area" role="status"></div><script>
      document.querySelector('#start').onclick=()=>{document.querySelector('#area').textContent='正在准备表单…';setTimeout(()=>{document.querySelector('#area').innerHTML='<form id="form"><label>Full name<input name="fullName" required></label><label>Service level<select name="level"><option>Standard</option><option>Express</option></select></label><a href="/brief" target="_blank">View dispatch brief</a><label>Dispatch code<input name="code" required></label><label><input name="confirmed" type="checkbox" required>I confirm this is a test entry</label><button>Confirm registration</button></form><p id="result" role="status"></p>';document.querySelector('#form').onsubmit=async(e)=>{e.preventDefault();document.querySelector('#result').textContent='登记处理中…';const f=new FormData(e.target);const response=await fetch('/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:f.get('fullName'),level:f.get('level'),code:f.get('code'),confirmed:f.get('confirmed')==='on',fixture:'${fixtureId}'})});const data=await response.json();setTimeout(()=>{document.querySelector('#result').textContent=data.message},500)}},350)};
    </script>`))
  } else if (req.method === 'GET' && path === '/brief') {
    serverState.pageReads.push('brief')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html(`<h1>Dispatch brief</h1><p id="code" role="status">正在加载调度说明…</p><script>setTimeout(async()=>{const d=await(await fetch('/brief-data')).json();document.querySelector('#code').textContent='Dispatch code: '+d.code},650)</script>`))
  } else if (req.method === 'GET' && path === '/brief-data') {
    serverState.briefReads++
    res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify({ code: dispatchCode }))
  } else if (req.method === 'POST' && path === '/complete') {
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 10000) { res.writeHead(413);res.end();return } }
    let value
    try { value = JSON.parse(body) } catch { res.writeHead(400);res.end();return }
    const valid = value.fullName === fullName && value.level === 'Express' && value.code === dispatchCode && value.confirmed === true && value.fixture === fixtureId
    serverState.submissions.push({ ...value, valid })
    if (valid) serverState.completed = true
    res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify({ message: valid ? `Registration complete. Confirmation: ${confirmation}` : 'Registration rejected: check the entered fields.' }))
  } else { res.writeHead(404);res.end('Not found') }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const policyPath = join(root, 'verification-policy.mjs')
const overlayPath = join(root, 'overlay.json')
const policySource = `import source from ${JSON.stringify(pathToFileURL(sourcePath).href)};
import { appendFileSync } from 'node:fs';
export const name='source-browser-acceptance';
export const inject=['tools','approval'];
const write=(value)=>appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({at:Date.now(),...value})+'\\n');
const origin=${JSON.stringify(origin)};
const allowed=(name)=>(/^browser_/.test(name)&&!['browser_upload','browser_download'].includes(name))||['run_steps','computer_skill','skill'].includes(name);
function route(agent){const effective=agent?.session?.requestHeader?.()?.config||agent?.options||{};return {provider:effective.provider,model:effective.model};}
export function apply(ctx){
 source.apply(ctx,{ttlMs:120000,maxElements:200,cursorTheme:'',browserBackend:'playwright',browserHeadless:true});
 write({kind:'source-mounted'});
 ctx.tools.guard((exec)=>{
   if(!allowed(exec.name)){write({kind:'denied',tool:exec.name});return 'Acceptance allows only the source browser tools.';}
   if(exec.name==='skill'&&!['dsh-browser','dsh-desktop'].includes(exec.arguments?.name))return 'Only the bundled browser skill is allowed.';
   const url=exec.arguments?.url;
   if(url&&['browser_open','browser_navigate','browser_tabs'].includes(exec.name)){try{if(new URL(url).origin!==origin&&url!=='about:blank')return 'Only this local acceptance fixture is allowed.';}catch{return 'Invalid fixture URL.'}}
 });
 ctx.on('agent/created',({agent})=>{
   const names=agent.ctx.tools.schemas(agent).map((tool)=>tool.name).filter(allowed);
   agent.ctx.tools.restrict({allow:names});write({kind:'agent-created',route:route(agent),tools:names});
 });
 ctx.on('tools/result',(exec,result)=>{
   const data=result.value?.data;
   write({kind:'tool-result',tool:exec.name,route:route(exec.agent),arguments:allowed(exec.name)?exec.arguments:undefined,isError:result.isError===true,ok:result.value?.ok,status:result.value?.status||data?.status,snapshotId:data?.snapshotId,refCount:data?.refs?.length,errorCode:result.error?.code});
 });
 ctx.on('dispose',()=>write({kind:'host-disposed'}));
}
export default {name,inject,apply};
`
await writeFile(policyPath, policySource)
const disable = ['session-title-llm','llm-retry','session-log-deepseek','session-telemetry-otel','session-persistence-jsonl','tool-bash','tool-pwsh','tool-fs','tool-fs-search','tool-web','tool-jobs','tool-plugin-manager','tool-subagent','tool-subagent-fork','tool-subagent-control','tool-subagent-list-agents','tool-workflow','tool-working-directory','goal-round-driver']
await writeFile(overlayPath, JSON.stringify([{ id:'tools',config:{mode:'native'} },...disable.map((id)=>({id,disabled:true})),{insert:[{id:'source-browser-acceptance',name:policyPath}]}],null,2))

function metadata(raw) {
  const routes=[];let current=''
  for(const line of raw.split('\n')){
    const id=line.match(/^\s*-\s*id:\s*([a-zA-Z0-9_.-]+)\s*$/);if(id)current=id[1]
    const match=line.match(/^\s*(provider|model):\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/)
    if(match&&current==='agent-default-model')routes.push({key:match[1],value:match[2]})
  }
  return { sourceOverlayPresent:raw.includes('source-browser-acceptance'),route:routes }
}
function classify(text, timedOut) {
  if(timedOut)return 'task_deadline_exceeded'
  if(/missing.credential|api.?key.*(?:missing|not set|required|not configured)|not.authenticated|no.credentials/i.test(text))return 'model_credentials_unavailable'
  if(/unknown.provider|provider.*not found|unknown.model|model.*not found/i.test(text))return 'model_route_unavailable'
  if(/ERR_MODULE_NOT_FOUND|Cannot find module|failed to load.*plugin/i.test(text))return 'plugin_mount_failed'
  if(/unauthorized|authentication|401|403/i.test(text))return 'model_authentication_failed'
  if(/unsupported.JSON.schema|INVALID_TOOL_OUTPUT|ToolOutputError/i.test(text))return 'tool_contract_failure'
  if(/ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(text))return 'model_network_failed'
  return 'agent_task_incomplete'
}
try {
  if (bridgeMode) {
    evidence.environment = 'real model in external DSH session via audited local CLI bridge; actual source tools; bridge host services are stubs'
    const registered = new Map(), listeners = new Map(), owner = { agent: { session: {} }, signal: new AbortController().signal }
    const isAllowed = (name) => (/^browser_/.test(name) && !['browser_upload','browser_download'].includes(name)) || ['run_steps','computer_skill'].includes(name)
    const invoke = async (name, args = {}) => {
      if (!isAllowed(name) || !registered.has(name)) throw new Error('Tool not admitted by browser acceptance bridge.')
      if (args.url && ['browser_open','browser_navigate','browser_tabs'].includes(name) && new URL(args.url).origin !== origin && args.url !== 'about:blank') throw new Error('Only this local fixture is admitted.')
      const value = await registered.get(name).execute(args, owner)
      evidence.trace ||= [];evidence.trace.push({at:Date.now(),tool:name,arguments:args,ok:value.ok,status:value.status,snapshotId:value.data?.snapshotId})
      for (const handler of listeners.get('tools/result') || []) await handler({name,arguments:args,agent:owner.agent},{value,isError:false})
      return value
    }
    const ctx = {
      get() {}, logger:{info(){}}, approval:{async request(){return 'denied'}},
      on(name,handler){const list=listeners.get(name)||[];list.push(handler);listeners.set(name,list);return()=>{}},
      tools:{register(tool){registered.set(tool.name,tool);return()=>{}},get(name){return registered.get(name)},async execute(request){const value=await invoke(request.name,request.arguments);return {value,isError:false,additionalContexts:[]}}},
    }
    sourcePlugin.apply(ctx,{ttlMs:120000,maxElements:200,cursorTheme:'',browserBackend:'playwright',browserHeadless:true})
    const socketPath=join(root,'tools.sock'), clientPath=join(root,'browser-call.mjs')
    let finishBridge
    const finished=new Promise((resolve)=>{finishBridge=resolve})
    const rpc=createServer(async(req,res)=>{
      try{
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)throw new Error('Input too large')}
        const message=JSON.parse(raw||'{}')
        let value
        if(message.tool==='__list')value=[...registered.values()].filter(tool=>isAllowed(tool.name)).map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}))
        else if(message.tool==='__status')value={completed:serverState.completed,briefReads:serverState.briefReads,submissions:serverState.submissions.map(value=>({valid:value.valid})),confirmation:serverState.completed?confirmation:undefined}
        else if(message.tool==='__shutdown'){value={closed:true};setTimeout(finishBridge,0)}
        else value=await invoke(message.tool,message.args||{})
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))
      }catch(error){res.statusCode=400;res.end(JSON.stringify({ok:false,result:error.message}))}
    })
    await new Promise((resolve)=>rpc.listen(socketPath,resolve))
    await writeFile(clientPath,`import {request} from 'node:http';const tool=process.argv[2]==='list'?'__list':process.argv[2];const data=JSON.stringify({tool,args:JSON.parse(process.argv[3]||'{}')});const req=request({socketPath:${JSON.stringify(socketPath)},path:'/',method:'POST',headers:{'Content-Type':'application/json'}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>{console.log(text);if(res.statusCode>=400)process.exitCode=1})});req.on('error',e=>{console.error(e.message);process.exitCode=1});req.end(data);\n`)
    const skillRoot=join(root,'.agents','skills','dsh-browser')
    await mkdir(skillRoot,{recursive:true})
    await writeFile(join(skillRoot,'SKILL.md'),await readFile(new URL('./skills/dsh-browser/SKILL.md',import.meta.url),'utf8'))
    await writeFile(join(root,'AGENTS.md'),`# Browser acceptance environment\nThe user task concerns only the local test site ${origin}. Actual source-plugin browser tools are available through the persistent CLI bridge. Use bash only to invoke: node ${clientPath} list, or node ${clientPath} TOOL_NAME 'JSON_ARGUMENTS'. This interface returns the real tools' schemas and canonical JSON values; select tools and refs from their observations yourself. Never use shell HTTP, filesystem inspection, arbitrary JavaScript, or other tools to bypass the browser. The bundled dsh-browser skill is available locally for the standard skill loader. The task itself supplies no element refs or action sequence.\n`)
    evidence.bridge={clientPath,socketPath,origin};evidence.status='bridge_ready';evidence.modelTaskRun=false
    await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n')
    console.log(JSON.stringify({status:'bridge_ready',clientPath,origin,evidencePath,fullName}))
    await finished
    for(const handler of listeners.get('dispose')||[])await handler()
    rpc.closeAllConnections();await new Promise((resolve)=>rpc.close(resolve))
    evidence.cleanup={pluginDisposeCallbacksAwaited:true,bridgeServerClosed:true}
    evidence.ok=serverState.completed&&serverState.briefReads>0&&evidence.trace?.some(item=>item.tool==='browser_type')
    evidence.status=evidence.ok?'bridge_fixture_passed':'bridge_fixture_incomplete'
  } else {
  const composed=execFileSync(cli,['headless','--patch',overlayPath,'--dump-config'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:10*1024*1024})
  evidence.composition=metadata(composed)
  if(!evidence.composition.sourceOverlayPresent)throw new Error('Source overlay was not composed.')
  if(prepareOnly){evidence.status='prepared';evidence.modelTaskRun=false}
  else {
    const task=`请在 ${origin}/ 完成一条测试登记：姓名填写「${fullName}」，Service level 选择 Express，Dispatch code 从网页提供的调度说明页查找；确认这是测试条目后完成登记。等待页面明确显示登记完成，再告诉我确认编号。只能操作这个本地测试站点。`
    evidence.prompt=task
    const started=Date.now();let stdout='',stderr='',timedOut=false
    const child=spawn(cli,['headless','--patch',overlayPath,'--json',task],{cwd:root,stdio:['ignore','pipe','pipe']})
    const soft=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},118000)
    const hard=setTimeout(()=>child.kill('SIGKILL'),120000)
    child.stdout.on('data',(chunk)=>{if(stdout.length<2*1024*1024)stdout+=chunk;else{timedOut=true;child.kill('SIGTERM')}})
    child.stderr.on('data',(chunk)=>{if(stderr.length<1024*1024)stderr+=chunk})
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)}).finally(()=>{clearTimeout(soft);clearTimeout(hard)})
    evidence.durationMs=Date.now()-started;evidence.exitCode=code;evidence.modelTaskRun=true
    let trace=[];try{trace=(await readFile(tracePath,'utf8')).split('\n').filter(Boolean).map((line)=>JSON.parse(line))}catch{}
    evidence.trace=trace
    evidence.route=trace.find((item)=>item.kind==='tool-result'&&item.route?.provider)?.route||trace.find((item)=>item.kind==='agent-created')?.route
    evidence.modelEventCount=stdout.split('\n').filter((line)=>{try{JSON.parse(line);return true}catch{return false}}).length
    evidence.confirmationMentioned=stdout.includes(confirmation)
    evidence.ok=code===0&&serverState.completed&&serverState.briefReads>0&&evidence.confirmationMentioned&&trace.some((item)=>item.kind==='tool-result'&&item.tool==='browser_type')
    evidence.status=evidence.ok?'passed':classify(stdout+'\n'+stderr,timedOut)
    // No raw stdout, stderr, composed config, provider responses, or credentials
    // are persisted: evidence records safe route/tool metadata and fixture data.
    evidence.diagnostics={stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr),timedOut,sourceMounted:trace.some((item)=>item.kind==='source-mounted')}
  }
  }
} catch(error){evidence.ok=false;evidence.status='setup_failed';evidence.errorCode=error.code||error.name}
finally {
  server.closeAllConnections();await new Promise((resolve)=>server.close(resolve))
  evidence.cleanup={...evidence.cleanup,fixtureServerClosed:true}
  evidence.finishedAt=new Date().toISOString()
  await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n')
  console.log(JSON.stringify({ok:evidence.ok,status:evidence.status,modelTaskRun:evidence.modelTaskRun,route:evidence.route||evidence.composition?.route,durationMs:evidence.durationMs,completed:serverState.completed,toolCalls:bridgeMode?evidence.trace?.length:evidence.trace?.filter((item)=>item.kind==='tool-result').length,evidencePath},null,2))
  if(evidence.ok===false)process.exitCode=1
}
