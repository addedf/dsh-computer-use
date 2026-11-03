/** Persistent, isolated installed DSH web instance for real approval UI tests.
 * No test approval answerer is mounted. Use the emitted UI prompts in the web
 * page and click the actual Reject / Allow once controls. Stop with SIGTERM.
 * Existing credentials are read-only; the official browser-session grant may
 * only be returned by a verified no-op modifyRecord callback.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, unlink, lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHostFixture } from './tools/host-fixture.mjs'

const cli = process.env.DSH_VERIFY_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const provider = process.env.DSH_VERIFY_PROVIDER
const model = process.env.DSH_VERIFY_MODEL
const apiKeyRef = process.env.DSH_VERIFY_API_KEY_REF
const credentialPath = process.env.DSH_VERIFY_CREDENTIALS
const baseURL = process.env.DSH_VERIFY_BASE_URL
const api = process.env.DSH_VERIFY_API
const ttlMs = Number(process.env.DSH_VERIFY_UI_TTL_MS || 120000)
if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000) throw new Error('DSH_VERIFY_UI_TTL_MS must be 1000–600000.')
const deadlineMs = Number(process.env.DSH_VERIFY_UI_DEADLINE_MS || 900000)
if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 30000 || deadlineMs > 3600000) throw new Error('DSH_VERIFY_UI_DEADLINE_MS must be 30000–3600000.')
if (![provider, model, apiKeyRef, credentialPath].every((value) => typeof value === 'string' && value.length)) throw new Error('Set DSH_VERIFY_PROVIDER, DSH_VERIFY_MODEL, DSH_VERIFY_API_KEY_REF and DSH_VERIFY_CREDENTIALS; never pass a key value.')
const requested = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const root = requested ? dirname(resolve(requested)) : await mkdtemp(join(tmpdir(), 'dsh-approval-ui-'))
await mkdir(root, { recursive: true, mode: 0o700 })
const evidencePath = requested ? resolve(requested) : join(root, 'evidence.json')
const statusPath = join(root, 'status.json')
const launchPath = join(root, 'launch-url.json')
const home = join(root, 'home')
await mkdir(home, { recursive: true, mode: 0o700 })
// The web UI owns a default workspace distinct from process.cwd(). Seed its
// official controller under this run's root before it initializes a registry.
const documentsDirectory = join(root, 'isolated-documents')
const expectedSessionCwd = join(documentsDirectory, 'deepseek-harness', 'default-workspace')
await mkdir(expectedSessionCwd, { recursive: true, mode: 0o700 })
const fixture = await createHostFixture(root)
const { task, origin } = fixture
const tracePath = join(root, 'ui-trace.jsonl')
const auditStatePath = join(root, 'audit-state.json')
const overlayPath = join(root, 'overlay.json')
const readonlyPath = join(root, 'readonly-credentials.mjs')
const officialCredentials = process.env.DSH_VERIFY_CREDENTIAL_MODULE || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js'
const officialCredentialKeys = fileURLToPath(new URL('../../dsh-credentials/lib/index.js', pathToFileURL(officialCredentials)))
await writeFile(readonlyPath, `import { LocalCredentialProvider } from ${JSON.stringify(pathToFileURL(officialCredentials).href)};
import { credentialKey } from ${JSON.stringify(pathToFileURL(officialCredentialKeys).href)};
export default class ReadOnlyAcceptanceCredentials extends LocalCredentialProvider {
  async set(){throw new Error('Acceptance credentials are read-only')}
  async unset(){throw new Error('Acceptance credentials are read-only')}
  async write(){throw new Error('Acceptance credentials are read-only')}
  async modifyRecord(key, mutate){
    if(key!==credentialKey('client-connection','browser-session'))throw new Error('Acceptance credential records are read-only');
    const current=await super.readRecord(key);
    if(!current)throw new Error('Acceptance requires an existing official browser-session grant');
    const borrowed=structuredClone(current);
    const before=JSON.stringify(borrowed);
    const next=await mutate(borrowed);
    if(next!==undefined||JSON.stringify(borrowed)!==before)throw new Error('Acceptance refuses browser-session grant updates');
    return current;
  }
  async deleteRecord(){throw new Error('Acceptance credentials are read-only')}
  async migrateFlatDocument(){throw new Error('Acceptance requires an already versioned credential store')}
}
`, { mode: 0o600 })
const disable = ['session-title-llm', 'session-log-deepseek', 'session-telemetry-otel', 'otel', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-jobs', 'tool-plugin-manager', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-working-directory', 'goal-round-driver', 'tool-goal', 'tool-todo', 'skill-filesystem']
const overlay = [
  ...disable.map((id) => ({ id, disabled: true })),
  { id: 'credentials', disabled: true },
  { id: 'tools', config: { mode: 'native' } },
  { id: 'llm-retry', disabled: false },
  { id: 'approval', config: { policy: 'ask' } },
  { id: 'workspace-controller', config: { documentsDirectory } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: expectedSessionCwd } },
  { id: 'agent-default-model', config: { provider, model } },
  { id: 'llm-pi-ai', config: { providers: { [provider]: { apiKeyEnv: apiKeyRef, ...(baseURL ? { baseURL } : {}), ...(api ? { api } : {}), retryPolicy: { mode: 'normal', maxRetries: 3, retryableCodes: ['TRANSPORT'], backoff: { initialDelayMs: 500, maxDelayMs: 2000, jitterRatio: 0.1 } }, models: [{ id: model, name: model, contextWindow: 1000000, maxTokens: 16384, input: ['text', 'image'] }] } } } },
  { insert: [
    { id: 'acceptance-readonly-credentials', name: readonlyPath, config: { path: credentialPath, watch: false } },
    { id: 'native-computer-use', name: fileURLToPath(new URL('./index.js', import.meta.url)), config: { ttlMs, maxElements: 200, cursorTheme: '', browserBackend: 'playwright', browserHeadless: true } },
    { id: 'computer-use-web-ui-acceptance', name: fileURLToPath(new URL('./tools/ui-acceptance-plugin.mjs', import.meta.url)), config: { task, origin, tracePath, auditStatePath, expectedSessionCwd, runRoot: root } },
  ] },
]
await writeFile(overlayPath, JSON.stringify(overlay, null, 2) + '\n')
const credentialHash = async () => createHash('sha256').update(await readFile(credentialPath)).digest('hex')
const beforeCredential = await credentialHash()
const existingInstances = () => execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean).filter((entry) => Number(entry[2]) === 1 && ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].includes(entry[3])).map((entry) => Number(entry[1]))
const baselineInstances = existingInstances()
const collectUIEvidence = async (approvals) => {
  let actions = []
  try {
    actions = (await readFile(join(root, 'ui-actions.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).map((entry) => ({
      at: entry.at, actor: entry.actor, action: entry.action, decisionId: entry.decisionId,
      confirmedByUser: entry.confirmedByUser === true, screenshot: typeof entry.screenshot === 'string' && /^[a-z0-9_.-]+\.png$/i.test(entry.screenshot) ? entry.screenshot : undefined,
    }))
  } catch {}
  const screenshots = (await readdir(root)).filter((name) => /^approval[a-z0-9_.-]*\.png$/i.test(name))
  const confirmedHumanActions = actions.filter((entry) => {
    const expected = entry.action === 'allow-once' ? 'allowed-once' : entry.action === 'reject' ? 'rejected' : undefined
    return entry.actor === 'human' && entry.confirmedByUser && expected && approvals?.some((approval) => approval.id === entry.decisionId && approval.outcome === expected)
  }).map((entry) => {
    const approval = approvals.find((approval) => approval.id === entry.decisionId)
    return { ...entry, actualOutcome: approval.outcome, approvalWaitMs: approval.decidedAt - approval.askedAt, readsAtAsk: approval.readsAtAsk, readsAtDecision: approval.readsAtDecision }
  })
  return { actions, screenshots, browserAutomationActions: actions.filter((entry) => entry.actor === 'browser-automation').length, confirmedHumanActions, humanConfirmed: confirmedHumanActions.length > 0, provenance: 'controller interaction records matched to real ApprovalService audit; actor is not inferred from a button outcome' }
}
const prompts = {
  reject: `请打开 ${task.checksURL}，把我指定的文件 ${task.uploadPath} 放入“Boundary upload”文件框。只允许这个本地测试站点和这个文件，不提交其他表单。本次如果审批被拒绝，立即停止并报告，不要重试、不要切换上传方式。`,
  allow: `请再次观察 ${task.checksURL}，将我指定的 ${task.uploadPath} 放入“Boundary upload”文件框。只允许这个站点和文件。审批允许后，重新观察并报告文件框回显的文件名；不提交表单，不关闭浏览器。`,
}
const status = { root, home, statusPath, evidencePath, tracePath, auditStatePath, launchPath, fixtureURL: task.checksURL, uploadPath: task.uploadPath, workspace: task.workspace, documentsDirectory, expectedSessionCwd, route: { provider, model }, prompts, ttlMs, status: 'preparing' }
const evidence = { startedAt: new Date().toISOString(), environment: 'installed isolated DSH web + ordinary source plugin entry + real approval UI; no fixture answerer', root, home, documentsDirectory, expectedSessionCwd, route: { provider, model }, fixtureURL: task.checksURL, uploadPath: task.uploadPath, tracePath, auditStatePath, ttlMs, deadlineMs }
let child, stdout = '', stderr = '', timer, statusTimer, stopRequested = false
const saveStatus = async () => writeFile(statusPath, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 })
const stop = () => {
  stopRequested = true
  if (child?.pid) try { process.kill(-child.pid, 'SIGTERM') } catch {}
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_MODE: 'OFF' }
  const composed = execFileSync(cli, ['web', '--patch', overlayPath, '--dump-config'], { cwd: task.workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
  evidence.composition = { sourcePresent: composed.includes('native-computer-use'), readonlyCredentialsPresent: composed.includes('acceptance-readonly-credentials'), uiApprovalPresent: composed.includes('ui-approval'), originalHomeUsed: composed.includes(join(dirname(credentialPath), 'sessions')) }
  if (!evidence.composition.sourcePresent || !evidence.composition.readonlyCredentialsPresent || !evidence.composition.uiApprovalPresent || evidence.composition.originalHomeUsed) throw new Error('Isolated web composition did not meet its contract.')
  if (process.argv.includes('--prepare')) { status.status = 'prepared'; evidence.status = 'prepared'; await saveStatus() }
  else {
    child = spawn(cli, ['web', '--patch', overlayPath, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: task.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    status.processGroup = child.pid
    evidence.ownedProcessGroup = child.pid
    const capture = async (data, isError) => {
      const text = String(data)
      if (isError) { if (stderr.length < 2 * 1024 * 1024) stderr += text }
      else { if (stdout.length < 8 * 1024 * 1024) stdout += text }
      // Official web-runtime prints a process-scoped authenticated launch URL.
      // Keep it private for the UI controller; never print or persist it in
      // status, traces, evidence, screenshots, or repository artifacts.
      const source = isError ? stderr : stdout
      const matched = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+[^\s\u001b]*)/.exec(source)?.[1]
      if (matched && !status.webURL) {
        const url = new URL(matched)
        status.webURL = url.origin + '/'
        status.status = 'ready'
        await writeFile(launchPath, JSON.stringify({ url: matched }) + '\n', { mode: 0o600 })
        await saveStatus()
        console.log(JSON.stringify({ status: 'ready', webURL: status.webURL, statusPath, evidencePath, tracePath, launchPath, processGroup: child.pid }))
      }
    }
    child.stdout.on('data', (data) => { void capture(data, false).catch(() => stop()) })
    child.stderr.on('data', (data) => { void capture(data, true).catch(() => stop()) })
    timer = setTimeout(() => { evidence.deadlineExceeded = true; stop() }, deadlineMs)
    statusTimer = setInterval(() => { void saveStatus() }, 2000)
    console.log(JSON.stringify({ status: 'starting', statusPath, evidencePath, tracePath, processGroup: child.pid }))
    evidence.exitCode = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
    evidence.stopRequested = stopRequested
    let trace = []
    try { trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch {}
    let audit
    try { audit = JSON.parse(await readFile(auditStatePath, 'utf8')) } catch {}
    evidence.audit = audit
    evidence.uiEvidence = await collectUIEvidence(audit?.approvals)
    evidence.humanUIStatus = evidence.uiEvidence.humanConfirmed ? 'confirmed_by_user' : 'not_confirmed'
    const asks = trace.filter((item) => item.kind === 'approval-asked')
    const decisions = trace.filter((item) => item.kind === 'approval-decided')
    const rejected = decisions.find((item) => item.data.outcome === 'rejected')
    const allowed = decisions.find((item) => item.data.outcome === 'allowed-once')
    evidence.checks = {
      productionServices: trace.some((item) => item.kind === 'source-mounted' && item.services.fs === 'SandboxedFileSystem' && item.services.approval === 'ApprovalService' && item.noTestAnswerer),
      sessionWorkspaceIsolated: audit?.workspaceChecks?.length > 0 && audit.workspaceChecks.every((entry) => entry.canonicalMatchesExpected && entry.withinRunRoot),
      nativeSkillLoaded: trace.some((item) => item.kind === 'tool-result' && item.tool === 'skill' && item.bundledBodyLoaded),
      approvalAuditPaired: asks.length >= 2 && asks.every((item) => decisions.some((decision) => decision.data.id === item.data.id)),
      rejectedBeforeReading: Boolean(rejected && rejected.fileReadAttempts === 0 && trace.some((item) => item.kind === 'tool-result' && item.tool === 'browser_upload' && item.ok === false && item.at >= rejected.at && (!allowed || item.at < allowed.at))),
      allowedBeforeReading: Boolean(allowed && allowed.fileReadAttempts === 0 && trace.some((item) => item.kind === 'real-fs-read' && item.bytes > 0 && item.at >= allowed.at)),
      allowedUploadConfirmed: Boolean(audit?.uploadResults.some((item) => item.ok === true) && audit?.observedFileValues.some((item) => String(item.value).endsWith('upload.txt'))),
      hostDisposed: audit?.disposed === true,
    }
    evidence.ok = Object.values(evidence.checks).every(Boolean)
    evidence.status = evidence.ok ? 'passed' : 'incomplete'
  }
} catch (error) {
  evidence.ok = false; evidence.status = 'setup_failed'; evidence.errorCode = error.code || error.name
} finally {
  clearTimeout(timer); clearInterval(statusTimer)
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  let ownedBrowsers = []
  try { ownedBrowsers = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((item) => item.kind === 'owned-browser-process') } catch {}
  const browserStillMatches = (item) => {
    try { const args = execFileSync('ps', ['-p', String(item.pid), '-o', 'pgid=,args='], { encoding: 'utf8' }); return Number(/^\s*(\d+)/.exec(args)?.[1]) === item.pgid && args.includes(`--user-data-dir=${item.profile}`) && args.includes('--remote-debugging-pipe') } catch { return false }
  }
  let fallbackBrowserCleanupCount = 0
  for (const item of ownedBrowsers) if (browserStillMatches(item)) { try { process.kill(-item.pgid, 'SIGTERM'); fallbackBrowserCleanupCount++ } catch {} }
  for (let attempt = 0; attempt < 20 && ownedBrowsers.some(browserStillMatches); attempt++) await new Promise((done) => setTimeout(done, 100))
  for (const item of ownedBrowsers) if (browserStillMatches(item)) { try { process.kill(-item.pgid, 'SIGKILL') } catch {} }
  for (let attempt = 0; attempt < 20 && ownedBrowsers.some(browserStillMatches); attempt++) await new Promise((done) => setTimeout(done, 100))
  await fixture.close()
  await unlink(launchPath).catch(() => {})
  const privateLaunchURLRemoved = await lstat(launchPath).then(() => false, (error) => error.code === 'ENOENT')
  const remainingInstances = existingInstances()
  evidence.cleanup = { fixtureClosed: true, privateLaunchURLRemoved, credentialStoreUnchanged: beforeCredential === await credentialHash(), existingInstancesPreserved: baselineInstances.every((pid) => remainingInstances.includes(pid)), ownedBrowserCount: new Set(ownedBrowsers.map((item) => item.pid)).size, ownedBrowsersAbsent: ownedBrowsers.every((item) => !browserStillMatches(item)), fallbackBrowserCleanupCount }
  if (evidence.ok !== undefined) { evidence.ok = evidence.ok && evidence.cleanup.credentialStoreUnchanged && evidence.cleanup.existingInstancesPreserved && evidence.cleanup.ownedBrowsersAbsent && evidence.cleanup.privateLaunchURLRemoved; if (!evidence.ok && evidence.status === 'passed') evidence.status = 'cleanup_failed' }
  evidence.diagnostics = { stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), launchURLObserved: Boolean(status.webURL), noRawProcessOutputPersisted: true }
  evidence.finishedAt = new Date().toISOString()
  status.status = evidence.status; status.stopped = true
  await saveStatus()
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ok: evidence.ok, status: evidence.status, checks: evidence.checks, cleanup: evidence.cleanup, evidencePath, statusPath }))
  if (evidence.ok === false) process.exitCode = 1
}
