// HTTP and SSE routes for the Bridge Annotate UI and the extension.
//
// The webserver's upgrade table cannot carry a WebSocket under a prefix, so the
// extension's socket lives at the fixed path `/browser-annotate/ws` while the
// panel's read/write API shares the same prefix over plain HTTP. The panel's
// push channel is Server-Sent Events rather than a second socket: the panel only
// ever receives notifications, and SSE survives the same-origin rules that
// already govern the GUI.
//
// Every route here is loopback-only by construction — the shipped web server
// binds 127.0.0.1 — and none of them accept a caller-supplied path or command,
// so there is no route through this surface to anything but the attached tab.

import { publicAnnotation } from './bridge.js'

/** Prefix every route in this plugin owns. */
export const ROUTE_PREFIX = '/browser-annotate'

/** Route the extension upgrades to. */
export const WS_PATH = `${ROUTE_PREFIX}/ws`

/** Keep-alive comment interval for idle SSE streams, in milliseconds. */
const SSE_HEARTBEAT_MS = 20000

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Read a request body up to a byte cap.
 * @param req - the request to drain.
 * @param limit - maximum accepted bytes.
 * @returns the decoded body text.
 * @throws when the body exceeds the cap.
 */
function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`request body exceeded ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Parse a JSON body, treating an empty body as an empty object.
 * @param req - the request to read.
 * @returns the parsed object.
 * @throws when the body is not a JSON object.
 */
async function readJson(req) {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object body')
  }
  return parsed
}

/**
 * Build every route handler this plugin registers.
 *
 * @param bridge - the live browser bridge.
 * @param logger - Cordis logger for route-level diagnostics.
 * @returns the route table to register on `ctx.webServer`.
 */
export function browserRoutes(bridge, logger) {
  /** Exact-path handlers. */
  const exact = new Map()

  /**
   * The panel's snapshot: connection state, active tab, and the annotation queue.
   * Screenshot bytes are omitted; each annotation exposes `hasScreenshot` and is
   * fetched by id from the screenshot route so the snapshot stays small.
   */
  exact.set(`${ROUTE_PREFIX}/state`, (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    json(res, 200, bridge.snapshot(false))
  })

  /** Liveness probe used by the extension's connect flow before it opens the socket. */
  exact.set(`${ROUTE_PREFIX}/health`, (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    json(res, 200, { ok: true, connected: bridge.connected, wsPath: WS_PATH })
  })

  /** The panel's push channel. */
  exact.set(`${ROUTE_PREFIX}/events`, (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`retry: 2000\n\n`)
    res.write(`event: snapshot\ndata: ${JSON.stringify(bridge.snapshot(false))}\n\n`)
    // Every push is named for what it is. The panel listens per event name —
    // `EventSource` delivers a named event only to listeners registered for that exact
    // name — so publishing frames, annotations and the connection state all as one
    // `bridge` event meant the listeners for `frame` and `annotation/update` could
    // never fire, and the live view showed nothing at all. The name is taken from the
    // payload the bridge already sets, so the two halves cannot drift.
    const unsubscribe = bridge.subscribe(payload => {
      let name = 'bridge'
      try {
        const parsed = JSON.parse(payload)
        if (typeof parsed?.type === 'string' && parsed.type !== '') name = parsed.type
      } catch {
        // A payload that is not JSON is still forwarded, under the generic name.
      }
      res.write(`event: ${name}\ndata: ${payload}\n\n`)
    })
    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n')
    }, SSE_HEARTBEAT_MS)
    // One disposal path for every way an SSE stream ends.
    const close = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', close)
    req.on('error', close)
    res.on('error', close)
  })

  /** Start or stop annotation mode in the attached tab. */
  exact.set(`${ROUTE_PREFIX}/annotate-mode`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const mode = String(body.mode ?? 'quick')
      const result = await bridge.call('annotate.mode', { mode })
      json(res, 200, { ok: true, mode: result?.mode ?? mode, tab: result?.tab ?? bridge.activeTab })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * The browser's own tab list, or a new or closed tab.
   *
   * A browser in the sidebar needs the three things a browser does with tabs: show them,
   * make one, and get rid of one. Switching is `activate`, because making a tab active is
   * what the browser already calls it.
   */
  exact.set(`${ROUTE_PREFIX}/tabs`, async (req, res) => {
    try {
      if (req.method === 'GET') {
        const result = await bridge.call('listTabs', {})
        return json(res, 200, { ok: true, tabs: result?.tabs ?? bridge.tabs, activeId: bridge.activeTabId })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const body = await readJson(req)
      const action = String(body.action ?? 'new')
      if (action === 'new') {
        const result = await bridge.call('newTab', { url: body.url })
        return json(res, 200, { ok: true, tab: result?.tab ?? null })
      }
      if (action === 'close') {
        await bridge.call('closeTab', { tabId: body.tabId })
        return json(res, 200, { ok: true })
      }
      if (action === 'switch') {
        const result = await bridge.call('activate', { tabId: body.tabId })
        return json(res, 200, { ok: true, tab: result?.tab ?? null })
      }
      return json(res, 400, { error: `unknown tab action: ${action}` })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * Bring the human's own Chrome window to the front and focus the active tab.
   *
   * The panel shows the page, but the browser's own chrome — tab strip, address bar,
   * history, extensions, password manager — cannot be rendered from the protocol: the
   * DevTools Protocol exposes the page, not the browser window around it. So the panel
   * does not imitate that chrome; it hands the human to it. This is the route behind
   * the "Show in Chrome" control, and it is the honest answer to "I want the real
   * browser here" — one click, and the real browser is the one in front.
   */
  exact.set(`${ROUTE_PREFIX}/activate`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const result = await bridge.call('activate', { tabId: body?.tabId })
      json(res, 200, { ok: true, tab: result?.tab ?? bridge.activeTab ?? null })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * Start or stop the live view's screencast.
   *
   * The panel asks for this when its tab becomes visible and stops it when the tab
   * is hidden. Frames are JPEG and flow over the existing SSE channel, so a hidden
   * panel that forgets to stop costs the host pixel traffic for a canvas nobody
   * is looking at.
   */
  exact.set(`${ROUTE_PREFIX}/live`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const running = body.running !== false
      const result = await bridge.call('screencast', {
        running,
        tabId: body.tabId,
        quality: body.quality,
        maxWidth: body.maxWidth,
        maxHeight: body.maxHeight,
      })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /** Navigate the attached tab: an address, or a history action. */
  exact.set(`${ROUTE_PREFIX}/navigate`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const result = await bridge.call('navigate', { action: body.action ?? 'navigate', url: body.url, tabId: body.tabId })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /** Forward one pointer or keyboard event from the live view into the page. */
  exact.set(`${ROUTE_PREFIX}/input`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const result = await bridge.call('input', { kind: body.kind, event: body.event, tabId: body.tabId })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * Resolve the element at a point in the live view.
   *
   * This is what makes annotating a streamed frame possible: the panel knows only
   * where the human clicked, and the page is the only thing that knows what is
   * there. Reading it through CDP rather than the content script also means it
   * works on pages that never received one.
   */
  exact.set(`${ROUTE_PREFIX}/element`, async (req, res, url) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    try {
      // The parsed URL is the third argument the prefix handler supplies; reading a
      // query string without it is a ReferenceError at request time, not at load time.
      const x = Number(url.searchParams.get('x'))
      const y = Number(url.searchParams.get('y'))
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return json(res, 400, { ok: false, error: 'x and y are required' })
      }
      const result = await bridge.call('elementAt', { x, y })
      json(res, 200, { ok: true, element: result?.element ?? null })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * Capture a screenshot in the attached tab on behalf of the panel.
   *
   * Three shapes, in order of precision: a `rect` is captured through CDP and needs
   * no permission at all; an `annotationId` attaches that screenshot to a record the
   * panel already queued, which is how a live-view pick gets its image; and a bare
   * call falls back to the visible tab for the panel's own Capture button.
   */
  exact.set(`${ROUTE_PREFIX}/capture`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const result =
        body.rect === undefined || body.rect === null
          ? await bridge.call(
              'screenshot',
              { selector: body.selector, fullPage: body.fullPage === true },
              { timeoutMs: 60000 },
            )
          : await bridge.call('captureRect', { rect: body.rect }, { timeoutMs: 60000 })
      const dataUrl = result?.dataUrl
      if (typeof body.annotationId === 'string' && typeof dataUrl === 'string') {
        bridge.attachScreenshot(body.annotationId, dataUrl)
      }
      json(res, 200, { ok: true, result })
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  /** Record an annotation the panel produced itself (for example from its own capture button). */
  exact.set(`${ROUTE_PREFIX}/annotations`, async (req, res) => {
    if (req.method === 'POST') {
      try {
        const body = await readJson(req)
        const annotation = body.annotation ?? body
        const stored = bridge.addAnnotation(annotation)
        return json(res, 200, { ok: true, annotation: publicAnnotation(stored) })
      } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (req.method === 'DELETE') {
      try {
        const body = await readJson(req)
        const removed = bridge.removeAnnotations(Array.isArray(body.ids) ? body.ids : [])
        return json(res, 200, { ok: true, removed })
      } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return json(res, 405, { error: 'method not allowed' })
  })

  /** One annotation's screenshot, as a data URL the panel can put straight into an img. */
  exact.set(`${ROUTE_PREFIX}/screenshot`, (req, res, url) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const id = url.searchParams.get('id')
    const annotation = bridge.annotations.find(entry => entry.id === id)
    if (annotation === undefined) return json(res, 404, { error: 'no such annotation' })
    if (typeof annotation.screenshot !== 'string' || annotation.screenshot.length === 0) {
      return json(res, 404, { error: 'that annotation has no screenshot' })
    }
    json(res, 200, { id, dataUrl: annotation.screenshot })
  })

  return { exact }
}

/**
 * Register this plugin's HTTP and upgrade routes on the web server.
 *
 * One prefix route carries every HTTP endpoint and the fixed upgrade path
 * carries the extension's socket. A prefix registration is deliberate: the
 * exact table would need one row per endpoint, and `prefix p` already matches
 * both `p` and `p/<anything>`, so a single row is the whole HTTP surface.
 *
 * @param ctx - context carrying the `webServer` service.
 * @param bridge - the live browser bridge.
 * @param logger - Cordis logger.
 * @returns a disposer removing every route this plugin registered.
 */
export function registerRoutes(ctx, bridge, logger) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    logger?.warn?.('the web server is not mounted, so the Browser Annotate panel has no API')
    return () => {}
  }
  const { exact } = browserRoutes(bridge, logger)
  const disposeHttp = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      let url
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        return json(res, 400, { error: 'malformed request URL' })
      }
      const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
      const handler = exact.get(path)
      if (handler === undefined) return json(res, 404, { error: `no route for ${path}` })
      return handler(req, res, url)
    },
  })
  const disposeUpgrade = webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      const connection = bridge.handleUpgrade(req, socket, head)
      if (connection === null) logger?.warn?.('rejected a non-WebSocket request on the bridge path')
    },
  })
  return () => {
    for (const dispose of [disposeHttp, disposeUpgrade]) {
      try {
        dispose()
      } catch {
        // A route already removed by a reload is not an error.
      }
    }
  }
}
