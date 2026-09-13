// The app: two real browsers side by side, each with its own address bar and its own tabs.
//
// The left pane is the conversation. It is not a special-cased viewer — it is a browser
// whose first tab happens to be DSH, which is why the URL that `dsh web --port 3090` printed
// can be pasted into its address bar, token and all, and simply load. The right pane is a
// browser for the work itself, where pages are inspected, annotated, and handed to the agent.
//
// What this corrects: an earlier attempt concluded that real Chromium could never appear
// beside a DSH conversation, because a DSH sidebar tab is a React component in a web page
// and a web page cannot host another process's window. That was true of one architecture —
// DSH as a page inside a normal browser — and false as a statement about the problem. Put
// DSH inside a desktop shell that owns a native window and the objection disappears, which
// is how the Codex app does it.
//
// The split is between native views, not a CSS grid in a page, so a pane can be dragged
// without a page having to agree about it.

const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu } = require('electron')
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const { Pane, START_PAGE } = require('./pane')
const { captureElement, captureViewport, describeAnnotation } = require('./annotate')
const { showContextMenu } = require('./context-menu')
const { AnnotationBridge, DEFAULT_PORT: DEFAULT_BRIDGE_PORT } = require('./annotation-bridge')
const { PageDriver, deliver } = require('./deliver')
const { BrowserRpc } = require('./rpc')

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080/'
const START_URL = process.env.DSH_BROWSER_START ?? START_PAGE
const SPLIT = Number(process.env.DSH_SPLIT ?? 0.5)

// The protocol port is always open, because Playwright attaches to the browser through it: a
// tool that runs Playwright code needs a port to connect to, and a port that only exists when
// someone remembered to set an environment variable is a port that is missing when it is needed.
//
// Port 0 lets Chromium choose a free one and write it to `DevToolsActivePort` in the user data
// directory, which is read back below. A fixed port would be a port that is sometimes taken, and
// the failure for a taken port is silent — the app starts and simply has no debugging endpoint.
if (process.env.DSH_SHELL_DEBUG_PORT !== undefined) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DSH_SHELL_DEBUG_PORT)
} else {
  app.commandLine.appendSwitch('remote-debugging-port', '0')
}

/**
 * The port Chromium opened for the protocol, or null when it has not opened one.
 *
 * Read from disk rather than remembered, because with port 0 only Chromium knows which port it
 * chose, and it writes the answer only once it is listening.
 *
 * @returns the port number, or null.
 */
