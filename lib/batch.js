/** Declarative data flow over registered tools. Every leaf is dispatched through
 * the host policy pipeline; no code evaluation and no retry of failed actions. */
const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])
const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/
const STEP_KEYS = new Set(['tool', 'args', 'save_as', 'when', 'repeat', 'until', 'for_each', 'as', 'steps', 'otherwise'])
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function name(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || RESERVED.has(value)) throw new Error('变量名需要小写字母开头，只含字母、数字及下划线。')
  return value
}
function pathValue(value, path) {
  if (typeof path !== 'string' || !path || path.length > 300) throw new Error('变量路径无效。')
  for (const key of path.split('.')) {
    if (!key || RESERVED.has(key) || value == null || !own(Object(value), key)) throw new Error(`变量路径不存在或禁止访问：${path}`)
    value = value[key]
  }
  return value
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

/** Resolve a whole JSON value; matching never guesses between duplicate refs. */
export function resolveBindings(value, variables, depth = 0) {
  if (depth > 20) throw new Error('参数引用嵌套过深。')
  if (Array.isArray(value)) return value.map((entry) => resolveBindings(entry, variables, depth + 1))
  if (!object(value)) return value
  if (own(value, '$ref')) {
    if (Object.keys(value).some((key) => !['$ref', 'where', 'pick'].includes(key))) throw new Error('引用仅支持 $ref、where、pick。')
    let selected = pathValue(variables, value.$ref)
    if (own(value, 'where')) {
      if (!Array.isArray(selected) || !object(value.where) || !Object.keys(value.where).length) throw new Error('where 需要非空条件并引用数组。')
      const criteria = resolveBindings(value.where, variables, depth + 1)
      const matches = selected.filter((entry) => object(entry) && Object.entries(criteria).every(([key, expected]) => !RESERVED.has(key) && own(entry, key) && equal(entry[key], expected)))
      if (matches.length !== 1) throw new Error(`目标需要唯一匹配，实际 ${matches.length} 个；请重新观察并收紧条件。`)
      selected = matches[0]
    }
    if (own(value, 'pick')) selected = pathValue(selected, value.pick)
    if (selected === undefined) throw new Error('引用值不可用。')
    return structuredClone(selected)
  }
  const result = Object.create(null)
  for (const [key, entry] of Object.entries(value)) {
    if (RESERVED.has(key)) throw new Error(`禁止的参数字段：${key}`)
    result[key] = resolveBindings(entry, variables, depth + 1)
  }
  return result
}
function conditionShape(spec) {
  if (!object(spec) || typeof spec.ref !== 'string' || Object.keys(spec).some((key) => !['ref', 'equals', 'not'].includes(key))) throw new Error('条件需要 {ref, equals? ,not?}。')
  if (!spec.ref || spec.ref.length > 300 || spec.ref.split('.').some((key) => !key || RESERVED.has(key))) throw new Error('条件变量路径无效。')
  if (spec.not !== undefined && typeof spec.not !== 'boolean') throw new Error('条件 not 必须是布尔值。')
}
function condition(spec, variables) {
  conditionShape(spec)
  const value = pathValue(variables, spec.ref)
  let result
  if (own(spec, 'equals')) result = equal(value, resolveBindings(spec.equals, variables))
  else {
    if (typeof value !== 'boolean') throw new Error('没有 equals 的条件必须引用布尔值。')
    result = value
  }
  if (spec.not !== undefined && typeof spec.not !== 'boolean') throw new Error('条件 not 必须是布尔值。')
  return spec.not ? !result : result
}
function validateSteps(steps, tools, depth = 0, counter = { nodes: 0 }) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20 || depth > 3) throw new Error('run_steps: 每组需要 1–20 步，嵌套最多 3 层。')
  for (const step of steps) {
    if (++counter.nodes > 100 || !object(step) || Object.keys(step).some((key) => !STEP_KEYS.has(key))) throw new Error('run_steps: 无效步骤或计划过大。')
    if (own(step, 'when')) conditionShape(step.when)
    if (own(step, 'until')) conditionShape(step.until)
    if (step.save_as !== undefined) name(step.save_as)
    if (step.tool !== undefined) {
      if (step.tool === 'run_steps' || !tools.has(step.tool)) throw new Error(`run_steps: 不支持的工具 ${String(step.tool)}。`)
      if (['steps', 'repeat', 'for_each', 'until', 'otherwise', 'as'].some((key) => own(step, key))) throw new Error('工具步骤不能同时声明循环或分支。')
      if (step.args !== undefined && !object(step.args)) throw new Error('工具 args 必须是对象。')
    } else {
      if (own(step, 'args') || own(step, 'save_as')) throw new Error('控制组不能包含 args 或 save_as。')
      if (step.repeat !== undefined && (!Number.isSafeInteger(step.repeat) || step.repeat < 1 || step.repeat > 10)) throw new Error('repeat 必须是 1–10。')
      if (step.until && step.repeat === undefined) throw new Error('until 需要设置 repeat 上限。')
      if (step.for_each !== undefined) {
        name(step.as)
        if (step.repeat !== undefined || step.until || step.otherwise) throw new Error('for_each 不能混合 repeat/otherwise。')
      } else if (step.as !== undefined) throw new Error('as 需要 for_each。')
      if (step.otherwise && !step.when) throw new Error('otherwise 需要 when。')
      validateSteps(step.steps, tools, depth + 1, counter)
      if (step.otherwise) validateSteps(step.otherwise, tools, depth + 1, counter)
    }
  }
}

