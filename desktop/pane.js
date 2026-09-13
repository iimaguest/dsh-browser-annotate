// One pane of the app: a real browser, holding real tabs, with a toolbar of its own.
//
// Both panes are this same object. The left pane is a browser whose first tab happens to
// be DSH; the right pane is a browser whose first tab is whatever the human is working on.
// Nothing distinguishes them but their contents, which is what makes the left one's address
// bar work like any other address bar: paste the URL that `dsh web` printed, token and all,
// and that is what loads.
//
// Every value handed to the toolbar is read from the engine — title, favicon, the history
// stack, certificate state, loading progress, zoom. Nothing is inferred from a URL string,
// because a browser bar that guesses disagrees with the page under it.

const { WebContentsView, Menu, clipboard, shell } = require('electron')
const { join } = require('node:path')

/** The toolbar is the address row, plus a tab strip once a pane has more than one tab. */
const BAR_HEIGHT = 74
const STRIP_HEIGHT = 36

/** How tall this pane's toolbar is right now. A pane with a single tab spends no height on
    a strip that would hold one chip and say nothing. */
function chromeHeight(tabCount) {
  return BAR_HEIGHT + (tabCount > 1 ? STRIP_HEIGHT : 0)
}

/** A new tab with no address shows a start page rather than a blank white field. */
const START_PAGE = `file://${join(__dirname, 'start.html')}`

class Tab {
  constructor(view, id) {
    this.view = view
    this.id = id
    this.title = 'New Tab'
    this.url = ''
    this.favicon = ''
    this.loading = false
    this.canGoBack = false
    this.canGoForward = false
    this.security = { level: 'unknown', text: '' }
    this.zoom = 1
  }

  /** What the strip and the address row need, and nothing else. */
  describe(active) {
    return {
      id: this.id,
      title: this.title === '' ? 'Untitled' : this.title,
      url: this.url,
      favicon: this.favicon,
      loading: this.loading,
      active,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      security: this.security,
      zoom: this.zoom,
    }
  }
}

