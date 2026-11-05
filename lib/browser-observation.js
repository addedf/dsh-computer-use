const limits = (value, fallback, maximum) =>
  Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback

/** One deadline and two independent traversal allowances for the whole page. */
export function createBrowserObservationBudget(config = {}, signal, stillCurrent = () => true) {
  const timeoutMs = limits(config.browserObservationTimeoutMs, 5000, 30000)
  const maxNodes = limits(config.browserObservationMaxNodes, 10000, 100000)
  const safetyMaxNodes = limits(config.browserObservationSafetyMaxNodes, 10000, 100000)
  const deadline = performance.now() + timeoutMs
  const visited = { output: 0, safety: 0 }
  const stopReasons = new Set()
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('操作已取消。'), { code: 'ABORTED' })
    if (!stillCurrent())
      throw Object.assign(new Error('网页观察已被更新的观察或导航取代。'), {
        code: 'BROWSER_OBSERVATION_SUPERSEDED',
      })
    if (performance.now() >= deadline) {
      stopReasons.add('timeout')
      throw Object.assign(new Error('网页观察已达到总时间预算。'), {
        code: 'BROWSER_OBSERVATION_TIMEOUT',
      })
    }
  }
  const disposeLater = (handle) => {
    try {
      void Promise.resolve(handle?.dispose?.()).catch(() => {})
    } catch {}
  }
  const call = async (task, onLate) => {
    check()
    let timer,
      onAbort,
      settled = false
    const operation = Promise.resolve().then(() => {
      check()
      return task()
    })
    operation.then(
      (value) => {
        if (settled) onLate?.(value)
      },
      () => {},
    )
    const boundary = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          stopReasons.add('timeout')
          reject(
            Object.assign(new Error('网页观察已达到总时间预算。'), {
              code: 'BROWSER_OBSERVATION_TIMEOUT',
            }),
          )
        },
        Math.max(0, deadline - performance.now()),
      )
      onAbort = () => reject(Object.assign(new Error('操作已取消。'), { code: 'ABORTED' }))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    try {
      const value = await Promise.race([operation, boundary])
      try {
        check()
      } catch (error) {
        onLate?.(value)
        throw error
      }
      return value
    } finally {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return {
    timeoutMs,
    maxNodes,
    safetyMaxNodes,
    visited,
    stopReasons,
    check,
    call,
    remainingMs: () => Math.max(0, deadline - performance.now()),
    dispose: async (handle) => {
      if (!handle?.dispose) return
      if (performance.now() >= deadline || signal?.aborted || !stillCurrent()) {
        disposeLater(handle)
        return
      }
      try {
        await call(() => handle.dispose())
      } catch {
        disposeLater(handle)
      }
    },
  }
}

export async function collectBrowserFrame(frame, request, budget) {
  let batch,
    elementArray,
    cursor,
    transferred = false
  const elements = []
  const disposeLate = (handle) => {
    void budget.dispose(handle)
  }
  try {
    batch = await budget.call(() => frame.evaluateHandle(inspectBrowserDOM, request), disposeLate)
    const metadata = await budget.call(() =>
      batch.evaluate((data) => ({
        cursorValid: data.cursorValid,
        rows: data.rows,
        text: data.text,
        used: data.used,
        outputComplete: data.outputComplete,
        safetyComplete: data.safetyComplete,
        sensitive: data.sensitive,
        stopReasons: data.stopReasons,
      })),
    )
    elementArray = await budget.call(() => batch.getProperty('elements'), disposeLate)
    const properties = await budget.call(
      () => elementArray.getProperties(),
      (properties) => {
        for (const handle of properties.values()) disposeLate(handle)
      },
    )
    for (const [key, handle] of properties) {
      if (/^\d+$/.test(key) && handle.asElement()) elements[Number(key)] = handle.asElement()
      else disposeLate(handle)
    }
    if (metadata.rows.length !== elements.length)
      throw new Error('网页观察的元素与元数据数量不一致。')
    if (metadata.cursorValid && !metadata.outputComplete)
      cursor = await budget.call(() => batch.getProperty('cursor'), disposeLate)
    budget.check()
    transferred = true
    return {
      ...metadata,
      rows: metadata.rows.map((entry, index) => ({ ...entry, handle: elements[index], frame })),
      cursor,
    }
  } finally {
    await budget.dispose(elementArray)
    await budget.dispose(batch)
    if (!transferred) {
      for (const element of elements) await budget.dispose(element)
      await budget.dispose(cursor)
    }
  }
}

