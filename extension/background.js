// Browser Annotate — extension service worker.
//
// One worker instance owns three things:
//
//   1. the WebSocket to the DSH host, with reconnect and an outbound queue;
//   2. the Chrome DevTools Protocol session (`chrome.debugger`) used for
//      screenshots and for the raw `cdp` passthrough the agent calls;
//   3. the message router between the content-script overlay and the host.
//
// Screenshots deliberately use `chrome.tabs.captureVisibleTab` plus an
// offscreen crop rather than `Page.captureScreenshot`. captureVisibleTab needs
// no debugger attachment and no user gesture, so a screenshot works even while
// the agent is mid-command; the crop keeps the annotation payload small and
// gives the model exactly the element it was asked about. When a full-page or
// otherwise protocol-only capture is needed, the CDP path is available and the
// caller passes `viaCdp`.

/** Command-line style defaults for the DSH host the extension dials. */
const DEFAULT_HOST = 'http://127.0.0.1:3080'

/** Domains enabled on every debugger attach, so the common commands just work. */
const AUTO_ENABLED_DOMAINS = ['Runtime', 'Page', 'DOM', 'CSS', 'Network', 'Log']

/** Console/network buffers are per tab and bounded so they cannot grow forever. */
const MAX_LOG_ENTRIES = 400
const MAX_NETWORK_ENTRIES = 400

/** Reconnect backoff bounds, in milliseconds. */
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15000

/** Per-tab capture state, keyed by Chrome tab id. */
const logBuffers = new Map()
const networkBuffers = new Map()

/** The live bridge socket, or null while disconnected. */
let socket = null
/** Outbound frames buffered while the socket is down. */
let outbound = []
/** Current reconnect delay; grows on failure and resets on open. */
let reconnectDelay = RECONNECT_MIN_MS
/** Timer for the pending reconnect attempt. */
let reconnectTimer = null
/** The host origin the extension is currently dialing. */
let hostBase = DEFAULT_HOST
/** The context-menu entry id, shared by the creator and the click handler. */
const CONTEXT_MENU_ID = 'dsh-browser-annotate-element'

/** Per-tab annotation mode, so the panel and the overlay agree. */
const tabModes = new Map()

/**
 * Read the configured host origin.
 * @returns the stored origin, or the default when unset.
 */
async function loadHost() {
  const stored = await chrome.storage.local.get({ host: DEFAULT_HOST })
  hostBase = normalizeHost(stored.host)
  return hostBase
}

/**
 * Normalize a user-typed host into an origin.
 * @param value - the raw setting.
 * @returns an `http(s)://host:port` origin without a trailing slash.
 */
function normalizeHost(value) {
  const raw = String(value ?? '').trim() || DEFAULT_HOST
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    return new URL(withScheme).origin
  } catch {
    return DEFAULT_HOST
  }
}

/** Derive the WebSocket URL the bridge listens on. */
function socketUrl() {
  const url = new URL(hostBase)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/browser-annotate/ws'
  return url.toString()
}

/** Open (or reopen) the bridge socket. Safe to call repeatedly. */
function connect() {
  if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  clearTimeout(reconnectTimer)
  let next
  try {
    next = new WebSocket(socketUrl())
  } catch {
    scheduleReconnect()
    return
  }
  socket = next
  next.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS
    send({
      kind: 'hello',
      version: chrome.runtime.getManifest().version,
      browser: navigator.userAgent.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome',
      capabilities: ['cdp', 'annotate', 'screenshot', 'console', 'network'],
    })
    flushOutbound()
    reportActiveTab()
    reportTabs()
  })
  next.addEventListener('message', event => {
    handleHostMessage(event.data).catch(error => {
      log('error', `host message failed: ${String(error)}`)
    })
  })
  next.addEventListener('close', () => {
    socket = null
    scheduleReconnect()
  })
  next.addEventListener('error', () => {
    // `close` follows and owns the retry; nothing to do here.
  })
}

/** Queue the next reconnect attempt with backoff. */
function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    connect().catch(() => scheduleReconnect())
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}

/**
 * Send one frame to the host, buffering it while the socket is down.
 * @param message - the JSON-serializable frame.
 */
function send(message) {
  const payload = JSON.stringify(message)
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(payload)
      return
    } catch {
      // Fall through to the buffer; `close` will bring the socket back.
    }
  }
  // Only control frames are worth buffering; screenshots would arrive stale.
  if (message.kind === 'hello' || message.kind === 'tab' || message.kind === 'tabs' || message.kind === 'annotation') {
    outbound.push(payload)
    if (outbound.length > 50) outbound = outbound.slice(-50)
  }
}

/** Flush buffered frames once the socket is open. */
function flushOutbound() {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return
  const pending = outbound
  outbound = []
  for (const payload of pending) {
    try {
      socket.send(payload)
    } catch {
      outbound.push(payload)
    }
  }
}

/**
 * Emit a diagnostic line to the host, which forwards it to the sidebar panel.
 * @param level - severity label.
 * @param textValue - the message.
 */
function log(level, textValue) {
  send({ kind: 'log', level, text: textValue })
}

/**
 * Tell the host every tab there is, and which one is in front.
 *
 * The panel is meant to be a browser rather than a picture of a page, and a browser
 * without a tab strip cannot open a second page. The list is small — id, title, url,
 * and which one is active — so it is sent whole instead of being patched.
 */
