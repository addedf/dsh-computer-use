/** Loopback-only business fixture for real DSH-host acceptance.
 * No DSH services are replaced here: this module owns only test files and HTTP.
 */
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir, lstat, symlink } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'

const BODY_LIMIT = 128 * 1024
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const page = (body, title = 'DSH host acceptance') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:18px system-ui;max-width:760px;margin:32px}label,input,select,button,a{display:block;margin:12px 0}input,select,button{font:inherit}input[type=checkbox]{display:inline}#result{white-space:pre-wrap}</style><body>${body}</body></html>`

/** Parse only small, ordinary browser FormData requests used by this fixture. */
function parseMultipart(bytes, contentType) {
  const boundary = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=? -]{1,100})"|([A-Za-z0-9'()+_,./:=?-]{1,100}))$/i.exec(contentType || '')
  if (!boundary) throw new Error('Expected browser multipart form data.')
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`)
  if (!bytes.subarray(0, marker.length).equals(marker)) throw new Error('Invalid multipart start.')
  const fields = new Map()
  let cursor = marker.length
  while (cursor < bytes.length) {
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) return fields
    if (!bytes.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) throw new Error('Invalid multipart separator.')
    cursor += 2
    const headerEnd = bytes.indexOf('\r\n\r\n', cursor)
    if (headerEnd < cursor || headerEnd - cursor > 8192) throw new Error('Invalid multipart headers.')
    const headers = bytes.subarray(cursor, headerEnd).toString('utf8')
    const disposition = /^content-disposition:\s*form-data;\s*name="([A-Za-z][A-Za-z0-9_-]{0,63})"(?:;\s*filename="([^"\r\n]{0,200})")?\s*$/im.exec(headers)
    if (!disposition || fields.has(disposition[1]) || fields.size >= 12) throw new Error('Invalid or duplicate form field.')
    const start = headerEnd + 4
    const next = bytes.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), start)
    if (next < 0) throw new Error('Missing multipart terminator.')
    fields.set(disposition[1], { bytes: bytes.subarray(start, next), filename: disposition[2] })
    cursor = next + 2 + marker.length
  }
  throw new Error('Unterminated multipart form.')
}

export async function createHostFixture(root) {
  if (!isAbsolute(root)) throw new Error('Fixture root must be absolute.')
  const fixtureRoot = resolve(root)
  const workspace = join(fixtureRoot, 'workspace')
  const downloadDir = join(workspace, 'downloads')
  const boundaryDownloadDir = join(workspace, 'boundary-downloads')
  const uploadPath = join(workspace, 'upload.txt')
  const symlinkUploadPath = join(workspace, 'upload-link.txt')
  const outsidePath = join(fixtureRoot, 'outside.txt')
  await mkdir(downloadDir, { recursive: true })
  await mkdir(boundaryDownloadDir, { recursive: true })
  const fixtureId = randomBytes(6).toString('hex')
  const name = `Acceptance ${fixtureId}`
  const dispatchCode = `QA-${randomBytes(6).toString('hex').toUpperCase()}`
  const confirmation = `CONF-${randomBytes(6).toString('hex').toUpperCase()}`
  const uploadMarker = `UPLOAD-${randomBytes(16).toString('hex')}`
  const uploadBytes = Buffer.from(`DSH host acceptance supporting file\n${uploadMarker}\n`)
  const receiptName = `receipt-${fixtureId}.txt`
  const receiptBytes = Buffer.from(`Registration complete\nConfirmation: ${confirmation}\nName: ${name}\nService: Express\nUpload: upload.txt\n${uploadMarker}\n`)
  const boundaryBytes = Buffer.from('DSH boundary download fixture\n')
  // Exclusive creation prevents an accidentally reused root from replacing files.
  await writeFile(uploadPath, uploadBytes, { flag: 'wx', mode: 0o600 })
  await symlink('upload.txt', symlinkUploadPath)
  await writeFile(outsidePath, `OUTSIDE-WORKSPACE-${fixtureId}\n`, { flag: 'wx', mode: 0o600 })
  const state = { fixtureId, formReads: 0, briefReads: 0, submissions: [], receiptRequests: 0, boundaryRequests: 0, accepted: 0, completed: false }
  let closed = false
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const path = new URL(request.url, 'http://localhost').pathname
    const json = (code, data) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    try {
      if (request.method === 'GET' && path === '/files') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(page('<h1>Boundary file checks</h1><label>Boundary upload<input type="file" aria-label="Boundary upload"></label><a href="/boundary-file" download="boundary.txt">Download boundary file</a>', 'Boundary file checks'))
      } else if (request.method === 'GET' && path === '/boundary-file') {
        state.boundaryRequests++
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="boundary.txt"', 'Content-Length': boundaryBytes.length })
        response.end(boundaryBytes)
      } else if (request.method === 'GET' && path === '/') {
        state.formReads++
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        const form = `<form id="registration"><label>Full name<input name="fullName" required></label><label>Service level<select name="level"><option>Standard</option><option>Express</option></select></label><a href="/brief" target="_blank" rel="noopener">View dispatch brief</a><label>Dispatch code<input name="code" required></label><label>Supporting file<input name="attachment" type="file" accept="text/plain,.txt" required></label><label><input name="confirmed" type="checkbox" required>I confirm this is a test entry</label><button type="submit">Confirm registration</button></form><p id="result" role="status"></p><div id="receipt"></div>`
        response.end(page(`<h1>Test registration</h1><button id="start">Start registration</button><div id="area" role="region" aria-label="Registration form"></div><script>
          document.querySelector('#start').onclick=()=>{document.querySelector('#start').disabled=true;document.querySelector('#area').textContent='Preparing registration form…';setTimeout(()=>{document.querySelector('#area').innerHTML=${JSON.stringify(form)};document.querySelector('#registration').onsubmit=async(event)=>{event.preventDefault();const form=event.target;const button=form.querySelector('button');button.disabled=true;document.querySelector('#result').textContent='Processing registration…';try{const response=await fetch('/complete',{method:'POST',body:new FormData(form)});const data=await response.json();setTimeout(()=>{document.querySelector('#result').textContent=data.message;if(data.ok){const link=document.createElement('a');link.href='/receipt';link.download=${JSON.stringify(receiptName)};link.textContent='Download receipt';document.querySelector('#receipt').replaceChildren(link)}else{button.disabled=false}},450)}catch(error){document.querySelector('#result').textContent='Registration failed';button.disabled=false}}},350)};
          </script>`))
      } else if (request.method === 'GET' && path === '/brief') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(page('<h1>Dispatch brief</h1><p id="code" role="status">Loading dispatch instructions…</p><script>setTimeout(async()=>{const data=await(await fetch("/brief-data")).json();document.querySelector("#code").textContent="Dispatch code: "+data.code},550)</script>'))
      } else if (request.method === 'GET' && path === '/brief-data') {
        state.briefReads++
        json(200, { code: dispatchCode })
      } else if (request.method === 'POST' && path === '/complete') {
        if (Number(request.headers['content-length'] || 0) > BODY_LIMIT) { request.resume(); json(413, { ok: false, message: 'Test form is too large.' }); return }
        const chunks = []; let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > BODY_LIMIT) { json(413, { ok: false, message: 'Test form is too large.' }); request.destroy(); return }
          chunks.push(chunk)
        }
        const fields = parseMultipart(Buffer.concat(chunks), request.headers['content-type'])
        const text = (field) => fields.get(field)?.bytes.toString('utf8')
        const attachment = fields.get('attachment')
        const valid = text('fullName') === name && text('level') === 'Express' && text('code') === dispatchCode
          && text('confirmed') === 'on' && attachment?.filename === 'upload.txt' && attachment.bytes.equals(uploadBytes)
        const duplicate = valid && state.completed
        state.submissions.push({ valid, duplicate, fullName: text('fullName'), level: text('level'), codeMatches: text('code') === dispatchCode, confirmed: text('confirmed') === 'on', uploadName: attachment?.filename, uploadBytes: attachment?.bytes.length || 0, uploadSha256: attachment ? digest(attachment.bytes) : undefined })
        if (!valid) json(422, { ok: false, message: 'Registration rejected: check all fields and supporting file.' })
        else if (duplicate) json(409, { ok: false, message: 'This test registration has already been completed.' })
        else { state.accepted++; state.completed = true; json(200, { ok: true, message: `Registration complete. Confirmation: ${confirmation}` }) }
      } else if (request.method === 'GET' && path === '/receipt' && state.completed) {
        state.receiptRequests++
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${receiptName}"`, 'Content-Length': receiptBytes.length })
        response.end(receiptBytes)
      } else { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found') }
    } catch {
      if (!response.headersSent) json(400, { ok: false, message: 'Invalid test request.' })
      else response.end()
    }
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); done() }) })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    task: { url: `${origin}/`, checksURL: `${origin}/files`, workspace, name, uploadPath, symlinkUploadPath, downloadDir, boundaryDownloadDir, outsidePath, expected: { confirmation, dispatchCode, uploadMarker, uploadSha256: digest(uploadBytes), receiptName, receiptSha256: digest(receiptBytes), boundaryName: 'boundary.txt', boundarySha256: digest(boundaryBytes) } },
    state,
    async verify() {
      const files = await readdir(downloadDir)
      const receiptPath = join(downloadDir, receiptName)
      let downloadedBytes, regularFile = false
      try { const info = await lstat(receiptPath); regularFile = info.isFile() && !info.isSymbolicLink(); if (regularFile) downloadedBytes = await readFile(receiptPath) } catch {}
      const checks = [
        { name: 'registration page was opened', ok: state.formReads > 0 },
        { name: 'asynchronous dispatch brief was read', ok: state.briefReads > 0 },
        { name: 'exactly one valid submission was accepted', ok: state.accepted === 1 && state.submissions.length === 1 && state.submissions[0].valid && !state.submissions[0].duplicate },
        { name: 'uploaded file bytes match the authorized fixture', ok: state.submissions[0]?.uploadSha256 === digest(uploadBytes) },
        { name: 'receipt was requested by the browser', ok: state.receiptRequests > 0 },
        { name: 'receipt exists as a regular file in the download directory', ok: regularFile },
        { name: 'downloaded receipt bytes match the server result', ok: Boolean(downloadedBytes?.equals(receiptBytes)) },
      ]
      return { ok: checks.every((check) => check.ok), checks, files, receiptPath, downloadedSha256: downloadedBytes ? digest(downloadedBytes) : undefined }
    },
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()))
    },
  }
}
