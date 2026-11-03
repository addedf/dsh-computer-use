/**
 * cua.js —— cua-driver 引擎调用封装。
 *
 * 通过 `cua-driver call <tool> '<json-args>'` 的子进程方式调用引擎。
 * 零外部依赖：不需要 MCP SDK，CLI 即接口。
 *
 * 引擎二进制定位见 resolveBin()：CUA_DRIVER_BIN → PATH → 官方安装器路径 → 常见安装路径。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { getDriverSession } from './session.js'

/**
 * 解析引擎二进制路径（优先级）：
 *   1. 环境变量 CUA_DRIVER_BIN（显式指定）
 *   2. PATH 目录扫描（cua-driver / cua-driver.exe）
 *   3. 官方安装器路径：~/.cua-driver/packages/current/<exe>
 *   4. 常见安装路径：~/.local/bin（旧版安装器默认位置）、
 *      /usr/local/bin、/opt/homebrew/bin（Apple Silicon）、Windows %LOCALAPPDATA%
 *   5. macOS 的 /Applications/CuaDriver.app/Contents/MacOS/cua-driver
 *   6. 兜底 'cua-driver'（交给 spawn 报 ENOENT，错误信息含自救指引）
 *
 * 说明：GUI 应用（harness-desktop）的 PATH 通常不含 shell 的 ~/.local/bin，
 * 因此必须探测官方安装器的默认位置，否则 macOS 用户开箱即 ENOENT。
 */
export function resolveBin({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const explicit = env.CUA_DRIVER_BIN
  if (explicit) return explicit
  const sep = platform === 'win32' ? ';' : ':'
  const exe = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const pathJoin = platform === 'win32' ? win32.join : join
  for (const dir of (env.PATH || '').split(sep)) {
    if (!dir) continue
    try { if (exists(pathJoin(dir, exe))) return pathJoin(dir, exe) } catch { /* 忽略 */ }
  }
  const common = [
    pathJoin(home, '.cua-driver', 'packages', 'current', exe),
    pathJoin(home, '.local', 'bin', exe),
    pathJoin('/usr/local/bin', exe),
    pathJoin('/opt/homebrew/bin', exe),
    ...(platform === 'win32' ? [pathJoin(env.LOCALAPPDATA || pathJoin(home, 'AppData', 'Local'), 'cua-driver', exe)] : []),
    ...(platform === 'darwin' ? [
      '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      pathJoin(home, 'Applications', 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver'),
    ] : []),
  ]
  for (const p of common) {
    try { if (exists(p)) return p } catch { /* 忽略 */ }
  }
  return 'cua-driver'
}

/** Compatibility export; calls re-resolve rather than caching a missing binary. */
export let CUA_BIN = resolveBin()

/**
 * 插件统一的虚拟光标会话 id：所有动作绑定同一会话，
 * 光标主题/运动参数才能稳定生效（会话级）。
 */
export const CUA_SESSION = process.env.CUA_SESSION || 'dsh-computer-use'

/** 给动作类调用注入统一会话（观察类只读工具不需要）。 */
export function withSession(args = {}) {
  return { session: getDriverSession() || CUA_SESSION, ...args }
}

export function isSessionEndedError(message) {
  return /\bsession\s+(?:'[^']+'\s+)?has\s+ended\b/i.test(String(message || ''))
}

/** Create the retry wrapper with an injectable raw call for deterministic tests. */
export function createCuaCall(callRaw, session = CUA_SESSION) {
  if (typeof callRaw !== 'function') throw new TypeError('createCuaCall requires a raw-call function')
  return async function callWithSessionRecovery(tool, args = {}) {
    try {
      return await callRaw(tool, args)
    } catch (err) {
      if (tool !== 'start_session' && isSessionEndedError(err?.message)) {
        // An ended session is an explicit pre-action refusal, so one retry is safe.
        // Never replay actions for timeouts, transport failures, or arbitrary errors.
        await callRaw('start_session', { session: args.session || getDriverSession() || session })
        return callRaw(tool, args)
      }
      throw err
    }
  }
}

