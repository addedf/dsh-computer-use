/** Audit-only plugin for a real public-site model task in an isolated DSH.
 * The source plugin is loaded separately by the ordinary profile loader.
 */
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const name = 'computer-use-public-web-acceptance'
export const inject = ['tools', 'approval', 'fs', 'sandboxPolicy', 'skills', 'systemPrompt']

export function apply(ctx, config) {
  const { tracePath, workspace, downloadDir } = config
  const write = (value) => appendFileSync(tracePath, JSON.stringify({ at: Date.now(), ...value }) + '\n')
  const admitted = (tool) => (/^browser_/.test(tool) && tool !== 'browser_upload') || ['run_steps', 'computer_skill', 'skill'].includes(tool)
  write({ kind: 'source-mounted', standardProfileEntry: true, services: Object.fromEntries(['fs', 'sandboxPolicy', 'approval', 'skills', 'systemPrompt'].map((key) => [key, ctx.get(key)?.constructor.name])) })
  ctx.effect(() => () => write({ kind: 'host-disposed' }))
  // There are no uploads, purchases, logins or submissions in this task.
  ctx.on('approval/request', async (request) => { write({ kind: 'approval-refused', tool: request.toolName }); return 'rejected' })
  ctx.tools.guard((exec) => {
    if (!admitted(exec.name)) return 'Only source-plugin browser tools and bundled skill are admitted.'
    const args = exec.arguments || {}
    if (exec.name === 'skill' && !['dsh-browser', 'dsh-desktop'].includes(args.name)) return 'Only bundled skills are admitted.'
    if (args.url && ['browser_open', 'browser_navigate', 'browser_tabs'].includes(exec.name)) {
      try { const u = new URL(args.url); if (u.href !== 'about:blank' && (u.protocol !== 'https:' || !['archive.ics.uci.edu', 'www.archive.ics.uci.edu'].includes(u.hostname) || u.username || u.password)) return 'Only the official public UCI site is admitted.' } catch { return 'Invalid website URL.' }
    }
    if (exec.name === 'browser_download' && args.destination_root !== downloadDir) return 'Use the user-selected test download directory.'
  })
  ctx.on('agent/created', async ({ agent }) => {
    const schemas = agent.ctx.tools.schemas(agent)
    write({ kind: 'agent-created', nativeTools: schemas.map((tool) => tool.name), bundledSkills: (await ctx.skills.list({ scope: agent, cwd: workspace })).filter((skill) => skill.name.startsWith('dsh-')).map((skill) => ({ name: skill.name, path: skill.path })) })
    agent.ctx.tools.restrict({ allow: schemas.map((tool) => tool.name).filter(admitted) })
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const routed = assembled.sections.some((section) => section.text.includes('{{dsh_computer_use_skills}}')) && typeof assembled.variables.dsh_computer_use_skills === 'string' && assembled.variables.dsh_computer_use_skills.includes('dsh-browser')
    write({ kind: 'prompt-assembled', bundledRoutingPresent: routed })
    return assembled
  }, { prepend: true })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') write({ kind: 'turn-ended', reason: event.data.reason?.kind, code: event.data.reason?.error?.code })
    if (event.type === 'user/message' && event.data.source?.kind === 'skill-catalog') write({ kind: 'skill-catalog', names: event.data.source.entries?.map((entry) => entry.name) })
    if (['llm/retry', 'llm/retry-started'].includes(event.type)) write({ kind: 'model-request-retry', type: event.type })
  })
  ctx.on('tools/result', (exec, result) => {
    const value = result.value
    let failureCode
    if (value?.ok === false) { try { failureCode = JSON.parse(value.result).code } catch {} }
    write({ kind: 'tool-result', tool: exec.name, arguments: admitted(exec.name) ? exec.arguments : undefined, isError: result.isError === true, ok: value?.ok, status: value?.status, data: value?.data, ...(exec.name === 'skill' ? { skillName: value?.name, bundledBodyLoaded: value?.content?.includes('DSH 浏览器操作') === true } : {}), errorCode: result.error?.code, failureCode })
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
}

export default { name, inject, apply }
