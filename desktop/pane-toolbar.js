// The toolbar that belongs to one pane: a tab strip, and an address row.
//
// It draws what the engine reports and sends back what the human asks for. It keeps no
// state of its own beyond the text being typed, because a toolbar that remembered a URL
// would show the old one for the length of a redirect, which is exactly when someone is
// looking at it.
//
// The strip stays hidden while a pane has a single tab. A permanently visible one-tab
// strip is chrome that says nothing, and a pane whose job is to show one page should spend
// its height on the page.

const strip = document.getElementById('strip')
const address = document.getElementById('address')
const security = document.getElementById('security')
const zoom = document.getElementById('zoom')
const back = document.getElementById('back')
const forward = document.getElementById('forward')
const reload = document.getElementById('reload')
const menu = document.getElementById('menu')
const quick = document.getElementById('quick')
const inspect = document.getElementById('inspect')
const queueButton = document.getElementById('queue')
const count = document.getElementById('count')
const progress = document.getElementById('progress')
/** The panel that lists what is waiting to be sent into the conversation. */
const queuePanel = document.getElementById('queue-panel')
const bar = document.getElementById('bar')

const paneId = new URLSearchParams(location.search).get('pane') ?? 'right'
const bar_ = window.browserBar

let editing = false
let loading = false
let tabCount = 1
/** Whether this pane shows a strip at all. DSH's own pane is one page and is not a place to
    open others, so it has no strip and no + button. */
let stripAllowed = true

const call = (action, payload) => bar_.command(action, payload)

/** The padlock slot, from the engine's own account of the connection. */
function drawSecurity(state) {
  security.className = ''
  const level = state?.level ?? 'none'
  if (level === 'secure') {
    security.textContent = '🔒'
    security.title = state.text
  } else if (level === 'local') {
    security.textContent = '⌂'
    security.title = state.text
  } else if (level === 'insecure') {
    security.textContent = '⚠'
    security.title = state.text
    security.className = 'warn'
  } else if (level === 'broken') {
    security.textContent = '⚠'
    security.title = state.text
    security.className = 'bad'
  } else {
    security.textContent = '⌕'
    security.title = 'Search or enter an address'
  }
}

function drawTabs(state) {
  strip.textContent = ''
  tabCount = state.tabs.length
  stripAllowed = state.strip !== false
  document.body.classList.toggle('single', stripAllowed !== true || tabCount <= 1)

  for (const tab of state.tabs) {
    const chip = document.createElement('div')
    chip.className = tab.active === true ? 'tab active' : 'tab'
    chip.title = tab.url === '' ? tab.title : `${tab.title}\n${tab.url}`
    chip.addEventListener('mousedown', event => {
      if (event.button === 1) {
        call('close', { tabId: tab.id })
        return
      }
      if (tab.active !== true) call('switch', { tabId: tab.id })
    })

    if (tab.loading === true) {
      chip.append(glyph('◌'))
    } else if (tab.favicon !== '') {
      const icon = document.createElement('img')
      icon.className = 'favicon'
      icon.src = tab.favicon
      icon.addEventListener('error', () => icon.replaceWith(glyph('🌐')))
      chip.append(icon)
    } else {
      chip.append(glyph('🌐'))
    }

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = tab.title
    chip.append(label)

    const close = document.createElement('button')
    close.className = 'close'
    close.textContent = '×'
    close.title = 'Close tab'
    close.addEventListener('click', event => {
      event.stopPropagation()
      call('close', { tabId: tab.id })
    })
    chip.append(close)

    strip.append(chip)
  }

  // No + in a pane that cannot open pages: a control that does nothing is worse than none.
  if (stripAllowed !== true) return

  const plus = document.createElement('button')
  plus.id = 'newtab'
  plus.textContent = '+'
  plus.title = 'New tab'
  plus.addEventListener('click', () => call('new'))
  strip.append(plus)

  const activeChip = strip.querySelector('.tab.active')
  if (activeChip !== null && tabCount > 1) activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

const glyph = text => {
  const span = document.createElement('span')
  span.className = 'glyph'
  span.textContent = text
  return span
}

function draw(state) {
  if (state === null || state === undefined) return
  drawTabs(state)
  const tab = state.active
  if (tab === null || tab === undefined) return
  if (editing !== true) address.value = tab.url.startsWith('file://') ? '' : tab.url
  back.disabled = tab.canGoBack !== true
  forward.disabled = tab.canGoForward !== true
  drawSecurity(tab.security)
  zoom.textContent = Math.abs(tab.zoom - 1) < 0.01 ? '' : `${Math.round(tab.zoom * 100)}%`
  loading = tab.loading === true
  reload.textContent = loading ? '×' : '⟳'
  reload.title = loading ? 'Stop' : 'Reload'
  progress.className = loading ? '' : 'done'
  progress.style.width = loading ? '70%' : '0'
}

// ── the address row ────────────────────────────────────────────────────────

address.addEventListener('focus', () => {
  editing = true
  address.select()
})
address.addEventListener('blur', () => {
  editing = false
})
address.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    address.blur()
    return
  }
  if (event.key !== 'Enter') return
  event.preventDefault()
  const typed = address.value.trim()
  if (typed === '') return
  call('go', { url: normalize(typed) })
  address.blur()
})

