/** Real public UCI website task through installed DSH and native source tools.
 * All writable DSH state lives in a fresh DSH_HOME. No shell bridge or fs stubs.
 * Explicit environment: DSH_VERIFY_PROVIDER, DSH_VERIFY_MODEL,
 * DSH_VERIFY_API_KEY_REF, DSH_VERIFY_CREDENTIALS (existing store, read-only).
 * --prepare composes the isolated configuration without calling a model.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluatePublicWebFinal } from './tools/web-task.mjs'

const cli = process.env.DSH_VERIFY_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const provider = process.env.DSH_VERIFY_PROVIDER
const model = process.env.DSH_VERIFY_MODEL
const apiKeyRef = process.env.DSH_VERIFY_API_KEY_REF
const baseURL = process.env.DSH_VERIFY_BASE_URL
const api = process.env.DSH_VERIFY_API
const credentialPath = process.env.DSH_VERIFY_CREDENTIALS
if (![provider, model, apiKeyRef, credentialPath].every((value) => typeof value === 'string' && value.length)) throw new Error('Set the four documented DSH_VERIFY_* route/store settings; do not pass a key value.')
const requested = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const root = requested ? dirname(resolve(requested)) : await mkdtemp(join(tmpdir(), 'dsh-public-web-'))
await mkdir(root, { recursive: true })
const evidencePath = requested ? resolve(requested) : join(root, 'evidence.json')
const home = join(root, 'home')
await mkdir(home, { recursive: true, mode: 0o700 })
const workspace = join(root, 'workspace')
const downloadDir = join(workspace, 'downloads')
await mkdir(downloadDir, { recursive: true })
const task = { workspace, downloadDir, url: 'https://archive.ics.uci.edu/' }
const referenceURL = 'https://archive.ics.uci.edu/static/public/53/iris.zip'
const referenceResponse = await fetch(referenceURL, { signal: AbortSignal.timeout(30000) })
if (!referenceResponse.ok) throw new Error('Official UCI reference archive is unavailable.')
const referenceChunks = []
let referenceSize = 0
for await (const chunk of referenceResponse.body) { referenceSize += chunk.length; if (referenceSize > 10 * 1024 * 1024) throw new Error('Official archive exceeds the acceptance limit.'); referenceChunks.push(chunk) }
const referenceBytes = Buffer.concat(referenceChunks)
if (referenceBytes.length > 10 * 1024 * 1024 || referenceBytes[0] !== 0x50 || referenceBytes[1] !== 0x4b) throw new Error('Official reference was not a bounded ZIP archive.')
const referenceSha256 = createHash('sha256').update(referenceBytes).digest('hex')
const existingInstances = () => execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean).filter((entry) => ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].includes(entry[2])).map((entry) => Number(entry[1]))
const baselineInstances = existingInstances()
const tracePath = join(root, 'native-trace.jsonl')
const overlayPath = join(root, 'overlay.json')
const readonlyPath = join(root, 'readonly-credentials.mjs')
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
    { id: 'computer-use-public-web-acceptance', name: fileURLToPath(new URL('./tools/web-acceptance-plugin.mjs', import.meta.url)), config: { workspace, downloadDir, tracePath } },
  ] },
]
await writeFile(overlayPath, JSON.stringify(overlay, null, 2) + '\n')
const credentialHash = async () => createHash('sha256').update(await readFile(credentialPath)).digest('hex')
const beforeCredential = await credentialHash()
const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_MODE: 'OFF' }
const evidence = { reference: { url: referenceURL, bytes: referenceBytes.length, sha256: referenceSha256 }, startedAt: new Date().toISOString(), environment: 'installed isolated DSH + standard source plugin/skill + real model + live public UCI website', route: { provider, model }, root, home, task, tracePath, approvalAnswerer: 'reject all approval-requiring operations; this task only reads public pages and downloads a public archive' }
let child, stdout = '', stderr = '', timedOut = false
try {
  const composed = execFileSync(cli, ['headless', '--patch', overlayPath, '--dump-config'], { cwd: task.workspace, env, encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
  evidence.composition = { sourcePresent: composed.includes('native-computer-use'), readonlyCredentialsPresent: composed.includes('acceptance-readonly-credentials'), originalHomeUsed: composed.includes(join(dirname(credentialPath), 'sessions')) }
  if (!evidence.composition.sourcePresent || !evidence.composition.readonlyCredentialsPresent || evidence.composition.originalHomeUsed) throw new Error('Isolated composition did not meet its contract.')
  if (process.argv.includes('--prepare')) evidence.status = 'prepared'
  else {
    const prompt = `请在 UCI Machine Learning Repository 官方站点 ${task.url} 中查找 Iris 和 Wine 两个数据集。分别从网页读出样本数（Instances）、特征数（Features）和 DOI，用 Markdown 表格给出两者的对比及数据集页面来源链接。把 Iris 数据集的官方 ZIP 下载到 ${downloadDir}，最后报告实际保存路径。请通过站点页面查找和交互，只使用这个公开网站及指定下载目录；无需登录，不上传文件，不提交评论或其他业务数据。`
    evidence.prompt = prompt
    const deadline = Number(process.env.DSH_VERIFY_DEADLINE_MS || 480000)
    if (!Number.isSafeInteger(deadline) || deadline < 30000 || deadline > 900000) throw new Error('Deadline must be 30000–900000ms.')
    evidence.deadlineMs = deadline
    console.log(JSON.stringify({ status: 'public_web_starting', evidencePath, tracePath, route: evidence.route, deadlineMs: deadline }))
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
    const calls = trace.filter((item) => item.kind === 'tool-result')
    evidence.services = trace.find((item) => item.kind === 'source-mounted')?.services
    evidence.nativeToolNames = trace.find((item) => item.kind === 'agent-created')?.nativeTools
    evidence.pluginToolCount = evidence.nativeToolNames?.filter((name) => /^(?:browser_|computer_|screen_|app_)|^run_steps$/.test(name)).length
    evidence.modelRequestRetries = trace.filter((item) => item.kind === 'model-request-retry' && item.type === 'llm/retry-started').length
    evidence.promptAutoRouting = trace.some((item) => item.kind === 'prompt-assembled' && item.bundledRoutingPresent)
    evidence.nativeCatalog = trace.some((item) => item.kind === 'skill-catalog' && item.names?.includes('dsh-browser'))
    evidence.modelCalls = calls.map((item) => ({ tool: item.tool, ok: item.ok, isError: item.isError, skillName: item.skillName, status: item.status }))
    evidence.nativeSkillLoaded = calls.some((item) => item.tool === 'skill' && item.bundledBodyLoaded)
    const finalAnswers = stdout.split('\n').flatMap((line) => { try { const event = JSON.parse(line); return event.type === 'final' && typeof event.text === 'string' ? [event.text] : [] } catch { return [] } })
    evidence.finalAnswer = finalAnswers.at(-1)
    const final = evidence.finalAnswer || ''
    const finalEvaluation = evaluatePublicWebFinal(final)
    const observed = calls.filter((item) => item.data?.outline).map((item) => ({ url: item.data.url, outline: item.data.outline }))
    const irisRead = observed.some((item) => /\/dataset\/53\/iris/.test(item.url || '') && /150/.test(item.outline) && /Features[\s\S]{0,15}4/.test(item.outline))
    const wineRead = observed.some((item) => /\/dataset\/109\//.test(item.url || '') && /178/.test(item.outline) && /Features[\s\S]{0,15}13/.test(item.outline))
    const downloaded = calls.find((item) => item.tool === 'browser_download' && item.ok)?.data
    let actual, zippedRows = [], ordinaryFile = false
    if (downloaded?.savedFile) {
      const info = await lstat(downloaded.savedFile)
      ordinaryFile = info.isFile() && !info.isSymbolicLink()
      if (ordinaryFile) {
        actual = await readFile(downloaded.savedFile)
        zippedRows = execFileSync('unzip', ['-p', downloaded.savedFile, 'iris.data'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split(/\r?\n/).filter(Boolean)
      }
    }
    const checks = [
      { name: 'live Iris page was observed with its actual metadata', ok: irisRead },
      { name: 'live Wine page was observed with its actual metadata', ok: wineRead },
      { name: 'final answer attributes both instance and feature counts', ok: finalEvaluation.countsCorrect },
      { name: 'final answer reports both source DOIs', ok: finalEvaluation.doisPresent },
      { name: 'native browser download created a regular file', ok: ordinaryFile && dirname(downloaded.savedFile) === await import('node:fs/promises').then((fs) => fs.realpath(downloadDir)) },
      { name: 'download matches the independent official-site response byte for byte', ok: Boolean(actual?.equals(referenceBytes)) },
      { name: 'downloaded Iris archive contains 150 rows and four measurements', ok: zippedRows.length === 150 && zippedRows.every((row) => row.split(',').length === 5 && row.split(',').slice(0, 4).every((n) => Number.isFinite(Number(n)))) },
      { name: 'final answer reports the actual downloaded filename', ok: Boolean(downloaded?.savedFile) && final.includes(downloaded.savedFile.split('/').at(-1)) },
    ]
    evidence.business = { ok: checks.every((check) => check.ok), checks, files: await readdir(downloadDir), savedFile: downloaded?.savedFile, downloadedBytes: actual?.length, downloadedSha256: actual && createHash('sha256').update(actual).digest('hex'), csvRows: zippedRows.length }
    evidence.modelClosedBrowser = calls.some((item) => item.tool === 'browser_close' && item.ok)
    evidence.hostDisposed = trace.some((item) => item.kind === 'host-disposed')
    evidence.diagnostics = { timedOut, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), missingCredentials: /missing.credentials|credential.*not.*configured|api.?key.*(?:missing|required)/i.test(stdout + stderr), failedAuthentication: /unauthorized|status.?401|authentication.*fail/i.test(stdout + stderr) }
    evidence.ok = evidence.exitCode === 0 && evidence.pluginToolCount === 36 && evidence.promptAutoRouting && evidence.nativeCatalog && evidence.nativeSkillLoaded && evidence.business.ok
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
  const remainingInstances = existingInstances()
  evidence.cleanup = { credentialStoreUnchanged: beforeCredential === await credentialHash(), independentHome: home !== process.env.DSH_HOME, existingInstancesPreserved: baselineInstances.every((pid) => remainingInstances.includes(pid)), ownedBrowserCount: new Set(ownedBrowsers.map((item) => item.pid)).size, ownedBrowsersAbsent: ownedBrowsers.every((item) => !browserStillMatches(item)), fallbackBrowserCleanupCount }
  if (evidence.ok !== undefined) {
    evidence.ok = evidence.ok && evidence.cleanup.credentialStoreUnchanged && evidence.cleanup.existingInstancesPreserved && evidence.cleanup.ownedBrowsersAbsent && evidence.hostDisposed === true
    if (!evidence.ok && evidence.status === 'passed') evidence.status = 'cleanup_failed'
  }
  evidence.finishedAt = new Date().toISOString()
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ok: evidence.ok, status: evidence.status, pluginToolCount: evidence.pluginToolCount, modelCalls: evidence.modelCalls?.length, nativeSkillLoaded: evidence.nativeSkillLoaded, business: evidence.business?.ok, modelRequestRetries: evidence.modelRequestRetries, diagnostics: evidence.diagnostics, evidencePath }, null, 2))
  if (evidence.ok === false) process.exitCode = 1
}
