/** Real installed DSH + current plugin + native tools/skill/file authorization.
 * All writable DSH state lives in a fresh DSH_HOME. No shell bridge or fs stubs.
 * Explicit environment: DSH_VERIFY_PROVIDER, DSH_VERIFY_MODEL,
 * DSH_VERIFY_API_KEY_REF, DSH_VERIFY_CREDENTIALS (existing store, read-only).
 * --prepare composes the isolated configuration without calling a model.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHostFixture } from './tools/host-fixture.mjs'

const cli = process.env.DSH_VERIFY_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const provider = process.env.DSH_VERIFY_PROVIDER
const model = process.env.DSH_VERIFY_MODEL
const apiKeyRef = process.env.DSH_VERIFY_API_KEY_REF
const baseURL = process.env.DSH_VERIFY_BASE_URL
const api = process.env.DSH_VERIFY_API
const credentialPath = process.env.DSH_VERIFY_CREDENTIALS
if (![provider, model, apiKeyRef, credentialPath].every((value) => typeof value === 'string' && value.length)) throw new Error('Set the four documented DSH_VERIFY_* route/store settings; do not pass a key value.')
const requested = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const root = requested ? dirname(resolve(requested)) : await mkdtemp(join(tmpdir(), 'dsh-native-host-'))
await mkdir(root, { recursive: true })
const evidencePath = requested ? resolve(requested) : join(root, 'evidence.json')
const home = join(root, 'home')
await mkdir(home, { recursive: true, mode: 0o700 })
const fixture = await createHostFixture(root)
const existingInstances = () => execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean).filter((entry) => ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].includes(entry[2])).map((entry) => Number(entry[1]))
const baselineInstances = existingInstances()
const { task, origin } = fixture
const tracePath = join(root, 'native-trace.jsonl')
const overlayPath = join(root, 'overlay.json')
const readonlyPath = join(root, 'readonly-credentials.mjs')
const repo = fileURLToPath(new URL('.', import.meta.url))
const officialCredentials = process.env.DSH_VERIFY_CREDENTIAL_MODULE || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js'
await writeFile(readonlyPath, `import { LocalCredentialProvider } from ${JSON.stringify(pathToFileURL(officialCredentials).href)};
export default class ReadOnlyAcceptanceCredentials extends LocalCredentialProvider {
  async set(){throw new Error('Acceptance credentials are read-only')}
  async unset(){throw new Error('Acceptance credentials are read-only')}
  async write(){throw new Error('Acceptance credentials are read-only')}
  async modifyRecord(){throw new Error('Acceptance credentials are read-only')}
  async deleteRecord(){throw new Error('Acceptance credentials are read-only')}
  async migrateFlatDocument(){throw new Error('Acceptance requires an already versioned credential store')}
}
`)
const disable = ['plugin-manager', 'settings', 'config-editor', 'session-title-llm', 'session-log-deepseek', 'session-telemetry-otel', 'otel', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-jobs', 'tool-plugin-manager', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-working-directory', 'goal-round-driver', 'tool-goal', 'tool-todo', 'skill-filesystem']
const overlay = [
  ...disable.map((id) => ({ id, disabled: true })),
  { id: 'credentials', disabled: true },
  { id: 'tools', config: { mode: 'native' } },
  { id: 'llm-retry', disabled: false },
  { id: 'approval', config: { policy: 'ask' } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: task.workspace } },
  { id: 'agent-default-model', config: { provider, model } },
  { id: 'llm-pi-ai', config: { providers: { [provider]: { apiKeyEnv: apiKeyRef, ...(baseURL ? { baseURL } : {}), ...(api ? { api } : {}), retryPolicy: { mode: 'normal', maxRetries: 3, retryableCodes: ['TRANSPORT'], backoff: { initialDelayMs: 500, maxDelayMs: 2000, jitterRatio: 0.1 } }, models: [{ id: model, name: model, contextWindow: 1000000, maxTokens: 16384, input: ['text', 'image'] }] } } } },
  { insert: [
    { id: 'acceptance-readonly-credentials', name: readonlyPath, config: { path: credentialPath, watch: false } },
    { id: 'native-computer-use', name: fileURLToPath(new URL('./index.js', import.meta.url)), config: { ttlMs: 120000, maxElements: 200, cursorTheme: '', browserBackend: 'playwright', browserHeadless: true } },
    { id: 'computer-use-native-host-acceptance', name: fileURLToPath(new URL('./tools/host-acceptance-plugin.mjs', import.meta.url)), config: { task, origin, tracePath, deniedDestination: repo } },
  ] },
]
await writeFile(overlayPath, JSON.stringify(overlay, null, 2) + '\n')
const credentialHash = async () => createHash('sha256').update(await readFile(credentialPath)).digest('hex')
const beforeCredential = await credentialHash()
const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_MODE: 'OFF' }
const evidence = { startedAt: new Date().toISOString(), environment: 'installed isolated DSH headless + native source tools + standard skill + production fs/sandbox/approval + real model', route: { provider, model }, root, home, task: { url: task.url, name: task.name, uploadPath: task.uploadPath, downloadDir: task.downloadDir }, tracePath, approvalAnswerer: 'scoped fixture-only answerer based on this authorized acceptance; real ApprovalService audit; no human UI test', state: fixture.state }
let child, stdout = '', stderr = '', timedOut = false
try {
  const composed = execFileSync(cli, ['headless', '--patch', overlayPath, '--dump-config'], { cwd: task.workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
  evidence.composition = { sourcePresent: composed.includes('native-computer-use'), readonlyCredentialsPresent: composed.includes('acceptance-readonly-credentials'), originalHomeUsed: composed.includes(join(dirname(credentialPath), 'sessions')) }
  if (!evidence.composition.sourcePresent || !evidence.composition.readonlyCredentialsPresent || evidence.composition.originalHomeUsed) throw new Error('Isolated composition did not meet its contract.')
  if (process.argv.includes('--prepare')) evidence.status = 'prepared'
  else {
    const prompt = `请在 ${task.url} 完成一条测试登记：姓名「${task.name}」，Service level 选 Express，Dispatch code 从网站调度说明页查找，Supporting file 上传我指定的 ${task.uploadPath}，确认是测试条目后提交。页面明确登记成功后，将收据下载到 ${task.downloadDir}，最后告诉我确认编号及保存路径。只允许这个本地测试站点和指定测试文件；不得重复提交。`
    evidence.prompt = prompt
    const deadline = Number(process.env.DSH_VERIFY_DEADLINE_MS || 480000)
    if (!Number.isSafeInteger(deadline) || deadline < 30000 || deadline > 900000) throw new Error('Deadline must be 30000–900000ms.')
    evidence.deadlineMs = deadline
    console.log(JSON.stringify({ status: 'native_host_starting', evidencePath, tracePath, route: evidence.route, deadlineMs: deadline }))
    const started = Date.now()
    child = spawn(cli, ['headless', '--patch', overlayPath, '--json', prompt], { cwd: task.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    evidence.ownedProcessGroup = child.pid
    const stopGroup = (signal) => { try { process.kill(-child.pid, signal) } catch {} }
    const soft = setTimeout(() => { timedOut = true; stopGroup('SIGTERM') }, deadline)
    const hard = setTimeout(() => stopGroup('SIGKILL'), deadline + 5000)
    child.stdout.on('data', (data) => { if (stdout.length < 8 * 1024 * 1024) stdout += data; else { timedOut = true; stopGroup('SIGTERM') } })
    child.stderr.on('data', (data) => { if (stderr.length < 2 * 1024 * 1024) stderr += data })
    evidence.exitCode = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) }).finally(() => { clearTimeout(soft); clearTimeout(hard) })
    evidence.durationMs = Date.now() - started
    let trace = []
    try { trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch {}
    const calls = trace.filter((item) => item.kind === 'tool-result' && item.phase === 'model')
    const approvals = trace.filter((item) => item.kind === 'session-event' && item.type.startsWith('approval/'))
    const asks = approvals.filter((item) => item.type === 'approval/asked')
    const decisions = approvals.filter((item) => item.type === 'approval/decided')
    evidence.hostChecks = trace.filter((item) => item.kind === 'host-check').map(({ label, ok }) => ({ label, ok }))
    evidence.hostChecksPassed = trace.some((item) => item.kind === 'preflight-complete') && evidence.hostChecks.every((item) => item.ok)
    evidence.services = trace.find((item) => item.kind === 'source-mounted')?.services
    evidence.nativeToolNames = trace.find((item) => item.kind === 'agent-created')?.nativeTools
    evidence.pluginToolCount = evidence.nativeToolNames?.filter((name) => /^(?:browser_|computer_|screen_|app_)|^run_steps$/.test(name)).length
    evidence.modelRequestRetries = trace.filter((item) => item.kind === 'model-request-retry' && item.type === 'llm/retry-started').length
    evidence.promptAutoRouting = trace.some((item) => item.kind === 'prompt-assembled' && item.bundledRoutingPresent)
    evidence.nativeCatalog = trace.some((item) => item.kind === 'skill-catalog' && item.names?.includes('dsh-browser'))
    evidence.modelCalls = calls.map((item) => ({ tool: item.tool, ok: item.ok, isError: item.isError, skillName: item.skillName, status: item.status }))
    evidence.nativeSkillLoaded = calls.some((item) => item.tool === 'skill' && item.bundledBodyLoaded)
    evidence.modelReadThroughRealFS = trace.some((item) => item.kind === 'real-fs-read' && item.phase === 'model' && item.bytes > 0)
    evidence.approvalAudit = { asked: asks.length, decided: decisions.length, paired: asks.length > 0 && asks.every((item) => decisions.some((decision) => decision.data.id === item.data.id)), modelUploadAllowed: asks.some((item) => item.phase === 'model' && item.data.toolName === 'browser_upload' && decisions.some((decision) => decision.data.id === item.data.id && decision.data.outcome === 'allowed-once')) }
    evidence.business = await fixture.verify()
    const finalAnswers = stdout.split('\n').flatMap((line) => { try { const event = JSON.parse(line); return event.type === 'final' && typeof event.text === 'string' ? [event.text] : [] } catch { return [] } })
    evidence.finalAnswer = finalAnswers.at(-1)
    evidence.confirmationReported = evidence.finalAnswer?.includes(task.expected.confirmation) === true
    evidence.modelClosedBrowser = calls.some((item) => item.tool === 'browser_close' && item.ok)
    evidence.hostDisposed = trace.some((item) => item.kind === 'host-disposed')
    evidence.diagnostics = { timedOut, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), preflightFailure: trace.find((item) => item.kind === 'preflight-failed')?.error, missingCredentials: /missing.credentials|credential.*not.*configured|api.?key.*(?:missing|required)/i.test(stdout + stderr), failedAuthentication: /unauthorized|status.?401|authentication.*fail/i.test(stdout + stderr), network: trace.filter((item) => ['real-network', 'real-network-error'].includes(item.kind)) }
    evidence.ok = evidence.exitCode === 0 && evidence.pluginToolCount === 36 && evidence.hostChecksPassed && evidence.promptAutoRouting && evidence.nativeCatalog && evidence.nativeSkillLoaded && evidence.modelReadThroughRealFS && evidence.approvalAudit.paired && evidence.approvalAudit.modelUploadAllowed && evidence.business.ok && evidence.confirmationReported
    evidence.status = evidence.ok ? 'passed' : timedOut ? 'deadline_exceeded' : 'acceptance_failed'
  }
} catch (error) {
  evidence.ok = false
  evidence.status = 'setup_failed'
  evidence.errorCode = error.code || error.name
} finally {
  // DSH has its own group; Playwright Chrome creates a separate group. Only
  // signal Chrome groups whose recorded PID, PGID and exact test profile match.
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); evidence.residualGroupSignalled = true } catch { evidence.residualGroupSignalled = false } }
  let ownedBrowsers = []
  try { ownedBrowsers = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((item) => item.kind === 'owned-browser-process') } catch {}
  const browserStillMatches = (item) => {
    try { const args = execFileSync('ps', ['-p', String(item.pid), '-o', 'pgid=,args='], { encoding: 'utf8' }); return Number(/^\s*(\d+)/.exec(args)?.[1]) === item.pgid && args.includes(`--user-data-dir=${item.profile}`) && args.includes('--remote-debugging-pipe') } catch { return false }
  }
  let fallbackBrowserCleanupCount = 0
  for (const item of ownedBrowsers) {
    if (browserStillMatches(item)) { try { process.kill(-item.pgid, 'SIGTERM'); fallbackBrowserCleanupCount++ } catch {} }
  }
  for (let attempt = 0; attempt < 20 && ownedBrowsers.some(browserStillMatches); attempt++) await new Promise((done) => setTimeout(done, 100))
  for (const item of ownedBrowsers) if (browserStillMatches(item)) { try { process.kill(-item.pgid, 'SIGKILL') } catch {} }
  for (let attempt = 0; attempt < 20 && ownedBrowsers.some(browserStillMatches); attempt++) await new Promise((done) => setTimeout(done, 100))
  await fixture.close()
  const remainingInstances = existingInstances()
  evidence.cleanup = { fixtureClosed: true, credentialStoreUnchanged: beforeCredential === await credentialHash(), independentHome: home !== process.env.DSH_HOME, existingInstancesPreserved: baselineInstances.every((pid) => remainingInstances.includes(pid)), ownedBrowserCount: new Set(ownedBrowsers.map((item) => item.pid)).size, ownedBrowsersAbsent: ownedBrowsers.every((item) => !browserStillMatches(item)), fallbackBrowserCleanupCount }
  if (evidence.ok !== undefined) {
    evidence.ok = evidence.ok && evidence.cleanup.credentialStoreUnchanged && evidence.cleanup.existingInstancesPreserved && evidence.cleanup.ownedBrowsersAbsent && evidence.hostDisposed === true
    if (!evidence.ok && evidence.status === 'passed') evidence.status = 'cleanup_failed'
  }
  evidence.finishedAt = new Date().toISOString()
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ok: evidence.ok, status: evidence.status, hostChecks: evidence.hostChecks?.filter((item) => item.ok).length, pluginToolCount: evidence.pluginToolCount, modelCalls: evidence.modelCalls?.length, nativeSkillLoaded: evidence.nativeSkillLoaded, business: evidence.business?.ok, modelRequestRetries: evidence.modelRequestRetries, diagnostics: evidence.diagnostics && { timedOut: evidence.diagnostics.timedOut, preflightFailure: evidence.diagnostics.preflightFailure, missingCredentials: evidence.diagnostics.missingCredentials, failedAuthentication: evidence.diagnostics.failedAuthentication, networkErrors: evidence.diagnostics.network.filter((item) => item.kind === 'real-network-error').length }, evidencePath }, null, 2))
  if (evidence.ok === false) process.exitCode = 1
}