/**
 * An address or a search, the way a browser decides it.
 *
 * A URL with a scheme is taken as written, which is what makes a pasted
 * `http://127.0.0.1:3090/?token=…` work exactly as pasted — token and all. Anything that
 * looks like a host gets https, and everything else is a search.
 */
function normalize(typed) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return typed
  if (/^localhost(:\d+)?(\/|$)/.test(typed)) return `http://${typed}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(typed)) return `http://${typed}`
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(typed)) return `https://${typed}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`
}

back.addEventListener('click', () => call('back'))
forward.addEventListener('click', () => call('forward'))
reload.addEventListener('click', () => call(loading ? 'stop' : 'reload'))
menu.addEventListener('click', () => bar_.menu())

// ⌘L, and the address field is focused and selected so typing replaces the URL.
bar_.onFocusAddress(() => {
  address.focus()
  address.select()
})

bar_.onTabs(draw)
bar_.command('list').then(draw)

// ── annotation ──────────────────────────────────────────────────────────────
//
// The two gestures the human has, and the queue they feed. Nothing here decides what an
// annotation *is*: the page-side picker owns that, the app takes the screenshot, and this is
// only the part the human touches.

/** Which mode this pane's picker is in, so the button that armed it can say so. */
let armed = 'off'

function paintArmed() {
  quick.classList.toggle('armed', armed === 'quick')
  inspect.classList.toggle('armed', armed === 'inspect')
}

/**
 * Arm a mode, or disarm it when the armed button is pressed again.
 *
 * Pressing the same button twice is how a human cancels: they armed the picker, changed their
 * mind, and should not have to find Escape.
 */
async function arm(mode) {
  const next = armed === mode ? 'off' : mode
  const reply = await browserBar.annotate(next)
  armed = reply?.mode ?? next
  paintArmed()
}

quick.addEventListener('click', () => arm('quick'))
inspect.addEventListener('click', () => arm('inspect'))

/** Repaint the queue. */
function paintQueue(list) {
  const items = Array.isArray(list) ? list : []
  count.dataset.n = String(items.length)
  count.textContent = String(items.length)
  queueList.textContent = ''
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'queue-empty'
    empty.textContent = 'Nothing waiting. Right-click anything on a page to annotate it.'
    queueList.append(empty)
    return
  }
  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'queue-item'
    const image = document.createElement('img')
    if (typeof item.screenshot === 'string') image.src = item.screenshot
    const body = document.createElement('div')
    body.className = 'body'
    const comment = document.createElement('div')
    comment.className = 'comment'
    comment.textContent = item.comment === undefined || item.comment === '' ? '(no comment)' : item.comment
    const selector = document.createElement('div')
    selector.className = 'selector'
    selector.textContent = item.selector ?? item.url ?? ''
    body.append(comment, selector)
    const drop = document.createElement('button')
    drop.className = 'drop'
    drop.textContent = '×'
    drop.title = 'Discard this annotation'
    drop.addEventListener('click', async () => {
      const reply = await browserBar.clearAnnotation(item.id)
      paintQueue(reply?.annotations)
    })
    row.append(image, body, drop)
    queueList.append(row)
  }
}

const queueList = document.getElementById('queue-list')

queueButton.addEventListener('click', async () => {
  if (queuePanel.hidden) {
    const reply = await browserBar.annotations()
    paintQueue(reply?.annotations)
    queuePanel.hidden = false
    return
  }
  queuePanel.hidden = true
})

document.getElementById('queue-clear').addEventListener('click', async () => {
  const reply = await browserBar.clearAnnotation()
  paintQueue(reply?.annotations)
})

document.getElementById('queue-send').addEventListener('click', async () => {
  const send = document.getElementById('queue-send')
  send.textContent = 'Sending…'
  const reply = await browserBar.sendAnnotations()
  send.textContent = reply?.ok === true ? 'Sent' : 'Could not send'
  // The queue repaints from the app's own answer rather than from an assumption about what
  // happened; a failed delivery must leave the annotations where the human can still see them.
  window.setTimeout(async () => {
    send.textContent = 'Add to input'
    paintQueue((await browserBar.annotations())?.annotations)
  }, 1400)
})

// A page that has been annotated is a page worth looking at, so the panel opens itself the
// first time something lands in it.
browserBar.onAnnotationAdded(() => {
  armed = 'off'
  paintArmed()
  queuePanel.hidden = false
})

browserBar.onAnnotations(list => paintQueue(list))
browserBar.annotations().then(reply => paintQueue(reply?.annotations))
paintArmed()
