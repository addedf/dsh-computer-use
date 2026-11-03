/** Audit only: the real web UI answers ApprovalService requests. No answerer
 * is registered here, and no replacement tools, filesystem or policy is used.
 */
import { appendFileSync, writeFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { relative, isAbsolute, sep } from 'node:path'

export const name = 'computer-use-web-ui-acceptance'
export const inject = ['tools', 'approval', 'fs', 'sandboxPolicy', 'skills', 'systemPrompt']

export function apply(ctx, config) {
  const { task, origin, tracePath, auditStatePath, expectedSessionCwd, runRoot } = config
  const state = { sessionIds: [], workspaceChecks: [], fileReadAttempts: 0, fileReadBytes: 0, approvals: [], toolCalls: 0, uploadResults: [], observedFileValues: [], disposed: false }
  const canonical = (path) => { try { return typeof path === 'string' ? realpathSync(path) : undefined } catch { return undefined } }
  const checkWorkspace = (agent) => {
    const cwd = agent?.session?.header?.cwd
    const actual = canonical(cwd), expected = canonical(expectedSessionCwd), root = canonical(runRoot)
    const path = actual && root ? relative(root, actual) : undefined
    return { sessionId: agent?.session?.id, cwd, expectedSessionCwd, canonicalMatchesExpected: Boolean(actual && expected && actual === expected), withinRunRoot: typeof path === 'string' && (path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) }
  }
  const write = (value) => {
    appendFileSync(tracePath, JSON.stringify({ at: Date.now(), ...value }) + '\n')
    writeFileSync(auditStatePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  }
  const admitted = (tool) => /^browser_/.test(tool) || ['run_steps', 'computer_skill', 'skill'].includes(tool)
  const fs = ctx.get('fs')
  const originalRead = fs.readBytes
  fs.readBytes = async function (...args) {
    state.fileReadAttempts++
    write({ kind: 'real-fs-read-start', attempt: state.fileReadAttempts })
    const bytes = await originalRead.apply(this, args)
    state.fileReadBytes += bytes.byteLength
    write({ kind: 'real-fs-read', bytes: bytes.byteLength })
    return bytes
  }
  write({ kind: 'source-mounted', standardProfileEntry: true, noTestAnswerer: true, services: Object.fromEntries(['fs', 'sandboxPolicy', 'approval', 'skills', 'systemPrompt'].map((key) => [key, ctx.get(key)?.constructor.name])) })
  ctx.effect(() => () => { fs.readBytes = originalRead; state.disposed = true; write({ kind: 'host-disposed' }) })

  ctx.tools.guard((exec) => {
    const workspace = checkWorkspace(exec.agent)
    if (!workspace.canonicalMatchesExpected || !workspace.withinRunRoot) return 'The UI session workspace must match this isolated run before tools are admitted.'
    if (!admitted(exec.name)) return 'Only the source browser tools and bundled skills are admitted by this isolated acceptance.'
    const args = exec.arguments || {}
    if (exec.name === 'skill' && !['dsh-browser', 'dsh-desktop'].includes(args.name)) return 'Only bundled skills are admitted.'
    if (args.url && ['browser_open', 'browser_navigate', 'browser_tabs'].includes(exec.name)) {
      try { if (new URL(args.url).origin !== origin && args.url !== 'about:blank') return 'Only this loopback fixture is admitted.' } catch { return 'Invalid fixture URL.' }
    }
    if (exec.name === 'browser_upload' && (args.files?.length !== 1 || args.files[0] !== task.uploadPath)) return 'Only the explicitly selected disposable fixture file is admitted.'
    if (exec.name === 'browser_download' && args.destination_root !== task.downloadDir) return 'Only the fixture download directory is admitted.'
  })
  ctx.on('agent/created', async ({ agent }) => {
    state.sessionIds.push(agent.session.id)
    const workspace = checkWorkspace(agent)
    state.workspaceChecks.push(workspace)
    write({ kind: 'session-workspace', ...workspace })
    if (!workspace.canonicalMatchesExpected || !workspace.withinRunRoot) throw new Error('Isolated UI session cwd does not match the seeded workspace.')
    const schemas = agent.ctx.tools.schemas(agent)
    write({ kind: 'agent-created', sessionId: agent.session.id, nativeTools: schemas.map((tool) => tool.name), bundledSkills: (await ctx.skills.list({ scope: agent, cwd: task.workspace })).filter((skill) => skill.name.startsWith('dsh-')).map((skill) => skill.name) })
    agent.ctx.tools.restrict({ allow: schemas.map((tool) => tool.name).filter(admitted) })
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    write({ kind: 'prompt-assembled', bundledRoutingPresent: assembled.sections.some((section) => section.text.includes('{{dsh_computer_use_skills}}')) && assembled.variables.dsh_computer_use_skills?.includes('dsh-browser') === true })
    return assembled
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked') {
      state.approvals.push({ id: event.data.id, sessionId: session.id, toolName: event.data.toolName, reason: event.data.reason, askedAt: Date.now(), readsAtAsk: state.fileReadAttempts })
      write({ kind: 'approval-asked', sessionId: session.id, data: event.data, fileReadAttempts: state.fileReadAttempts })
    }
    if (event.type === 'approval/decided') {
      const entry = state.approvals.find((approval) => approval.id === event.data.id)
      if (entry) Object.assign(entry, { outcome: event.data.outcome, decidedAt: Date.now(), readsAtDecision: state.fileReadAttempts })
      write({ kind: 'approval-decided', sessionId: session.id, data: event.data, fileReadAttempts: state.fileReadAttempts })
    }
    if (event.type === 'user/message' && event.data.source?.kind === 'skill-catalog') write({ kind: 'skill-catalog', sessionId: session.id, names: event.data.source.entries?.map((entry) => entry.name) })
    if (['turn/start', 'turn/end'].includes(event.type)) write({ kind: 'turn', sessionId: session.id, type: event.type, turn: event.data.turn, reason: event.data.reason?.kind, errorCode: event.data.reason?.error?.code })
    if (['llm/retry', 'llm/retry-started'].includes(event.type)) write({ kind: 'model-request-retry', sessionId: session.id, type: event.type })
  })
  ctx.on('tools/result', (exec, result) => {
    const value = result.value
    state.toolCalls++
    if (exec.name === 'browser_upload') state.uploadResults.push({ at: Date.now(), ok: value?.ok, fileReadAttempts: state.fileReadAttempts })
    const refs = value?.data?.refs || value?.observation?.data?.refs || value?.observation?.refs
    if (Array.isArray(refs)) for (const entry of refs.filter((entry) => entry.name === 'Boundary upload')) state.observedFileValues.push({ at: Date.now(), value: entry.value })
    write({ kind: 'tool-result', sessionId: exec.agent?.session?.id, tool: exec.name, arguments: admitted(exec.name) ? exec.arguments : undefined, isError: result.isError === true, ok: value?.ok, status: value?.status, data: value?.data, ...(exec.name === 'skill' ? { skillName: value?.name, bundledBodyLoaded: value?.content?.includes('DSH 浏览器操作') === true } : {}), errorCode: result.error?.code })
    if (exec.name === 'browser_open' && value?.ok) {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' }).split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((entry) => ({ pid: Number(entry[1]), ppid: Number(entry[2]), pgid: Number(entry[3]), args: entry[4] }))
      const descendants = new Set([process.pid])
      for (let count = 0; count < rows.length; count++) { const before = descendants.size; for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid); if (before === descendants.size) break }
      for (const row of rows) {
        const profile = /--user-data-dir=(\S*playwright_chromiumdev_profile-\S+)/.exec(row.args)?.[1]
        if (descendants.has(row.pid) && profile && row.args.includes('--remote-debugging-pipe') && row.pgid === row.pid) write({ kind: 'owned-browser-process', pid: row.pid, pgid: row.pgid, profile })
      }
    }
  })
}

export default { name, inject, apply }
