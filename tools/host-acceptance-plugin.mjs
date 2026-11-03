/** Test-only plugin mounted inside an actual, isolated installed DSH process.
 * Every call uses its real ToolRuntime, filesystem, sandbox and ApprovalService.
 * The answerer grants only the exact fixture file/page authorized by this test.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const name = 'computer-use-native-host-acceptance'
export const inject = ['tools', 'approval', 'fs', 'sandboxPolicy', 'skills', 'systemPrompt']

export function apply(ctx, config) {
  const { task, origin, tracePath, deniedDestination } = config
  const write = (value) => appendFileSync(tracePath, JSON.stringify({ at: Date.now(), ...value }) + '\n')
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const admitted = (tool) => /^browser_/.test(tool) || ['run_steps', 'computer_skill', 'skill'].includes(tool)
  let phase = 'setup', preflightDone = false, fileReads = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async function (input, init) {
    let hostname
    try { hostname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname } catch {}
    try {
      const response = await originalFetch.call(this, input, init)
      write({ kind: 'real-network', hostname, method: init?.method || 'GET', status: response.status })
      return response
    } catch (error) {
      const chain = []
      for (let current = error; current && chain.length < 4; current = current.cause) chain.push({ name: current.name, code: current.code, errno: current.errno, syscall: current.syscall })
      write({ kind: 'real-network-error', hostname, chain })
      throw error
    }
  }
  const fs = ctx.get('fs')
  const originalRead = fs.readBytes
  fs.readBytes = async function (...args) {
    fileReads++
    const bytes = await originalRead.apply(this, args)
    write({ kind: 'real-fs-read', phase, bytes: bytes.byteLength })
    return bytes
  }
  // The source is a separate, ordinary profile entry. This audit plugin never
  // calls apply() or registers any replacement feature tools/services.
  write({ kind: 'source-mounted', standardProfileEntry: true, services: Object.fromEntries(['fs', 'sandboxPolicy', 'approval', 'skills', 'systemPrompt'].map((key) => [key, ctx.get(key)?.constructor.name])) })
  ctx.effect(() => () => { fs.readBytes = originalRead; globalThis.fetch = originalFetch; write({ kind: 'host-disposed' }) })

  ctx.on('approval/request', async (request) => {
    let selection
    try { selection = JSON.parse(request.reason.slice(request.reason.indexOf('{'))) } catch {}
    const knownFile = selection?.files?.length === 1 && [task.uploadPath, ...(phase === 'preflight' ? [task.symlinkUploadPath] : [])].includes(selection.files[0])
    const allowed = request.toolName === 'browser_upload' && knownFile && [task.url, task.checksURL].includes(selection.page) && phase !== 'reject-upload'
    const outcome = allowed ? 'allowed-once' : 'rejected'
    write({ kind: 'fixture-answerer', phase, tool: request.toolName, outcome, exactFileMatched: Boolean(knownFile), pageMatched: selection?.page?.startsWith(origin) === true })
    return outcome
  })

  ctx.tools.guard((exec) => {
    if (!admitted(exec.name)) return 'Only native source-plugin browser tools and the bundled skill are admitted.'
    if (exec.name === 'skill' && !['dsh-browser', 'dsh-desktop'].includes(exec.arguments?.name)) return 'Only the bundled skills are admitted.'
    const args = exec.arguments || {}
    if (args.url && ['browser_open', 'browser_navigate', 'browser_tabs'].includes(exec.name)) {
      try { if (new URL(args.url).origin !== origin && args.url !== 'about:blank') return 'Only this loopback fixture is admitted.' } catch { return 'Invalid fixture URL.' }
    }
    if (phase === 'model' && exec.name === 'browser_download' && args.destination_root !== task.downloadDir) return 'Use the user-selected fixture download directory.'
    if (phase === 'model' && exec.name === 'browser_upload' && (args.files?.length !== 1 || args.files[0] !== task.uploadPath)) return 'Only the user-selected supporting file is admitted.'
  })
  ctx.on('agent/created', async ({ agent }) => {
    const schemas = agent.ctx.tools.schemas(agent)
    write({ kind: 'agent-created', nativeTools: schemas.map((tool) => tool.name), bundledSkills: (await ctx.skills.list({ scope: agent, cwd: task.workspace })).filter((skill) => skill.name.startsWith('dsh-')).map((skill) => ({ name: skill.name, path: skill.path })) })
    agent.ctx.tools.restrict({ allow: schemas.map((tool) => tool.name).filter(admitted) })
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const routed = assembled.sections.some((section) => section.text.includes('{{dsh_computer_use_skills}}')) && typeof assembled.variables.dsh_computer_use_skills === 'string' && assembled.variables.dsh_computer_use_skills.includes('dsh-browser') && assembled.variables.dsh_computer_use_skills.includes('skill({name})')
    write({ kind: 'prompt-assembled', bundledRoutingPresent: routed })
    return assembled
  }, { prepend: true })
  ctx.on('session/event', (_session, event) => {
    if (['approval/asked', 'approval/decided', 'approval/policy', 'sandbox/mode', 'turn/start', 'turn/end'].includes(event.type)) write({ kind: 'session-event', phase, type: event.type, data: event.type === 'turn/end' ? { turn: event.data.turn, reason: { kind: event.data.reason?.kind, code: event.data.reason?.error?.code } } : event.data })
    if (event.type === 'user/message' && event.data.source?.kind === 'skill-catalog') write({ kind: 'skill-catalog', names: event.data.source.entries?.map((entry) => entry.name) })
    if (['llm/retry', 'llm/retry-started'].includes(event.type)) write({ kind: 'model-request-retry', type: event.type })
  })
  ctx.on('tools/result', (exec, result) => {
    const value = result.value
    write({ kind: 'tool-result', phase, tool: exec.name, arguments: admitted(exec.name) ? exec.arguments : undefined, isError: result.isError === true, ok: value?.ok, status: value?.status, data: value?.data, ...(exec.name === 'skill' ? { skillName: value?.name, bundledBodyLoaded: value?.content?.includes('DSH 浏览器操作') === true } : {}), errorCode: result.error?.code })
    if (exec.name === 'browser_open' && value?.ok) {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' }).split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((entry) => ({ pid: Number(entry[1]), ppid: Number(entry[2]), pgid: Number(entry[3]), args: entry[4] }))
      const descendants = new Set([process.pid])
      for (let count = 0; count < rows.length; count++) { const previous = descendants.size; for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid); if (previous === descendants.size) break }
      for (const row of rows) {
        const profile = /--user-data-dir=(\S*playwright_chromiumdev_profile-\S+)/.exec(row.args)?.[1]
        if (descendants.has(row.pid) && profile && row.args.includes('--remote-debugging-pipe') && row.pgid === row.pid) write({ kind: 'owned-browser-process', pid: row.pid, pgid: row.pgid, profile })
      }
    }
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (preflightDone) return next()
    preflightDone = true
    phase = 'preflight'
    let call = 0
    const checks = []
    const check = (label, ok) => { checks.push({ label, ok: Boolean(ok) }); write({ kind: 'host-check', label, ok: Boolean(ok) }); if (!ok) throw new Error(`Native host acceptance failed: ${label}`) }
    const run = async (name, args = {}) => {
      const result = await agent.ctx.tools.execute({ name, arguments: args, agent, signal, callId: `native-preflight-${++call}` })
      if (result.isError) throw new Error(`Native tool runtime rejected ${name}: ${result.error?.code}`)
      return result.value
    }
    const observe = () => run('browser_observe')
    const codeOf = (value) => value.data?.code || JSON.parse(value.result).code
    const messageOf = (value) => value.data?.message || JSON.parse(value.result).message
    const audited = (from, outcome) => {
      const events = []
      for (let seq = from; seq < agent.session.seq; seq++) events.push(agent.session.eventAt(seq))
      const ask = events.find((event) => event.type === 'approval/asked' && event.data.toolName === 'browser_upload')
      return ask && events.some((event) => event.type === 'approval/decided' && event.data.id === ask.data.id && event.data.outcome === outcome)
    }
    const ref = (page, name, action) => {
      const entries = page.data?.refs?.filter((entry) => entry.name === name && (!action || entry.actions.includes(action))) || []
      if (entries.length !== 1) throw new Error(`Expected one observed ${name}`)
      return entries[0].ref
    }
    try {
      const names = agent.ctx.tools.schemas(agent).map((tool) => tool.name)
      check('new browser tools and standard skill are natively callable', ['skill', 'browser_upload', 'browser_download', 'browser_wait_for', 'browser_verify', 'run_steps'].every((name) => names.includes(name)))
      check('production filesystem and approval services are mounted', fs.constructor.name === 'SandboxedFileSystem' && ctx.approval.constructor.name === 'ApprovalService')
      check('bundled skill body is provided by plugin without filesystem installation', (await ctx.skills.get('dsh-browser', { scope: agent, cwd: task.workspace })).content.includes('DSH 浏览器操作'))
      let page = await run('browser_open', { url: task.checksURL })
      const verified = await run('browser_verify', { expect: [{ kind: 'title', value: 'Boundary file checks' }] })
      check('native condition assertion returns satisfied for the actual page', verified.ok === true && verified.status === 'satisfied')
      const waited = await run('browser_wait_for', { expect: [{ kind: 'exists', role: 'fileinput', name: 'Boundary upload' }], stable_samples: 2, interval_ms: 50, timeout_ms: 2000 })
      check('native conditional wait observes two stable samples and returns fresh refs', waited.ok === true && waited.status === 'satisfied' && Array.isArray(waited.observation?.data?.refs || waited.observation?.refs))
      page = await observe()
      agent.session.append('approval/policy', { policy: 'never' })
      const before = fileReads
      let from = agent.session.seq
      const never = await run('browser_upload', { ref: ref(page, 'Boundary upload', 'upload'), files: [task.uploadPath] })
      check('real never policy rejects upload before reading bytes', never.ok === false && audited(from, 'rejected') && fileReads === before)
      agent.session.append('approval/policy', { policy: 'ask' })
      phase = 'reject-upload'
      page = await observe()
      from = agent.session.seq
      const denied = await run('browser_upload', { ref: ref(page, 'Boundary upload', 'upload'), files: [task.uploadPath] })
      check('real approval rejection prevents file reads', denied.ok === false && audited(from, 'rejected') && fileReads === before)
      phase = 'preflight'
      page = await observe()
      from = agent.session.seq
      const symlink = await run('browser_upload', { ref: ref(page, 'Boundary upload', 'upload'), files: [task.symlinkUploadPath] })
      check('approved selection still rejects symbolic links without reading', symlink.ok === false && audited(from, 'allowed-once') && /符号链接/.test(messageOf(symlink)) && fileReads === before)
      agent.session.append('sandbox/mode', { mode: 'read-only' })
      page = await observe()
      const readonly = await run('browser_download', { ref: ref(page, 'Download boundary file', 'click'), destination_root: task.boundaryDownloadDir })
      check('real read-only session policy rejects download', readonly.ok === false && codeOf(readonly) === 'FILE_WRITE_DENIED')
      agent.session.append('sandbox/mode', { mode: 'workspace-write' })
      page = await observe()
      const outside = await run('browser_download', { ref: ref(page, 'Download boundary file', 'click'), destination_root: deniedDestination })
      check('real workspace policy rejects destination outside workspace and temp', outside.ok === false && codeOf(outside) === 'FILE_WRITE_DENIED')
      const batched = await run('run_steps', { steps: [
        { tool: 'browser_observe', args: {}, save_as: 'page' },
        { tool: 'browser_download', args: { ref: { $ref: 'page.data.refs', where: { name: 'Download boundary file' }, pick: 'ref' }, destination_root: task.boundaryDownloadDir } },
      ] })
      check('dynamic refs dispatch through real host and create authorized file', batched.ok === true && hash(join(task.boundaryDownloadDir, task.expected.boundaryName)) === task.expected.boundarySha256)
      page = await observe()
      const duplicate = await run('browser_download', { ref: ref(page, 'Download boundary file', 'click'), destination_root: task.boundaryDownloadDir })
      check('repeat download refuses overwrite and preserves exact bytes', duplicate.ok === false && codeOf(duplicate) === 'EEXIST' && hash(join(task.boundaryDownloadDir, task.expected.boundaryName)) === task.expected.boundarySha256)
      await run('browser_close')
      write({ kind: 'preflight-complete', checks: checks.length, fileReads })
      phase = 'model'
      return next()
    } catch (error) {
      write({ kind: 'preflight-failed', error: error.message })
      throw error
    }
  })
}

export default { name, inject, apply }