class Pane {
  /**
   * @param win - the window whose content view hosts the tabs.
   * @param name - `left` or `right`, for the toolbar's own identity and for diagnostics.
   * @param onChange - called after anything the host should know about.
   */
  constructor(win, name, options = {}) {
    this.win = win
    this.name = name
    /** Called with this pane's state whenever it changes, for whoever is listening. */
    this.onChange = options.onChange ?? (() => undefined)
    /** Called with (params, webContents) for a right-click on a page, so the app can draw
        the menu. A pane does not know how menus are drawn and does not want to. */
    this.onContextMenu = options.onContextMenu ?? null
    /** Whether this pane shows a tab strip. The left pane is DSH itself and is not a place
        to open pages, so it holds exactly one tab and no strip. The right pane is a browser
        and holds as many tabs as the human opens. */
    this.strip = name !== 'left'
    /** @type {Tab[]} */
    this.tabs = []
    this.activeId = null
    this.nextId = 1
    /** The pane rectangle in CSS pixels, as reported by whoever owns the layout. */
    this.box = null
    this.visible = false
    /** Whether the human's attention is in this pane's toolbar. */
    this.focused = false
    /** The annotation mode every page in this pane should be in: off, quick, or inspect. */
    this.mode = 'off'
    /** Called with (tab, message) for everything the page-side annotator reports. */
    this.onAnnotation = undefined
    /** Questions asked of the page that are still waiting for their answer, by id. */
    this.pendingRequests = new Map()
    this.nextRequest = 1

    this.toolbar = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'pane-toolbar-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // The toolbar is a separate document from the page it describes, so it carries its
        // own pane name in the query string rather than sharing module state with it.
        additionalArguments: [`--pane=${name}`],
      },
    })
    this.win.contentView.addChildView(this.toolbar)
    this.toolbar.setVisible(false)
    this.toolbar.webContents.loadFile(join(__dirname, 'pane-toolbar.html'), { query: { pane: name } })
    this.toolbar.webContents.on('did-finish-load', () => this.publish())

    // Focus decides which pane a keyboard shortcut acts on. Without this, ⌘T for a page in
    // the right pane would open a tab somewhere the human is not looking.
    this.toolbar.webContents.on('focus', () => this.focus())
  }

  /** The human's attention is in this pane. */
  focus() {
    this.focused = true
    if (this.onFocus !== undefined) this.onFocus(this)
  }

  /** Put the keyboard focus on the page, so typing reaches the page and not the toolbar. */
  focusPage() {
    const tab = this.active
    if (tab !== null && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
  }

  /** Whether a keyboard shortcut belongs to this pane. */
  owns() {
    const tab = this.active
    if (this.focused === true) return true
    // A page in the pane can hold the focus too, since clicking a page does not go through
    // the toolbar. Either one counts as being in this pane.
    return tab !== null && !tab.view.webContents.isDestroyed() && tab.view.webContents.isFocused()
  }

  get active() {
    return this.tabs.find(tab => tab.id === this.activeId) ?? null
  }

  /**
   * A new tab, in front, with its own engine view.
   *
   * The tab exists before it is navigated, so the start page is a real page in a real tab
   * rather than a placeholder drawn in the strip. It is also why `+` feels instant.
   */
  addTab(url = START_PAGE, { activate = true } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // Not sandboxed, because the annotator is a preload and a preload needs the module
        // it shims. Pages themselves still get no node access: context isolation is on and
        // nothing crosses into the main world except the two functions below.
        sandbox: false,
        preload: join(__dirname, 'annotate-overlay.js'),
      },
    })
    const tab = new Tab(view, this.nextId++)
    this.tabs.push(tab)
    this.win.contentView.addChildView(view)
    view.setVisible(false)

    // A page asking for a window gets a tab, which is what a browser does and what keeps
    // a target="_blank" link from opening a window nobody asked for.
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      this.addTab(target)
      return { action: 'deny' }
    })

    view.webContents.on('focus', () => this.focus())

    // A right-click on a page. The page keeps its own handling — the picker records the element
    // under the pointer during the click itself, and that recording is what the menu annotates.
    view.webContents.on('context-menu', (event, params) => {
      if (this.onContextMenu !== null) this.onContextMenu(params, view.webContents)
      else Menu.buildFromTemplate([{ role: 'copy' }, { role: 'paste' }]).popup({ window: this.win })
      event.preventDefault?.()
    })

    // The annotator's own channel. It runs inside the page, so what it sends arrives here and
    // goes straight to the app; the page never talks to the app directly.
    view.webContents.on('ipc-message', (_event, channel, message) => {
      if (channel !== 'annotate') return
      if (this.onAnnotation !== undefined) this.onAnnotation(tab, message)
    })

    // The picker is per-document, so a navigation gets a fresh one by construction. What a
    // navigation must not lose is the mode: a human who armed quick annotate and then the
    // page redirected should still be armed.
    view.webContents.on('did-finish-load', () => {
      if (this.mode !== 'off' && this.mode !== undefined) this.setMode(this.mode, tab)
    })
    // A page offers its keystrokes to its own pane, so ⌘L works with the pointer on a page
    // and ⌘T opens a tab beside it. The pane decides; a key it does not claim reaches the page.
    view.webContents.on('before-input-event', (event, input) => {
      if (this.onShortcut === undefined) return
      if (this.onShortcut(event, input) === true) event.preventDefault()
    })

    const refresh = () => {
      this.describe(tab)
      this.publish()
    }
    // A pane that carries the conversation must not be navigable away from it. The tools
    // already refuse to navigate it, but that guard only covers calls that come through the
    // tools, and a pane that can be moved off DSH by anything else is a pane that can lose the
    // conversation with no way back — the browser history is the only record, and a human who
    // did not ask for the navigation has no reason to look there.
    //
    // The attempt is reported rather than silently dropped. A navigation that is refused and a
    // navigation that never happened look identical from outside, and only one of them means
    // something is wrong.
    view.webContents.on('will-navigate', (event, target) => {
      if (this.onWillNavigate === undefined) return
      const verdict = this.onWillNavigate(tab, target)
      if (verdict?.allow !== true) {
        event.preventDefault()
        if (this.onNavigationBlocked !== undefined) this.onNavigationBlocked(tab, target, verdict?.reason ?? 'refused')
      }
    })

    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      view.webContents.on(event, refresh)
    }
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons.length > 0 ? favicons[0] : ''
      refresh()
    })
    // A failed main-frame load is a real state a browser reports, and swallowing it would
    // leave the address showing a page that never arrived.
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame === true && code !== -3) {
        tab.security = { level: 'broken', text: `${description} (${code})` }
        refresh()
      }
    })
    view.webContents.on('zoom-changed', () => {
      tab.zoom = view.webContents.getZoomFactor()
      refresh()
    })

    // Announced before the first load, so a dialog raised by the page being loaded is already
    // being watched for.
    if (this.onTabCreated !== undefined) this.onTabCreated(tab)

    view.webContents.loadURL(url)
    if (activate) this.activate(tab.id, { quiet: true })
    else this.layout()
    this.publish()
    return tab
  }

  /** Put one tab in front: the only visible view, and the one the strip marks. */
  activate(tabId, { quiet = false } = {}) {
    const tab = this.tabs.find(candidate => candidate.id === tabId)
    if (tab === undefined) return { ok: false, error: `no tab ${tabId}` }
    this.activeId = tabId
    this.layout()
    if (!quiet) this.publish()
    return { ok: true, tab: tab.describe(true) }
  }

  closeTab(tabId) {
    const index = this.tabs.findIndex(tab => tab.id === tabId)
    if (index === -1) return { ok: false, error: `no tab ${tabId}` }
    const [tab] = this.tabs.splice(index, 1)
    try {
      this.win.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    } catch {
      // A tab that is already gone is not a failure worth reporting.
    }
    // A browser with no tabs is not a browser; the last close leaves a fresh one, which is
    // what Chrome does and what stops a pane from becoming a dead rectangle.
    if (this.tabs.length === 0) this.addTab()
    else if (this.activeId === tabId || this.active === null) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id)
    else {
      this.layout()
      this.publish()
    }
    return { ok: true }
  }

  /**
   * Put every page in this pane into an annotation mode.
   *
   * `quick` is the one-step path: the next click picks an element and a comment box opens on
   * it, with no picker to walk first. `inspect` is the DevTools picker, kept open until the
   * human has found the node. `off` is neither.
   */
  setMode(mode, only) {
    this.mode = mode
    const targets = only === undefined ? this.tabs : [only]
    for (const tab of targets) {
      if (tab.view.webContents.isDestroyed()) continue
      // The picker is a preload, so it is already there; this only tells it what to do. A
      // page mid-navigation is skipped rather than queued: its own did-finish-load re-arms it.
      if (tab.view.webContents.isLoadingMainFrame()) continue
      // `mode` is the message type the picker already answers to; see its own listener.
      tab.view.webContents.send('annotate-command', { type: 'mode', mode })
    }
    return { ok: true, mode }
  }

  /**
   * Ask the page-side picker something and wait for its answer.
   *
   * The picker runs in the page's isolated world, so this is not a function call that can
   * return a value; it is a message out and a message back. The app's half of that round trip
   * lives in `onAnnotation`, which is why a request carries an id: a reply has to be matched
   * to the question that caused it.
   */
  ask(tab, message, timeout = 4000) {
    if (tab === undefined || tab === null || tab.view.webContents.isDestroyed()) {
      return Promise.resolve({ ok: false, error: 'no page' })
    }
    const id = this.nextRequest++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        resolve({ ok: false, error: 'the page did not answer' })
      }, timeout)
      this.pendingRequests.set(id, value => {
        clearTimeout(timer)
        resolve(value)
      })
      tab.view.webContents.send('annotate-request', { id, message })
    })
  }

  /** What the last right-click in this pane landed on, described by the page itself. */
  pick(tab) {
    return this.ask(tab, { type: 'context' }).then(reply => reply?.element ?? null)
  }

  /** Read the engine's own state back into the tab record. */
  describe(tab) {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    tab.url = contents.getURL()
    tab.title = contents.getTitle()
    tab.loading = contents.isLoading()
    tab.canGoBack = contents.navigationHistory.canGoBack()
    tab.canGoForward = contents.navigationHistory.canGoForward()
    tab.zoom = contents.getZoomFactor()
    const url = tab.url
    // The scheme, plus what it means for this particular host. A local development server
    // over http is not "not secure" in the alarming sense and saying so would train the
    // human to ignore the warning where it matters.
    if (url.startsWith('https://')) tab.security = { level: 'secure', text: 'Connection is secure' }
    else if (url.startsWith('http://')) {
      const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(url)
      tab.security = local ? { level: 'local', text: 'Local address — not encrypted' } : { level: 'insecure', text: 'Not secure' }
    } else if (url === '' || url.startsWith('file://')) tab.security = { level: 'none', text: '' }
  }

  /**
   * Place the toolbar at the top of the pane and the active page under it.
   *
   * A hidden pane hides every view rather than leaving them where they were: a native view
   * is composited above the page and does not clip to its parent, so a view left visible
   * over a collapsed region is a rectangle of browser on top of whatever is under it.
   */
  layout() {
    const box = this.box
    const chrome = chromeHeight(this.strip ? this.tabs.length : 1)
    const show = this.visible === true && box !== null && box.width >= 140 && box.height >= chrome + 40
    if (!show) {
      this.toolbar.setVisible(false)
      for (const tab of this.tabs) tab.view.setVisible(false)
      return
    }
    const [width, height] = this.win.getContentSize()
    const x = Math.max(0, Math.min(Math.round(box.x), width))
    const y = Math.max(0, Math.min(Math.round(box.y), height))
    const w = Math.max(0, Math.min(Math.round(box.width), width - x))
    const h = Math.max(0, Math.min(Math.round(box.height), height - y))
    this.toolbar.setVisible(true)
    this.toolbar.setBounds({ x, y, width: w, height: Math.min(chrome, h) })
    const pageY = y + chrome
    const pageH = Math.max(0, h - chrome)
    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeId
      tab.view.setVisible(isActive)
      if (isActive) tab.view.setBounds({ x, y: pageY, width: w, height: pageH })
    }
  }

  setBox(box) {
    this.box = box
    this.layout()
  }

  setVisible(visible) {
    this.visible = visible === true
    this.layout()
  }

  /** Redraw the toolbar and tell the host what this pane is doing. */
  publish() {
    const tabs = this.tabs.map(tab => tab.describe(tab.id === this.activeId))
    const active = this.active
    const state = {
      pane: this.name,
      // Whether this pane draws a strip at all, and therefore how tall the toolbar is. The
      // toolbar document cannot work this out for itself: it never sees the tab count of a
      // pane that is not showing a strip.
      strip: this.strip,
      tabs,
      activeId: this.activeId,
      active: active === null ? null : active.describe(true),
    }
    if (!this.toolbar.webContents.isDestroyed()) this.toolbar.webContents.send('tabs', state)
    // The toolbar's height depends on the tab count, and only this side knows it.
    this.layout()
    if (this.onChange !== undefined) this.onChange(state)
  }

  /** Act on the toolbar's behalf. */
  command(action, payload = {}) {
    const tab = this.active
    switch (action) {
      case 'new':
        this.addTab(typeof payload.url === 'string' && payload.url !== '' ? payload.url : START_PAGE)
        return { ok: true }
      case 'close':
        return this.closeTab(typeof payload.tabId === 'number' ? payload.tabId : this.activeId)
      case 'switch':
        return this.activate(payload.tabId)
      case 'back':
        if (tab !== null && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack()
        return { ok: true }
      case 'forward':
        if (tab !== null && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward()
        return { ok: true }
      case 'reload':
        tab?.view.webContents.reload()
        return { ok: true }
      case 'stop':
        tab?.view.webContents.stop()
        return { ok: true }
      case 'home':
        tab?.view.webContents.loadURL(START_PAGE)
        return { ok: true }
      case 'zoom':
        if (tab !== null) {
          const next = Math.min(3, Math.max(0.25, tab.view.webContents.getZoomFactor() + payload.delta))
          tab.view.webContents.setZoomFactor(next)
          tab.zoom = next
          this.publish()
        }
        return { ok: true }
      case 'zoom-reset':
        if (tab !== null) {
          tab.view.webContents.setZoomFactor(1)
          tab.zoom = 1
          this.publish()
        }
        return { ok: true }
      case 'go': {
        if (tab === null) return { ok: false, error: 'no tab is open' }
        tab.view.webContents.loadURL(String(payload.url ?? ''))
        return { ok: true }
      }
      case 'devtools':
        tab?.view.webContents.openDevTools({ mode: 'detach' })
        return { ok: true }
      case 'list':
        return {
          pane: this.name,
          strip: this.strip,
          tabs: this.tabs.map(candidate => candidate.describe(candidate.id === this.activeId)),
          activeId: this.activeId,
          active: tab === null ? null : tab.describe(true),
        }
      default:
        return { ok: false, error: `unknown browser action: ${action}` }
    }
  }

  /** The small native menu behind ⋮, for this pane. */
  menu() {
    if (this.win === null) return { ok: false }
    const tab = this.active
    const template = [
      { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => this.command('new') },
      { label: 'Duplicate tab', click: () => tab !== null && this.addTab(tab.url === '' ? START_PAGE : tab.url) },
      { type: 'separator' },
      { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => this.command('zoom', { delta: 0.1 }) },
      { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => this.command('zoom', { delta: -0.1 }) },
      { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => this.command('zoom-reset') },
      { type: 'separator' },
      { label: 'Copy page address', click: () => tab !== null && clipboard.writeText(tab.url) },
      { label: 'Open in default browser', click: () => tab !== null && tab.url !== '' && shell.openExternal(tab.url) },
      { type: 'separator' },
      { label: 'Developer tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => this.command('devtools') },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.win })
    return { ok: true }
  }

  destroy() {
    for (const tab of this.tabs) {
      try {
        tab.view.webContents.close()
      } catch {
        // Closing what is already closing is not an error.
      }
    }
    this.tabs = []
  }
}

module.exports = { Pane, CHROME_HEIGHT: BAR_HEIGHT, BAR_HEIGHT, STRIP_HEIGHT, chromeHeight, START_PAGE }
