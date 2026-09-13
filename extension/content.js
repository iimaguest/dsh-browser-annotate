// Browser Annotate — page overlay content script.
//
// This script runs inside the inspected page, which is the only place a
// trustworthy element picker can live: it reads the real DOM, the real computed
// styles, and the real bounding boxes, and it renders its chrome inside a
// shadow root so the host application's stylesheet cannot reach it and its own
// styles cannot leak back into the app.
//
// Two modes, matching how the annotation is meant to feel:
//
//   quick   — one step. The pointer picks an element, a small comment box opens
//             anchored to it, and Enter captures the annotation. This is the
//             right-click-and-tell-it-what-is-wrong path.
//   inspect — the DevTools picker, kept open. Moving the pointer walks the DOM,
//             a panel shows the candidate's selector, size, and computed
//             styles, and the human annotates when they have found the node.
//
// The script is also the page-side executor for every driving tool: snapshot,
// click, type, scroll, get, wait, readPage, and geometry. Those run here rather
// than over the debugger because the page context is where event sequencing,
// framework binding, and lazy rendering actually behave like they do for a
// human.

;(() => {
  /** Guard against a double injection when the worker re-injects the file. */
  if (window.__dshBrowserAnnotateLoaded === true) return
  window.__dshBrowserAnnotateLoaded = true

  /** Current annotation mode. */
  let mode = 'off'
  /** The element the pointer is over. */
  const state = {
    hover: null,
    picked: null,
    commentOpen: false,
    /**
     * The element under the last right-click.
     *
     * Chrome's own context menu is what the human actually clicked, and
     * `contextMenus.onClicked` reports only a coordinate — so the element has to be
     * remembered while the click is still in the page. This is captured in the
     * capture phase, before any page handler can stop propagation, because the
     * whole point is to annotate elements on pages that fight for their own events.
     */
    contextTarget: null,
  }
  /** `@ref` → element, rebuilt on every snapshot. */
  let refMap = new Map()
  /** Console and network capture, installed once. */
  const consoleBuffer = []
  const networkBuffer = []

  // ── console and network capture ──────────────────────────────────────────
  // Patched before the page's own bundles run, so nothing is missed. The
  // buffers are drained by whatever attaches to this page over the DevTools Protocol
  // and are also reported to the worker for tabs whose overlay is gone.

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    if (typeof original !== 'function') continue
    console[level] = function patched(...args) {
      try {
        consoleBuffer.push({
          level: level === 'warn' ? 'warning' : level,
          text: args
            .map(value => {
              if (typeof value === 'string') return value
              try {
                return JSON.stringify(value)
              } catch {
                return String(value)
              }
            })
            .join(' ')
            .slice(0, 4000),
          url: location.href,
          line: 0,
        })
        if (consoleBuffer.length > 400) consoleBuffer.shift()
      } catch {
        // A console patch must never break the page's logging.
      }
      return original.apply(this, args)
    }
  }
  window.addEventListener('error', event => {
    pushConsole('error', `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`)
  })
  window.addEventListener('unhandledrejection', event => {
    pushConsole('error', `Unhandled rejection: ${String(event.reason)}`)
  })

  /**
   * Append one captured console line.
   * @param level - severity label.
   * @param value - the message.
   */
  function pushConsole(level, value) {
    consoleBuffer.push({ level, text: String(value).slice(0, 4000), url: location.href, line: 0 })
    if (consoleBuffer.length > 400) consoleBuffer.shift()
  }

  // fetch and XHR are wrapped in the page's own realm, which is the only place
  // a failure reason is observable without the debugger.
  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const started = performance.now()
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      return originalFetch.call(this, input, init).then(
        response => {
          pushNetwork({ method: init?.method ?? 'GET', url, status: response.status, durationMs: Math.round(performance.now() - started) })
          return response
        },
        error => {
          pushNetwork({ method: init?.method ?? 'GET', url, failure: String(error), durationMs: Math.round(performance.now() - started) })
          throw error
        },
      )
    }
  }
  const OriginalXhr = window.XMLHttpRequest
  if (typeof OriginalXhr === 'function') {
    const open = OriginalXhr.prototype.open
    const send = OriginalXhr.prototype.send
    OriginalXhr.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__dshMethod = method
      this.__dshUrl = url
      this.__dshStarted = performance.now()
      return open.call(this, method, url, ...rest)
    }
    OriginalXhr.prototype.send = function patchedSend(...args) {
      this.addEventListener('loadend', () => {
        pushNetwork({
          method: this.__dshMethod ?? 'GET',
          url: String(this.__dshUrl ?? ''),
          status: this.status,
          durationMs: Math.round(performance.now() - (this.__dshStarted ?? performance.now())),
        })
      })
      return send.apply(this, args)
    }
  }

  /**
   * Append one captured network entry and mirror it to the worker.
   * @param entry - the request summary.
   */
  function pushNetwork(entry) {
    networkBuffer.push(entry)
    if (networkBuffer.length > 400) networkBuffer.shift()
    try {
      chrome.runtime.sendMessage({ type: 'requestDone', entry })
    } catch {
      // The worker may be asleep; the local buffer still answers the tool.
    }
  }

  // ── element description ──────────────────────────────────────────────────

  /**
   * Properties captured as computed styles: the ones that explain layout bugs.
   *
   * The four-sided longhands are here on purpose. The `margin` shorthand reads
   * `0px 0px 0px -4px`, which leaves the model to work out which side is wrong —
   * exactly the guessing this tool exists to remove. `margin-left: -4px` says it.
   */
  const STYLE_KEYS = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'line-height',
    'text-align',
    'border',
    'border-radius',
    'opacity',
    'overflow',
    'z-index',
    'gap',
    'flex-direction',
    'justify-content',
    'align-items',
    'grid-template-columns',
    'visibility',
  ]

  /**
   * Build the shortest selector that uniquely identifies an element, falling
   * back to an `nth-of-type` chain when a bare id or class is ambiguous.
   * @param element - the target element.
   * @returns a CSS selector that resolves to this element in this document.
   */
  function selectorFor(element) {
    if (!(element instanceof Element)) return ''
    if (element.id !== '' && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
      return `#${CSS.escape(element.id)}`
    }
    const testId = element.getAttribute('data-testid') ?? element.getAttribute('data-test-id')
    if (testId !== null && testId !== '') {
      const candidate = `[data-testid="${testId}"]`
      if (document.querySelectorAll(candidate).length === 1) return candidate
    }
    const parts = []
    let node = element
    while (node !== null && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase()
      const stableClasses = Array.from(node.classList ?? [])
        .filter(name => name !== '' && !/^(css-|sc-|styled-|_)|[0-9a-f]{6,}/i.test(name))
        .slice(0, 3)
      if (stableClasses.length > 0) {
        part += stableClasses.map(name => `.${CSS.escape(name)}`).join('')
      } else {
        const parent = node.parentElement
        if (parent !== null) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName)
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
        }
      }
      parts.unshift(part)
      const candidate = parts.join(' > ')
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate
      } catch {
        // An unparsable intermediate selector just keeps walking up.
      }
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  /**
   * Build the human-readable DOM ancestry, useful when a selector is fragile.
   * @param element - the target element.
   * @returns a `tag#id.class > …` path from the root to the element.
   */
  function domPathFor(element) {
    const parts = []
    let node = element
    while (node !== null && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase()
      if (node.id !== '') part += `#${node.id}`
      else if (typeof node.className === 'string' && node.className.trim() !== '') {
        part += `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  /**
   * Suggest which source file likely owns an element, by walking the framework's
   * own bookkeeping. React's `_debugSource` is present in development builds,
   * which is exactly when this feature matters.
   * @param element - the target element.
   * @returns a hint string, or an empty string when nothing is known.
   */
  function frameworkHintFor(element) {
    const hints = []
    if (element.__reactFiber$ !== undefined || Object.keys(element).some(key => key.startsWith('__reactFiber$'))) {
      hints.push('React')
    }
    if (Object.keys(element).some(key => key.startsWith('__vueParentComponent'))) hints.push('Vue')
    if (Object.keys(element).some(key => key.startsWith('__svelte'))) hints.push('Svelte')
    let node = element
    for (let depth = 0; node !== null && depth < 40; depth++) {
      const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))
      if (key !== undefined) {
        let fiber = node[key]
        let hop = 0
        while (fiber !== null && fiber !== undefined && hop < 80) {
          const source = fiber._debugSource
          const name = fiber.type?.displayName ?? fiber.type?.name ?? fiber.elementType?.name
          if (source?.fileName !== undefined) {
            hints.push(`${name ?? 'component'} @ ${source.fileName}:${source.lineNumber ?? 0}`)
            return hints.join(' · ')
          }
          if (name !== undefined && hints.length === 1 && hop === 0) hints.push(`component: ${name}`)
          fiber = fiber.return
          hop++
        }
        break
      }
      node = node.parentElement
    }
    return hints.join(' · ')
  }

  /**
   * Capture everything the model needs about one element.
   * @param element - the target element.
   * @returns the element record sent with an annotation.
   */
  function describeElement(element) {
    const rect = element.getBoundingClientRect()
    const computed = getComputedStyle(element)
    const styles = {}
    for (const key of STYLE_KEYS) {
      const value = computed.getPropertyValue(key)
      if (value !== '' && value !== 'none' && value !== 'normal' && value !== 'auto') styles[key] = value
    }
    const html = element.outerHTML ?? ''
    return {
      selector: selectorFor(element),
      domPath: domPathFor(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') ?? implicitRole(element),
      accessibleName:
        element.getAttribute('aria-label') ??
        element.getAttribute('alt') ??
        element.getAttribute('title') ??
        (element.innerText ?? '').trim().slice(0, 120),
      text: (element.innerText ?? element.textContent ?? '').trim().slice(0, 600),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      styles,
      html: html.length > 6000 ? `${html.slice(0, 6000)}…` : html,
      framework: frameworkHintFor(element) || null,
      componentHint: frameworkHintFor(element) || '',
    }
  }

  /**
   * Infer an ARIA role from the tag when the author declared none.
   * @param element - the target element.
   * @returns the implied role, or an empty string.
   */
  function implicitRole(element) {
    const tag = element.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : ''
    if (tag === 'input') return element.getAttribute('type') ?? 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'nav') return 'navigation'
    return ''
  }

  // ── overlay chrome ───────────────────────────────────────────────────────

  const host = document.createElement('div')
  // A fixed, maximum z-index host with pointer events off by default: the page
  // stays fully usable, and only the toolbar and comment box opt back in.
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; contain: layout style;'
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .box {
      position: fixed; pointer-events: none; border: 2px solid #4d6bfe;
      background: rgba(77,107,254,0.14); border-radius: 3px; box-sizing: border-box;
      transition: all 60ms linear; display: none;
    }
    .box.on { display: block; }
    .tagLabel {
      position: fixed; pointer-events: none; font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #4d6bfe; color: #fff; padding: 2px 6px; border-radius: 4px 4px 0 0;
      white-space: nowrap; display: none; max-width: 70vw; overflow: hidden; text-overflow: ellipsis;
    }
    .tagLabel.on { display: block; }
    .bar {
      position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
      pointer-events: auto; display: flex; align-items: center; gap: 8px;
      background: #16181d; color: #e8e8ea; border: 1px solid rgba(255,255,255,0.14);
      border-radius: 999px; padding: 7px 10px 7px 14px;
      font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 12px 32px rgba(0,0,0,0.42);
    }
    .bar .mode { font-weight: 600; letter-spacing: 0.02em; }
    .bar .hint { opacity: 0.66; }
    button {
      appearance: none; font: inherit; cursor: pointer; border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18); background: transparent; color: inherit;
      padding: 4px 10px;
    }
    button.primary { background: #4d6bfe; border-color: transparent; color: #fff; }
    button:hover { border-color: rgba(255,255,255,0.4); }
    .panel {
      position: fixed; top: 14px; right: 14px; width: 340px; max-height: 70vh; overflow: auto;
      /* The panel is information, not a control, and it sits in the corner the pointer is most
         likely to cross on its way to the thing being inspected. Taking clicks there meant the
         click that was meant to select an element hit the panel describing it instead. Only the
         bar and the composer take the pointer, because only they have something to press. */
      pointer-events: none; background: #16181d; color: #e8e8ea;
      border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; padding: 10px 12px;
      font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 16px 40px rgba(0,0,0,0.45);
    }
    .panel h4 { margin: 0 0 6px; font-size: 12px; font-weight: 700; }
    .panel dl { display: grid; grid-template-columns: 88px 1fr; gap: 2px 8px; margin: 0; }
    .panel dt { opacity: 0.6; }
    .panel dd { margin: 0; word-break: break-all; }
    .mono { font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .composer {
      position: fixed; pointer-events: auto; width: 340px; background: #16181d; color: #e8e8ea;
      border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; padding: 10px;
      font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 18px 44px rgba(0,0,0,0.5);
    }
    .composer .target { opacity: 0.66; margin-bottom: 6px; word-break: break-all; }
    textarea {
      width: 100%; box-sizing: border-box; resize: vertical; min-height: 62px;
      background: #0f1115; color: inherit; border: 1px solid rgba(255,255,255,0.16);
      border-radius: 6px; padding: 7px 8px; font: inherit;
    }
    .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
    .count { opacity: 0.6; margin-left: auto; }
  `
  shadow.append(style)

  const box = document.createElement('div')
  box.className = 'box'
  const tagLabel = document.createElement('div')
  tagLabel.className = 'tagLabel'
  shadow.append(box, tagLabel)

  const bar = document.createElement('div')
  bar.className = 'bar'
  shadow.append(bar)

  const inspectPanel = document.createElement('div')
  inspectPanel.className = 'panel'
  inspectPanel.style.display = 'none'
  shadow.append(inspectPanel)

  const composer = document.createElement('div')
  composer.className = 'composer'
  composer.style.display = 'none'
  shadow.append(composer)

  /** Attach the host once the document body exists. */
  function mount() {
    if (document.body === null) return
    if (!host.isConnected) document.body.append(host)
  }
  if (document.body !== null) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  // A single-page app can replace the body's children wholesale while it boots.
  // The real DSH GUI does exactly that during hydration: the overlay host was
  // appended, then swept away with the rest of the body, and every later
  // annotation silently lost its chrome. Watching for the host leaving the
  // document is what keeps this tool installed on real apps rather than only on
  // pages that never touch their own body.
  const mounted = new MutationObserver(() => {
    if (!host.isConnected) mount()
  })
  mounted.observe(document.documentElement, { childList: true, subtree: true })
  // The watch only has to cover the boot; a settled page is not going to drop the
  // host, and an observer running forever in every tab is a cost this tool should
  // not charge.
  const stopWatching = () => mounted.disconnect()
  if (document.readyState === 'complete') stopWatching()
  else window.addEventListener('load', stopWatching, { once: true })

  /**
   * Position the highlight and label over an element.
   * @param element - the element to highlight.
   */
  function drawBox(element) {
    if (element === null || !element.isConnected) {
      box.classList.remove('on')
      tagLabel.classList.remove('on')
      return
    }
    const rect = element.getBoundingClientRect()
    box.style.left = `${rect.left}px`
    box.style.top = `${rect.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    box.classList.add('on')
    const label = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} · ${Math.round(rect.width)}×${Math.round(rect.height)}`
    tagLabel.textContent = label
    const labelTop = rect.top > 22 ? rect.top - 20 : rect.bottom + 2
    tagLabel.style.left = `${Math.max(2, rect.left)}px`
    tagLabel.style.top = `${labelTop}px`
    tagLabel.classList.add('on')
  }

  /** Hide the highlight. */
  function clearBox() {
    box.classList.remove('on')
    tagLabel.classList.remove('on')
  }

  /** Render the mode bar for the current mode. */
  function renderBar() {
    bar.textContent = ''
    if (mode === 'off') {
      bar.style.display = 'none'
      inspectPanel.style.display = 'none'
      return
    }
    bar.style.display = 'flex'
    const label = document.createElement('span')
    label.className = 'mode'
    label.textContent = mode === 'quick' ? 'Quick annotate' : 'Inspect'
    const hint = document.createElement('span')
    hint.className = 'hint'
    hint.textContent =
      mode === 'quick' ? 'click an element, then type your note' : 'hover to walk the DOM, click to select, Enter to annotate'
    const annotate = document.createElement('button')
    annotate.className = 'primary'
    annotate.textContent = 'Annotate'
    annotate.addEventListener('click', () => {
      if (state.picked !== null) openComposer(state.picked)
    })
    const off = document.createElement('button')
    off.textContent = 'Done'
    off.addEventListener('click', () => setMode('off'))
    bar.append(label, hint)
    if (mode === 'inspect') bar.append(annotate)
    bar.append(off)
  }

  /**
   * Switch annotation mode and tell the worker so the host stays in step.
   * @param next - the mode to enter.
   */
  function setMode(next) {
    mode = next
    state.hover = null
    state.picked = null
    clearBox()
    renderBar()
    inspectPanel.style.display = 'none'
    closeComposer()
    try {
      chrome.runtime.sendMessage({ type: 'modeChanged', mode: next })
    } catch {
      // A sleeping worker re-reads the mode when it next talks to this tab.
    }
  }

  /** Close and reset the comment composer. */
  function closeComposer() {
    composer.style.display = 'none'
    composer.textContent = ''
    state.commentOpen = false
  }

  /**
   * Open the comment composer, anchored near the element.
   * @param element - the annotated element.
   */
  function openComposer(element) {
    const rect = element.getBoundingClientRect()
    composer.textContent = ''

    const target = document.createElement('div')
    target.className = 'target mono'
    target.textContent = selectorFor(element)

    const area = document.createElement('textarea')
    area.placeholder = 'What should change here? (Enter to save, Shift+Enter for a new line)'
    area.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.shiftKey !== true) {
        event.preventDefault()
        commit(element, area.value)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeComposer()
      }
      event.stopPropagation()
    })
    area.addEventListener('keyup', event => event.stopPropagation())
    area.addEventListener('keypress', event => event.stopPropagation())

    const actions = document.createElement('div')
    actions.className = 'actions'
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', closeComposer)
    const save = document.createElement('button')
    save.className = 'primary'
    save.textContent = 'Save annotation'
    save.addEventListener('click', () => commit(element, area.value))
    actions.append(cancel, save)

    composer.append(target, area, actions)
    composer.style.display = 'block'
    // Keep the composer on screen for elements near the edges.
    const width = 340
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 12)
    const top = rect.bottom + 10 + 140 < window.innerHeight ? rect.bottom + 10 : Math.max(8, rect.top - 160)
    composer.style.left = `${left}px`
    composer.style.top = `${top}px`
    composer.style.right = 'auto'
    state.commentOpen = true
    area.focus()
  }

  /**
   * Capture one annotation and hand it to the worker.
   * @param element - the annotated element.
   * @param comment - the human's note.
   */
  function commit(element, comment) {
    const record = {
      comment: String(comment ?? '').trim(),
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      element: describeElement(element),
    }
    closeComposer()
    clearBox()
    // The worker crops a screenshot to the element's rectangle; the annotation
    // is sent immediately so a screenshot failure never loses the comment.
    try {
      chrome.runtime.sendMessage({ type: 'annotation', annotation: record })
    } catch {
      // Nothing else can be done from the page side.
    }
    if (mode === 'quick') setMode('off')
  }

  /** Render the inspect panel for the candidate element. */
  function renderInspect() {
    if (mode !== 'inspect' || state.hover === null) {
      inspectPanel.style.display = 'none'
      return
    }
    inspectPanel.style.display = 'block'
    inspectPanel.textContent = ''
    const element = state.hover
    const rect = element.getBoundingClientRect()
    const computed = getComputedStyle(element)
    const heading = document.createElement('h4')
    heading.textContent = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`
    const list = document.createElement('dl')
    const rows = [
      ['size', `${Math.round(rect.width)} × ${Math.round(rect.height)}`],
      ['position', `${Math.round(rect.x)}, ${Math.round(rect.y)}`],
      ['display', computed.display],
      ['color', computed.color],
      ['background', computed.backgroundColor],
      ['font', `${computed.fontSize} / ${computed.fontWeight}`],
      ['padding', computed.padding],
      ['margin', computed.margin],
    ]
    for (const [key, value] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = key
      const dd = document.createElement('dd')
      dd.textContent = value
      list.append(dt, dd)
    }
    const selector = document.createElement('div')
    selector.className = 'mono'
    selector.style.marginTop = '8px'
    selector.textContent = selectorFor(element)
    inspectPanel.append(heading, list, selector)
  }

  // ── pointer interaction ──────────────────────────────────────────────────

  /**
   * Resolve the deepest meaningful element at a point, walking into shadow roots
   * and open iframes so a pick inside a component still lands on the component.
   * @param x - viewport x coordinate.
   * @param y - viewport y coordinate.
   * @returns the resolved element.
   */
  /**
   * The last few things the picker saw, kept so a gesture that does nothing can be explained
   * instead of guessed at. A pick that silently does not happen has several possible causes —
   * the overlay itself under the pointer, a point outside the layout viewport, the page moving
   * between the highlight and the click — and they are indistinguishable from outside.
   */
  const trace = []
  function note(kind, event, element, note) {
    if (note === undefined) note = null
    trace.push({
      kind,
      target: event.target instanceof Element ? event.target.tagName.toLowerCase() : String(event.target),
      overlay: event.composedPath().includes(host),
      at: element instanceof Element ? element.tagName.toLowerCase() : null,
      x: Math.round(event.clientX ?? 0),
      y: Math.round(event.clientY ?? 0),
      note,
    })
    if (trace.length > 8) trace.shift()
  }

  function elementAt(x, y) {    let element = document.elementFromPoint(x, y)
    while (element !== null && element.shadowRoot !== null && element.shadowRoot !== undefined) {
      const inner = element.shadowRoot.elementFromPoint(x, y)
      if (inner === null || inner === element) break
      element = inner
    }
    return element
  }

  /**
   * Record what a right-click landed on, so the extension's context-menu entry has
   * a real element to annotate rather than just a pair of coordinates.
   */
  const onContextMenu = event => {
    // The overlay's own chrome is never a target.
    if (event.composedPath().includes(host)) {
      state.contextTarget = null
      return
    }
    state.contextTarget = event.target instanceof Element ? event.target : elementAt(event.clientX, event.clientY)
    // The page keeps its own context menu and this handler stays read-only. It
    // deliberately does NOT preventDefault: when an extension contributes an item
    // to Chrome's menu, suppressing the menu would take that item away from the
    // human in the same gesture that needs it. The composer is opened by the menu
    // click instead, which arrives as `composeAt`.
  }

  const onPointerMove = event => {
    if (mode === 'off') return
    // Our own chrome must never be the annotation target.
    if (event.composedPath().includes(host)) {
      note('move', event, null, 'the pointer was over the overlay itself')
      return
    }
    const element = elementAt(event.clientX, event.clientY)
    note('move', event, element)
    if (element === null || element === state.hover) return
    state.hover = element
    drawBox(element)
    renderInspect()
  }

  const onClick = event => {
    if (mode === 'off') return
    if (event.composedPath().includes(host)) {
      note('click', event, null, 'the click landed on the overlay, not on the page')
      return
    }
    const element = elementAt(event.clientX, event.clientY)
    note('click', event, element)
    if (element === null) return
    // Swallow the page's own handling while a pick is in progress.
    event.preventDefault()
    event.stopPropagation()
    state.picked = element
    drawBox(element)
    if (mode === 'quick') {
      openComposer(element)
    } else {
      renderInspect()
    }
  }

  const onKeyDown = event => {
    if (mode === 'off') return
    if (event.key === 'Escape') {
      if (state.commentOpen) closeComposer()
      else setMode('off')
      event.preventDefault()
      return
    }
    // In inspect mode, arrows walk to the parent and first child, the same
    // gesture the DevTools inspector uses. The walk moves the selection too,
    // because in the real inspector the highlighted node is the selected one —
    // otherwise Enter after a walk would annotate whatever was last clicked,
    // not the node the human walked to and is looking at.
    if (mode === 'inspect' && state.hover !== null && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const next = event.key === 'ArrowUp' ? state.hover.parentElement : state.hover.firstElementChild
      if (next !== null) {
        state.hover = next
        state.picked = next
        drawBox(next)
        renderInspect()
        event.preventDefault()
      }
      return
    }
    // Enter annotates what was just selected. Without it the only way on from a
    // selection is the button on the mode bar, which means the hand has to leave
    // the element it just chose and find a control somewhere else on the screen.
    if (mode === 'inspect' && state.commentOpen !== true && event.key === 'Enter' && state.picked !== null) {
      openComposer(state.picked)
      event.preventDefault()
    }
  }

  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', () => {
    if (state.hover !== null) drawBox(state.hover)
  }, true)
  window.addEventListener('resize', () => {
    if (state.hover !== null) drawBox(state.hover)
  })

  // ── page-side executors for the driving tools ────────────────────────────

  /**
   * Resolve a tool target, accepting a `@ref` from a snapshot or a selector.
   * @param target - the target string.
   * @returns the element, or null when nothing matches.
   */
  function resolveTarget(target) {
    if (typeof target !== 'string' || target === '') return null
    // A reference is accepted with or without its sigil. The snapshot prints `@e1`, and a
    // reference that only works when copied exactly is a reference that fails the moment a
    // model writes `e1`, which is the same string with one character of punctuation missing.
    const reference = target.startsWith('@') ? target.slice(1) : target
    if (/^e\d+$/.test(reference)) {
      const element = refMap.get(reference)
      return element !== undefined && element.isConnected ? element : null
    }
    try {
      return document.querySelector(target)
    } catch {
      return null
    }
  }

  /** Selector for elements a snapshot treats as actionable. */
  const INTERACTIVE_SELECTOR =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])'

  /**
   * Build the page snapshot: interactive elements with stable refs, plus text.
   * @param options - element and text caps.
   * @returns the snapshot payload.
   */
  function buildSnapshot(options) {
    refMap = new Map()
    const elements = []
    const seen = new Set()
    // A selector scopes the whole read, and a selector that matches nothing is an error rather
    // than a silent fall back to the document: a caller that asked about one subtree and was
    // handed the entire page cannot tell the difference between that and an empty subtree.
    let scope = document
    if (typeof options.selector === 'string' && options.selector !== '') {
      const found = resolveTarget(options.selector)
      if (found === null) return { error: `no element matches "${options.selector}"` }
      scope = found
    }
    const roots = [scope]
    // Shadow roots are searched too, so component libraries are reachable.
    for (const candidate of scope.querySelectorAll('*')) {
      if (candidate.shadowRoot !== null && candidate.shadowRoot !== undefined) roots.push(candidate.shadowRoot)
    }
    for (const root of roots) {
      let matches
      try {
        matches = root.querySelectorAll(INTERACTIVE_SELECTOR)
      } catch {
        continue
      }
      for (const element of matches) {
        if (seen.has(element) || elements.length >= options.maxElements) continue
        const rect = element.getBoundingClientRect()
        // Zero-size elements are hidden or layout-only; they are not targets.
        if (rect.width < 1 || rect.height < 1) continue
        if (rect.bottom < -200 || rect.top > window.innerHeight + 2000) continue
        seen.add(element)
        const ref = `e${elements.length + 1}`
        refMap.set(ref, element)
        elements.push({
          ref,
          tag: element.tagName.toLowerCase(),
          role: implicitRole(element),
          name: (
            element.getAttribute('aria-label') ??
            element.getAttribute('placeholder') ??
            element.getAttribute('alt') ??
            element.innerText ??
            element.value ??
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 160),
          selector: selectorFor(element),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          disabled: element.disabled === true,
        })
      }
    }
    let text = ''
    let truncated = false
    if (options.includeText) {
      // The text is read from the same scope the elements were, or a scoped read answers with
      // the whole page's prose while looking like it answered about one element. A reviewer put
      // a marker outside the requested subtree and watched it come back anyway.
      const source = scope === document ? document.body : scope
      const raw = (source?.innerText ?? '').replace(/\n{3,}/g, '\n\n')
      truncated = raw.length > options.maxText
      text = truncated ? raw.slice(0, options.maxText) : raw
    }
    return { elements, text, truncated, url: location.href, title: document.title }
  }

  /**
   * Convert the page's main content to Markdown.
   * @param maxChars - character cap.
   * @returns the rendered content.
   */
  function readPage(maxChars) {
    const root = document.querySelector('main, article, [role="main"]') ?? document.body
    if (root === null) return { content: '', title: document.title }
    const lines = []
    const walk = node => {
      if (lines.join('\n').length > maxChars) return
      if (node.nodeType === 3) {
        const value = node.textContent.replace(/\s+/g, ' ').trim()
        if (value !== '') lines.push(value)
        return
      }
      if (node.nodeType !== 1) return
      const tag = node.tagName.toLowerCase()
      if (['script', 'style', 'noscript', 'svg', 'nav', 'footer'].includes(tag)) return
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        lines.push('', `${'#'.repeat(Number(tag[1]))} ${node.innerText.trim()}`, '')
        return
      }
      if (tag === 'p') {
        lines.push('', node.innerText.trim(), '')
        return
      }
      if (tag === 'li') {
        lines.push(`- ${node.innerText.trim().replace(/\n+/g, ' ')}`)
        return
      }
      if (tag === 'a' && node.getAttribute('href') !== null) {
        const label = node.innerText.trim()
        if (label !== '') lines.push(`[${label}](${node.href})`)
        return
      }
      if (tag === 'pre' || tag === 'code') {
        lines.push('', '```', node.innerText.trim(), '```', '')
        return
      }
      for (const child of node.childNodes) walk(child)
    }
    walk(root)
    const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    const clipped = content.length > maxChars ? `${content.slice(0, maxChars)}\n…[truncated]` : content
    return { content: clipped, title: document.title }
  }

  /**
   * Synthesize a real click at an element's centre.
   * @param element - the element to click.
   */
  function realClick(element) {
    element.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
    const target = document.elementFromPoint(x, y) ?? element
    target.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }))
    target.dispatchEvent(new MouseEvent('mousedown', base))
    target.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }))
    target.dispatchEvent(new MouseEvent('mouseup', base))
    target.dispatchEvent(new MouseEvent('click', base))
    if (typeof element.click === 'function' && target !== element) element.click()
  }

  /**
   * Type text into an element the way a human does, so framework bindings see it.
   * @param element - the target field.
   * @param value - the text to type.
   */
  function realType(element, value) {
    element.focus()
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (element.isContentEditable === true) {
      element.textContent = value
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
      return
    }
    if (setter !== undefined) setter.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * Press one key on an element.
   * @param element - the target, or null for the focused element.
   * @param key - the key name.
   */
  function pressKey(element, key) {
    const target = element ?? document.activeElement ?? document.body
    const base = { key, bubbles: true, cancelable: true, composed: true }
    target.dispatchEvent(new KeyboardEvent('keydown', base))
    if (key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', { ...base, charCode: key.charCodeAt(0) }))
    target.dispatchEvent(new KeyboardEvent('keyup', base))
  }

  /**
   * Wait for one of the supported conditions.
   * @param params - the condition and its budget.
   * @returns the wait outcome.
   */
  async function waitFor(params) {
    const started = performance.now()
    const timeoutMs = Number(params.timeoutMs ?? 15000)
    const detail = []
    while (performance.now() - started < timeoutMs) {
      if (params.target !== undefined && resolveTarget(params.target) !== null) {
        return { satisfied: true, waitedMs: Math.round(performance.now() - started), detail: `found ${params.target}` }
      }
      if (params.urlContains !== undefined && location.href.includes(params.urlContains)) {
        return { satisfied: true, waitedMs: Math.round(performance.now() - started), detail: `URL contains ${params.urlContains}` }
      }
      if (params.text !== undefined && (document.body?.innerText ?? '').includes(params.text)) {
        return { satisfied: true, waitedMs: Math.round(performance.now() - started), detail: `text found` }
      }
      if (params.target === undefined && params.urlContains === undefined && params.text === undefined) {
        await new Promise(resolve => setTimeout(resolve, timeoutMs))
        return { satisfied: true, waitedMs: Math.round(performance.now() - started), detail: 'waited the full duration' }
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    if (params.target !== undefined) detail.push(`no element matched ${params.target}`)
    if (params.urlContains !== undefined) detail.push(`URL never contained ${params.urlContains}`)
    if (params.text !== undefined) detail.push(`text never appeared`)
    return { satisfied: false, waitedMs: Math.round(performance.now() - started), detail: detail.join('; ') }
  }

  // ── message surface for the service worker ───────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message === null || typeof message !== 'object') return false
    switch (message.type) {
      // A liveness probe. The content script runs in an isolated world, so nothing
      // outside it can read its guard flag off `window`; answering a message is the
      // only honest way to ask "are you installed on this page?". The harness uses
      // it to tell "injected but idle" apart from "not injected at all".
      case 'ping':
        respond({
          ok: true,
          loaded: true,
          overlay: host !== null && host.isConnected === true,
          // `mode` is its own binding, not a field of `state`; reading
          // `state.mode` answered undefined and made an armed overlay look idle.
          mode,
          armed: state.picked !== null,
          // What the overlay is doing, as opposed to what it was last told to do. The two are
          // the same until something goes wrong, and when something goes wrong this is the only
          // way to tell which of them is wrong.
          hover: state.hover === null || state.hover.isConnected !== true ? null : selectorFor(state.hover),
          picked: state.picked === null || state.picked.isConnected !== true ? null : selectorFor(state.picked),
          commentOpen: state.commentOpen === true,
          trace: trace.slice(-6),
        })
        return false
      case 'mode':
        setMode(message.mode ?? 'quick')
        respond({ ok: true, mode })
        return false
      case 'context': {
        // What the last right-click landed on, described. The recording is made during the
        // click itself (see onContextMenu) because a menu click arrives after the page has
        // had every chance to change underneath it; this only reports it.
        const element = state.contextTarget
        respond({
          ok: true,
          element: element !== null && element.isConnected === true ? describeElement(element) : null,
        })
        return false
      }
      case 'composeAt': {
        // The worker has just armed `quick`; the element is the one recorded while
        // the right-click was in the page, falling back to the coordinates Chrome
        // reported so a click that raced the content script still resolves.
        const recorded = state.contextTarget
        const element =
          recorded !== null && recorded.isConnected
            ? recorded
            : elementAt(Number(message.x) || 0, Number(message.y) || 0)
        if (element === null || element === host) {
          respond({ opened: false })
          return false
        }
        state.picked = element
        openComposer(element)
        respond({ opened: true, selector: selectorFor(element) })
        return false
      }
      case 'geometry': {
        const element = resolveTarget(message.selector)
        if (element === null) {
          respond({ error: `no element matches "${message.selector}"` })
          return false
        }
        const rect = element.getBoundingClientRect()
        respond({
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          devicePixelRatio: window.devicePixelRatio,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        })
        return false
      }
      case 'focus': {
        // Focus without clicking. Clicking a link or a submit button to reach it would activate
        // it, which is not what "type into this field" means; `focus()` is the DOM's own answer
        // and it fires the focus events a framework binds to.
        const element = resolveTarget(message.target)
        if (element === null) {
          respond({ error: `no element matches "${message.target}"` })
          return false
        }
        if (typeof element.focus === 'function') element.focus()
        respond({ ok: true, selector: selectorFor(element), focused: document.activeElement === element })
        return false
      }
      case 'snapshot':
        respond(buildSnapshot({ includeText: message.includeText, maxElements: message.maxElements, maxText: message.maxText, selector: message.selector }))
        return false
      case 'readPage':
        respond(readPage(message.maxChars ?? 40000))
        return false
      case 'click': {
        const element = resolveTarget(message.target)
        if (element === null) {
          respond({ error: `no element matches "${message.target}"` })
          return false
        }
        realClick(element)
        respond({ target: message.target, url: location.href, navigated: false })
        return false
      }
      case 'type': {
        const element = message.target === undefined ? null : resolveTarget(message.target)
        if (message.target !== undefined && element === null) {
          respond({ error: `no element matches "${message.target}"` })
          return false
        }
        if (element !== null && message.clear === true) realType(element, '')
        if (typeof message.text === 'string' && message.text !== '') realType(element ?? document.activeElement ?? document.body, message.text)
        if (typeof message.key === 'string' && message.key !== '') pressKey(element, message.key)
        if (message.submit === true) pressKey(element, 'Enter')
        respond({ target: message.target ?? '', typed: message.text ?? '', key: message.key ?? '' })
        return false
      }
      case 'scroll': {
        if (message.target !== undefined) {
          const element = resolveTarget(message.target)
          if (element === null) {
            respond({ error: `no element matches "${message.target}"` })
            return false
          }
          element.scrollIntoView({ block: 'center', behavior: 'instant' })
        } else {
          window.scrollBy({ left: message.deltaX ?? 0, top: message.deltaY ?? 0, behavior: 'instant' })
        }
        respond({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) })
        return false
      }
      case 'get': {
        const element = resolveTarget(message.target)
        if (element === null) {
          respond({ error: `no element matches "${message.target}"` })
          return false
        }
        const rect = element.getBoundingClientRect()
        const computed = getComputedStyle(element)
        const properties = Array.isArray(message.properties) ? message.properties : ['text', 'value', 'attributes', 'styles', 'rect']
        const detail = {}
        if (properties.includes('text')) detail.text = (element.innerText ?? element.textContent ?? '').trim().slice(0, 4000)
        if (properties.includes('value')) detail.value = element.value ?? null
        if (properties.includes('attributes')) {
          detail.attributes = Object.fromEntries(Array.from(element.attributes).map(attribute => [attribute.name, attribute.value]))
        }
        if (properties.includes('styles')) {
          detail.styles = Object.fromEntries(STYLE_KEYS.map(key => [key, computed.getPropertyValue(key)]))
        }
        if (properties.includes('rect')) {
          detail.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        }
        if (properties.includes('html')) detail.html = (element.outerHTML ?? '').slice(0, 8000)
        detail.selector = selectorFor(element)
        detail.domPath = domPathFor(element)
        respond(detail)
        return false
      }
      case 'wait':
        waitFor(message).then(respond)
        return true
      case 'console': {
        const entries = consoleBuffer.slice(-(message.limit ?? 100))
        if (message.clear === true) consoleBuffer.length = 0
        respond({ entries })
        return false
      }
      case 'network': {
        const entries = networkBuffer.slice(-(message.limit ?? 50))
        if (message.clear === true) networkBuffer.length = 0
        respond({ entries })
        return false
      }
      default:
        return false
    }
  })

  renderBar()
})()
