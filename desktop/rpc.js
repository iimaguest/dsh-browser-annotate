// What the conversation can ask the browser to do.
//
// This is the surface the DSH in the left pane drives. Its tools reach this app over loopback
// HTTP, and every method name here is the name the tools already send — the same vocabulary
// the Chrome extension answers, so a tool does not care which of the two engines is on the
// other end. What changes is only who is answering: a browser this app owns, rather than a
// browser somebody else owns and an extension is attached to.
//
// Two rules decide how each method is implemented, and neither is a preference:
//
//   Input goes through the Chrome DevTools Protocol, not through the page's own dispatchEvent.
//   A synthesized DOM event is untrusted, so a password manager ignores it, a native file
//   picker never opens, and a framework that checks isTrusted does nothing. Input.* produces
//   the same trusted events a human's hands produce.
//
//   Reading goes through the page's own picker, which is already installed in every tab as a
//   preload. It is the same code that produces an annotation's selector and computed styles,
//   so what the agent reads and what the human annotated cannot disagree.
//
// The conversation's own tab is not drivable. It is the surface this is being driven from, and
// an agent that navigates it away has removed the only place it could report what it did.

const { captureElement, captureViewport } = require('./annotate')

/** Reading from the page goes through a message round trip, not a call, so it gets a budget. */
const ASK_TIMEOUT = 5000

/** A CDP command is answered immediately or not at all; this only bounds a wedged engine. */
const CDP_TIMEOUT = 30000

/** The key names a caller may press, with the codes Chromium needs to deliver them. */
const KEYS = {
  enter: { keyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
  tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  esc: { keyCode: 27, code: 'Escape', key: 'Escape' },
  backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  delete: { keyCode: 46, code: 'Delete', key: 'Delete' },
  space: { keyCode: 32, code: 'Space', key: ' ', text: ' ' },
  arrowup: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  arrowdown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  arrowleft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  arrowright: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  home: { keyCode: 36, code: 'Home', key: 'Home' },
  end: { keyCode: 35, code: 'End', key: 'End' },
  pageup: { keyCode: 33, code: 'PageUp', key: 'PageUp' },
  pagedown: { keyCode: 34, code: 'PageDown', key: 'PageDown' },
}

/** Modifier bits as Chromium counts them. */
const MODIFIERS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

/**
 * Turn one key specification into the fields a CDP key event needs.
 *
 * Accepts the names a caller would write — `Enter`, `Escape`, `Meta+A`, `Shift+ArrowDown` — and
 * a bare single character, which is a key press like any other.
 *
 * @param spec - the key specification.
 * @returns the key fields, and the modifier bits.
 */
function keyFields(spec) {
  const parts = String(spec ?? '').split('+').map(part => part.trim()).filter(part => part !== '')
  const name = parts.length === 0 ? '' : parts[parts.length - 1]
  let modifiers = 0
  for (const modifier of parts.slice(0, -1)) {
    modifiers |= MODIFIERS[modifier.toLowerCase()] ?? 0
  }
  const known = KEYS[name.toLowerCase()]
  if (known !== undefined) return { ...known, modifiers }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    const shifted = modifiers & 8 ? upper : name
    return {
      keyCode: upper.charCodeAt(0),
      code: /[a-z]/i.test(name) ? `Key${upper}` : `Digit${name}`,
      key: shifted,
      text: modifiers === 0 || modifiers === 8 ? shifted : undefined,
      modifiers,
    }
  }
  // Anything else is sent as a named key with no text, which is what Chromium does with a key
  // it has no character for. It is better than refusing: a page may still act on it.
  return { keyCode: 0, code: name, key: name, modifiers }
}

class BrowserRpc {
  /**
   * @param options.panes - returns every pane, in order; the last one is the browser.
   * @param options.conversation - returns the pane holding the conversation, or null.
   * @param options.log - a line sink for the app's own output.
   */
  constructor(options) {
    this.panes = options.panes
    this.conversation = options.conversation
    this.log = options.log ?? (() => undefined)
    /** Open JavaScript dialogs by webContents id, so a dialog can be reported and answered. */
    this.dialogs = new Map()
    /** Tabs whose debugger has been attached and armed, by webContents id. */
    this.armed = new Set()
    /** Resolvers waiting on an intercepted drag, by webContents id. */
    this.dragWaiters = new Map()
  }

  /** Every tab in the app, as the tools see them. */
  describeTabs() {
    const out = []
    for (const pane of this.panes()) {
      if (pane === null) continue
      for (const tab of pane.tabs) {
        out.push({
          // Qualified by its pane, because tab numbering restarts in each one: a bare `1` names
          // a tab in the conversation and a tab in the browser, and an agent that asked for the
          // page it just opened would get the conversation instead.
          id: `${pane.name}:${tab.id}`,
          pane: pane.name,
          url: tab.url,
          title: tab.title,
          active: tab.id === pane.activeId,
          loading: tab.loading,
          mode: pane.mode,
          // A page waiting on a dialog is a page where nothing else will work, so it is part of
          // what a browser reports about itself rather than something to discover by timing out.
          dialog: this.dialogs.get(tab.view.webContents.id) ?? null,
          conversation: this.isConversation(tab),
        })
      }
    }
    return out
  }

