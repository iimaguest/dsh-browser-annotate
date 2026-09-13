// The app's outward API: annotations waiting, and the browser they were made in.
//
// Where this sits, because two mechanisms existed for one job and only one of them is real:
//
//   Putting an annotation INTO the conversation is not this file's job. That is done over the
//   Chrome DevTools Protocol, directly against the page the human started themselves — see
//   deliver.js. It needs nothing installed inside DSH, which is what makes it work against a
//   DSH started in someone else's terminal on someone else's port.
//
//   This file is the other direction: what the app offers to anything outside it. The DSH
//   that drives the right pane's tabs is a separate process, and its tools reach this app
//   over loopback HTTP rather than by being loaded into it. The annotation queue is part of
//   that surface: an agent can read what the human annotated, and a person can curl it.
//
// The queue is the source of truth for "not yet sent". An entry leaves it only after the
// composer accepted it, so an annotation survives a reload of either side.

const { createServer } = require('node:http')

/** Where the DSH page looks. A single well-known port keeps the two halves discoverable
    without a config file, and the range means a second copy of the app can still start. */
const DEFAULT_PORT = 7391
const PORT_RANGE = 8

/** How long one annotation is kept after being taken, for the page to re-fetch on a retry. */
const TAKEN_GRACE_MILLISECONDS = 60_000

class AnnotationBridge {
  /**
   * @param onLog - called with human-readable lines worth showing in the app.
   */
  constructor(onLog = () => undefined) {
    this.onLog = onLog
    this.entries = []
    this.nextId = 1
    this.port = null
    this.server = null
    this.onChange = undefined
    /**
     * How the app answers the conversation's tools: `(method, params) => Promise<result>`.
     * Left unset when the app is only serving the annotation queue.
     */
    this.onRpc = undefined
    /** How anything outside can see which tabs exist: `() => tab[]`. */
    this.onTabs = undefined
  }

  /**
   * Add an annotation.
   *
   * The screenshot is stored as a data URL alongside the text rather than written to disk:
   * the only thing that ever consumes it is the page, which needs a URL or a blob it can
   * hand to an upload, and a file on disk would have to be cleaned up by someone.
   */
  add(annotation) {
    const entry = {
      id: this.nextId++,
      createdAt: new Date().toISOString(),
      annotation,
    }
    this.entries.push(entry)
    this.onLog(`annotation ${entry.id}: ${annotation.element?.selector ?? '(no selector)'} on ${annotation.url ?? ''}`)
    if (this.onChange !== undefined) this.onChange(this.list())
    return entry
  }

  /**
   * Attach the screenshot that belongs to an annotation already in the queue.
   *
   * The comment arrives first because the human typed it first and it must never be lost to a
   * capture that failed. This is the picture catching up.
   */
  setScreenshot(id, screenshot) {
    const entry = this.entries.find(candidate => candidate.id === id)
    if (entry === undefined) return false
    entry.annotation.screenshot = screenshot
    if (this.onChange !== undefined) this.onChange(this.list())
    return true
  }

  list() {
    return this.entries.map(entry => ({
      id: entry.id,
      createdAt: entry.createdAt,
      url: entry.annotation.url,
      title: entry.annotation.title,
      comment: entry.annotation.comment,
      selector: entry.annotation.element?.selector ?? null,
      screenshot: entry.annotation.screenshot ?? null,
      text: entry.annotation.text ?? null,
    }))
  }