/** Driver failures expose a stable code without attaching action payloads. */
export class CuaDriverError extends Error {
  constructor(code, message, { tool, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'CuaDriverError'
    this.code = code
    if (tool) this.tool = tool
  }
}

/**
 * Injectable bounded transport. A failed call is never replayed here: actions may
 * already have been delivered when a process times out or produces bad output.
 */
export function createRawCuaCall({
  spawnFn = spawn,
  resolveBinary = () => { CUA_BIN = resolveBin(); return CUA_BIN },
  timeoutMs = 30000,
  maxOutputBytes = 64 * 1024 * 1024,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes must be positive')
  return function rawCall(tool, args = {}) {
    return new Promise((resolve, reject) => {
      // Installation or CUA_DRIVER_BIN updates after plugin startup take effect now.
      const binary = resolveBinary()
      let child
      let timer
      let killTimer
      let settled = false
      let bytes = 0
      const stdout = []
      const stderr = []
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const failAndStop = (code, message) => {
        finish(new CuaDriverError(code, message, { tool }))
        try { child.kill('SIGTERM') } catch { /* Already exited. */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* Already exited. */ }
        }, 1000)
        killTimer.unref?.()
      }
      try {
        child = spawnFn(binary, ['call', tool, JSON.stringify(args)], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        finish(spawnError(binary, tool, error))
        return
      }
      const collect = (parts) => (data) => {
        if (settled) return
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
        bytes += chunk.byteLength
        if (bytes > maxOutputBytes) {
          failAndStop('OUTPUT_LIMIT', `cua-driver ${tool} 输出超过 ${maxOutputBytes} 字节，已停止；操作可能已执行，请重新观察，勿直接重试。`)
          return
        }
        parts.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.on('error', (error) => finish(spawnError(binary, tool, error)))
      child.on('close', (code) => {
        clearTimeout(killTimer)
        if (settled) return
        const out = Buffer.concat(stdout).toString('utf8')
        const err = Buffer.concat(stderr).toString('utf8')
        if (code !== 0) {
          finish(new CuaDriverError('DRIVER_EXIT', `cua-driver ${tool} 失败 (exit ${code}): ${(err || out).trim().slice(0, 800)}`, { tool }))
          return
        }
        let value
        try { value = JSON.parse(out) } catch {
          finish(new CuaDriverError('INVALID_JSON', `cua-driver ${tool} 返回非 JSON，操作结果未知：请重新观察。`, { tool }))
          return
        }
        try {
          assertMcpSuccess(value, tool)
          finish(null, normalizeMcp(value))
        } catch (error) {
          finish(error)
        }
      })
      timer = setTimeout(() => failAndStop('DRIVER_TIMEOUT', `cua-driver ${tool} 超过 ${timeoutMs}ms，已停止；操作可能已执行，请重新观察，勿直接重试。`), timeoutMs)
      // Synchronous fake transports can settle during registration; don't leak a timer.
      if (settled) clearTimeout(timer)
    })
  }
}

function spawnError(binary, tool, error) {
  const missing = error?.code === 'ENOENT'
  const hint = missing
    ? ' 请安装 cua-driver（官方安装目录 ~/.cua-driver/packages/current/ 或 macOS /Applications/CuaDriver.app），或设置 CUA_DRIVER_BIN；安装后可直接重新调用，无需重启插件。'
    : ''
  return new CuaDriverError(missing ? 'DRIVER_NOT_FOUND' : 'DRIVER_SPAWN', `cua-driver 无法启动 (${binary}): ${error.message}${hint}`, { tool, cause: error })
}

function assertMcpSuccess(value, tool) {
  if (value?.isError !== true) return
  const detail = Array.isArray(value.content)
    ? value.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
    : value.message || value.error?.message || 'MCP tool reported isError'
  throw new CuaDriverError('DRIVER_TOOL_ERROR', `cua-driver ${tool || 'tool'} 拒绝：${String(detail).slice(0, 800)}`, { tool })
}

/** Call a cua-driver tool with explicit ended-session recovery enabled. */
export const cuaCall = createCuaCall(createRawCuaCall())

/**
 * 归一化 MCP 形状的返回：若结果带 content 数组（[{type:'text',text}]），
 * 提取文本拼接；否则原样返回。
 */
export function normalizeMcp(value) {
  assertMcpSuccess(value)
  if (value?.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent
  if (value && Array.isArray(value.content)) {
    const texts = value.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (texts.length > 0) {
      const combined = texts.join('\n')
      try { return JSON.parse(combined) } catch { return combined }
    }
  }
  return value
}
