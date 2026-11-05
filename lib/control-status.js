import { cuaCall, withSession, getDriverCapabilities } from './cua.js'
import { getSessionState } from './session.js'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeCode = (value) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : 'CONTROL_STATUS_READ_FAILED'
const READ_EVIDENCE_LIMIT = 16 * 1024
const ACK_EVIDENCE_LIMIT = 4 * 1024
const timestamp = () => new Date().toISOString()
const refused = (value) =>
  value === false ||
  (object(value) &&
    (value.ok === false ||
      value.isError === true ||
      value.error ||
      ['error', 'failed', 'refused', 'rejected'].includes(value.status)))

function copyEvidence(value, limit) {
  try {
    const json = JSON.stringify(value)
    if (json === undefined || Buffer.byteLength(json) > limit) return { omitted: true }
    return { data: JSON.parse(json) }
  } catch {
    return { omitted: true }
  }
}

function observation(result, limit) {
  if (result.status === 'rejected')
    return {
      ok: false,
      error: {
        code: safeCode(result.reason?.code),
        message: '所属控制会话状态读取失败；未创建或恢复会话。',
      },
    }
  const value = result.value
  if (!object(value) || refused(value)) {
    return {
      ok: false,
      error: {
        code: 'CONTROL_STATUS_READ_FAILED',
        message: '驱动未返回可确认的只读状态；未创建或恢复会话。',
      },
    }
  }
  // These two driver APIs are documented as content-free. Preserve their real
  // fields rather than inventing a visibility/lifecycle schema or treating a
  // missing cursor as proof that it is hidden.
  if (limit !== undefined) {
    const copied = copyEvidence(value, limit)
    if (copied.omitted)
      return {
        ok: false,
        error: {
          code: 'CONTROL_STATUS_EVIDENCE_LIMIT',
          message: '只读状态超出记录限额；未据此判定光标状态。',
        },
      }
    return { ok: true, data: copied.data }
  }
  return { ok: true, data: value }
}

async function acknowledged(call, tool, args) {
  try {
    const value = await call(tool, args)
    if (refused(value))
      return { ok: false, at: timestamp(), error: { code: 'CONTROL_RELEASE_REFUSED' } }
    if (!object(value))
      return {
        ok: false,
        at: timestamp(),
        error: { code: 'CONTROL_RELEASE_ACK_UNKNOWN' },
        ...copyEvidence(value, ACK_EVIDENCE_LIMIT),
      }
    // ok means this command was acknowledged, not that a later live cursor
    // query succeeded. Keep the actual small reply for independent review.
    return { ok: true, at: timestamp(), ...copyEvidence(value, ACK_EVIDENCE_LIMIT) }
  } catch (cause) {
    return { ok: false, at: timestamp(), error: { code: safeCode(cause?.code) } }
  }
}

function beginRelease(record, mode) {
  if (!record.releaseEvidence) {
    record.releaseEvidence = {
      kind: 'historical-release-evidence',
      source: 'cua-driver-cleanup',
      sessionId: record.state.driverSession,
      startedAt: timestamp(),
      mode,
    }
    record.state.lastDriverRelease = record.releaseEvidence
  }
  return record.releaseEvidence
}

/** Stop must send end immediately, without waiting for observation or cleanup. */
export function captureImmediateDriverEnd(record, { call = cuaCall } = {}) {
  const evidence = beginRelease(record, 'interrupted')
  evidence.mode = 'interrupted'
  const pending = acknowledged(call, 'end_session', { session: evidence.sessionId })
  return pending.then((value) => {
    evidence.immediateEnd = value
    return value
  })
}

function boundedRead(call, tool, sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ status: 'rejected', reason: { code: 'CONTROL_STATUS_TIMEOUT' } }),
      timeoutMs,
    )
    Promise.resolve()
      .then(() => call(tool, { session: sessionId }))
      .then(
        (value) => {
          clearTimeout(timer)
          resolve({ status: 'fulfilled', value })
        },
        (reason) => {
          clearTimeout(timer)
          resolve({ status: 'rejected', reason })
        },
      )
  })
}

