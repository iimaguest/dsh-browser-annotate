// The DSH half's side of the conversation with the desktop browser.
//
// Where this fits, and why it is an HTTP client rather than a socket:
//
//   The conversation runs in a normal DSH, started by a human in their own terminal on their
//   own port. Nothing of ours is loaded into it and nothing can be: the browser it drives is a
//   different process. So the app publishes a small API on the loopback interface and this
//   speaks it. The direction is the host's, which is the direction that works — the app cannot
//   know which port a DSH is on, and a DSH that had to be told would need configuring before it
//   could be used.
//
// The method vocabulary is deliberately the Chrome extension's, not a new one. Every tool in
// tools.js calls `bridge.call(name, params)` and does not care which engine answers, so
// pointing the same tools at a browser this project owns costs nothing at the tool layer.
// What is different is who is on the other end, and that is reported honestly in
// to the model rather than smoothed over.

/** The ports the app tries, in the order it tries them. */
export const APP_PORT_RANGE = [7391, 7392, 7393, 7394, 7395, 7396, 7397, 7398]

/** How long a successful discovery is trusted before the app is asked again. */
const DISCOVERY_TTL_MS = 4000

/** A call that never returns would hold a tool open forever; this bounds the wait. */
const DEFAULT_TIMEOUT_MS = 30000

/** Screenshots travel as base64 and take longer than a DOM read. */
const IMAGE_TIMEOUT_MS = 60000

/** Methods whose reply carries an image. */
const IMAGE_METHODS = new Set(['screenshot', 'captureRect'])

/**
 * The desktop app, as seen from the host.
 *
 * One instance is shared by every tool in the session. It holds no connection: HTTP is
 * connectionless from this side, and a persisted socket would only be a thing to go stale.
 */
export class DesktopApp {
  /** @param logger - Cordis logger for diagnostics; optional. */
  constructor(logger) {
    this.logger = logger
    /** The port the app was last found on, or null. */
    this.port = null
    /** When the last successful discovery happened, in epoch milliseconds. */
    this.foundAt = 0
    /** The last `/health` payload, for discovery and the panel. */
    this.health = null
    /** The last discovery failure, so a tool can say why rather than only that. */
    this.lastError = null
  }

  /** Whether the app answered recently enough to be considered attached. */
  get attached() {
    return this.port !== null
  }

  /**
   * Find the app.
   *
   * Every candidate port is probed and the one that identifies itself as this app wins. A port
   * that answers with something else is not taken: there is no way to tell a wrong server from
   * a right one afterwards, and the failure would look like a browser bug.
   *
   * @param options.force - ignore the cached answer and probe again.
   * @returns the app's health payload, or null when nothing is listening.
   */
  async locate({ force = false } = {}) {
    if (!force && this.port !== null && Date.now() - this.foundAt < DISCOVERY_TTL_MS) return this.health
    for (const port of APP_PORT_RANGE) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) })
        if (!response.ok) continue
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json()
        if (body?.app !== 'dsh-desktop') continue
        const changed = this.port !== port
        this.port = port
        this.foundAt = Date.now()
        this.health = body
        this.lastError = null
        if (changed) this.logger?.info?.(`desktop browser found on http://127.0.0.1:${port}`)
        return body
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (this.port !== null) this.logger?.warn?.('the desktop browser stopped answering')
    this.port = null
    this.health = null
    return null
  }

  /** Whether the app is there right now. */
  async available() {
    return (await this.locate()) !== null
  }

  /**
   * Run one method in the app.
   *
   * @param method - the tool vocabulary name.
   * @param params - its arguments.
   * @param options.timeoutMs - override the default budget.
   * @param options.signal - abort when the agent abandons the turn.
   * @returns the method's result.
   * @throws when the app is not running, the call times out, or the app reports a failure.
   */
  async call(method, params = {}, options = {}) {
    const health = await this.locate()
    if (health === null) {
      throw new Error(
        'the desktop browser app is not running, so there is no browser to drive. Start it (npm start in dsh-desktop), or attach the Chrome extension instead.',
      )
    }
    const timeoutMs = options.timeoutMs ?? (IMAGE_METHODS.has(method) ? IMAGE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    let response
    try {
      response = await fetch(`http://127.0.0.1:${this.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new Error(`the desktop browser did not answer "${method}" within ${timeoutMs}ms`)
      throw new Error(`the desktop browser could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await response.json().catch(() => null)
    if (body === null) throw new Error(`the desktop browser answered "${method}" with something that is not JSON`)
    if (body.ok !== true) throw new Error(String(body.error ?? `the desktop browser refused "${method}"`))
    // The tool layer reads fields off the result, so a method that legitimately returns nothing
    // must still return an object rather than undefined.
    return body.result ?? {}
  }

  /**
   * The annotations waiting in the app, in the shape the extension's queue uses.
   *
   * The app stores each one wrapped in an envelope with its own id and timestamp, because that
   * is what its own toolbar needs to address it. The tools were written against the extension's
   * flat record, so the two are reconciled here rather than in the tools: one place to look
   * when an annotation field turns out to be missing.
   *
   * @returns the waiting annotations.
   */
  async annotations() {
    const health = await this.locate()
    if (health === null) return []
    const response = await fetch(`http://127.0.0.1:${this.port}/annotations`, { signal: AbortSignal.timeout(10000) })
    const body = await response.json().catch(() => null)
    const entries = Array.isArray(body?.annotations) ? body.annotations : []
    return entries.map(entry => ({
      id: `app_${entry.id}`,
      capturedAt: entry.createdAt ?? '',
      ...entry.annotation,
    }))
  }

  /**
   * Tell the app which annotations have been taken.
   * @param ids - the annotation ids, as {@link annotations} reported them.
   * @returns the ids the app says it removed.
   */
  async take(ids) {
    const health = await this.locate()
    if (health === null) return []
    const numeric = (Array.isArray(ids) ? ids : []).map(id => Number(String(id).replace(/^app_/, ''))).filter(Number.isFinite)
    const response = await fetch(`http://127.0.0.1:${this.port}/annotations/taken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: numeric }),
      signal: AbortSignal.timeout(10000),
    })
    const body = await response.json().catch(() => null)
    return Array.isArray(body?.removed) ? body.removed.map(id => `app_${id}`) : numeric.map(id => `app_${id}`)
  }

  /**
   * The port the app's browser speaks the DevTools Protocol on, or null when it has not
   * published one. Playwright attaches there; nothing else needs it.
   */
  get debugPort() {
    const port = this.health?.debugPort
    return Number.isInteger(port) && port > 0 ? port : null
  }

  /** What the panel can say about the app without making a call. */
  describe() {
    if (this.port === null) return { attached: false, port: null, debugPort: null, tabs: [] }
    return {
      attached: true,
      port: this.port,
      debugPort: this.debugPort,
      tabs: Array.isArray(this.health?.tabs) ? this.health.tabs : [],
    }
  }
}
