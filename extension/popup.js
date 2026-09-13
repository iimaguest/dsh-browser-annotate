// Browser Annotate — toolbar popup.
//
// The popup is the human's control surface, not the agent's: it shows whether
// the bridge is reachable, which tab commands will land on, and the two buttons
// that arm annotation mode. Everything it does goes through the service worker,
// which owns the socket and the debugger session.

const DEFAULT_HOST = 'http://127.0.0.1:3080'

const dot = document.getElementById('dot')
const status = document.getElementById('status')
const tabLabel = document.getElementById('tab')
const hostInput = document.getElementById('host')
const warn = document.getElementById('warn')
const quickButton = document.getElementById('quick')
const inspectButton = document.getElementById('inspect')
const stopButton = document.getElementById('stop')

/** The tab the popup is acting on. */
let currentTab = null
/** Whether the host bridge answered its health probe. */
let bridgeOk = false

/**
 * Normalize a typed address into an origin.
 * @param value - the raw input.
 * @returns an `http(s)://host:port` origin.
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

/**
 * Translate one failed operation into the next action the human should take.
 * @param message - the service worker's error text.
 * @returns the guidance string.
 */
function explain(message) {
  if (/Cannot access|chrome:\/\//i.test(message)) {
    return 'Chrome blocks extensions on its own pages and the Web Store. Open the web app you want to annotate and try again.'
  }
  if (/no active tab/i.test(message)) {
    return 'Focus the browser window that shows your app, then reopen this popup.'
  }
  if (/Cannot attach|Another debugger|DevTools/i.test(message)) {
    return 'Close the DevTools window for this tab and try again — a tab can have only one debugger client.'
  }
  return message
}

/**
 * Show a warning banner.
 * @param message - the text, or an empty string to hide the banner.
 */
function setWarning(message) {
  warn.textContent = message
  warn.style.display = message === '' ? 'none' : 'block'
}

/**
 * Render the connection and tab state.
 */
function render() {
  dot.classList.toggle('on', bridgeOk)
  status.textContent = bridgeOk ? 'Connected to DeepSeek Harness' : 'Cannot reach DeepSeek Harness'
  if (currentTab === null) {
    tabLabel.textContent = 'No active tab.'
    quickButton.disabled = true
    inspectButton.disabled = true
    stopButton.disabled = true
    return
  }
  tabLabel.textContent = `${currentTab.title || '(untitled)'}\n${currentTab.url || ''}`
  const drivable = /^https?:\/\//i.test(currentTab.url ?? '')
  quickButton.disabled = !drivable
  inspectButton.disabled = !drivable
  stopButton.disabled = !drivable
  if (!drivable) setWarning('This page cannot be annotated — Chrome does not allow extensions to modify it.')
}

/**
 * Ask the bridge whether it is listening.
 */
async function probeBridge() {
  const host = normalizeHost(hostInput.value)
  try {
    const response = await fetch(`${host}/browser-annotate/health`, { cache: 'no-store' })
    bridgeOk = response.ok
  } catch {
    bridgeOk = false
  }
  render()
}

/**
 * Arm one annotation mode in the active tab.
 * @param mode - `quick` or `inspect`.
 */
async function setMode(mode) {
  if (currentTab?.id === undefined) return
  setWarning('')
  try {
    const response = await chrome.runtime.sendMessage({ type: 'armMode', mode, tabId: currentTab.id })
    if (response?.ok !== true) setWarning(explain(response?.error ?? 'the overlay could not be armed'))
  } catch (error) {
    setWarning(explain(error instanceof Error ? error.message : String(error)))
  }
  window.close()
}

quickButton.addEventListener('click', () => setMode('quick'))
inspectButton.addEventListener('click', () => setMode('inspect'))
stopButton.addEventListener('click', () => setMode('off'))

hostInput.addEventListener('change', async () => {
  const host = normalizeHost(hostInput.value)
  hostInput.value = host
  await chrome.storage.local.set({ host })
  await probeBridge()
})

/**
 * Load the stored address and the active tab, then probe the bridge.
 */
async function init() {
  const stored = await chrome.storage.local.get({ host: DEFAULT_HOST })
  hostInput.value = normalizeHost(stored.host)
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  currentTab = tab ?? null
  render()
  await probeBridge()
}

init()