function devtoolsPort() {
  if (process.env.DSH_SHELL_DEBUG_PORT !== undefined) {
    const fixed = Number(process.env.DSH_SHELL_DEBUG_PORT)
    return Number.isInteger(fixed) ? fixed : null
  }
  try {
    const first = readFileSync(join(app.getPath('userData'), 'DevToolsActivePort'), 'utf8').split('\n')[0]
    const port = Number(String(first).trim())
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/** @type {BrowserWindow | null} */
let win = null
/** @type {Pane | null} */
let left = null
/** @type {Pane | null} */
let right = null
/** @type {WebContentsView | null} */
let divider = null
/** The draggable divider's position, as a fraction of the window. */
let split = SPLIT

/**
 * Where annotations wait until the human sends them into the conversation.
 *
 * They are kept in the app rather than pushed straight at the chat, because the whole value
 * of an annotation is that the human wrote it deliberately: several of them accumulate, each
 * one is re-read, and the batch goes into the composer together.
 */
/**
 * One line to stdout, which is where the app's own log goes and where a human reads it.
 * @param message - what happened.
 */
function note(message) {
  process.stdout.write(`[dsh-desktop] ${message}\n`)
}

const bridge = new AnnotationBridge(note)

/**
 * What the conversation can ask this browser to do.
 *
 * The DSH in the left pane is a normal DSH on a normal port with no plugin of ours inside it,
 * so its tools reach this app over loopback HTTP instead of by being loaded into it. That is
 * the whole of the integration: no service is shared, and the app does not know DSH exists
 * beyond answering these method names.
 */
const rpc = new BrowserRpc({
  panes: () => [left, right],
  conversation: () => left,
  log: line => process.stdout.write(`[dsh-desktop] ${line}\n`),
})
bridge.onTabs = () => rpc.describeTabs()
// Where Playwright connects. Published rather than configured, so the plugin never has to be told
// a port and never has to guess one.
bridge.onDebugPort = () => devtoolsPort()
bridge.onRpc = async (method, params) => {
  const started = Date.now()
  try {
    const result = await rpc.dispatch(method, params)
    process.stdout.write(`[dsh-desktop] rpc ${method} ok in ${Date.now() - started}ms\n`)
    return result
  } catch (error) {
    process.stdout.write(`[dsh-desktop] rpc ${method} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}
/** The debugger handle on the conversation's page, opened on first delivery. */
let driver = null

/** Lay out both panes for the current window size and split. */
function layout() {
  if (win === null || left === null || right === null || divider === null) return
  const [width, height] = win.getContentSize()
  const handle = 6
  const leftWidth = Math.max(240, Math.min(Math.round(width * split) - handle / 2, width - 240 - handle))
  left.setBox({ x: 0, y: 0, width: leftWidth, height })
  right.setBox({ x: leftWidth + handle, y: 0, width: width - leftWidth - handle, height })
  divider.setBounds({ x: leftWidth, y: 0, width: handle, height })
}

/** Which pane the human is in. Set by the panes themselves as focus moves. */
let focusedPane = 'right'

/**
 * The command a keyboard shortcut maps to, and the pane it applies to.
 *
 * The shortcut goes to the pane the human is in, not to a fixed one: ⌘T while reading a page
 * beside the conversation should open a tab beside that page.
 */
function commandFor(input) {
  const pane = focusedPane === 'left' ? left : right
  if (pane === null) return null
  const meta = process.platform === 'darwin' ? input.meta : input.control
  if (meta !== true || input.type !== 'keyDown') return null
  // A pane that is DSH itself holds one page; opening a browser tab inside the conversation
  // is not a thing it can do, so the shortcut falls through to DSH's own handling.
  const canOpenTabs = pane.strip === true
  const key = String(input.key).toLowerCase()
  if (key === 't' && canOpenTabs) return { pane, action: 'new' }
  if (key === 'w' && canOpenTabs) return { pane, action: 'close' }
  if (key === 'r') return { pane, action: 'reload' }
  if (key === 'l') return { pane, action: 'focus-address' }
  if (key === '[') return { pane, action: 'back' }
  if (key === ']') return { pane, action: 'forward' }
  return null
}

/** The tab a page's webContents belongs to, in either pane. */
function tabFor(webContents) {
  for (const pane of [left, right]) {
    if (pane === null) continue
    const tab = pane.tabs.find(candidate => candidate.view.webContents === webContents)
    if (tab !== undefined) return Object.assign(tab, {
      // The pane answers for its own tabs; a tab does not need to know which pane it is in.
      pane,
      pick: () => pane.pick(tab),
    })
  }
  return null
}

/** The pane a page's webContents belongs to. */
function paneFor(webContents) {
  return tabFor(webContents)?.pane ?? null
}

/**
 * Turn what the picker reports into an annotation the human can send.
 *
 * The picker sends the comment the instant it is written, before any screenshot exists,
 * because a comment typed by a human must never be lost to a screenshot that failed. The
 * picture is taken here and joins the entry moments later.
 */
async function collect(tab, message) {
  const annotation = message.annotation
  const entry = bridge.add({ ...annotation, text: describeAnnotation(annotation, 0) })
  publishAnnotations()
  const pane = paneFor(tab.view.webContents)
  // The crop is taken through the same engine that is showing the page, so what is captured is
  // what is on screen. A capture that fails costs the picture and not the comment.
  const screenshot = await captureElement(tab.view.webContents, annotation.element?.rect, {
    // The view's own size, so the crop is scaled from CSS pixels to the device pixels the engine
    // hands back. On a retina display those differ by two, and a crop that ignores it is a
    // picture of the wrong part of the page.
    cssSize: tab.view.getBounds(),
  }).catch(() => null)
  if (screenshot !== null) {
    annotation.screenshot = screenshot
    bridge.setScreenshot(entry.id, screenshot)
    publishAnnotations()
  }
  pane?.toolbar.webContents.send('annotation-added', entry.id)
}

/**
 * Everything a page says arrives here and is routed by kind.
 *
 * One channel, one dispatcher: a reply that was mistaken for an annotation would file the
 * page's answer to a question as a comment from the human.
 */
function fromPage(tab, message) {
  if (message === null || typeof message !== 'object') return
  if (message.type === '__reply') {
    const pane = paneFor(tab.view.webContents)
    const settle = pane?.pendingRequests.get(message.id)
    if (settle !== undefined) {
      pane.pendingRequests.delete(message.id)
      settle(message.value)
    }
    return
  }
  if (message.type === 'annotation') {
    collect(tab, message).catch(error => process.stderr.write(`[dsh-desktop] annotate: ${error.message}\n`))
  }
}

/**
 * Open the picker's comment box on whatever was just right-clicked.
 *
 * The page recorded the element during the click, because a menu is drawn after the page has
 * had every chance to change underneath the pointer; this only asks it to open on that.
 */
async function annotateHere(webContents, params) {
  const pane = paneFor(webContents)
  const tab = tabFor(webContents)
  if (pane === null || tab === null) return { ok: false }
  // The composer opens on its own; nothing needs to be armed first, and leaving inspect armed
  // would mean the next click started a second annotation.
  pane.setMode('off', tab)
  const reply = await pane.ask(tab, { type: 'composeAt', x: params?.x ?? 0, y: params?.y ?? 0 })
  return reply ?? { ok: false }
}

/**
 * Hand every waiting annotation to the conversation.
 *
 * Text and images both go in through the conversation's own composer, over the protocol
 * described in deliver.js. The queue is emptied only after a successful delivery, so a failure
 * leaves the human's work where they can see it rather than in a chat message that never was.
 */
async function sendAnnotations() {
  const contents = dshContents()
  if (contents === null) return { ok: false, error: 'the conversation pane has no page' }
  if (contents.isLoadingMainFrame()) return { ok: false, error: 'the conversation is still loading' }
  const waiting = bridge.waiting()
  if (waiting.length === 0) return { ok: false, error: 'there is nothing waiting' }

  driver = driver !== null && driver.webContents === contents ? driver : new PageDriver(contents)
  const results = []
  for (const entry of waiting) {
    const text = describeAnnotation(entry.annotation, results.length)
    // eslint-disable-next-line no-await-in-loop
    const report = await deliver(driver, { ...entry.annotation, id: entry.id }, text)
    results.push({ id: entry.id, ...report })
    if (report.text === false) break
  }
  const delivered = results.filter(result => result.text).map(result => result.id)
  if (delivered.length > 0) bridge.clear(delivered)
  publishAnnotations()
  return { ok: delivered.length > 0, delivered, results }
}

/** Walk the DOM with the picker, the way the DevTools inspector does. */
async function inspectHere(webContents) {
  const pane = paneFor(webContents)
  if (pane === null) return { ok: false }
  pane.setMode('inspect')
  return { ok: true }
}

/** Tell every toolbar how many annotations are waiting. */
function publishAnnotations() {
  const list = bridge.list()
  for (const pane of [left, right]) {
    if (pane === null) continue
    pane.toolbar.webContents.send('annotations', list)
  }
}

/** The left pane's first tab, which is DSH itself. */
function dshContents() {
  const contents = left?.tabs[0]?.view.webContents
  return contents !== undefined && !contents.isDestroyed() ? contents : null
}

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1040,
    minWidth: 900,
    minHeight: 600,
    title: 'DSH',
    backgroundColor: '#202124',
    // The traffic lights are inset over the panes' own toolbars rather than sitting in a
    // title bar above them, which would put a strip of nothing between the two browsers.
    titleBarStyle: 'hiddenInset',
  })

  // A window always has its own webContents, and this one is never navigated anywhere: the two
  // panes are separate views that cover it completely. Left alone it stays a page target with an
  // empty URL and no frame tree, which is a page that never finishes initialising — and anything
  // that attaches to the whole browser over the DevTools Protocol waits for every attached page
  // to be ready, so that one blank view hangs Playwright's connection indefinitely. Giving it a
  // document costs nothing and makes it an ordinary initialised page like the rest.
  win.webContents.loadURL('about:blank').catch(() => {})
  win.webContents.setAudioMuted(true)

  // The divider is a view rather than a line drawn in a page, because it has to sit between
  // two native views and anything a page draws is composited underneath them.
  divider = new WebContentsView({
    webPreferences: { preload: join(__dirname, 'divider-preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(divider)
  divider.webContents.loadFile(join(__dirname, 'divider.html'))

  left = new Pane(win, 'left')
  right = new Pane(win, 'right', {
    // A right-click on a page is the gesture the whole app exists for, so the menu it opens
    // is the platform's own and carries the annotation entries at the top.
    onContextMenu: (params, webContents) => {
      showContextMenu({
        webContents,
        params,
        describe: () => tabFor(webContents)?.pick(),
        onAnnotate: () => annotateHere(webContents, params),
        onInspect: () => inspectHere(webContents),
      }).catch(error => process.stderr.write(`[dsh-desktop] menu: ${error.message}\n`))
    },
  })
  left.onAnnotation = (tab, message) => fromPage(tab, message)
  right.onAnnotation = (tab, message) => fromPage(tab, message)
  // Attention starts in the conversation, because that is what the human opened.
  left.onFocus = () => {
    focusedPane = 'left'
  }
  right.onFocus = () => {
    focusedPane = 'right'
  }

  // A shortcut is offered to the focused pane first, and only if that pane has no use for it
  // does it reach the page. ⌘W while the conversation is focused closes nothing here, so DSH
  // still receives it.
  for (const pane of [left, right]) {
    // Shortcuts are handled in one place for both the toolbar and the pages, so a key means
    // the same thing whether the pointer is on a page or on the address row.
    pane.onShortcut = (event, input) => {
      const command = commandFor(input)
      if (command === null || command.pane !== pane) return false
      if (command.action === 'focus-address') {
        // Reported to the toolbar, which owns the address field and knows how to select it.
        pane.toolbar.webContents.focus()
        pane.toolbar.webContents.send('focus-address')
        return true
      }
      pane.command(command.action)
      return true
    }
  }

  // Every tab is observed from the moment it exists, so a state a page enters on its own — a
  // dialog above all — is on record before any tool asks about it.
  for (const pane of [left, right]) {
    pane.onTabCreated = tab => {
      rpc.attach(tab).catch(() => undefined)
    }
  }

  left.addTab(DSH_URL)
  right.addTab(START_URL)

  // The conversation pane belongs to DSH and to nothing else. Anything that tries to move it
  // somewhere else is refused, and the refusal is written down, because a blocked navigation
  // and a navigation that never happened are indistinguishable from the outside and only one
  // of them means something in the app is doing something it should not.
  //
  // The origin is taken from the URL that actually loaded rather than from the one that was
  // asked for: DSH consumes its token and redirects, and the token in the address is not part
  // of the origin it settles on. Same-origin navigation stays allowed, because DSH routes
  // within itself and refusing that would break the app to prevent nothing.
  left.onWillNavigate = (tab, target) => {
    const settled = left.settledOrigin
    if (settled === null || settled === undefined) return { allow: true }
    let origin
    try {
      origin = new URL(target).origin
    } catch {
      return { allow: false, reason: `"${target}" is not a URL` }
    }
    if (origin === settled) return { allow: true }
    return { allow: false, reason: `${origin} is not ${settled}, the origin the conversation is on` }
  }
  left.onNavigationBlocked = (tab, target, reason) => {
    note(`refused to move the conversation pane to ${target}: ${reason}`)
  }

  // `will-navigate` only sees navigations the page starts. A navigation the app starts with
  // `loadURL` never passes through it, and that is the kind that moved the conversation pane off
  // DSH once already — recorded in this window's history as a *typed* navigation to the browser
  // pane's start URL, with nothing in the RPC log to explain it. So the load itself is watched
  // as well, and the stack is kept: the URL says what happened, and only the stack says who.
  const conversation = left.tabs[0]
  conversation.view.webContents.on('did-start-navigation', (event, target, _inPlace, isMainFrame) => {
    if (isMainFrame !== true) return
    try {
      left.settledOrigin = new URL(target).origin
    } catch {
      left.settledOrigin = null
    }
    const stack = new Error('navigation').stack.split('\n').slice(2, 6).map(frame => frame.trim()).join(' ← ')
    note(`conversation pane loading ${target}  [${event.transitionType ?? 'unknown'}]  via ${stack}`)
  })
  left.setVisible(true)
  right.setVisible(true)

  layout()
  win.on('resize', layout)

  win.on('closed', () => {
    left?.destroy()
    right?.destroy()
    win = null
  })
}

// ── the divider's side ────────────────────────────────────────────────────

ipcMain.handle('split-set', (_event, ratio) => {
  split = Math.max(0.2, Math.min(0.8, Number(ratio) || SPLIT))
  layout()
  return { ok: true, split }
})

ipcMain.handle('split-nudge', (_event, delta) => {
  split = Math.max(0.2, Math.min(0.8, split + Number(delta || 0)))
  layout()
  return { ok: true, split }
})

// ── a toolbar's side ──────────────────────────────────────────────────────

ipcMain.handle('pane-command', (_event, paneName, action, payload) => {
  const pane = paneName === 'left' ? left : right
  if (pane === null) return { ok: false, error: `no ${paneName} pane` }
  return pane.command(String(action), payload ?? {})
})

ipcMain.handle('pane-menu', (_event, paneName) => {
  const pane = paneName === 'left' ? left : right
  return pane?.menu() ?? { ok: false }
})

// ── annotation's side ─────────────────────────────────────────────────────

/** Arm the picker in the focused pane. `quick` annotates the next click; `inspect` walks. */
ipcMain.handle('annotate-mode', (_event, paneName, mode) => {
  const pane = paneName === 'left' ? left : right
  if (pane === null) return { ok: false }
  return pane.setMode(String(mode))
})

/**
 * Ask the pane's page whether the annotator is alive, and in what state.
 *
 * A preload runs in the page's isolated world, so nothing outside the page can read its
 * variables — the only honest way to ask "is the picker installed and armed here?" is to send
 * it a message and see whether it answers. This is what the app checks before blaming a click.
 */
ipcMain.handle('annotate-ping', async (_event, paneName) => {
  const pane = paneName === 'left' ? left : right
  const tab = pane?.active
  if (pane === null || tab === undefined) return { ok: false, error: 'no page' }
  return { ok: true, reply: await pane.ask(tab, { type: 'ping' }) }
})

/** What is waiting, for a toolbar that wants to show it. */
ipcMain.handle('annotations-list', () => ({ ok: true, annotations: bridge.list() }))

/** Drop one waiting annotation, or all of them when no id is given. */
ipcMain.handle('annotations-clear', (_event, id) => {
  bridge.clear(id === undefined || id === null ? [] : [Number(id)])
  publishAnnotations()
  return { ok: true, annotations: bridge.list() }
})

/** Send everything waiting into the conversation's composer. */
ipcMain.handle('annotations-send', () => sendAnnotations())

/** Where the queue can be read from outside this app, for a DSH that wants to poll it. */
ipcMain.handle('bridge-url', () => ({ ok: true, url: bridge.url, port: bridge.port }))

// ── inspection, for checks and for the agent ──────────────────────────────

ipcMain.handle('view-bounds', () => ({
  split,
  left: {
    box: left?.box ?? null,
    toolbar: left?.toolbar.getBounds() ?? null,
    page: left?.active?.view.getBounds() ?? null,
    tabs: left?.tabs.map(tab => tab.describe(tab.id === left.activeId)) ?? [],
  },
  right: {
    box: right?.box ?? null,
    toolbar: right?.toolbar.getBounds() ?? null,
    page: right?.active?.view.getBounds() ?? null,
    tabs: right?.tabs.map(tab => tab.describe(tab.id === right.activeId)) ?? [],
  },
}))

app.whenReady().then(async () => {
  // DSH is behind a session cookie, and a URL carrying its own token does not need one. When
  // a cookie is supplied it goes to both the store and the wire: a pane can issue its first
  // request before an async store write has landed.
  const cookie = process.env.DSH_COOKIE
  if (typeof cookie === 'string' && cookie.includes('=')) {
    const [name, ...rest] = cookie.split('=')
    const origin = new URL(DSH_URL).origin
    await session.defaultSession.cookies.set({ url: origin, name, value: rest.join('='), httpOnly: true })
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      const existing = details.requestHeaders.Cookie
      details.requestHeaders.Cookie = existing === undefined ? cookie : `${existing}; ${cookie}`
      callback({ requestHeaders: details.requestHeaders })
    })
  }
  // The queue is served before the window exists, because the conversation may already be
  // running and polling for it.
  await bridge.listen(Number(process.env.DSH_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT))
  createWindow()
  publishAnnotations()
})

app.on('window-all-closed', () => {
  // On macOS an app with no window is still running; quitting here would take it out from
  // under a Dock click that is about to reopen it.
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
