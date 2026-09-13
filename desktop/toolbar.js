// The tab strip and the address row.
//
// It draws what the engine reports and sends back what the human asks for; it holds no
// state of its own beyond the text being typed. A toolbar that kept its own idea of the
// current URL would show the old one for as long as a redirect took, which is exactly when
// the human is watching it.

const strip = document.getElementById('strip')
const address = document.getElementById('address')
const security = document.getElementById('security')
const zoom = document.getElementById('zoom')
const back = document.getElementById('back')
const forward = document.getElementById('forward')
const reload = document.getElementById('reload')
const menu = document.getElementById('menu')
const progress = document.getElementById('progress')

/** Whether the address field is being edited, so incoming state does not overwrite it. */
let editing = false
let activeTabId = null
let loading = false

const call = (action, payload) => window.browserBar.command(action, payload)

/** The padlock slot: an engine-reported state, never a guess from the URL scheme. */
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

/** One chip per tab, drawn from the tab list the engine produced. */
function drawTabs(state) {
  strip.textContent = ''
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
      const glyph = document.createElement('span')
      glyph.className = 'glyph'
      glyph.textContent = '◌'
      chip.append(glyph)
    } else if (tab.favicon !== '') {
      const icon = document.createElement('img')
      icon.className = 'favicon'
      icon.src = tab.favicon
      icon.addEventListener('error', () => {
        icon.replaceWith(Object.assign(document.createElement('span'), { className: 'glyph', textContent: '🌐' }))
      })
      chip.append(icon)
    } else {
      const glyph = document.createElement('span')
      glyph.className = 'glyph'
      glyph.textContent = '🌐'
      chip.append(glyph)
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

  const plus = document.createElement('button')
  plus.id = 'newtab'
  plus.textContent = '+'
  plus.title = 'New tab'
  plus.addEventListener('click', () => call('new'))
  strip.append(plus)
  const activeChip = strip.querySelector('.tab.active')
  if (activeChip !== null) activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function draw(state) {
  activeTabId = state.activeId
  drawTabs(state)
  const tab = state.active
  if (tab === null) return
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
  // An address or a search, the way a browser decides it: something that looks like a
  // host goes to the host, and everything else is a search.
  const looksLikeAddress = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || /^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(typed) || /^localhost(:\d+)?(\/|$)/.test(typed)
  const target = looksLikeAddress
    ? /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)
      ? typed
      : `https://${typed}`
    : `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`
  call('go', { url: target })
  address.blur()
})

back.addEventListener('click', () => call('back'))
forward.addEventListener('click', () => call('forward'))
reload.addEventListener('click', () => call(loading ? 'stop' : 'reload'))

// The menu is a small native menu rather than a drawn one, so it behaves like a menu.
menu.addEventListener('click', () => window.browserBar.menu())

window.browserBar.onTabs(draw)
window.browserBar.command('list').then(state => {
  if (state?.tabs !== undefined) draw(state)
})
