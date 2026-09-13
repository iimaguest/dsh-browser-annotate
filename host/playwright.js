// Playwright, over the desktop app's own protocol port.
//
// Playwright is here for the things the tool vocabulary cannot express: reaching into iframes,
// locating by role and text with auto-waiting, intercepting routes, waiting on responses. It
// does not get a browser of its own. It connects to the one already open, over the protocol
// port the app publishes, so `page` is the tab the human is looking at rather than a second
// invisible copy of it.
//
// That also means it is only available when the app is the engine. A Chrome extension has no
// protocol port to connect to, and the honest answer there is to say so rather than to launch
// a browser nobody asked for.

/** How long model-authored code may run before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 30000

/** How long to wait for the protocol port to accept a connection. */
const CONNECT_TIMEOUT_MS = 15000

/**
 * Describe one console argument the way `console.log` in a terminal would.
 * @param value - any value the code passed to the console.
 * @returns a short readable string.
 */
function describe(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Make a value safe to return through a JSON tool contract.
 *
 * Playwright's own objects — a Locator, a Page — stringify to `{}` or throw, and returning one
 * would tell the model nothing while looking like an answer.
 *
 * @param value - whatever the code returned.
 * @returns a JSON-safe value.
 */
function safe(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : JSON.parse(json)
  } catch {
    return String(value)
  }
}

/**
 * Run one promise with a deadline.
 * @param promise - the work.
 * @param timeoutMs - how long it may take.
 * @param message - the error to raise when it does not finish.
 * @returns the promise's value.
 */