  /** Whether a tab is the conversation itself, which is not the agent's to drive. */
  isConversation(tab) {
    const pane = this.conversation()
    return pane !== null && pane.tabs.length > 0 && pane.tabs[0] === tab
  }

  /**
   * The tab a method acts on: the one named, or the browser pane's front tab.
   *
   * The browser pane is the one with a tab strip. The other pane holds the conversation, and
   * driving it by default would mean every browser tool acted on the page the human is reading
   * the agent's answers in.
   */
  target(tabId) {
    const panes = this.panes().filter(pane => pane !== null)
    const all = []
    for (const pane of panes) {
      for (const tab of pane.tabs) all.push({ pane, tab })
    }
    if (tabId !== undefined && tabId !== null && String(tabId) !== '') {
      const key = String(tabId)
      const qualified = key.includes(':') ? key.split(':') : null
      const found =
        qualified === null
          ? // A bare number is ambiguous, because each pane numbers its own tabs from one. It is
            // resolved to the browser pane, since that is the pane every other method defaults to
            // and a caller that meant the conversation has no reason to name it by bare number.
            (all.filter(entry => String(entry.tab.id) === key).find(entry => entry.pane.strip === true) ??
            all.find(entry => String(entry.tab.id) === key))
          : all.find(entry => entry.pane.name === qualified[0] && String(entry.tab.id) === qualified[1])
      if (found === undefined) throw new Error(`no tab ${tabId} is open in this app`)
      return found
    }
    const browser = panes.find(pane => pane.strip === true) ?? panes[panes.length - 1]
    if (browser === undefined || browser.active === null) throw new Error('no page is open in the browser pane')
    return { pane: browser, tab: browser.active }
  }