  /** Drop entries the page has taken, unless it asked for them again. */
  clear(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      this.entries = []
    } else {
      this.entries = this.entries.filter(entry => !ids.includes(entry.id))
    }
    if (this.onChange !== undefined) this.onChange(this.list())
    return { ok: true, remaining: this.entries.length }
  }

  /** Everything waiting, in the order it was made. */
  waiting() {
    return this.entries.map(entry => ({ ...entry, annotation: { ...entry.annotation } }))
  }

  /**
   * Serve the queue.
   *
   * The routes are deliberately few: read what is waiting, say what was taken, check that
   * this is the right server. CORS is open because the caller is a page on another origin,
   * and the data never leaves the machine.
   */
  async listen(port = DEFAULT_PORT) {
    const handler = (request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port ?? port}`)
      const allow = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'cache-control': 'no-store',
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, allow)
        response.end()
        return
      }

      const json = (status, body) => {
        response.writeHead(status, { ...allow, 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }

      if (url.pathname === '/health') {
        // `app` is what identifies this server as the desktop browser rather than any other
        // thing on a loopback port: the DSH-side tools scan for it before they will talk to it.
        json(200, {
          ok: true,
          app: 'dsh-desktop',
          version: 1,
          port: this.port,
          // Published so Playwright can attach without being told where to. Null while Chromium
          // is still choosing, which the client reads as "not yet" rather than as "never".
          debugPort: this.onDebugPort === undefined ? null : this.onDebugPort(),
          waiting: this.entries.length,
          tabs: this.onTabs === undefined ? [] : this.onTabs(),
        })
        return
      }
      if (url.pathname === '/annotations' && request.method === 'GET') {
        json(200, { ok: true, annotations: this.waiting() })
        return
      }
      // What the conversation's tools ask the browser to do. This is one route rather than one
      // per verb because the verbs are the tool vocabulary, not a REST resource: the DSH-side
      // tools already speak it, and the Chrome extension answers the identical names, so a tool
      // is genuinely agnostic about which engine is on the other end.
      if (url.pathname === '/rpc' && request.method === 'POST') {
        let body = ''
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', async () => {
          let call = {}
          try {
            call = JSON.parse(body === '' ? '{}' : body)
          } catch {
            json(400, { ok: false, error: 'the request body is not JSON' })
            return
          }
          if (this.onRpc === undefined) {
            json(503, { ok: false, error: 'this app is not serving the browser API yet' })
            return
          }
          try {
            const result = await this.onRpc(String(call.method ?? ''), call.params ?? {})
            json(200, { ok: true, result: result ?? null })
          } catch (error) {
            // A method that failed is a normal answer, not a broken request: the tool turns this
            // into the sentence the model reads, so the message is the payload.
            json(200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })
        return
      }
      // Which tabs exist, without going through the tool vocabulary, so anything on this machine
      // can see what the browser is showing with one curl.
      if (url.pathname === '/tabs' && request.method === 'GET') {
        json(200, { ok: true, tabs: this.onTabs === undefined ? [] : this.onTabs() })
        return
      }
      if (url.pathname === '/annotations/taken' && request.method === 'POST') {
        let body = ''
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', () => {
          let ids = []
          try {
            ids = JSON.parse(body === '' ? '{}' : body).ids ?? []
          } catch {
            // A malformed body is treated as "nothing was taken" rather than as a failure: the
            // page can ask again, and losing an annotation to a parse error would be worse.
            ids = []
          }
          json(200, this.clear(ids))
        })
        return
      }
      json(404, { ok: false, error: `no route for ${url.pathname}` })
    }

    for (let candidate = port; candidate < port + PORT_RANGE; candidate++) {
      const server = createServer(handler)
      // eslint-disable-next-line no-await-in-loop
      const bound = await new Promise(resolve => {
        server.once('error', () => resolve(false))
        server.listen(candidate, '127.0.0.1', () => resolve(true))
      })
      if (bound) {
        this.server = server
        this.port = candidate
        this.onLog(`annotation bridge listening on http://127.0.0.1:${candidate}`)
        return candidate
      }
      server.close()
    }
    this.onLog('the annotation bridge could not find a free port; annotations will stay in this window')
    return null
  }

  /** The URL the DSH page should poll, or null when nothing is listening. */
  get url() {
    return this.port === null ? null : `http://127.0.0.1:${this.port}`
  }

  dispose() {
    this.server?.close()
    this.server = null
  }
}

module.exports = { AnnotationBridge, DEFAULT_PORT, TAKEN_GRACE_MILLISECONDS }