async function reportTabs() {
  try {
    const tabs = await chrome.tabs.query({})
    send({
      kind: 'tabs',
      tabs: tabs
        .filter(tab => typeof tab.id === 'number')
        .map(tab => ({
          id: tab.id,
          title: tab.title ?? '',
          url: tab.url ?? '',
          active: tab.active === true,
          windowId: tab.windowId,
          status: tab.status ?? '',
        })),
      activeId: tabs.find(tab => tab.active === true)?.id ?? null,
    })
  } catch (error) {
    log('error', `tab list failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Report the active tab to the host so its tools know where commands land. */
async function reportActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab === undefined) return
    send({
      kind: 'tab',
      tab: {
        id: tab.id,
        url: tab.url ?? '',
        title: tab.title ?? '',
        mode: tabModes.get(tab.id) ?? 'off',
        debuggerAttached: isAttached(tab.id),
      },
    })
  } catch {
    // A closed window during shutdown is not an error worth surfacing.
  }
}

/**
 * Whether the debugger is currently attached to a tab.
 * @param tabId - the Chrome tab id.
 * @returns true when a debugger session exists.
 */
function isAttached(tabId) {
  return attachedTabs.has(tabId)
}

/** Tabs with a live debugger session. */
const attachedTabs = new Set()

/**
 * Resolve the tab commands act on: the one the host named, else the active tab.
 * @param explicitTabId - a tab id supplied by the caller, if any.
 * @returns the target Chrome tab.
 * @throws when no tab can be resolved.
 */
async function resolveTab(explicitTabId) {
  const fallback = async reason => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    diagnostics.tabFallbacks += 1
    diagnostics.lastTabFallback = reason
    if (tab === undefined || tab.id === undefined) throw new Error('no active tab is available')
    return tab
  }
  if (typeof explicitTabId === 'number') {
    // A caller that names a tab may be naming one that has since closed. Reading it
    // throws rather than returning undefined, and that is worth surviving: the panel
    // keeps a tab id from the last tab event it saw, and a tab closing between that
    // event and the next command is ordinary. The fallback is the active tab, which
    // is also what every caller means when the named one is gone.
    try {
      const tab = await chrome.tabs.get(explicitTabId)
      if (tab !== undefined && tab.id !== undefined) return tab
    } catch {
      return fallback(`tab ${explicitTabId} was asked for and no longer exists`)
    }
    return fallback(`tab ${explicitTabId} resolved to nothing`)
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab !== undefined && tab.id !== undefined) return tab
  } catch {
    // A window that has gone away makes the query itself throw; the wider query below
    // is the one that still has an answer.
  }
  const [anyActive] = await chrome.tabs.query({ active: true })
  diagnostics.tabFallbacks += 1
  diagnostics.lastTabFallback = 'no active tab in the last focused window'
  if (anyActive !== undefined && anyActive.id !== undefined) return anyActive
  const [first] = await chrome.tabs.query({})
  if (first !== undefined && first.id !== undefined) return first
  throw new Error('no tab is available to act on')
}

/**
 * Attach the debugger to a tab and enable the common domains.
 * @param tabId - the Chrome tab id.
 * @returns the protocol version string reported by the browser.
 */
async function attach(tabId) {
  if (attachedTabs.has(tabId)) return 'already attached'
  const target = { tabId }
  await chrome.debugger.attach(target, '1.3')
  attachedTabs.add(tabId)
  for (const domain of AUTO_ENABLED_DOMAINS) {
    try {
      await chrome.debugger.sendCommand(target, `${domain}.enable`, {})
    } catch {
      // A domain a page cannot expose (Log on some targets) is not fatal.
    }
  }
  await reportActiveTab()
  return 'attached'
}

/**
 * Detach the debugger from a tab, tolerating an already-detached session.
 * @param tabId - the Chrome tab id.
 */
async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // Already detached by the browser or the user.
  }
  attachedTabs.delete(tabId)
  await reportActiveTab()
}

/**
 * Send one raw CDP command through the debugger session, attaching on demand.
 * @param tabId - the Chrome tab id to command.
 * @param method - the fully qualified CDP method.
 * @param params - the method parameters.
 * @returns `{ result }` or `{ error }`; the caller inspects which.
 */
/**
 * The tab whose screencast frames the host is currently being sent.
 *
 * One at a time on purpose: the panel shows one live view, and a second screencast
 * would double the pixel traffic into the same socket for frames nobody draws.
 */
let screencastTabId = null

/**
 * What the frame path has actually done.
 *
 * The panel can only see frames that arrive, so "the live view is black" has three
 * possible causes — Chrome sent nothing, the extension dropped it, or the host never
 * relayed it — and they are indistinguishable from the outside. These counters are
 * what tell them apart.
 */
const diagnostics = {
  screencastTabId: null,
  acksSent: 0,
  ackFailures: 0,
  lastAckError: null,
  framesReceived: 0,
  framesForwarded: 0,
  framesSkippedWrongTab: 0,
  lastForwardSocketState: null,
  lastNavigate: null,
  tabFallbacks: 0,
  lastTabFallback: null,
  lastFrameTabId: null,
  lastScreencastMethod: null,
}

/**
 * The element resolver, evaluated in the page to answer "what is under this point?".
 *
 * The in-page overlay cannot be used for this: the panel asks about a point in a
 * streamed frame, on a page the worker was not told to inject anything into, and
 * the page may not even have a content script (Chrome's own pages never do). CDP can
 * evaluate anywhere it is attached to, so this walks the DOM itself — including
 * open shadow roots, because a target the page renders inside one is still the
 * target the human pointed at.
 */
const ELEMENT_AT_SOURCE = `(function (x, y) {
  const deep = (root, px, py) => {
    let node = root.elementFromPoint(px, py)
    while (node !== null && node.shadowRoot !== null && node.shadowRoot !== undefined) {
      const inner = node.shadowRoot.elementFromPoint(px, py)
      if (inner === null || inner === node) break
      node = inner
    }
    return node
  }
  const element = deep(document, x, y)
  if (element === null) return null
  const path = []
  let cursor = element
  while (cursor !== null && cursor.nodeType === 1 && cursor !== document.documentElement) {
    const parent = cursor.parentElement
    if (parent === null) { path.unshift(cursor.tagName.toLowerCase()); break }
    const index = Array.prototype.indexOf.call(parent.children, cursor) + 1
    path.unshift(cursor.tagName.toLowerCase() + ':nth-child(' + index + ')')
    cursor = parent
  }
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const paint = ['display', 'position', 'width', 'height', 'margin', 'margin-left', 'margin-top', 'padding', 'padding-left', 'padding-top', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'text-align', 'border', 'border-radius', 'opacity', 'overflow', 'z-index', 'gap', 'flex-direction', 'justify-content', 'align-items', 'transform', 'box-shadow']
  const styles = {}
  for (const key of paint) {
    const value = style.getPropertyValue(key)
    if (value !== '' && value !== 'none' && value !== 'normal' && value !== 'auto') styles[key] = value
  }
  const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || ''
  return {
    selector: path.join(' > '),
    domPath: [document.documentElement.tagName.toLowerCase()].concat(path).join(' > '),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || '',
    accessibleName: label,
    text: (element.textContent || '').trim().slice(0, 200),
    html: element.outerHTML.slice(0, 2000),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio || 1 },
  }
})`

/**
 * Capture one rectangle of the viewport through CDP.
 *
 * `Page.captureScreenshot` with a clip needs no permission and never touches the
 * visible window, unlike `chrome.tabs.captureVisibleTab`, which refuses without
 * `<all_urls>` and captures whatever is on top. For an annotation the clip is the
 * element's own box, so this is both the more accurate route and the one that
 * cannot be broken by a permission the user never granted.
 *
 * @param tabId - the tab to capture.
 * @param rect - the clip in CSS pixels, relative to the viewport origin.
 * @returns the PNG as a data URL.
 */
async function captureRect(tabId, rect) {
  const x = Math.max(0, Math.floor(Number(rect?.x) || 0))
  const y = Math.max(0, Math.floor(Number(rect?.y) || 0))
  const width = Math.max(1, Math.ceil(Number(rect?.width) || 1))
  const height = Math.max(1, Math.ceil(Number(rect?.height) || 1))
  const shot = await sendCdp(tabId, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 },
  })
  if (shot.error) throw new Error(shot.error.message)
  const data = shot.result?.data
  if (typeof data !== 'string' || data.length === 0) throw new Error('the capture returned no image data')
  return `data:image/png;base64,${data}`
}

/**
 * The DevTools domains this extension can drive, and their headline commands.
 *
 * A tab session cannot read the protocol schema — `Schema.getDomains` is a
 * browser-target command and `chrome.debugger` only ever attaches to a tab, so
 * asking for it answers `-32601`. The index an agent navigates by therefore has to
 * be carried here. It lists the commands worth knowing when driving a page; an
 * absent command can still be sent, because `browser_cdp` is a passthrough.
 */
const CDP_INDEX = {
  Accessibility: ['enable', 'disable', 'getFullAXTree', 'getPartialAXTree', 'queryAXTree'],
  Animation: ['enable', 'disable', 'getCurrentTime', 'setPaused', 'seekAnimations'],
  Audits: ['enable', 'disable', 'getEncodedResponse'],
  BackgroundService: ['startObserving', 'stopObserving', 'setRecording'],
  Browser: ['getVersion', 'getBrowserCommandLine', 'grantPermissions', 'resetPermissions'],
  CacheStorage: ['requestCacheNames', 'requestEntries', 'deleteCache', 'deleteEntry'],
  Cast: ['enable', 'disable', 'setSinkToUse', 'startTabMirroring'],
  Console: ['enable', 'disable', 'clearMessages'],
  CSS: ['enable', 'disable', 'getComputedStyleForNode', 'getMatchedStylesForNode', 'getMediaQueries', 'setStyleTexts', 'createStyleSheet', 'addRule', 'forcePseudoState', 'getBackgroundColors'],
  Database: ['enable', 'disable', 'executeSQL', 'getDatabaseTableNames'],
  Debugger: ['enable', 'disable', 'setBreakpoint', 'removeBreakpoint', 'resume', 'pause', 'stepOver', 'stepInto', 'stepOut', 'evaluateOnCallFrame', 'getScriptSource', 'setPauseOnExceptions', 'searchInContent'],
  DeviceOrientation: ['setDeviceOrientationOverride', 'clearDeviceOrientationOverride'],
  DOM: ['enable', 'disable', 'getDocument', 'querySelector', 'querySelectorAll', 'getOuterHTML', 'setOuterHTML', 'setAttributeValue', 'removeNode', 'describeNode', 'resolveNode', 'getBoxModel', 'focus', 'requestChildNodes', 'getAttributes', 'performSearch', 'getSearchResults', 'setFileInputFiles', 'getContentQuads'],
  DOMDebugger: ['getEventListeners', 'setDOMBreakpoint', 'removeDOMBreakpoint', 'setEventListenerBreakpoint'],
  DOMSnapshot: ['enable', 'disable', 'captureSnapshot'],
  DOMStorage: ['enable', 'disable', 'getDOMStorageItems', 'setDOMStorageItem', 'removeDOMStorageItem', 'clear'],
  Emulation: ['setDeviceMetricsOverride', 'clearDeviceMetricsOverride', 'setUserAgentOverride', 'setGeolocationOverride', 'setEmulatedMedia', 'setTimezoneOverride', 'setLocaleOverride', 'setCPUThrottlingRate', 'setTouchEmulationEnabled', 'setScrollbarsHidden', 'setAutoDarkModeOverride', 'setVisionDeficiency'],
  EventBreakpoints: ['setInstrumentationBreakpoint', 'removeInstrumentationBreakpoint'],
  FedCm: ['enable', 'disable', 'selectAccount', 'clickDialogButton'],
  Fetch: ['enable', 'disable', 'failRequest', 'fulfillRequest', 'continueRequest', 'continueResponse', 'getResponseBody', 'continueWithAuth', 'takeResponseBodyAsStream'],
  HeapProfiler: ['enable', 'disable', 'takeHeapSnapshot', 'collectGarbage', 'startSampling', 'stopSampling', 'getHeapObjectId'],
  IndexedDB: ['enable', 'disable', 'requestDatabaseNames', 'requestDatabase', 'requestData', 'clearObjectStore', 'deleteDatabase'],
  Input: ['dispatchKeyEvent', 'dispatchMouseEvent', 'dispatchTouchEvent', 'insertText', 'dispatchDragEvent', 'synthesizeScrollGesture', 'synthesizePinchGesture', 'setIgnoreInputEvents'],
  Inspector: ['enable', 'disable'],
  LayerTree: ['enable', 'disable', 'compositingReasons', 'makeSnapshot', 'profileSnapshot', 'snapshotCommandLog'],
  Log: ['enable', 'disable', 'clear', 'startViolationsReport', 'stopViolationsReport'],
  Media: ['enable', 'disable', 'playerPropertiesChanged', 'playerEventsAdded'],
  Memory: ['getDOMCounters', 'prepareForLeakDetection', 'forciblyPurgeJavaScriptMemory', 'setPressureNotificationsSuppressed', 'simulatePressureNotification', 'startSampling', 'stopSampling', 'getAllTimeSamplingProfile', 'getBrowserSamplingProfile', 'getSamplingProfile'],
  Network: ['enable', 'disable', 'setUserAgentOverride', 'setExtraHTTPHeaders', 'getResponseBody', 'setBlockedURLs', 'emulateNetworkConditions', 'setCacheDisabled', 'clearBrowserCache', 'clearBrowserCookies', 'getAllCookies', 'setCookie', 'deleteCookies', 'setRequestInterception', 'continueInterceptedRequest', 'getCertificate', 'setBypassServiceWorker', 'streamResourceContent', 'takeResponseBodyForInterceptionAsStream', 'loadNetworkResource'],
  Overlay: ['enable', 'disable', 'highlightNode', 'highlightRect', 'highlightQuad', 'highlightFrame', 'setInspectMode', 'setShowFlexOverlays', 'setShowGridOverlays', 'setShowScrollBottleneckRects', 'setShowHitTestBorders', 'setShowLayoutShiftRegions', 'setShowAdHighlights', 'setShowPaintRects', 'getHighlightObjectForTest'],
  Page: ['enable', 'disable', 'navigate', 'reload', 'getNavigationHistory', 'navigateToHistoryEntry', 'captureScreenshot', 'captureSnapshot', 'printToPDF', 'startScreencast', 'stopScreencast', 'screencastFrameAck', 'getLayoutMetrics', 'getFrameTree', 'createIsolatedWorld', 'addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument', 'setBypassCSP', 'setDocumentContent', 'setDeviceMetricsOverride', 'setLifecycleEventsEnabled', 'bringToFront', 'setInterceptFileChooserDialog', 'generateTestReport', 'getAppManifest', 'getInstallabilityErrors', 'getPermissionsPolicyState', 'getResourceContent', 'searchInResource', 'resetNavigationHistory', 'crash', 'close'],
  Performance: ['enable', 'disable', 'setTimeDomain', 'getMetrics'],
  PerformanceTimeline: ['enable', 'disable'],
  Preload: ['enable', 'disable'],
  Profiler: ['enable', 'disable', 'setSamplingInterval', 'start', 'stop', 'startPreciseCoverage', 'stopPreciseCoverage', 'takePreciseCoverage', 'getBestEffortCoverage'],
  Runtime: ['enable', 'disable', 'evaluate', 'awaitPromise', 'callFunctionOn', 'getProperties', 'getIsolateId', 'compileScript', 'runScript', 'getHeapUsage', 'releaseObject', 'releaseObjectGroup', 'discardConsoleEntries', 'setCustomObjectFormatterEnabled', 'globalLexicalScopeNames', 'queryObjects', 'setAsyncCallStackDepth'],
  Schema: ['getDomains'],
  Security: ['enable', 'disable', 'setIgnoreCertificateErrors', 'handleCertificateError', 'setOverrideCertificateErrors'],
  ServiceWorker: ['enable', 'disable', 'unregister', 'updateRegistration', 'startWorker', 'stopWorker', 'deliverPushMessage', 'dispatchSyncEvent', 'setForceUpdateOnPageLoad', 'skipWaiting', 'dispatchPeriodicSyncEvent'],
  Storage: ['getUsageAndQuota', 'overrideQuotaForOrigin', 'clearDataForOrigin', 'clearDataForStorageKey', 'getTrustTokens', 'clearTrustTokens', 'setCookies', 'getCookies', 'clearCookies', 'setInterestGroupAccess', 'getInterestGroupDetails'],
  SystemInfo: ['getInfo', 'getProcessInfo', 'getFeatureState'],
  Target: ['getTargets', 'attachToTarget', 'attachToBrowserTarget', 'detachFromTarget', 'createTarget', 'closeTarget', 'activateTarget', 'setDiscoverTargets', 'setAutoAttach', 'getTargetInfo', 'exposeDevToolsProtocol', 'setRemoteLocations'],
  Tethering: ['bind', 'unbind'],
  Tracing: ['start', 'end', 'getCategories', 'requestMemoryDump', 'recordClockSyncMarker', 'getCoverageReport'],
  WebAudio: ['enable', 'disable', 'getRealtimeData'],
  WebAuthn: ['enable', 'disable', 'addVirtualAuthenticator', 'removeVirtualAuthenticator', 'addCredential', 'getCredentials', 'clearCredentials', 'setUserVerified'],
}

/**
 * Turn the curated index plus the live target list into the tool's answer.
 * @param params - the request's `domain` and `search` filters.
 * @param targetInfos - the live list from `Target.getTargets`.
 * @returns the summary text.
 */
function describeProtocolIndex(params, liveTargets) {
  const wanted = params?.domain === undefined ? null : String(params.domain).toLowerCase()
  const search = params?.search === undefined ? null : String(params.search).toLowerCase()
  const lines = []
  let count = 0
  for (const [domain, commands] of Object.entries(CDP_INDEX)) {
    if (wanted !== null && domain.toLowerCase() !== wanted) continue
    const matching =
      search === null ? commands : commands.filter(command => command.toLowerCase().includes(search))
    if (matching.length === 0) continue
    lines.push(domain)
    for (const command of matching) {
      lines.push(`  ${domain}.${command}`)
      count += 1
    }
  }
  const live = liveTargets
    .slice(0, 12)
    .map(target => `  ${target.active ? '* ' : '  '}${target.type} ${target.id} ${target.url || '(no url)'}`)
  const header =
    lines.length === 0
      ? "No matching protocol commands were found in this extension's index."
      : `Chrome DevTools Protocol commands this extension can send (${count} listed). This is a navigation aid, not a whitelist: every command the DevTools client can send is passed through, including ones absent here.`
  // The live part goes first. The command index runs to hundreds of lines, so a
  // reader — or a truncating tool result — that only sees the top would never reach
  // the targets, which are the one part of this answer that is read from the browser
  // rather than carried in the extension.
  return {
    summary: [
      'Live targets in this browser:',
      ...(live.length === 0 ? ['  (none reported)'] : live),
      '',
      header,
      ...lines,
      '',
      `Enabled at connect time: ${AUTO_ENABLED_DOMAINS.join(', ')}. Call "<Domain>.enable" for any other domain before using it.`,
    ].join('\n'),
  }
}

/**
 * Ask the page what element sits under a viewport point.
 * @param tabId - the tab to ask.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @returns the element description, or null when the point is empty.
 */
async function resolveElementAtPoint(tabId, x, y) {
  const answer = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `${ELEMENT_AT_SOURCE}(${Number(x)}, ${Number(y)})`,
    returnByValue: true,
  })
  if (answer.error) throw new Error(answer.error.message)
  const value = answer.result?.result?.value
  return value === undefined ? null : value
}

/**
 * Start or stop the live-view screencast, and keep its frame acknowledgements.
 *
 * `Page.startScreencast` sends one frame at a time and waits for
 * `Page.screencastFrameAck` before sending the next — an unacknowledged frame
 * stalls the stream, so the ack is what keeps the view alive rather than a nicety.
 *
 * @param tabId - the tab to stream.
 * @param options - `running` (default true) and optional frame limits.
 * @returns the resulting state.
 */
async function setScreencast(tabId, options = {}) {
  const running = options.running !== false
  // The running tab is recorded as each branch decides it, not up front: a start that
  // fails must leave the diagnostics pointing at whatever is still streaming.
  if (running) {
    // Asking to stream the tab that is already streaming is not an error and not a
    // restart: the panel re-asks whenever its own state changes, and tearing the stream
    // down to rebuild it identically is what makes the view flicker.
    if (screencastTabId === tabId) return { running: true, tabId }
    // The new stream is started before the old one is stopped, so a tab that cannot be
    // streamed — one another debugger already holds, say — leaves the working view
    // alone instead of replacing a live page with an error.
    const result = await sendCdp(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: Math.min(100, Math.max(1, Number(options.quality) || 70)),
      maxWidth: Number(options.maxWidth) || 1280,
      maxHeight: Number(options.maxHeight) || 900,
      everyNthFrame: 1,
    })
    if (result.error) {
      send({ kind: 'screencast/state', running: screencastTabId !== null, tabId: screencastTabId, reason: result.error.message })
      throw new Error(`the screencast could not start: ${result.error.message}`)
    }
    const previous = screencastTabId
    screencastTabId = tabId
    diagnostics.screencastTabId = tabId
    if (previous !== null && previous !== tabId) {
      // Stopped only now that the replacement is confirmed running.
      await sendCdp(previous, 'Page.stopScreencast', {}).catch(() => undefined)
    }
    send({ kind: 'screencast/state', running: true, tabId })
    return { running: true, tabId }
  }
  await sendCdp(tabId, 'Page.stopScreencast', {})
  if (screencastTabId === tabId) screencastTabId = null
  diagnostics.screencastTabId = screencastTabId
  send({ kind: 'screencast/state', running: false, tabId })
  return { running: false, tabId }
}

/**
 * Send one CDP input event to a tab.
 *
 * Input is dispatched through CDP rather than synthesised in the page, so the
 * events the page receives are trusted ones — the difference between an app that
 * responds to a click and an app that ignores it.
 *
 * @param tabId - the tab to drive.
 * @param kind - `mouse`, `key`, `wheel`, or `text`.
 * @param event - the event fields, in CSS pixels.
 * @returns the CDP result.
 */
async function dispatchInput(tabId, kind, event = {}) {
  const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  if (kind === 'mouse') {
    const type = String(event.type ?? 'mousePressed')
    const params = {
      type,
      x: number(event.x),
      y: number(event.y),
      button: String(event.button ?? 'left'),
      buttons: number(event.buttons),
      clickCount: type === 'mouseMoved' ? 0 : Math.max(1, number(event.clickCount) || 1),
      modifiers: number(event.modifiers),
    }
    const result = await sendCdp(tabId, 'Input.dispatchMouseEvent', params)
    if (result.error) throw new Error(result.error.message)
    return { ok: true }
  }
  if (kind === 'wheel') {
    const result = await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: number(event.x),
      y: number(event.y),
      deltaX: number(event.deltaX),
      deltaY: number(event.deltaY),
      modifiers: number(event.modifiers),
    })
    if (result.error) throw new Error(result.error.message)
    return { ok: true }
  }
  if (kind === 'text') {
    const result = await sendCdp(tabId, 'Input.insertText', { text: String(event.text ?? '') })
    if (result.error) throw new Error(result.error.message)
    return { ok: true }
  }
  if (kind === 'key') {
    const params = {
      type: String(event.type ?? 'keyDown'),
      key: String(event.key ?? ''),
      code: String(event.code ?? ''),
      windowsVirtualKeyCode: number(event.keyCode),
      nativeVirtualKeyCode: number(event.keyCode),
      modifiers: number(event.modifiers),
      text: typeof event.text === 'string' ? event.text : undefined,
    }
    const result = await sendCdp(tabId, 'Input.dispatchKeyEvent', params)
    if (result.error) throw new Error(result.error.message)
    return { ok: true }
  }
  throw new Error(`unknown input kind "${String(kind)}"`)
}

async function sendCdp(tabId, method, params) {
  try {
    if (!attachedTabs.has(tabId)) await attach(tabId)
    const result = await chrome.debugger.sendCommand({ tabId }, method, params ?? {})
    return { result: result ?? null }
  } catch (error) {
    return { error: { message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Crop a data URL to a rectangle in CSS pixels, scaled by the capture's device
 * pixel ratio. Used to turn a viewport screenshot into an element screenshot.
 * @param dataUrl - the full viewport capture.
 * @param rect - the element rectangle in CSS pixels.
 * @param scale - device pixels per CSS pixel.
 * @returns the cropped image as a data URL.
 */
async function cropDataUrl(dataUrl, rect, scale) {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const sx = Math.max(0, Math.round(rect.x * scale))
  const sy = Math.max(0, Math.round(rect.y * scale))
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scale)))
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scale)))
  const canvas = new OffscreenCanvas(sw, sh)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()
  const cropped = await canvas.convertToBlob({ type: 'image/png' })
  const buffer = await cropped.arrayBuffer()
  return `data:image/png;base64,${bytesToBase64(new Uint8Array(buffer))}`
}

/**
 * Base64-encode bytes without a Node Buffer.
 * @param bytes - the raw bytes.
 * @returns the base64 string.
 */
function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/**
 * Whether a tab's URL can be driven at all. Chrome forbids extensions from
 * touching its own pages, the Web Store, and other extensions' pages.
 * @param url - the tab URL.
 * @returns true when the URL is a drivable http(s) page.
 */
function isDrivable(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

/**
 * Capture the visible area of a tab, optionally cropped to an element.
 * @param options - `selector` crops to a CSS selector or `@ref`, `fullPage`
 *   uses CDP for the whole scrollable page.
 * @returns the capture result, including one or more data URLs.
 */
async function capture(options = {}) {
  const tab = await resolveTab(options.tabId)
  if (tab.id === undefined) throw new Error('the target tab has no id')
  if (!isDrivable(tab.url) && options.fullPage !== true) {
    throw new Error(`Chrome does not allow extensions to capture ${tab.url || 'this page'}`)
  }

  if (options.fullPage === true) {
    const { result, error } = await sendCdp(tab.id, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    if (error) throw new Error(error.message)
    const metrics = await sendCdp(tab.id, 'Page.getLayoutMetrics', {})
    const css = metrics.result?.cssContentSize ?? null
    return {
      dataUrls: [`data:image/png;base64,${result.data}`],
      url: tab.url ?? '',
      title: tab.title ?? '',
      fullPage: true,
      viewport: css ? { width: Math.round(css.width), height: Math.round(css.height) } : null,
    }
  }

  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  if (options.selector === undefined || options.selector === '') {
    return {
      dataUrls: [shot],
      dataUrl: shot,
      url: tab.url ?? '',
      title: tab.title ?? '',
      viewport: null,
    }
  }

  // Resolve the crop rectangle in the page, then crop the capture to it.
  const geometry = await sendToContent(tab.id, { type: 'geometry', selector: options.selector })
  if (geometry?.rect === undefined) throw new Error(`could not locate "${options.selector}" in the page`)
  const scale = geometry.devicePixelRatio || 1
  const cropped = await cropDataUrl(shot, geometry.rect, scale)
  return {
    dataUrls: [cropped],
    dataUrl: cropped,
    url: tab.url ?? '',
    title: tab.title ?? '',
    selector: options.selector,
    rect: geometry.rect,
    viewport: geometry.viewport ?? null,
  }
}

/**
 * Message one tab's content script, tolerating a missing overlay.
 * @param tabId - the Chrome tab id.
 * @param message - the message to deliver.
 * @returns the content script's reply, or null when no overlay is present.
 */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    return null
  }
}

/**
 * Ensure the overlay exists in a tab, injecting it when the content script is
 * missing (a tab that was already open when the extension loaded).
 * @param tabId - the Chrome tab id.
 * @param mode - the annotation mode to arm.
 * @returns the content script's acknowledgement.
 */
async function ensureOverlay(tabId, mode) {
  const reply = await sendToContent(tabId, { type: 'mode', mode })
  if (reply !== null) return reply
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
  return sendToContent(tabId, { type: 'mode', mode })
}

/**
 * Send one annotation to the host, with its cropped screenshot when one can be
 * taken.
 *
 * The crop is anchored on the element's own selector rather than the click
 * coordinate, so the image is exactly the element the note is about even if the
 * page reflows between the gesture and the capture.
 *
 * A capture can legitimately fail: Chrome refuses `captureVisibleTab` on some
 * pages, the window may be minimised, or the tab may have navigated away. None of
 * those is a reason to drop the annotation, so the text goes regardless and the
 * failure is logged where the sidebar can show it.
 *
 * @param annotation - the record the content script captured.
 * @param selector - the annotated element's selector, when the page reported one.
 */
async function annotateWithScreenshot(annotation, selector) {
  let screenshot = null
  try {
    const shot = await capture({
      tabId: annotation.tabId,
      selector: typeof selector === 'string' && selector !== '' ? selector : undefined,
    })
    screenshot = shot.dataUrl ?? shot.dataUrls?.[0] ?? null
  } catch (error) {
    log('warn', `annotation saved without a screenshot: ${error instanceof Error ? error.message : String(error)}`)
  }
  const complete = screenshot === null ? annotation : { ...annotation, screenshot }
  send({ kind: 'annotation', annotation: complete })
}

/**  
 * The host → extension method table. Each entry answers the host's `call`.
 * @param method - the method name.
 * @param params - the call parameters.
 * @returns the result payload the host receives.
 */
async function dispatch(method, params) {
  switch (method) {
    case 'annotate.mode': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      const mode = String(params?.mode ?? 'quick')
      tabModes.set(tab.id, mode)
      if (!isDrivable(tab.url)) throw new Error(`annotation is not available on ${tab.url || 'this page'}`)
      const reply = await ensureOverlay(tab.id, mode)
      await reportActiveTab()
      return { mode, tab: { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' }, overlay: reply ?? null }
    }
    case 'screenshot':
      return capture(params ?? {})
    case 'snapshot': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      const reply = await ensureOverlay(tab.id, tabModes.get(tab.id) ?? 'off')
      const snapshot = await sendToContent(tab.id, {
        type: 'snapshot',
        includeText: params?.includeText !== false,
        maxElements: params?.maxElements ?? 120,
        maxText: params?.maxText ?? 8000,
      })
      if (snapshot === null) throw new Error('the page overlay is not available, so the page cannot be read')
      return { ...snapshot, url: tab.url ?? '', title: tab.title ?? '' }
    }
    case 'readPage': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      await ensureOverlay(tab.id, tabModes.get(tab.id) ?? 'off')
      const content = await sendToContent(tab.id, {
        type: 'readPage',
        format: params?.format ?? 'markdown',
        maxChars: params?.maxChars ?? 40000,
      })
      if (content === null) throw new Error('the page overlay is not available, so the page cannot be read')
      return { ...content, url: tab.url ?? '', title: tab.title ?? '' }
    }
    case 'click':
    case 'type':
    case 'scroll':
    case 'get':
    case 'wait': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      await ensureOverlay(tab.id, tabModes.get(tab.id) ?? 'off')
      const result = await sendToContent(tab.id, { type: method, ...params })
      if (result === null) throw new Error('the page overlay is not available, so the page cannot be driven')
      if (result.error) throw new Error(result.error)
      return result
    }
    case 'cdp': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      return sendCdp(tab.id, String(params?.method ?? ''), params?.params)
    }
    case 'newTab': {
      // A browser needs a way to start a page that is not there yet. `chrome.tabs.create`
      // opens it in the window the panel is already looking at, so the tab strip grows
      // where the human can see it.
      const url = typeof params?.url === 'string' && params.url !== '' ? params.url : 'about:blank'
      const created = await chrome.tabs.create({ url, active: true })
      await reportTabs()
      return { ok: true, tab: { id: created?.id ?? null, url: created?.url ?? url, title: created?.title ?? '' } }
    }
    case 'closeTab': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the tab to close has no id')
      await chrome.tabs.remove(tab.id)
      await reportTabs()
      return { ok: true }
    }
    case 'listTabs': {
      const tabs = await chrome.tabs.query({})
      return {
        ok: true,
        tabs: tabs
          .filter(tab => typeof tab.id === 'number')
          .map(tab => ({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '', active: tab.active === true })),
      }
    }
    case 'activate': {
      // The page is in the sidebar, but the browser around it is a real window and this
      // is what brings it forward. `chrome.windows.update` takes a window id, and
      // `chrome.tabs.update` takes the tab id, so the tab is read first for its window.
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      if (typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true })
      const focused = await chrome.tabs.update(tab.id, { active: true })
      return { ok: true, tab: { id: focused?.id ?? tab.id, url: focused?.url ?? tab.url ?? '', title: focused?.title ?? tab.title ?? '' } }
    }
    case 'screencast': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      return setScreencast(tab.id, params ?? {})
    }
    case 'input': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      return dispatchInput(tab.id, String(params?.kind ?? 'mouse'), params?.event ?? {})
    }
    case 'navigate': {
      // Driving the browser's own navigation state, rather than asking a page to
      // change its location: history and reload have to be the tab's, or the live
      // view drifts out of step with what the browser thinks it is showing.
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      const action = String(params?.action ?? 'navigate')
      if (action === 'navigate') {
        const url = String(params?.url ?? '')
        if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs can be navigated to')
        // Recorded, not assumed: a navigation that is accepted and then does not
        // happen leaves no other trace, and the answer the panel gets is `ok`.
        const answer = await sendCdp(tab.id, 'Page.navigate', { url })
        diagnostics.lastNavigate = { tabId: tab.id, url, answer }
      } else if (action === 'back') {
        await sendCdp(tab.id, 'Runtime.evaluate', { expression: 'history.back()' })
      } else if (action === 'forward') {
        await sendCdp(tab.id, 'Runtime.evaluate', { expression: 'history.forward()' })
      } else {
        await sendCdp(tab.id, 'Page.reload', {})
      }
      return { ok: true, action }
    }
    case 'captureRect': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      return { dataUrl: await captureRect(tab.id, params?.rect) }
    }
    case 'elementAt': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      const element = await resolveElementAtPoint(tab.id, params?.x, params?.y)
      return { element }
    }
    case 'cdp.domains': {
      // `Schema.getDomains` is the browser's own protocol index.
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      if (!attachedTabs.has(tab.id)) await attach(tab.id)
      const schema = await sendCdp(tab.id, 'Schema.getDomains', {})
      if (schema.error) {
        // Every real Chrome lands here. `Schema.getDomains` is a browser-target command
        // and `chrome.debugger` attaches only to a tab, so the schema is unreachable;
        // `Target.getTargets` is refused the same way. The curated index answers
        // instead, and the live half comes from the extension's own view of the
        // browser — which is the only place that is allowed to see every tab.
        const open = await chrome.tabs.query({})
        return describeProtocolIndex(
          params,
          open.filter(entry => isDrivable(entry.url)).map(entry => ({
            type: 'page',
            id: entry.id,
            active: entry.active === true,
            url: entry.url ?? '',
          })),
        )
      }
      const domains = schema.result?.domains ?? []
      const wanted = params?.domain === undefined ? null : String(params.domain).toLowerCase()
      const search = params?.search === undefined ? null : String(params.search).toLowerCase()
      const lines = []
      for (const domain of domains) {
        if (wanted !== null && String(domain.name).toLowerCase() !== wanted) continue
        const commands = domain.commands ?? []
        const matching =
          search === null
            ? commands
            : commands.filter(command => `${command.name} ${command.description ?? ''}`.toLowerCase().includes(search))
        if (matching.length === 0) continue
        lines.push(`${domain.name}${domain.experimental ? ' (experimental)' : ''}`)
        for (const command of matching.slice(0, 80)) {
          const required = (command.parameters ?? []).filter(parameter => parameter.optional !== true)
          const summary = required.length === 0 ? '' : ` (${required.map(parameter => parameter.name).join(', ')})`
          lines.push(`  ${domain.name}.${command.name}${summary}`)
        }
      }
      return {
        summary:
          lines.length === 0
            ? 'No matching protocol commands were found.'
            : `Chrome DevTools Protocol commands (${lines.length} lines):\n${lines.join('\n')}`,
      }
    }
    case 'console': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      const entries = logBuffers.get(tab.id) ?? []
      if (params?.clear === true) logBuffers.set(tab.id, [])
      const level = String(params?.level ?? 'all')
      const filtered = entries.filter(entry => {
        if (level === 'error') return entry.level === 'error'
        if (level === 'warning') return entry.level === 'warning' || entry.level === 'warn'
        return true
      })
      return { entries: filtered.slice(-(params?.limit ?? 100)) }
    }
    case 'network': {
      const tab = await resolveTab(params?.tabId)
      if (tab.id === undefined) throw new Error('the target tab has no id')
      const entries = networkBuffers.get(tab.id) ?? []
      if (params?.clear === true) networkBuffers.set(tab.id, [])
      const filter = params?.filter === undefined ? null : String(params.filter)
      const filtered = entries.filter(entry => {
        if (filter !== null && !String(entry.url).includes(filter)) return false
        if (params?.failedOnly === true) return entry.failure !== undefined || (entry.status ?? 0) >= 400
        return true
      })
      return { entries: filtered.slice(-(params?.limit ?? 50)) }
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({})
      return {
        tabs: tabs
          .filter(tab => isDrivable(tab.url))
          .map(tab => ({
            id: tab.id,
            url: tab.url ?? '',
            title: tab.title ?? '',
            active: tab.active === true,
            mode: tabModes.get(tab.id) ?? 'off',
          })),
      }
    }
    default:
      throw new Error(`unknown method "${method}"`)
  }
}

/**
 * Wait for a tab to finish loading after a navigation.
 * @param tabId - the Chrome tab id.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the settled tab, or null on timeout.
 */
function waitForTabSettle(tabId, timeoutMs = 20000) {
  return new Promise(resolve => {
    let settled = false
    const finish = async () => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      try {
        resolve(await chrome.tabs.get(tabId))
      } catch {
        resolve(null)
      }
    }
    const listener = (changedId, info) => {
      if (changedId === tabId && info.status === 'complete') finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/**
 * Route one host → extension frame.
 * @param raw - the raw text frame.
 */
async function handleHostMessage(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object' || message.kind !== 'call') return
  try {
    const result = await dispatch(message.method, message.params)
    send({ kind: 'reply', id: message.id, result })
  } catch (error) {
    send({ kind: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
}

// ── content-script messages ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only this extension's own frames are accepted; no external messaging hook.
  if (message === null || typeof message !== 'object') return false
  if (message.type === 'armMode') {
    // The popup runs in an extension page with no `sender.tab`, so it names its
    // target explicitly.
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id
    if (tabId === undefined) {
      respond({ ok: false, error: 'no active tab' })
      return false
    }
    dispatch('annotate.mode', { tabId, mode: message.mode })
      .then(result => respond({ ok: true, result }))
      .catch(error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }
  const tabId = sender.tab?.id
  if (message.type === 'annotation') {
    if (tabId === undefined) {
      respond({ ok: true })
      return false
    }
    const annotation = { ...message.annotation, tabId }
    // The page sends the note first and the pixels second, so a capture that is
    // slow, refused, or impossible can never cost the human their comment. The
    // screenshot is the whole point of an annotation though — "this button is 4px
    // too far left" is a visual claim — so it is attempted every time, and its
    // absence is reported rather than silently accepted.
    respond({ ok: true })
    annotateWithScreenshot(annotation, message.annotation?.element?.selector)
    return false
  }
  if (message.type === 'modeChanged' && tabId !== undefined) {
    tabModes.set(tabId, message.mode)
    reportActiveTab()
    respond({ ok: true })
    return false
  }
  if (message.type === 'console' && tabId !== undefined) {
    const buffer = logBuffers.get(tabId) ?? []
    buffer.push({ level: message.level, text: message.text, url: message.url, line: message.line })
    logBuffers.set(tabId, buffer.slice(-MAX_LOG_ENTRIES))
    respond({ ok: true })
    return false
  }
  if (message.type === 'requestDone' && tabId !== undefined) {
    const buffer = networkBuffers.get(tabId) ?? []
    buffer.push(message.entry)
    networkBuffers.set(tabId, buffer.slice(-MAX_NETWORK_ENTRIES))
    respond({ ok: true })
    return false
  }
  if (message.type === 'capture' && tabId !== undefined) {
    capture({ tabId, selector: message.selector })
      .then(result => respond({ ok: true, dataUrl: result.dataUrl }))
      .catch(error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }
  if (message.type === 'attach') {
    if (tabId !== undefined) attach(tabId).catch(() => {})
    respond({ ok: true })
    return false
  }
  return false
})

// ── the right-click path ───────────────────────────────────────────────────

/**
 * Create the annotation entry in the page's context menu.
 *
 * This is the shortest gesture the extension offers, and the one the human is
 * most likely to reach for: right-click the thing that is wrong, choose
 * "Annotate this element", type, done. `contexts: ['all']` rather than
 * `['page']` so the entry is also there when the click lands on a link, an
 * image, or a text selection — those are exactly the elements a human annotates.
 *
 * `chrome.contextMenus` rejects a duplicate id, and `onInstalled` is not
 * guaranteed to be the only caller (a service worker restart re-runs this file),
 * so the stale entry is removed first. `removeAll` with no callback resolves to
 * undefined on older builds, and a rejected promise there is not a real failure.
 */
function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    // `lastError` is read so an absent menu does not surface as an unchecked
    // runtime error; there is nothing to recover from either way.
    void chrome.runtime.lastError
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Annotate this element',
      contexts: ['all'],
    })
  })
}

chrome.runtime.onInstalled.addListener(() => {
  installContextMenu()
})
chrome.runtime.onStartup.addListener(() => {
  installContextMenu()
})
// A service worker that was stopped and restarted also needs its menu back.
installContextMenu()

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return
  if (tab?.id === undefined) return
  if (!isDrivable(tab.url)) {
    log('warn', `annotation is not available on ${tab.url || 'this page'}`)
    return
  }
  const tabId = tab.id
  // The mode is armed first so the overlay reports `quick` to the host, then the
  // click point is handed to the page, which resolves the exact element under it
  // and opens the composer. Doing it in this order means a composer that fails to
  // appear still leaves the tab annotating rather than silently doing nothing.
  ;(async () => {
    try {
      tabModes.set(tabId, 'quick')
      await ensureOverlay(tabId, 'quick')
      const opened = await sendToContent(tabId, {
        type: 'composeAt',
        x: info.pageX ?? 0,
        y: info.pageY ?? 0,
      })
      if (opened === null || opened?.opened !== true) {
        // No element under the click (or no overlay): fall back to the mode, which
        // is still useful, and say so rather than failing silently.
        log('info', 'right-click did not land on an element; annotation mode is armed, point at an element to annotate it')
      }
      reportActiveTab()
    } catch (error) {
      log('error', `right-click annotate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
})

