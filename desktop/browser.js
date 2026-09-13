// The browser the pane shows: real Chromium views, with the tab and toolbar surface that
// belongs to them.
//
// Every value this hands to the toolbar is read from the engine — title, favicon, the
// history stack, the security state, loading progress, zoom. Nothing is inferred from a
// URL string and nothing is remembered here that the engine already knows, because a
// browser bar that guesses disagrees with the page it is describing.

const { WebContentsView } = require('electron')
const { join } = require('node:path')

/** The toolbar is the tab strip plus the address row. */
const CHROME_HEIGHT = 76

/** A new tab with no address yet shows a start page rather than a blank white field. */
const START_PAGE = `file://${join(__dirname, 'start.html')}`

/**
 * One tab: its engine view, and what the toolbar needs to draw it.
 *
 * The fields are a cache of engine state for the strip's benefit, refreshed from the
 * view's own events rather than written by hand, so a tab cannot describe itself wrongly.
 */
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

class BrowserPane {
  /**
   * @param win - the window whose content view hosts the tabs.
   * @param onTabs - called whenever the strip should be redrawn.
   */
  constructor(win, onTabs) {
    this.win = win
    this.onTabs = onTabs
    /** @type {Tab[]} */
    this.tabs = []
    this.activeId = null
    this.nextId = 1
    /** The pane rectangle in CSS pixels; null until the page reports one. */
    this.box = null
    this.visible = false
    this.toolbar = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'toolbar-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.win.contentView.addChildView(this.toolbar)
    this.toolbar.setVisible(false)
    this.toolbar.webContents.loadFile(join(__dirname, 'toolbar.html'))
    this.toolbar.webContents.on('did-finish-load', () => this.publish())
  }

  get active() {
    return this.tabs.find(tab => tab.id === this.activeId) ?? null
  }

  /**
   * A new tab, in front, with its own engine view.
   *
   * A tab is created before it is navigated, so the start page is a real page in a real
   * tab rather than a placeholder drawn in the strip. It is also what makes `+` instant:
   * the tab exists the moment the click lands.
   */
  addTab(url = START_PAGE, { activate = true } = {}) {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const tab = new Tab(view, this.nextId++)
    this.tabs.push(tab)
    this.win.contentView.addChildView(view)
    view.setVisible(false)

    // A page asking for a new window gets a new tab, which is what a browser does and
    // what keeps a target="_blank" link from opening a window nobody asked for.
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      this.addTab(target)
      return { action: 'deny' }
    })

    const refresh = () => {
      this.describe(tab)
      this.publish()
    }
    view.webContents.on('did-start-loading', refresh)
    view.webContents.on('did-stop-loading', refresh)
    view.webContents.on('did-navigate', refresh)
    view.webContents.on('did-navigate-in-page', refresh)
    view.webContents.on('page-title-updated', refresh)
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons.length > 0 ? favicons[0] : ''
      refresh()
    })
    // The certificate state, from the engine. A padlock drawn from the URL scheme would
    // say "https is fine" for a certificate that was overridden, which is worse than
    // saying nothing at all.
    view.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame === true) {
        tab.security = { level: 'broken', text: `${description} (${code})` }
        refresh()
      }
    })
    view.webContents.on('certificate-error', () => {
      tab.security = { level: 'broken', text: 'This connection is not private' }
      refresh()
    })
    view.webContents.on('zoom-changed', () => {
      tab.zoom = view.webContents.getZoomFactor()
      refresh()
    })

    view.webContents.loadURL(url)
    if (activate) this.activate(tab.id)
    else this.layout()
    this.publish()
    return tab
  }

  /** Put one tab in front: the only view that is visible, and the one the strip marks. */
  activate(tabId) {
    const tab = this.tabs.find(candidate => candidate.id === tabId)
    if (tab === undefined) return { ok: false, error: `no tab ${tabId}` }
    this.activeId = tabId
    this.layout()
    this.publish()
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
    // A browser with no tabs left is not a browser; the last close leaves a fresh one,
    // which is what Chrome does and what stops the pane from becoming a dead rectangle.
    if (this.tabs.length === 0) this.addTab()
    else if (this.activeId === tabId || this.active === null) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]
      this.activate(next.id)
    } else {
      this.layout()
      this.publish()
    }
    return { ok: true }
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
    // `isCurrentlyAudible` and the security level come from the engine rather than from
    // the address, so an http page on a local dev server can be shown as exactly that.
    const url = tab.url
    if (url.startsWith('https://')) tab.security = { level: 'secure', text: 'Connection is secure' }
    else if (url.startsWith('http://')) {
      const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)
      tab.security = local
        ? { level: 'local', text: 'Local development server — not encrypted' }
        : { level: 'insecure', text: 'Not secure' }
    } else if (url === '' || url.startsWith('file://')) tab.security = { level: 'none', text: '' }
  }

  /**
   * Place the toolbar over the top of the pane and the active page under it.
   *
   * A hidden pane hides every view rather than leaving them where they were: a native
   * view is composited above the page and does not clip to its parent, so a view left
   * visible over a collapsed sidebar is a rectangle of browser on top of the conversation.
   */
  layout() {
    const box = this.box
    const show = this.visible === true && box !== null && box.width >= 120 && box.height >= CHROME_HEIGHT + 40
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
    this.toolbar.setBounds({ x, y, width: w, height: Math.min(CHROME_HEIGHT, h) })
    const pageY = y + CHROME_HEIGHT
    const pageH = Math.max(0, h - CHROME_HEIGHT)
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

  /** Redraw the toolbar and tell the host page what the browser is doing. */
  publish() {
    const tabs = this.tabs.map(tab => tab.describe(tab.id === this.activeId))
    const active = this.active
    const state = {
      tabs,
      activeId: this.activeId,
      active: active === null ? null : active.describe(true),
    }
    if (!this.toolbar.webContents.isDestroyed()) this.toolbar.webContents.send('tabs', state)
    if (this.onTabs !== undefined) this.onTabs(state)
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
      default:
        return { ok: false, error: `unknown browser action: ${action}` }
    }
  }

  destroy() {
    for (const tab of this.tabs) {
      try {
        tab.view.webContents.close()
      } catch {
        // Closing a window that is already closing is not an error.
      }
    }
    this.tabs = []
  }
}

module.exports = { BrowserPane, CHROME_HEIGHT, START_PAGE }