/** Preserve one bounded record of actual cleanup, never a fabricated live state. */
export async function captureDriverRelease(
  record,
  { call = cuaCall, observationTimeoutMs = 1000 } = {},
) {
  const evidence = beginRelease(
    record,
    record.immediateEnd || record.state.controlStopped ? 'interrupted' : 'normal',
  )
  try {
    evidence.disable = await acknowledged(call, 'set_agent_cursor_enabled', {
      session: evidence.sessionId,
      enabled: false,
    })
    if (evidence.disable.ok && !record.immediateEnd && !record.state.controlStopped) {
      const [cursor, lifecycle] = await Promise.all([
        boundedRead(call, 'get_agent_cursor_state', evidence.sessionId, observationTimeoutMs),
        boundedRead(call, 'get_session', evidence.sessionId, observationTimeoutMs),
      ])
      evidence.beforeEnd =
        record.immediateEnd || record.state.controlStopped
          ? { skipped: true, reason: 'revoked-during-observation' }
          : {
              observedAt: timestamp(),
              cursor: observation(cursor, READ_EVIDENCE_LIMIT),
              lifecycle: observation(lifecycle, READ_EVIDENCE_LIMIT),
            }
    } else {
      evidence.beforeEnd = {
        skipped: true,
        reason: record.immediateEnd
          ? 'immediate-end-issued'
          : record.state.controlStopped
            ? 'control-stopped'
            : 'disable-not-confirmed',
      }
    }
  } finally {
    evidence.end = await acknowledged(call, 'end_session', { session: evidence.sessionId })
    evidence.completedAt = timestamp()
  }
  return evidence
}

export async function computerStatus(
  args = {},
  { call = cuaCall, state = getSessionState(), capabilities = getDriverCapabilities, signal } = {},
) {
  const scope = args.scope ?? 'health'
  if (
    !['health', 'control', 'capabilities'].includes(scope) ||
    Object.keys(args).some((key) => key !== 'scope')
  ) {
    throw Object.assign(
      new Error(
        'computer_status 仅接受 scope: health、control 或 capabilities；会话由当前任务固定。',
      ),
      { code: 'CONTROL_STATUS_INVALID' },
    )
  }
  if (scope === 'health') {
    const report = await call('health_report', withSession())
    return { ok: true, result: JSON.stringify(report, null, 2) }
  }
  if (scope === 'capabilities') {
    const report = await capabilities({ signal })
    const data = { scope, source: 'cua-driver', ...report }
    return { ok: report.transport === 'ok', result: JSON.stringify(data, null, 2), data }
  }
  const sessionId = state.driverSession
  if (typeof sessionId !== 'string' || !sessionId) {
    const data = {
      scope,
      source: 'cua-driver',
      error: { code: 'NO_CONTROL_SESSION', message: '当前任务没有可查询的所属控制会话。' },
    }
    return { ok: false, result: JSON.stringify(data, null, 2), data }
  }
  // Start both reads immediately so the observation can capture the brief
  // visible interval after a click, before idle_hide_ms elapses.
  const [cursorResult, sessionResult] = await Promise.allSettled([
    Promise.resolve().then(() => call('get_agent_cursor_state', { session: sessionId })),
    Promise.resolve().then(() => call('get_session', { session: sessionId })),
  ])
  const release = state.lastDriverRelease
  const historical = release?.sessionId === sessionId ? copyEvidence(release, 48 * 1024) : null
  const data = {
    scope,
    source: 'cua-driver',
    sessionId,
    cursor: observation(cursorResult),
    lifecycle: observation(sessionResult),
    ...(historical && !historical.omitted ? { lastRelease: historical.data } : {}),
  }
  return { ok: data.cursor.ok && data.lifecycle.ok, result: JSON.stringify(data, null, 2), data }
}