// ── lifecycle ──────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(() => {
  reportActiveTab()
  reportTabs()
})
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url !== undefined) {
    // A navigation discards the page's overlay and its buffers.
    logBuffers.delete(tabId)
    networkBuffers.delete(tabId)
  }
  reportActiveTab()
  reportTabs()
})
chrome.tabs.onCreated.addListener(() => {
  reportTabs()
})
chrome.tabs.onRemoved.addListener(tabId => {
  logBuffers.delete(tabId)
  networkBuffers.delete(tabId)
  tabModes.delete(tabId)
  attachedTabs.delete(tabId)
  reportTabs()
})
// The live view's frame pump. Each frame is forwarded to the host and immediately
// acknowledged; without the ack Chrome sends exactly one frame and stops.
chrome.debugger.onEvent.addListener((source, method, params) => {
  // Every screencast-related event is counted, not just the frames that are
  // forwarded: "Chrome sent nothing" and "the extension dropped it" look identical
  // from the panel, and they have completely different causes.
  if (method === 'Page.screencastFrame') diagnostics.framesReceived += 1
  if (method.startsWith('Page.screencast')) diagnostics.lastScreencastMethod = method
  if (method !== 'Page.screencastFrame') return
  const tabId = source.tabId
  diagnostics.lastFrameTabId = tabId === undefined ? null : tabId
  if (tabId === undefined || tabId !== screencastTabId) {
    diagnostics.framesSkippedWrongTab += 1
    return
  }
  diagnostics.framesForwarded += 1
  diagnostics.lastForwardSocketState = socket === null ? 'no socket' : socket.readyState
  send({
    kind: 'frame',
    tabId,
    data: params?.data ?? '',
    metadata: params?.metadata ?? null,
  })
  chrome.debugger
    .sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId: params?.sessionId })
    .then(() => {
      diagnostics.acksSent += 1
    })
    .catch(error => {
      // A frame that cannot be acknowledged means the stream is already gone; the
      // stop path, not this one, is what resets the state. It is counted anyway,
      // because a stream that stalls after one frame is exactly what a failing ack
      // looks like from the outside.
      diagnostics.ackFailures += 1
      diagnostics.lastAckError = error instanceof Error ? error.message : String(error)
    })
})
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId)
    reportActiveTab()
  }
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || changes.host === undefined) return
  loadHost().then(() => {
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    connect()
  })
})

// Bring the bridge up as soon as the worker starts.
loadHost()
  .then(() => connect())
  .catch(() => connect())

// Exposed for the test harness: the frame path's own account of what it received.
globalThis.__screencastDiagnostics = diagnostics