/** Fixed, self-contained browser code. The same descriptor serves observation
 * and live action validation, so their identity and action contracts agree.
 * A scan returns only selected DOM nodes as handles, never all page matches.
 */
export function inspectBrowserDOM(subject, mode = false) {
  const scanning = subject?.operation === 'scan'
  const request = scanning ? subject : null
  const deadline = performance.now() + (request?.timeoutMs ?? 1000)
  const sensitiveName =
    /密码|口令|密钥|\b(?:password|passphrase|secret|api[ _-]?key|access[ _-]?token)\b/i
  const selector = 'button,a[href],input,textarea,select,[role],[contenteditable="true"],[tabindex]'
  const used = { output: 0, safety: 0 }
  let channel = 'output'
  const allowance = () => (channel === 'safety' ? request.safetyNodes : request.outputNodes)
  const consume = () => {
    if (performance.now() >= deadline || (scanning && used[channel] >= allowance())) return false
    if (scanning) used[channel]++
    return true
  }
  const editableElement = (element) =>
    ['input', 'textarea', 'select'].includes(element.tagName.toLowerCase()) ||
    element.isContentEditable
  const textOf = (element, maximum = 2000, skipEditable = false) => {
    if (!element) return { text: '', complete: true }
    if (skipEditable && editableElement(element)) return { text: '', complete: true }
    let text = '',
      count = 0
    let node = element.firstChild
    while (node) {
      if (++count > 128 || !consume()) return { text, complete: false }
      const skipChildren =
        skipEditable && node.nodeType === Node.ELEMENT_NODE && editableElement(node)
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || ''
        const remaining = maximum - text.length
        text += value.slice(0, remaining)
        if (value.length > remaining) return { text, complete: false }
      }
      if (!skipChildren && node.firstChild) {
        node = node.firstChild
        continue
      }
      while (node !== element && !node.nextSibling) node = node.parentNode
      node = node === element ? null : node.nextSibling
    }
    return { text, complete: true }
  }
  const nameOf = (element) => {
    let complete = true
    const limited = (text) => {
      text = String(text || '')
      if (text.length > 2000) complete = false
      return text.slice(0, 2000)
    }
    let name = limited(element.getAttribute('aria-label'))
    if (!name) {
      const labelledBy = element.getAttribute('aria-labelledby') || ''
      if (labelledBy.length > 4096) complete = false
      const ids = labelledBy.slice(0, 4096).trim().split(/\s+/).filter(Boolean)
      if (ids.length > 16) complete = false
      name = ids
        .slice(0, 16)
        .map((id) => {
          const value = textOf(document.getElementById(id), 2000, true)
          complete &&= value.complete
          return value.text
        })
        .join(' ')
        .trim()
    }
    if (!name && element.labels) {
      if (element.labels.length > 16) complete = false
      const labels = []
      for (let index = 0; index < Math.min(16, element.labels.length); index++) {
        const value = textOf(element.labels[index], 2000, true)
        complete &&= value.complete
        labels.push(value.text)
      }
      name = labels.join(' ').trim()
    }
    if (!name) name = limited(element.getAttribute('placeholder'))
    const editableValue = editableElement(element)
    if (!name && !editableValue) {
      const value = textOf(element, 2000, true)
      name = value.text
      complete &&= value.complete
    }
    if (!name) name = limited(element.getAttribute('title'))
    return { name: limited(name).trim(), complete }
  }
  const describe = (element, purpose = false) => {
    const backgroundPointer = purpose === 'background-pointer'
    const explicitLink = purpose === 'open-link'
    if (
      (purpose === true || backgroundPointer || explicitLink) &&
      (!element.isConnected || element.ownerDocument !== document)
    )
      return null
    if (purpose === true && (!(element instanceof HTMLInputElement) || element.type !== 'file'))
      return null
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      ((backgroundPointer || explicitLink) && style.visibility !== 'visible')
    )
      return null
    const tag = element.tagName.toLowerCase()
    const type = (element.getAttribute('type') || '').toLowerCase()
    const role =
      element.getAttribute('role') ||
      (tag === 'input'
        ? ['checkbox', 'radio'].includes(type)
          ? type
          : ['submit', 'button', 'reset'].includes(type)
            ? 'button'
            : type === 'file'
              ? 'fileinput'
              : 'textbox'
        : {
            button: 'button',
            a: 'link',
            textarea: 'textbox',
            select: 'combobox',
            option: 'option',
          }[tag] || (element.isContentEditable ? 'textbox' : 'region'))
    const { name, complete: nameComplete } = nameOf(element)
    const protectedField = type === 'password'
    const enabled = !(
      element.matches(':disabled') ||
      element.disabled ||
      element.getAttribute('aria-disabled') === 'true'
    )
    const editable = ['input', 'textarea'].includes(tag) || element.isContentEditable
    const actions = ['pointer']
    if (
      ['button', 'link', 'checkbox', 'radio'].includes(role) ||
      element.getAttribute('onclick') ||
      element.tabIndex >= 0
    )
      actions.push('click')
    if (
      editable &&
      type !== 'file' &&
      !['checkbox', 'radio', 'submit', 'button', 'reset'].includes(type)
    )
      actions.push('type')
    if (tag === 'select') actions.push('select')
    if (type === 'file') actions.push('upload')
    const checked =
      typeof element.checked === 'boolean'
        ? element.checked
        : element.hasAttribute('aria-checked')
          ? element.getAttribute('aria-checked') === 'mixed'
            ? null
            : element.getAttribute('aria-checked') === 'true'
          : undefined
    const inViewport =
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
    const link =
      typeof HTMLAnchorElement !== 'undefined' && element instanceof HTMLAnchorElement
        ? {
            href: element.href,
            target: (
              element.target ||
              document.querySelector('base[target]')?.target ||
              ''
            ).toLowerCase(),
            download: element.hasAttribute('download'),
          }
        : null
    let pointerMetadata
    if (backgroundPointer) {
      const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2
      const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2
      const hit = inViewport ? document.elementFromPoint(x, y) : null
      pointerMetadata = {
        connected: true,
        hitTarget:
          style.pointerEvents !== 'none' &&
          !element.closest('[inert]') &&
          Boolean(hit && (hit === element || element.contains(hit))),
      }
    }
    let rawValue = null
    let valueComplete = true
    if (!protectedField && editable) {
      if (typeof element.value === 'string') rawValue = element.value
      else {
        const content = textOf(element)
        rawValue = content.text
        valueComplete = content.complete
      }
    } else if (tag === 'select') rawValue = element.value
    const value = typeof rawValue === 'string' ? rawValue.slice(0, 1001) : rawValue
    return {
      role,
      name,
      nameComplete,
      actions,
      protected: protectedField,
      enabled,
      ...(['checkbox', 'radio'].includes(role) && checked !== undefined ? { checked } : {}),
      value,
      valueComplete: valueComplete && (typeof rawValue !== 'string' || rawValue.length <= 1000),
      identity: { tag, type, linkDestination: tag === 'a' ? element.href : null },
      link,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport,
      ...(explicitLink ? { connected: true } : {}),
      ...pointerMetadata,
    }
  }
  if (!scanning) return describe(subject, mode)

  const root = request.scope || document.body || document.documentElement
  const newCursor = (root) => ({
    document,
    root,
    walkers: [
      { walker: document.createTreeWalker(root, NodeFilter.SHOW_ALL), root, started: false },
    ],
    textOffset: 0,
    pendingText: null,
  })
  const cursor = request.cursor || newCursor(root)
  const valid =
    cursor.document === document &&
    cursor.root === root &&
    root?.isConnected &&
    cursor.walkers.every((item) => item.walker.currentNode.isConnected)
  if (!valid)
    return {
      cursorValid: false,
      rows: [],
      elements: [],
      text: '',
      used,
      outputComplete: false,
      safetyComplete: false,
      sensitive: true,
      stopReasons: ['cursor_changed'],
    }
  const nextNode = (cursor) => {
    while (cursor.walkers.length) {
      const item = cursor.walkers[cursor.walkers.length - 1]
      const node = item.started ? item.walker.nextNode() : item.root
      item.started = true
      if (!node) {
        cursor.walkers.pop()
        continue
      }
      if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot)
        cursor.walkers.push({
          walker: document.createTreeWalker(node.shadowRoot, NodeFilter.SHOW_ALL),
          root: node.shadowRoot,
          started: false,
        })
      return node
    }
    return null
  }
  const rows = [],
    elements = [],
    stopReasons = []
  let text = '',
    outputComplete = request.outputDone === true,
    safetyComplete = false,
    sensitive = false
  channel = 'output'
  if (!outputComplete && request.maxRows > 0 && request.maxTextChars > 0) {
    while (consume()) {
      const node = cursor.pendingText || nextNode(cursor)
      if (!node) {
        outputComplete = true
        break
      }
      if (node.nodeType === Node.ELEMENT_NODE && node.matches(selector)) {
        const descriptor = describe(node)
        if (
          descriptor &&
          (!request.query ||
            `${descriptor.role} ${descriptor.name} ${descriptor.protected ? '' : descriptor.value || ''}`
              .toLowerCase()
              .includes(request.query))
        ) {
          rows.push(descriptor)
          elements.push(node)
          if (!descriptor.nameComplete) stopReasons.push('name_limit')
          if (rows.length >= request.maxRows) {
            stopReasons.push('elements')
            break
          }
        }
      }
      if (
        node.nodeType === Node.TEXT_NODE &&
        node.parentElement &&
        !node.parentElement.closest('script,style,template,noscript') &&
        node.parentElement.getClientRects().length
      ) {
        const value = node.nodeValue || ''
        if (request.query) {
          const step = 16000
          const window = value.slice(
            cursor.textOffset,
            cursor.textOffset + step + request.query.length - 1,
          )
          const matchIndex = window.toLowerCase().indexOf(request.query)
          const remaining = request.maxTextChars - text.length
          if (matchIndex >= 0 && matchIndex < step) {
            if (remaining < request.query.length) {
              cursor.pendingText = node
              stopReasons.push('text')
              break
            }
            const context = Math.min(128, Math.floor((remaining - request.query.length) / 2))
            text += window.slice(
              Math.max(0, matchIndex - context),
              matchIndex + request.query.length + context,
            )
            if (text.length < request.maxTextChars) text += '\n'
          }
          cursor.textOffset = Math.min(value.length, cursor.textOffset + step)
          if (cursor.textOffset < value.length) {
            cursor.pendingText = node
            if (text.length >= request.maxTextChars) {
              stopReasons.push('text')
              break
            }
            continue
          }
          cursor.pendingText = null
          cursor.textOffset = 0
          continue
        }
        const chunk = value.slice(cursor.textOffset, cursor.textOffset + 16000)
        const remaining = request.maxTextChars - text.length
        const part = chunk.slice(0, remaining)
        text += part
        cursor.textOffset += part.length
        if (cursor.textOffset < value.length) {
          cursor.pendingText = node
          stopReasons.push('text')
          break
        }
        text += '\n'
        cursor.pendingText = null
        cursor.textOffset = 0
        if (text.length >= request.maxTextChars) {
          stopReasons.push('text')
          break
        }
      }
    }
    if (!outputComplete && !stopReasons.length)
      stopReasons.push(performance.now() >= deadline ? 'timeout' : 'output_nodes')
  } else if (!outputComplete) stopReasons.push('elements')

  channel = 'safety'
  const safetyCursor = newCursor(document.documentElement)
  while (consume()) {
    const node = nextNode(safetyCursor)
    if (!node) {
      safetyComplete = true
      break
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    if (node.tagName.toLowerCase() === 'input' && node.type === 'password') sensitive = true
    if (node.matches(selector)) {
      const descriptor = describe(node)
      if (descriptor) {
        sensitive ||= descriptor.protected || sensitiveName.test(descriptor.name)
        if (!descriptor.nameComplete) {
          stopReasons.push('safety_name_limit')
          break
        }
      }
    }
  }
  if (!safetyComplete && !stopReasons.includes('safety_name_limit'))
    stopReasons.push(performance.now() >= deadline ? 'timeout' : 'safety_nodes')
  return {
    cursorValid: true,
    rows,
    elements,
    text: text.slice(0, request.maxTextChars),
    used,
    outputComplete,
    safetyComplete,
    sensitive,
    stopReasons,
    cursor: outputComplete ? null : cursor,
  }
}