export async function runSteps(args, exec, tools, dispatch, { maxCalls = 60, maxDurationMs = 120000, now = Date.now } = {}) {
  validateSteps(args.steps, tools)
  if (args.variables !== undefined && !object(args.variables)) throw new Error('variables 必须是对象。')
  const variables = Object.create(null)
  for (const [key, value] of Object.entries(args.variables || {})) { name(key); variables[key] = structuredClone(value) }
  if (args.return_vars !== undefined && (!Array.isArray(args.return_vars) || args.return_vars.some((key) => typeof key !== 'string'))) throw new Error('return_vars 必须是变量名数组。')
  for (const key of args.return_vars || []) name(key)
  const results = []
  const started = now()
  const controller = new AbortController()
  const parentCancelled = () => controller.abort()
  exec?.signal?.addEventListener('abort', parentCancelled, { once: true })
  if (exec?.signal?.aborted) controller.abort()
  const deadlineTimer = setTimeout(() => controller.abort(), maxDurationMs)
  deadlineTimer.unref?.()
  const childExec = { ...exec, signal: controller.signal }
  let image, failure, executed = 0, skipped = 0
  const budget = () => {
    if (exec?.signal?.aborted) throw new Error('操作已取消。')
    if (controller.signal.aborted || now() - started > maxDurationMs) throw new Error('动态流程超过执行时间上限，已停止；不重放已有动作。')
  }
  const walk = async (steps) => {
    for (const step of steps) {
      budget()
      if (step.when && !condition(step.when, variables)) {
        skipped++
        if (step.otherwise && await walk(step.otherwise) === false) return false
        continue
      }
      if (step.tool !== undefined) {
        if (executed >= maxCalls) throw new Error(`动态流程超过 ${maxCalls} 次工具调用，已停止。`)
        const resolved = { tool: step.tool, args: resolveBindings(step.args || {}, variables) }
        executed++
        let value
        try {
          value = dispatch ? await dispatch(resolved, executed - 1, childExec) : await tools.get(step.tool).execute(resolved.args, childExec)
          if (!object(value) || typeof value.ok !== 'boolean' || typeof value.result !== 'string') throw new Error('子工具返回格式无效。')
        } catch (error) { value = { ok: false, result: error.message } }
        results.push({ tool: step.tool, ok: value.ok, result: value.result })
        if (step.save_as) variables[step.save_as] = structuredClone(value)
        if (value.image) image = value.image
        else if (['screen_observe', 'browser_observe', 'browser_open', 'browser_navigate'].includes(step.tool)) image = undefined
        if (!value.ok) { failure = value.result || '子工具返回失败。'; return false }
        budget()
      } else if (step.for_each !== undefined) {
        const items = resolveBindings(step.for_each, variables)
        if (!Array.isArray(items) || items.length > 20) throw new Error('for_each 需要最多 20 项的数组。')
        const previous = own(variables, step.as) ? variables[step.as] : undefined
        const existed = own(variables, step.as)
        try {
          for (const item of items) {
            variables[step.as] = structuredClone(item)
            if (await walk(step.steps) === false) return false
          }
        } finally { if (existed) variables[step.as] = previous; else delete variables[step.as] }
      } else {
        let reached = false
        for (let iteration = 0; iteration < (step.repeat ?? 1); iteration++) {
          if (await walk(step.steps) === false) return false
          if (step.until && condition(step.until, variables)) { reached = true; break }
        }
        if (step.until && !reached) throw new Error('已达到 repeat 上限，until 条件仍未满足。')
      }
    }
    return true
  }
  try { await walk(args.steps); budget() } catch (error) { failure = error?.message || '动态流程执行失败。' }
  finally {
    clearTimeout(deadlineTimer)
    exec?.signal?.removeEventListener('abort', parentCancelled)
  }
  const returned = Object.create(null)
  if (!failure) {
    try { for (const key of args.return_vars || []) returned[key] = pathValue(variables, key) } catch (error) { failure = error.message }
  }
  const completed = results.filter((r) => r.ok).length
  return {
    ok: !failure,
    result: `${failure ? `动态流程停止：${failure}` : '批量操作完成'}（${completed}/${executed} 次工具成功，${skipped} 步跳过）：\n`
      + results.map((r, i) => `${i + 1}. ${r.tool}: ${r.result}`).join('\n')
      + '\n界面变化后重新观察；流程不会延长 TTL 或重放失败动作。',
    completed, failedStep: failure ? (results.findIndex((r) => !r.ok) + 1 || executed + 1) : null,
    steps: results, data: { executed, skipped, variables: returned },
    ...(image ? { image } : {}),
  }
}