function withTimeout(promise, timeoutMs, message) {
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Runs Playwright code against the desktop app's browser.
 */
export class PlaywrightRunner {
  /**
   * @param app - the desktop app client, which knows the protocol port.
   * @param logger - optional logger for connection diagnostics.
   */
  constructor(app, logger) {
    this.app = app
    this.logger = logger
    /** The connected browser, kept so repeated calls reuse one connection. */
    this.browser = null
    /** The endpoint the current connection was made to. */
    this.endpoint = null
    /** The loaded module, or null after a failed load. */
    this.module = undefined
    /** A note about an ambiguous page binding, reported with the next result. */
    this.ambiguous = null
  }

  /**
   * Load Playwright the first time it is needed.
   *
   * Imported lazily so a host without it still mounts: every other tool works, and only this one
   * says what is missing.
   */
  async #load() {
    if (this.module !== undefined) {
      if (this.module === null) throw new Error('Playwright is not installed')
      return this.module
    }
    try {
      this.module = await import('playwright-core')
    } catch (error) {
      this.module = null
      throw new Error(
        `Playwright is not installed, so runPlaywrightCode cannot work: ${error instanceof Error ? error.message : String(error)}. Install it in the plugin directory with "npm install playwright-core".`,
      )
    }
    return this.module
  }

  /**
   * Connect to the app's browser, reusing the connection while the port holds.
   * @returns the connected browser.
   */
  async #connect() {
    const playwright = await this.#load()
    const health = await this.app.locate()
    const port = health?.debugPort
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(
        'the desktop app has not published a browser protocol port, so Playwright has nothing to attach to. Restart the app; it opens the port on startup.',
      )
    }
    const endpoint = `http://127.0.0.1:${port}`
    if (this.browser !== null && this.browser.isConnected() && this.endpoint === endpoint) return this.browser
    this.dispose()
    this.browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS })
    this.endpoint = endpoint
    // Playwright answers dialogs by itself when nothing is listening for them, which silently
    // takes the dialogs away from the app: a confirm raised while Playwright is attached comes
    // back false with nothing having asked the human, and `handleDialog` — whose entire job is
    // to report and answer dialogs — reports that none is open while the page is blocked on one.
    // A listener that does nothing is what stops that: with one attached Playwright leaves the
    // dialog alone, and the app's own record of it stays true.
    for (const context of this.browser.contexts()) {
      context.on('page', page => page.on('dialog', () => {}))
      for (const page of context.pages()) page.on('dialog', () => {})
    }
    this.browser.on('disconnected', () => {
      this.browser = null
      this.endpoint = null
    })
    this.logger?.info?.(`Playwright connected over ${endpoint}`)
    return this.browser
  }

  /**
   * Pick the page a call is about.
   *
   * The app numbers its tabs for its own toolbar (`right:2`); Playwright numbers targets by its
   * own discovery order. Neither numbering can be translated into the other, so the app is asked
   * what the tab's URL is and the page with that URL is the one meant. Two tabs on the same URL
   * are therefore indistinguishable — which is worth knowing, and is why the active tab is the
   * default rather than a guess.
   *
   * @param browser - the connected browser.
   * @param pageId - the app's tab id, or undefined for the active tab.
   * @returns the Playwright page.
   */
  async #page(browser, pageId) {
    const pages = browser.contexts().flatMap(context => context.pages())
    if (pages.length === 0) throw new Error('the app has no page open for Playwright to bind to')
    const tabs = await this.app.call('tabs', {}).catch(() => null)
    const list = Array.isArray(tabs?.tabs) ? tabs.tabs : []
    const named = typeof pageId === 'string' && pageId !== '' ? list.find(entry => entry.id === pageId) : null
    const target = named ?? list.find(entry => entry.active === true && entry.conversation !== true)
    const url = target?.url
    if (typeof url === 'string' && url !== '') {
      const matches = pages.filter(page => page.url() === url)
      if (matches.length > 0) {
        // Two tabs on the same URL cannot be told apart this way, and binding to the wrong one
        // would run the model's code against a page it is not looking at while reporting
        // success. The ambiguity is carried out to the result rather than hidden here.
        if (matches.length > 1) this.ambiguous = `${matches.length} tabs are on ${url}, so \`page\` is the first of them`
        return matches[0]
      }
    }
    const web = pages.find(page => page.url().startsWith('http'))
    if (web !== undefined) return web
    throw new Error('none of the app\'s pages is a web page Playwright can drive')
  }

  /**
   * Run one piece of Playwright code.
   *
   * @param options.code - the body of an async function, with `page`, `context`, `browser`, and
   *   `console` in scope.
   * @param options.pageId - the app's tab id to bind `page` to.
   * @param options.timeoutMs - how long the code may run.
   * @returns `{ ok, result, logs, summary }`.
   */
  async run({ code, pageId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const started = Date.now()
    this.ambiguous = null
    const logs = []
    const collector = {}
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      collector[level] = (...args) => {
        logs.push({ level, text: args.map(describe).join(' ') })
      }
    }

    // Parsed before anything is connected, so a syntax error costs nothing and says so plainly.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    let body
    try {
      body = new AsyncFunction('page', 'context', 'browser', 'console', String(code))
    } catch (error) {
      return {
        ok: false,
        result: null,
        logs,
        summary: `The code could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    let browser
    let page
    try {
      browser = await this.#connect()
      page = await this.#page(browser, pageId)
    } catch (error) {
      return {
        ok: false,
        result: null,
        logs,
        summary: `Playwright could not attach to the browser: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    try {
      const result = await withTimeout(body(page, page.context(), browser, collector), timeoutMs, `the code did not finish within ${timeoutMs} ms`)
      const elapsed = Date.now() - started
      const lines = [`Ran on ${page.url()} in ${elapsed} ms.`]
      if (this.ambiguous !== null) {
        lines.push(`Note: ${this.ambiguous} — pass a pageId, or give the tabs different URLs, to be sure.`)
        this.ambiguous = null
      }
      if (logs.length > 0) {
        lines.push(`Console output (${logs.length}):`)
        for (const entry of logs) lines.push(`  [${entry.level}] ${entry.text}`)
      }
      const rendered = safe(result)
      lines.push(rendered === null ? 'The code returned nothing.' : `Returned:\n${JSON.stringify(rendered, null, 2)}`)
      return { ok: true, result: rendered, logs, summary: lines.join('\n') }
    } catch (error) {
      const lines = [`Playwright code failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`]
      if (logs.length > 0) {
        lines.push('Console output before the failure:')
        for (const entry of logs) lines.push(`  [${entry.level}] ${entry.text}`)
      }
      return { ok: false, result: null, logs, summary: lines.join('\n') }
    }
  }

  /**
   * Let go of the connection.
   *
   * Deliberately does not call `browser.close()`. On a browser reached through `connectOverCDP`
   * that is not a disconnect — it is a request to close the browser, and the browser on the other
   * end of this socket is the human's own app window with their conversation in it. A tool must
   * never be able to close that. Dropping the reference is enough: the socket ends when the app
   * exits, and the next run reconnects to whatever is there then.
   */
  dispose() {
    this.browser = null
    this.endpoint = null
  }
}
