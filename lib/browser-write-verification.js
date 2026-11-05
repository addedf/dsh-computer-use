/** Read back a single delivered write. Polling never repeats the mutation.
 * Inspired by iFurySt/open-computer-use's bounded set-value verification;
 * this implementation accepts only comparison results, never field values.
 */
export async function verifyBrowserWrite({
  read,
  validate,
  signal,
  budgetMs = 600,
  intervalMs = 50,
}) {
  const deadline = performance.now() + budgetMs
  let attempts = 0,
    mismatched = false
  const canceled = () => {
    if (signal?.aborted) throw Object.assign(new Error('操作已取消。'), { code: 'ABORTED' })
  }
  const bounded = async (task, duration) => {
    let timer,
      onAbort,
      retired = false
    const live = () => !retired && performance.now() < deadline
    const boundary = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          retired = true
          resolve({ status: 'timeout' })
        },
        Math.max(0, duration),
      )
      onAbort = () => {
        retired = true
        reject(Object.assign(new Error('操作已取消。'), { code: 'ABORTED' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    try {
      return await Promise.race([Promise.resolve().then(() => task(live)), boundary])
    } finally {
      retired = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  while (true) {
    canceled()
    const remaining = deadline - performance.now()
    if (remaining <= 0) return { status: mismatched ? 'mismatch' : 'timeout', attempts }
    const checked = await bounded(async (live) => {
      try {
        if (!live()) return { status: 'timeout' }
        if (!(await validate())) return { status: 'target_changed' }
        canceled()
        if (!live()) return { status: 'timeout' }
        attempts++
        const value = await read()
        canceled()
        if (!live()) return { status: 'timeout' }
        if (!(await validate())) return { status: 'target_changed' }
        canceled()
        if (!live()) return { status: 'timeout' }
        if (value?.available !== true || typeof value.matches !== 'boolean')
          return { status: 'unavailable' }
        return { status: value.matches ? 'matched' : 'mismatch' }
      } catch (error) {
        if (error.code === 'ABORTED') throw error
        return { status: 'unavailable' }
      }
    }, remaining)
    canceled()
    if (checked.status !== 'mismatch')
      return {
        ...checked,
        ...(checked.status === 'timeout' && mismatched ? { status: 'mismatch' } : {}),
        attempts,
      }
    mismatched = true
    const wait = Math.min(intervalMs, deadline - performance.now())
    if (wait <= 0) return { status: 'mismatch', attempts }
    await bounded(() => new Promise((resolve) => setTimeout(resolve, wait)), wait)
  }
}