  /** Refuse to move the page the agent is reporting into. */
  #refuseConversation(entry, what) {
    if (this.isConversation(entry.tab)) {
      throw new Error(
        `tab ${entry.tab.id} is the conversation itself, so it cannot be ${what}. Open a page in the browser pane, or name another tab id.`,
      )
    }
  }

  /**
   * Watch a tab's next main-frame load, so a load that failed cannot be reported as one that
   * worked.
   *
   * Chromium does not fail a navigation to an unreachable host: it commits an internal error
   * page and reports the load as finished. `loadURL` resolves, the tab has a title and an
   * address, and every check that asks "did this work?" says yes while the human is looking at
   * "This site can't be reached". This used to test for a `chrome-error://` URL and could never
   * fire, because the address that fails is the one that was asked for — the tab list shows
   * `https://this-host-does-not-exist.invalid/`, and that internal URL is only ever visible from
   * inside the page. `did-fail-load` is the event that actually knows, so it is what is watched.
   *
   * @param contents - the web contents whose next load is in question.
   * @returns a function that stops watching and reports the failure, or null if there was none.
   */
  #watchLoad(contents) {
    let failure = null
    const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Sub-frames fail constantly on ordinary pages — dead ad slots, blocked trackers, embed
      // frames that never load — and none of that means the page the human asked for is missing.
      if (isMainFrame === false) return
      // ERR_ABORTED is what a redirect, a download, or a navigation superseded by another one
      // produces. It is not a page that could not be reached.
      if (errorCode === -3) return
      failure = { errorCode, errorDescription, validatedURL }
    }
    contents.on('did-fail-load', onFail)
    return () => {
      contents.removeListener('did-fail-load', onFail)
      return failure
    }
  }

  /**
   * Turn a watched failure into an error that names the address the human typed.
   * @param failure - the record from `#watchLoad`, or null.
   */
  #reportLoadFailure(failure) {
    if (failure === null) return
    throw new Error(
      `the page did not load: ${failure.validatedURL} could not be reached — ${failure.errorDescription} (${failure.errorCode}). The tab is open and is showing Chromium's error page.`,
    )
  }

  /**
   * Attach the debugger to a tab and arm the domains the tools rely on.
   *
   * Attaching is exclusive: a tab whose DevTools window is open in the app cannot also be
   * driven here, and Chromium says so rather than half-working. That is reported as what it is
   * instead of as a mysterious timeout.
   */
  async #arm(tab) {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return { attached: false, reason: 'that tab has been closed' }
    if (!contents.debugger.isAttached()) {
      try {
        contents.debugger.attach('1.3')
      } catch (error) {
        return {
          attached: false,
          reason: `the debugger could not attach to this page: ${error instanceof Error ? error.message : String(error)}. Close its DevTools window in the app and try again.`,
        }
      }
    }
    const id = contents.id
    if (!this.armed.has(id)) {
      this.armed.add(id)
      contents.debugger.on('message', (_event, message, messageParams) => this.#onCdpEvent(contents, message, messageParams))
      contents.debugger.on('detach', () => {
        this.armed.delete(id)
        this.dialogs.delete(id)
      })
      // Page carries the load and dialog events, Runtime the evaluation, DOM the node lookups.
      // Network and Log are deliberately left off: the page's own buffer already records what
      // was requested and what was logged, and a second copy would only be a second answer.
      for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable']) {
        // eslint-disable-next-line no-await-in-loop
        await contents.debugger.sendCommand(domain).catch(() => undefined)
      }
    }
    return { attached: true }
  }

  /**
   * Observe a tab from the moment it exists.
   *
   * The protocol is attached to a tab lazily the first time a tool speaks to it, which is fine
   * for everything a tool asks for and wrong for everything a *page* does unprompted. A dialog
   * is the case that matters: it is raised by the page, it stops the page dead, and it is
   * reported from a record that is only written while a session is attached. Attached lazily,
   * a dialog on a tab nobody had spoken to yet is a modal window with no record of it anywhere —
   * `handleDialog` answers "no dialog is open" while one is on screen, and any tool that then
   * touches that tab hangs until a human clicks it away. So every tab is attached when it is
   * created, and the record is complete by construction.
   *
   * @param tab - the tab to observe.
   */
  async attach(tab) {
    const result = await this.#arm(tab)
    if (result.attached === false) this.log(`could not observe a new tab: ${result.reason}`)
    return result
  }

  async #cdp(tab, method, params) {
    const armed = await this.#arm(tab)
    if (armed.attached === false) throw new Error(armed.reason)
    return tab.view.webContents.debugger.sendCommand(method, params ?? {})
  }

  /** Route the protocol events the tools depend on. */
  #onCdpEvent(contents, method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      this.dialogs.set(contents.id, {
        type: params?.type ?? 'alert',
        message: params?.message ?? '',
        defaultPrompt: params?.defaultPrompt ?? '',
        url: contents.getURL(),
      })
      return
    }
    if (method === 'Page.javascriptDialogClosed') {
      this.dialogs.delete(contents.id)
      return
    }
    if (method === 'Input.dragIntercepted') {
      const waiter = this.dragWaiters.get(contents.id)
      if (waiter !== undefined) {
        this.dragWaiters.delete(contents.id)
        waiter(params?.data ?? {})
      }
    }
  }

  /** Ask the page-side picker something, with a budget that suits a round trip. */
  #ask(entry, message, timeout = ASK_TIMEOUT) {
    return entry.pane.ask(entry.tab, message, timeout)
  }

  /**
   * Where an element is, in viewport CSS pixels.
   *
   * The element is scrolled into view first, because an element's box is reported whether or
   * not it is on screen and clicking coordinates that are off-screen clicks whatever happens to
   * be at that point instead.
   */
  async #geometry(entry, target) {
    if (target !== undefined && target !== null && target !== '') {
      await this.#ask(entry, { type: 'scroll', target })
    }
    const reply = await this.#ask(entry, { type: 'geometry', selector: target })
    if (reply === null || reply?.error !== undefined || reply?.rect === undefined) {
      throw new Error(reply?.error ?? `no element matches "${target}"`)
    }
    return reply
  }

  /** One mouse event at a viewport point. */
  #mouse(entry, type, point, extra = {}) {
    return this.#cdp(entry.tab, 'Input.dispatchMouseEvent', {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: extra.button ?? 'none',
      buttons: extra.buttons ?? 0,
      clickCount: extra.clickCount ?? 0,
      modifiers: extra.modifiers ?? 0,
    })
  }

  /**
   * Press and release one key, and make sure the page actually heard it.
   *
   * Chromium routes a key event to the focused widget of the tab it is sent to, and a tab in a
   * window that is not in front has no focused widget — the event is dropped, and the protocol
   * reports success for a key nobody received. Mouse events are unaffected, which is what makes
   * this failure so confusing: clicking works and typing silently does nothing.
   *
   * So the tab is focused first, which is also what a person does by clicking a page before
   * typing on it, and then the page is asked what it heard. When the answer is nothing, the
   * page is told directly instead. Both paths produce the event a page's handlers see; only the
   * first one is indistinguishable from a human's keypress, so which one was used is reported.
   */
  async #press(entry, spec) {
    const contents = entry.tab.view.webContents
    // `Page.bringToFront` is the protocol's own way of saying this page is the one being looked
    // at, and Chromium implements it by activating the widget it belongs to. Without it a pane
    // that is not the front view of a window that is not the front window has nothing focused for
    // a key event to route to.
    await this.#cdp(entry.tab, 'Page.bringToFront').catch(() => undefined)
    try {
      contents.focus()
    } catch {
      // A tab that cannot take focus can still be told about a key below.
    }
    const fields = keyFields(spec)
    const base = {
      modifiers: fields.modifiers,
      key: fields.key,
      code: fields.code,
      windowsVirtualKeyCode: fields.keyCode,
      nativeVirtualKeyCode: fields.keyCode,
    }
    const down = { type: fields.text === undefined ? 'rawKeyDown' : 'keyDown', ...base }
    if (fields.text !== undefined) {
      down.text = fields.text
      down.unmodifiedText = fields.text
    }
    // The spy is installed in the page's own world, where the page's handlers are, so what it
    // records is what the page itself would have received.
    await this.#cdp(entry.tab, 'Runtime.evaluate', {
      expression:
        '(() => { if (window.__dshKeySpy !== true) { window.__dshKeySpy = true; window.__dshKeys = []; window.addEventListener("keydown", event => window.__dshKeys.push(event.key), true) } else { window.__dshKeys.length = 0 } return true })()',
    })
    await this.#cdp(entry.tab, 'Input.dispatchKeyEvent', down)
    await this.#cdp(entry.tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    const heard = await this.#cdp(entry.tab, 'Runtime.evaluate', {
      expression: 'window.__dshKeys.join(",")',
      returnByValue: true,
    })
    if (String(heard?.result?.value ?? '') !== '') return { ...fields, dispatched: 'protocol' }
    // Nothing arrived. `pressKey` in the page's own annotator builds the same KeyboardEvent and
    // dispatches it on the focused element, which every framework's handler sees.
    await this.#ask(entry, { type: 'type', key: String(spec) })
    return { ...fields, dispatched: 'page' }
  }

  /**
   * Wait for a navigation to start and then finish.
   *
   * The first half is the part that is easy to leave out and impossible to notice: a tab created
   * with a URL, or a click that schedules a route change, is still idle in the tick it was
   * requested, so a check for "is it loading" answers no and the caller reads the old page's
   * address as though it were the new one. That is how opening a page came back reporting an
   * empty URL for a page that had loaded perfectly.
   *
   * @param entry - the pane and tab to watch.
   * @param timeoutMs - how long to wait before giving up.
   * @returns whether the page settled.
   */
  async #settle(entry, timeoutMs = 15000) {
    const contents = entry.tab.view.webContents
    const deadline = Date.now() + timeoutMs
    let idleFor = 0
    while (!contents.isLoading() && Date.now() < deadline && idleFor < 1500) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 100))
      idleFor += 100
    }
    if (!contents.isLoading()) return true
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        contents.off('did-finish-load', done)
        contents.off('did-fail-load', done)
        resolve(true)
      }
      const timer = setTimeout(() => {
        contents.off('did-finish-load', done)
        contents.off('did-fail-load', done)
        resolve(false)
      }, Math.max(1000, deadline - Date.now()))
      contents.once('did-finish-load', done)
      contents.once('did-fail-load', done)
    })
  }

  /**
   * Select everything in the focused field, so the next text replaces it.
   *
   * This is a DOM selection rather than a `Meta+A` keypress: it produces the same selection, and
   * unlike a key it does not depend on the tab having a focused widget, which is exactly the
   * condition that is false when an agent is doing the typing.
   */
  async #selectAll(entry) {
    const result = await this.#cdp(entry.tab, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.activeElement
        if (el === null || el === document.body) return false
        if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { el.select(); return true }
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      })()`,
      returnByValue: true,
    })
    return result?.result?.value === true
  }

  /**
   * A picture of the page, or of one region of it.
   *
   * Electron's own capture is tried first, because it is the exact crop the human's annotations
   * already go through: what the agent sees and what the human saw should be the same picture,
   * taken the same way. It needs a display surface to read, though, and a window that is behind
   * another window has none — which is the normal state while an agent works, because the human
   * is somewhere else. So the protocol is the fallback, and it renders regardless of what is in
   * front. Which one was used is not reported to the model: it is the same picture either way.
   *
   * @param entry - the pane and tab to capture.
   * @param rect - a viewport rectangle, or null for the whole visible page.
   * @returns the image as a data URL.
   */
  async #capture(entry, rect) {
    try {
      const cssSize = entry.tab.view.getBounds()
      const dataUrl =
        rect === null
          ? await captureViewport(entry.tab.view.webContents)
          : await captureElement(entry.tab.view.webContents, rect, { padding: 8, cssSize })
      if (dataUrl !== null) return dataUrl
    } catch (error) {
      this.log(`no display surface to read: ${error instanceof Error ? error.message : String(error)}`)
    }
    const metrics = await this.#cdp(entry.tab, 'Page.getLayoutMetrics')
    const viewport = metrics?.cssLayoutViewport ?? { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 }
    // A clip is in page coordinates, while a box from the page is in viewport coordinates, so
    // the scroll offset is added back. Without that, every element below the fold is captured
    // from wherever it would have been had the page not been scrolled.
    const clip =
      rect === null
        ? { x: viewport.pageX ?? 0, y: viewport.pageY ?? 0, width: viewport.clientWidth ?? 1280, height: viewport.clientHeight ?? 800, scale: 1 }
        : {
            x: (rect.x ?? 0) + (viewport.pageX ?? 0),
            y: (rect.y ?? 0) + (viewport.pageY ?? 0),
            width: Math.max(1, rect.width ?? 1),
            height: Math.max(1, rect.height ?? 1),
            scale: 1,
          }
    const shot = await this.#cdp(entry.tab, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
    if (typeof shot?.data !== 'string' || shot.data === '') throw new Error('the capture came back empty')
    return `data:image/png;base64,${shot.data}`
  }

  /** A capture of the visible page, or of one element's region within it. */
  async #screenshot(params) {
    const entry = this.target(params.tabId)
    const contents = entry.tab.view.webContents
    const url = contents.getURL()
    if (typeof params.selector === 'string' && params.selector !== '') {
      const geometry = await this.#geometry(entry, params.selector)
      const dataUrl = await this.#capture(entry, geometry.rect)
      return { dataUrl, url, selector: params.selector, rect: geometry.rect, viewport: geometry.viewport }
    }
    if (params.fullPage === true) {
      // Electron can only capture what is laid out on screen, so the whole page is taken
      // through the protocol, which can render beyond the viewport. It is capped: a page of
      // forty thousand pixels is a picture nobody reads and a cost nobody agreed to.
      const metrics = await this.#cdp(entry.tab, 'Page.getLayoutMetrics')
      const size = metrics?.cssContentSize ?? metrics?.contentSize ?? { width: 1280, height: 800 }
      const scale = Math.min(1, 1600 / Math.max(1, size.width))
      const height = Math.min(size.height, 8000)
      const shot = await this.#cdp(entry.tab, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height, scale },
      })
      return {
        dataUrl: `data:image/png;base64,${shot.data}`,
        url,
        viewport: { width: Math.round(size.width), height: Math.round(height) },
        fullPage: true,
        truncated: size.height > height,
      }
    }
    const dataUrl = await this.#capture(entry, null)
    // The page's own viewport, not the window's: a pane is part of a window, and reporting the
    // window's size would describe a picture nobody took.
    const measured = await this.#cdp(entry.tab, 'Runtime.evaluate', {
      expression: '[window.innerWidth, window.innerHeight]',
      returnByValue: true,
    })
    const [width, height] = Array.isArray(measured?.result?.value) ? measured.result.value : [0, 0]
    return { dataUrl, url, viewport: { width, height } }
  }

  /** A drag, done the way Chromium itself reports one: intercept, then dispatch the payload. */
  async #drag(entry, from, to) {
    const contents = entry.tab.view.webContents
    const finish = new Promise(resolve => {
      const timer = setTimeout(() => {
        this.dragWaiters.delete(contents.id)
        resolve(null)
      }, 1500)
      this.dragWaiters.set(contents.id, data => {
        clearTimeout(timer)
        resolve(data)
      })
    })
    await this.#cdp(entry.tab, 'Input.setInterceptDrags', { enabled: true }).catch(() => undefined)
    await this.#mouse(entry, 'mouseMoved', from)
    await this.#mouse(entry, 'mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 })
    // A drag begins after the pointer has moved while the button is held, so the first move is
    // part of starting it and the payload arrives when Chromium has recognised the gesture.
    await this.#mouse(entry, 'mouseMoved', { x: from.x + 6, y: from.y + 6 }, { buttons: 1 })
    const data = await finish
    if (data === null) {
      // No drag was recognised — which is what happens on a page that drags with pointer events
      // rather than the HTML5 drag-and-drop API. The mouse sequence alone drives those, so it is
      // finished by hand rather than reported as a failure.
      for (let step = 1; step <= 8; step++) {
        const point = { x: from.x + ((to.x - from.x) * step) / 8, y: from.y + ((to.y - from.y) * step) / 8 }
        // eslint-disable-next-line no-await-in-loop
        await this.#mouse(entry, 'mouseMoved', point, { buttons: 1 })
      }
      await this.#mouse(entry, 'mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 })
      await this.#cdp(entry.tab, 'Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
      return { intercepted: false }
    }
    const payload = { ...data, items: data.items ?? [], dragOperationsMask: data.dragOperationsMask ?? 1 }
    await this.#cdp(entry.tab, 'Input.dispatchDragEvent', { type: 'dragEnter', x: Math.round(to.x), y: Math.round(to.y), data: payload })
    await this.#cdp(entry.tab, 'Input.dispatchDragEvent', { type: 'dragOver', x: Math.round(to.x), y: Math.round(to.y), data: payload })
    await this.#cdp(entry.tab, 'Input.dispatchDragEvent', { type: 'drop', x: Math.round(to.x), y: Math.round(to.y), data: payload })
    await this.#mouse(entry, 'mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 })
    await this.#cdp(entry.tab, 'Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
    return { intercepted: true }
  }

  /** Report the protocol's own index of itself, as the attached engine describes it. */
  async #domains(entry, params) {
    let schema = null
    try {
      schema = await this.#cdp(entry.tab, 'Schema.getDomains')
    } catch (error) {
      return { summary: `the engine would not describe its own protocol: ${error instanceof Error ? error.message : String(error)}` }
    }
    const domains = Array.isArray(schema?.domains) ? schema.domains : []
    const wanted = params.domain === undefined ? null : String(params.domain).toLowerCase()
    const search = params.search === undefined ? null : String(params.search).toLowerCase()
    const lines = []
    for (const domain of domains) {
      const name = String(domain.name ?? '')
      if (wanted !== null && name.toLowerCase() !== wanted) continue
      const hit = search === null || `${name} ${domain.description ?? ''}`.toLowerCase().includes(search)
      if (!hit) continue
      lines.push(`${name}${domain.experimental === true ? ' (experimental)' : ''} — ${domain.description ?? ''}`.slice(0, 160))
    }
    if (lines.length === 0) return { summary: 'No protocol domains matched.' }
    // Chromium's Schema domain lists domains, not their commands. Sending an unknown command is
    // answered with a precise protocol error naming it, so the index is a map rather than a
    // contract, and that is said here rather than left for the agent to discover.
    lines.push('', 'This is the domain list from the engine itself. Command names within a domain are not published by Schema; send the command with browser_cdp and the engine answers with its exact error if the name is wrong.')
    return { summary: `Chrome DevTools Protocol domains (${domains.length} available):\n${lines.join('\n')}` }
  }

  /**
   * Run one method the DSH-side tools send.
   *
   * @param method - the tool vocabulary name.
   * @param params - its arguments.
   * @returns the method's result, or throws with a message worth showing a human.
   */
  async dispatch(method, params = {}) {
    const args = params ?? {}
    switch (method) {
      case 'tabs':
      case 'listTabs': {
        return { ok: true, tabs: this.describeTabs(), activeId: this.target().tab.id }
      }

      case 'newTab': {
        const pane = this.panes().find(candidate => candidate !== null && candidate.strip === true)
        if (pane === undefined) throw new Error('this app has no browser pane')
        const url = typeof args.url === 'string' && args.url !== '' ? args.url : undefined
        const tab = pane.addTab(url)
        const entry = { pane, tab }
        // The tab exists before it has loaded, and its address and title are only the page's once
        // the page is there. Reporting the created-but-empty values is what made an open that
        // worked look like it had opened nothing.
        const stop = this.#watchLoad(tab.view.webContents)
        await this.#settle(entry, 20000)
        this.#reportLoadFailure(stop())
        return {
          ok: true,
          tab: { id: `${pane.name}:${tab.id}`, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() },
        }
      }

      case 'closeTab': {
        const entry = this.target(args.tabId)
        this.#refuseConversation(entry, 'closed')
        entry.pane.closeTab(entry.tab.id)
        return { ok: true }
      }

      case 'activate': {
        const entry = this.target(args.tabId)
        entry.pane.activate(entry.tab.id)
        return { ok: true, tab: { id: entry.tab.id, url: entry.tab.url, title: entry.tab.title } }
      }

      case 'navigate': {
        const entry = this.target(args.tabId)
        const action = String(args.action ?? 'url')
        if (action === 'reload') {
          // Reloading the conversation is allowed, and is the one navigation that is: it is how
          // a page picks up a change without losing its place, and refusing it would mean an
          // agent could not reload the very page it is working in.
          entry.tab.view.webContents.reload()
          return { ok: true, action, url: entry.tab.url, title: entry.tab.title }
        }
        if (action === 'back' || action === 'forward') {
          const history = entry.tab.view.webContents.navigationHistory
          if (action === 'back' && history.canGoBack()) history.goBack()
          if (action === 'forward' && history.canGoForward()) history.goForward()
          await this.#settle(entry, 15000)
          return { ok: true, action, url: entry.tab.view.webContents.getURL(), title: entry.tab.view.webContents.getTitle() }
        }
        this.#refuseConversation(entry, 'navigated')
        const url = String(args.url ?? '')
        if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs can be navigated to')
        const stop = this.#watchLoad(entry.tab.view.webContents)
        await entry.tab.view.webContents.loadURL(url).catch(error => {
          this.#reportLoadFailure(stop())
          throw new Error(`the page did not load: ${error instanceof Error ? error.message : String(error)}`)
        })
        this.#reportLoadFailure(stop())
        return { ok: true, action, url: entry.tab.view.webContents.getURL(), title: entry.tab.view.webContents.getTitle() }
      }

      case 'screenshot':
        return this.#screenshot(args)

      case 'snapshot': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, {
          type: 'snapshot',
          includeText: args.includeText !== false,
          maxElements: args.maxElements ?? 120,
          maxText: args.maxText ?? 8000,
          selector: args.selector,
        })
        // The overlay's own refusal is the useful message; "the page did not answer" above it
        // would replace a precise reason with a guess about navigation.
        if (typeof reply?.error === 'string') throw new Error(reply.error)
        if (reply === null || reply?.elements === undefined) {
          throw new Error('the page did not answer — it may have navigated, or the picker did not install')
        }
        return { ...reply, url: entry.tab.view.webContents.getURL(), title: entry.tab.view.webContents.getTitle() }
      }

      case 'readPage': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, { type: 'readPage', maxChars: args.maxChars ?? 40000 })
        if (reply === null || typeof reply?.content !== 'string') {
          throw new Error('the page did not answer — it may have navigated, or the picker did not install')
        }
        return { ...reply, url: entry.tab.view.webContents.getURL(), title: entry.tab.view.webContents.getTitle() }
      }

      case 'click': {
        const entry = this.target(args.tabId)
        const geometry = await this.#geometry(entry, args.target)
        const point = { x: geometry.rect.x + geometry.rect.width / 2, y: geometry.rect.y + geometry.rect.height / 2 }
        const viewport = geometry.viewport ?? { width: 0, height: 0 }
        const onScreen = point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height
        if (!onScreen && args.force !== true) {
          throw new Error(`"${args.target}" is outside the visible viewport, so a click would land on something else`)
        }
        await this.#mouse(entry, 'mouseMoved', point)
        await this.#mouse(entry, 'mousePressed', point, { button: 'left', buttons: 1, clickCount: 1 })
        await this.#mouse(entry, 'mouseReleased', point, { button: 'left', buttons: 0, clickCount: 1 })
        const navigated = args.expectNavigation === true ? await this.#settle(entry, 15000) : false
        return { target: args.target, url: entry.tab.view.webContents.getURL(), navigated }
      }

      case 'hover': {
        const entry = this.target(args.tabId)
        const geometry = await this.#geometry(entry, args.target)
        const point = { x: geometry.rect.x + geometry.rect.width / 2, y: geometry.rect.y + geometry.rect.height / 2 }
        await this.#mouse(entry, 'mouseMoved', point)
        return { target: args.target, at: { x: Math.round(point.x), y: Math.round(point.y) } }
      }

      case 'drag': {
        const entry = this.target(args.tabId)
        const source = await this.#geometry(entry, args.from)
        const destination = await this.#geometry(entry, args.to)
        const from = { x: source.rect.x + source.rect.width / 2, y: source.rect.y + source.rect.height / 2 }
        const to = { x: destination.rect.x + destination.rect.width / 2, y: destination.rect.y + destination.rect.height / 2 }
        const result = await this.#drag(entry, from, to)
        return { from: args.from, to: args.to, ...result }
      }

      case 'type': {
        const entry = this.target(args.tabId)
        if (args.target !== undefined && args.target !== null && args.target !== '') {
          // Focus is a DOM call, not a click: clicking a link or a submit button to focus it
          // would activate it, which is not what "type into this field" means.
          const focus = await this.#ask(entry, { type: 'focus', target: args.target })
          if (focus === null || focus?.error !== undefined) throw new Error(focus?.error ?? `no element matches "${args.target}"`)
        }
        let cleared = false
        if (args.clear === true) cleared = await this.#selectAll(entry)
        let dispatched = null
        if (typeof args.text === 'string' && args.text !== '') {
          // `Input.insertText` is what a real input method commits, so it fires the input events
          // a framework binds to without pretending to be a sequence of keystrokes it is not.
          await this.#cdp(entry.tab, 'Input.insertText', { text: String(args.text) })
        }
        if (typeof args.key === 'string' && args.key !== '') dispatched = (await this.#press(entry, args.key)).dispatched
        if (args.submit === true) dispatched = (await this.#press(entry, 'Enter')).dispatched
        return { target: args.target ?? '', typed: args.text ?? '', key: args.key ?? '', cleared, dispatched }
      }

      case 'scroll': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, { type: 'scroll', target: args.target, deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0 })
        if (reply === null || reply?.scrollY === undefined) throw new Error(reply?.error ?? 'the page did not answer')
        return reply
      }

      case 'get': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, { type: 'get', target: args.target, properties: args.properties })
        if (reply === null) throw new Error('the page did not answer')
        if (reply.error !== undefined) throw new Error(reply.error)
        return reply
      }

      case 'wait': {
        const entry = this.target(args.tabId)
        const timeoutMs = Number(args.timeoutMs ?? 15000)
        const reply = await this.#ask(
          entry,
          { type: 'wait', target: args.target, urlContains: args.urlContains, text: args.text, timeoutMs },
          timeoutMs + 3000,
        )
        if (reply === null) throw new Error('the page did not answer while waiting')
        return reply
      }

      case 'console': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, { type: 'console', clear: args.clear === true, limit: args.limit ?? 100 })
        const entries = Array.isArray(reply?.entries) ? reply.entries : []
        const level = String(args.level ?? 'all')
        return {
          entries: entries.filter(entry => {
            if (level === 'error') return entry.level === 'error'
            if (level === 'warning') return entry.level === 'warning' || entry.level === 'warn'
            return true
          }),
        }
      }

      case 'network': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, { type: 'network', clear: args.clear === true, limit: args.limit ?? 50 })
        const entries = Array.isArray(reply?.entries) ? reply.entries : []
        const filter = args.filter === undefined ? null : String(args.filter)
        return {
          entries: entries.filter(entry => {
            if (filter !== null && !String(entry.url).includes(filter)) return false
            if (args.failedOnly === true) return entry.failure !== undefined || (entry.ok === false) || (entry.status ?? 0) >= 400
            return true
          }),
        }
      }

      case 'eval': {
        const entry = this.target(args.tabId)
        const result = await this.#cdp(entry.tab, 'Runtime.evaluate', {
          expression: String(args.expression ?? ''),
          returnByValue: args.returnByValue !== false,
          awaitPromise: true,
          userGesture: true,
        })
        if (result?.exceptionDetails !== undefined) {
          const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'the expression threw'
          return { ok: false, value: null, error: String(text) }
        }
        return { ok: true, value: result?.result?.value ?? null, type: result?.result?.type ?? 'undefined' }
      }

      case 'dialog': {
        const entry = this.target(args.tabId)
        const open = this.dialogs.get(entry.tab.view.webContents.id) ?? null
        // Asking what a page is waiting on and answering it are different acts, and a request
        // that only asks must not answer. Defaulting to accept made the two indistinguishable:
        // `handleDialog` with no `accept` dismissed the dialog it was reporting, so a caller
        // that read the question and then decided never got the chance to decide.
        if (args.accept === undefined) return { ok: true, dialog: open, accepted: null }
        const accept = args.accept === true
        try {
          await this.#cdp(entry.tab, 'Page.handleJavaScriptDialog', { accept, promptText: args.promptText })
        } catch (error) {
          if (open === null) return { ok: false, dialog: null, detail: 'no dialog was open' }
          throw error
        }
        this.dialogs.delete(entry.tab.view.webContents.id)
        return { ok: true, dialog: open, accepted: accept }
      }

      case 'cdp': {
        const entry = this.target(args.tabId)
        const id = entry.tab.view.webContents.id
        try {
          const result = await this.#cdp(entry.tab, String(args.method ?? ''), args.params)
          return { result }
        } catch (error) {
          return { error: { message: error instanceof Error ? error.message : String(error) }, tabId: id }
        }
      }

      case 'cdp.domains': {
        return this.#domains(this.target(args.tabId), args)
      }

      case 'annotate.mode': {
        const entry = this.target(args.tabId)
        const mode = String(args.mode ?? 'quick')
        entry.pane.setMode(mode)
        // Told, and then asked. The pane records the mode it sent; the overlay reports the mode it
        // is in, and those are only the same until they are not.
        const overlay = await this.#ask(entry, { type: 'ping' }).catch(() => null)
        return {
          mode,
          overlay,
          tab: { id: entry.tab.id, url: entry.tab.view.webContents.getURL(), title: entry.tab.view.webContents.getTitle() },
        }
      }

      case 'overlay': {
        const entry = this.target(args.tabId)
        return { overlay: await this.#ask(entry, { type: 'ping' }).catch(() => null) }
      }

      case 'elementAt': {
        const entry = this.target(args.tabId)
        const reply = await this.#ask(entry, { type: 'composeAt', x: args.x, y: args.y })
        return { element: reply?.opened === true ? { selector: reply.selector } : null }
      }

      case 'captureRect': {
        const entry = this.target(args.tabId)
        return { dataUrl: await captureElement(entry.tab.view.webContents, args.rect, { padding: 0 }) }
      }

      default:
        throw new Error(`this app does not answer "${method}" — it is a desktop browser, not a Chrome extension`)
    }
  }
}

module.exports = { BrowserRpc, keyFields, KEYS, MODIFIERS, ASK_TIMEOUT, CDP_TIMEOUT }
