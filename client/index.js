// Browser Annotate — browser half.
//
// This module is served to the DSH web client as a plugin bundle, so it is
// written in the bundle's own dialect: a factory registered with
// `window.__ModuleLoader__.load`, CommonJS `require` for platform-seeded
// modules, and `exports.apply` / `exports.inject` as the loader face. It is
// deliberately not ESM — the client module system materializes factories, not
// ES modules, and `react`/`react/jsx-runtime` arrive from the platform seed
// table rather than from `node_modules`.
//
// What it contributes: one native right-sidebar tab type ("browser") whose body
// shows the annotation queue the Chrome extension feeds, the live connection and
// tab state, and the controls that arm annotation mode or hand a batch to the
// agent. The panel never talks to Chrome; it talks to its own host half over
// `/browser-annotate`, and the host half owns the socket to the extension.

window.__ModuleLoader__.load({
  id: 'dsh-browser-annotate',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    /** This implementation's identity in the tab system; also the body's slot key. */
    const TAB_ID = 'dsh-browser-annotate/browser'
    /** The tab kind `openTab` names. */
    const TAB_KIND = 'browser-annotate'
    /** Every HTTP endpoint lives under this prefix on the GUI's own origin. */
    const API = '/browser-annotate'

    /**
     * Fetch JSON from the plugin's own host routes.
     * @param path - path below the plugin prefix, for example '/state'.
     * @param options - fetch options; `body` objects are serialized for you.
     * @returns the parsed JSON body.
     */
    async function api(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: {}, signal: options.signal }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      if (options.method === 'DELETE' && options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(`${API}${path}`, init)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`)
      return payload
    }

    /**
     * The single host-event stream, shared by every consumer.
     *
     * One `EventSource` for the whole plugin, opened on first use and kept for the
     * bundle's lifetime. Consumers register a listener and get an unsubscribe
     * back; the source is torn down only when the last listener leaves, which
     * keeps a closed pane from leaving a live connection behind.
     */
    const bridgeFeed = (() => {
      /** @type {Map<Function, true>} */
      const listeners = new Map()
      let source = null
      let reconnects = 0

      /** Read one event and hand it to every listener, in subscription order. */
      const deliver = (name, payload) => {
        let event
        try {
          event = JSON.parse(payload)
          if (event === null || typeof event !== 'object') return
          if (typeof event.type !== 'string') event = { ...event, type: name }
        } catch {
          // A malformed frame is dropped; the next snapshot repairs the view.
          return
        }
        for (const listener of [...listeners.keys()]) {
          try {
            listener(event)
          } catch {
            // One broken listener must not stop the others.
          }
        }
      }

      const open = () => {
        if (source !== null) return source
        source = new EventSource(`${API}/events`)
        // Every event the host can push has to be named here: `EventSource` delivers a
        // named event only to listeners for that name, so an unlisted one is silently
        // dropped — which is exactly how a live view shows a frozen first frame.
        for (const name of [
          'snapshot',
          'bridge',
          'connection',
          'tab',
          'frame',
          'annotation/add',
          'annotation/update',
          'annotation/remove',
          'annotation/clear',
          'tabs',
        ]) {
          source.addEventListener(name, message => deliver(name, message.data))
        }
        source.onopen = () => {
          reconnects = 0
        }
        source.onerror = () => {
          // EventSource reconnects on its own; count the gaps so the panel can
          // say so rather than silently showing stale content.
          reconnects++
          for (const listener of [...listeners.keys()]) {
            try {
              listener({ type: 'stream/error', reconnects })
            } catch {
              // Same rule as above.
            }
          }
        }
        return source
      }

      /**
       * Subscribe to host events.
       * @param listener - called with each parsed event.
       * @returns an unsubscribe that closes the source once it is the last one.
       */
      return function subscribe(listener) {
        open()
        listeners.set(listener, true)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && source !== null) {
            source.close()
            source = null
          }
        }
      }
    })()

    /**
     * One fetch of the panel snapshot, with pushed host events applied on top.
     * @returns the live snapshot, the last stream error, and a manual refresh.
     */
    function useBridgeState() {
      // `lastFrame` rides the snapshot rather than its own state: frames arrive on the
      // same event stream as everything else, and a live view that re-rendered the
      // queue twice per frame would drop frames for no reason.
      const [snapshot, setSnapshot] = useState({ connected: false, client: null, tab: null, annotations: [], lastFrame: null })
      const [streamError, setStreamError] = useState('')
      const refresh = useCallback(async () => {
        try {
          const next = await api('/state')
          setSnapshot(current => ({ ...current, ...next }))
          setStreamError('')
        } catch (cause) {
          setStreamError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])
      useEffect(() => {
        let cancelled = false
        refresh()
        const unsubscribe = bridgeFeed(event => {
          if (cancelled) return
          if (event.type === 'stream/error') {
            setStreamError('reconnecting to the host…')
            return
          }
          setStreamError('')
          setSnapshot(current => reduceEvent(current, event))
        })
        return () => {
          cancelled = true
          unsubscribe()
        }
      }, [refresh])
      return { snapshot, streamError, refresh }
    }

    /**
     * Fold one host event into the panel snapshot.
     * @param current - the current snapshot.
     * @param event - the event pushed by the host.
     * @returns the next snapshot.
     */
    function reduceEvent(current, event) {
      switch (event.type) {
        case 'connection':
          return { ...current, connected: event.connected === true, client: event.client ?? null, tab: event.connected === true ? current.tab : null }
        case 'tab':
          return { ...current, tab: event.tab ?? null }
        case 'tabs':
          return { ...current, tabs: event.tabs ?? [], activeTabId: event.activeId ?? null }
        case 'snapshot':
          return { ...current, ...event, type: undefined }
        case 'frame':
          return { ...current, lastFrame: { data: event.data, metadata: event.metadata ?? null, seq: event.seq } }
        case 'annotation/add':
          return { ...current, annotations: [...current.annotations, event.annotation] }
        case 'annotation/update':
          return {
            ...current,
            annotations: current.annotations.map(item =>
              item.id === event.annotation?.id ? { ...item, ...event.annotation } : item,
            ),
          }
        case 'annotation/remove':
        case 'annotation/clear':
          return { ...current, annotations: current.annotations.filter(item => !event.ids.includes(item.id)) }
        default:
          return current
      }
    }

    /**
     * Copy text to the clipboard, tolerating a denied clipboard permission.
     * @param value - the text to copy.
     * @returns whether the copy succeeded.
     */
    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(value)
        return true
      } catch {
        return false
      }
    }

    /** Shared inline styles: no external sheet, no CSS-in-JS dependency. */
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        font: '12px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        color: 'var(--dsh-text-primary, #e6e6e6)',
      },
      header: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 10px 8px',
        borderBottom: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))',
      },
      row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      dot: connected => ({
        width: 8,
        height: 8,
        borderRadius: 4,
        flex: '0 0 auto',
        background: connected ? '#34c759' : '#ff9f0a',
      }),
      muted: { opacity: 0.62, fontSize: 11 },
      title: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: active => ({
        appearance: 'none',
        border: `1px solid ${active ? 'transparent' : 'var(--dsh-border-subtle, rgba(128,128,128,0.3))'}`,
        background: active ? 'var(--dsh-accent, #4d6bfe)' : 'transparent',
        color: active ? '#fff' : 'inherit',
        borderRadius: 6,
        padding: '4px 9px',
        font: 'inherit',
        cursor: 'pointer',
      }),
      iconButton: {
        appearance: 'none',
        border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.3))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '2px 6px',
        font: 'inherit',
        cursor: 'pointer',
        lineHeight: '16px',
      },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 },
      card: {
        border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--dsh-surface-raised, rgba(127,127,127,0.06))',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.18))' },
      badge: {
        flex: '0 0 auto',
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        background: 'var(--dsh-accent, #4d6bfe)',
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 600,
        padding: '0 5px',
      },
      thumb: { display: 'block', width: '100%', maxHeight: 190, objectFit: 'contain', background: 'rgba(0,0,0,0.35)' },
      body: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 },
      comment: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      code: {
        font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        opacity: 0.85,
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
      },
      footer: {
        display: 'flex',
        gap: 6,
        padding: 10,
        borderTop: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))',
        flexWrap: 'wrap',
      },
      empty: { padding: 18, textAlign: 'center', opacity: 0.68, display: 'flex', flexDirection: 'column', gap: 8 },

      // ── the live view ────────────────────────────────────────────────────────
      liveWrap: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 8px 0' },
      liveBar: { display: 'flex', alignItems: 'center', gap: 4 },
      // The tab strip. Chips are the browser's own tabs, so the row scrolls sideways
      // rather than wrapping: a wrapped strip changes height and moves the page under
      // the pointer, which is the one thing a browser's strip must never do.
      tabStrip: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingBottom: 2,
      },
      tabChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flex: '0 0 auto',
        maxWidth: 190,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.28))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      tabChipActive: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flex: '0 0 auto',
        maxWidth: 190,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-accent, #4d6bfe)',
        background: 'color-mix(in srgb, var(--dsh-accent, #4d6bfe) 18%, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      tabTitle: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 },
      tabClose: {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.6,
        fontSize: 12,
        lineHeight: 1,
        padding: 0,
      },
      toolButton: {
        minWidth: 26,
        height: 26,
        padding: '0 6px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.28))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
      },
      toolButtonOn: {
        minWidth: 26,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-accent, #4d6bfe)',
        background: 'color-mix(in srgb, var(--dsh-accent, #4d6bfe) 18%, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
      },
      address: {
        flex: 1,
        minWidth: 0,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.28))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      liveStage: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)',
        borderRadius: 8,
        overflow: 'hidden',
        minHeight: 120,
      },
      canvas: { display: 'block', maxWidth: '100%', maxHeight: '46vh', objectFit: 'contain', outline: 'none', cursor: 'default' },
      canvasAnnotate: {
        display: 'block',
        maxWidth: '100%',
        maxHeight: '46vh',
        objectFit: 'contain',
        outline: 'none',
        cursor: 'crosshair',
      },
      armed: {
        position: 'absolute',
        width: 10,
        height: 10,
        marginLeft: -5,
        marginTop: -5,
        borderRadius: '50%',
        background: 'var(--dsh-accent, #4d6bfe)',
        pointerEvents: 'none',
      },
      liveStatus: kind => ({
        position: 'absolute',
        left: 8,
        bottom: 8,
        right: 8,
        padding: '4px 8px',
        borderRadius: 6,
        fontSize: 11,
        background: kind === 'error' ? 'rgba(190,40,40,0.9)' : 'rgba(0,0,0,0.66)',
        color: '#fff',
      }),
    }

    /**
     * The prompt text one annotation contributes to the composer.
     *
     * Deliberately short. The screenshot carries the appearance, so the text only
     * has to carry what pixels cannot: which element, on which page, and what the
     * human wants changed. Nothing is repeated from the annotation record that the
     * model can read for itself with `browser_annotations`, because a composer
     * draft is the human's own message and should stay readable to them.
     * @param annotation - the queued annotation.
     * @returns the text to append.
     */
    function annotationPrompt(annotation) {
      const element = annotation.element ?? {}
      const lines = [annotation.comment ? annotation.comment : `Look at <${element.tag || 'this element'}> on this page.`]
      if (element.selector) lines.push(`Element: ${element.selector}${element.tag ? ` (<${element.tag}>)` : ''}`)
      if (annotation.url) lines.push(`Page: ${annotation.url}`)
      // The screenshot is attached alongside this text, so it needs no caption —
      // but a file the model cannot place is worse than a named one.
      if (annotation.hasScreenshot === true) lines.push('The cropped screenshot of that element is attached.')
      return lines.join('\n')
    }

    /**
     * Turn one captured screenshot back into a browser `File`.
     *
     * The host serves the crop as a data URL, and the composer's draft intake
     * accepts `File` objects — so this is the one conversion the hand-off needs.
     * Decoding happens through `atob`/`Uint8Array` rather than `fetch`, because a
     * data URL is not a resource to be requested and the synchronous decode keeps
     * the file ready before the human's next keystroke.
     *
     * @param dataUrl - the `data:image/png;base64,...` payload.
     * @param name - the filename the composer will show.
     * @returns the file, or null when the payload is not a usable image.
     */
    function fileFromDataUrl(dataUrl, name) {
      const comma = dataUrl.indexOf(',')
      if (comma === -1) return null
      const header = dataUrl.slice(0, comma)
      if (!header.startsWith('data:')) return null
      const mediaType = header.slice(5).split(';')[0] || 'image/png'
      if (!mediaType.startsWith('image/')) return null
      try {
        const binary = atob(dataUrl.slice(comma + 1))
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        return new File([bytes], name, { type: mediaType })
      } catch {
        return null
      }
    }

    /**
     * One annotation card: the captured pixels, the human's note, and the DOM
     * facts that let the model find the code.
     * @param props - the annotation, the removal callback, and the composer hook.
     * @returns the card element.
     */
    function AnnotationCard({ index, annotation, onRemove, onAdd, added }) {
      const [dataUrl, setDataUrl] = useState(null)
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        if (annotation.hasScreenshot !== true) return
        let cancelled = false
        api(`/screenshot?id=${encodeURIComponent(annotation.id)}`)
          .then(result => {
            if (!cancelled) setDataUrl(result.dataUrl ?? null)
          })
          .catch(() => {
            if (!cancelled) setDataUrl(null)
          })
        return () => {
          cancelled = true
        }
      }, [annotation.id, annotation.hasScreenshot])
      const element = annotation.element ?? {}
      const onCopy = useCallback(async () => {
        const ok = await copyText(
          [
            `Annotation ${index + 1}`,
            annotation.comment ? `Comment: ${annotation.comment}` : '',
            annotation.url ? `Page: ${annotation.url}` : '',
            element.selector ? `Selector: ${element.selector}` : '',
            element.domPath ? `DOM path: ${element.domPath}` : '',
            element.html ? `HTML: ${element.html}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        setCopied(ok)
        if (ok) setTimeout(() => setCopied(false), 1400)
      }, [annotation, element, index])
      return h(
        'div',
        { style: styles.card },
        dataUrl !== null ? h('img', { src: dataUrl, alt: `Annotation ${index + 1}`, style: styles.thumb }) : null,
        h(
          'div',
          { style: styles.cardHead },
          h('span', { style: styles.badge }, String(index + 1)),
          h('span', { style: { ...styles.title, flex: 1 } }, element.tag ? `<${element.tag}>` : 'annotation'),
          h(
            'button',
            {
              style: added ? { ...styles.iconButton, color: 'var(--dsh-accent, #4d6bfe)' } : styles.iconButton,
              title: 'Add this annotation to the message you are writing',
              onClick: () => onAdd(annotation),
            },
            added ? '✓ added' : '+ input',
          ),
          h('button', { style: styles.iconButton, title: 'Copy as text', onClick: onCopy }, copied ? '✓' : 'copy'),
          h('button', { style: styles.iconButton, title: 'Delete', onClick: () => onRemove(annotation.id) }, '✕'),
        ),
        h(
          'div',
          { style: styles.body },
          annotation.comment ? h('div', { style: styles.comment }, annotation.comment) : h('div', { style: styles.muted }, '(no comment — the element alone is the subject)'),
          element.selector ? h('div', { style: styles.code }, element.selector) : null,
          annotation.url ? h('div', { style: { ...styles.muted, wordBreak: 'break-all' } }, annotation.url) : null,
        ),
      )
    }

    /**
     * The annotation queue tab body.
     * @returns the panel element.
     */
    /**
     * The live view of the tab under annotation.
     *
     * DSH already runs this browser, and the extension already holds a debugger
     * session on it, so the view is a screencast of the tab the human is actually
     * looking at rather than a second browser embedded in a page. That is what keeps
     * the annotated element and the element in front of the human the same object —
     * no separate profile, no second login, no drift.
     *
     * Clicking the canvas either drives the page or resolves an element, which is the
     * whole point of the tab: annotate what you can see, without leaving DSH.
     */
    function LiveView(props) {
      const { onElement, visible } = props
      const canvasRef = useRef(null)
      const frameRef = useRef(null)
      const paneRef = useRef(null)
      const [status, setStatus] = useState({ kind: 'idle', text: '' })
      const [mode, setMode] = useState('interact')
      const [busy, setBusy] = useState('')
      const [armed, setArmed] = useState(null)

      /** Ask the host to start the stream, and name the failure when it will not. */
      const startStream = useCallback(async () => {
        setStatus({ kind: 'starting', text: 'Starting the live view…' })
        try {
          const result = await api('/live', { method: 'POST', body: { running: true } })
          if (result?.ok !== true) throw new Error(result?.error ?? 'the live view did not start')
          setStatus({ kind: 'live', text: '' })
        } catch (cause) {
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        }
      }, [])

      const stopStream = useCallback(async () => {
        try {
          await api('/live', { method: 'POST', body: { running: false } })
        } catch {
          // Stopping a stream that is already gone needs no report.
        }
      }, [])

      // Subscribing and streaming are separate concerns, and conflating them was a
      // real bug: the slot mounts the pane while it is hidden, so a subscription
      // created only on the visible path left the first frames arriving with nobody
      // listening, and the canvas stayed blank until the next unrelated event
      // re-rendered the panel.
      //
      // Frames arrive on the panel's existing event stream, so the live view needs no
      // second connection: `useBridgeState` multiplexes everything the host pushes,
      // and a frame is just another event on it.
      const state = useBridgeState()
      // The URL starts as whatever the host last reported and then follows the page.
      const [address, setAddress] = useState(state.snapshot?.tab?.url ?? '')
      // Every tab the browser has, and which one is in front.
      const tabs = state.snapshot?.tabs ?? state.tabs ?? []
      const activeTabId = state.snapshot?.activeTabId ?? state.activeTabId ?? null
      const frame = state.snapshot?.lastFrame

      useEffect(() => {
        if (frame === null || frame === undefined) return
        const canvas = canvasRef.current
        if (canvas === null) return
        const image = new Image()
        image.onload = () => {
          const ratio = window.devicePixelRatio || 1
          const width = image.naturalWidth
          const height = image.naturalHeight
          canvas.width = Math.round(width * ratio)
          canvas.height = Math.round(height * ratio)
          const painter = canvas.getContext('2d')
          if (painter === null) return
          painter.setTransform(ratio, 0, 0, ratio, 0, 0)
          painter.drawImage(image, 0, 0, width, height)
          frameRef.current = { width, height, metadata: frame.metadata ?? null }
        }
        image.src = `data:image/jpeg;base64,${frame.data}`
      }, [frame])

      // The stream lives exactly as long as the tab is in front.
      //
      // An earlier version of this watched `props.visible`, which the slot contract
      // does not contain and never delivered — so the gate was a silent no-op and the
      // panel streamed frames at a hidden pane. The canvas's box is the fallback
      // signal, because a hidden pane is rendered with no height, but the tab's own
      // info says so outright and does not depend on layout having settled.
      const [hasBox, setHasBox] = useState(false)
      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        const measure = () => {
          const box = canvas.getBoundingClientRect()
          setHasBox(box.width > 0 && box.height > 0)
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(canvas)
        return () => observer.disconnect()
      }, [])

      const onScreen = visible !== false && hasBox

      useEffect(() => {
        if (!onScreen) {
          stopStream()
          return undefined
        }
        let cancelled = false
        startStream().then(() => {
          if (cancelled) stopStream()
        })
        return () => {
          cancelled = true
          stopStream()
        }
        // Switching tabs in the browser changes which page the screencast is of, so the
        // stream is restarted against the tab that is now in front.
      }, [onScreen, startStream, stopStream, activeTabId])

      // The URL shown follows the page, so it reports where the tab really is after a
      // redirect or a link click rather than where it was asked to go.
      useEffect(() => {
        const tab = state.snapshot?.tab
        if (tab?.url) setAddress(tab.url)
      }, [state.snapshot?.tab?.url])

      /**
       * Map a point on the canvas to a point in the page.
       *
       * The frame is letterboxed into the canvas, so the offsets have to come off
       * before the scale goes on; skipping that is what makes a live view's clicks
       * land beside the thing the human aimed at.
       */
      const toPagePoint = useCallback(event => {
        const canvas = canvasRef.current
        const info = frameRef.current
        if (canvas === null || info === null) return null
        const box = canvas.getBoundingClientRect()
        const scale = Math.min(box.width / info.width, box.height / info.height)
        const drawnWidth = info.width * scale
        const drawnHeight = info.height * scale
        const offsetX = (box.width - drawnWidth) / 2
        const offsetY = (box.height - drawnHeight) / 2
        const x = (event.clientX - box.left - offsetX) / scale
        const y = (event.clientY - box.top - offsetY) / scale
        if (x < 0 || y < 0 || x > info.width || y > info.height) return null
        return { x: Math.round(x), y: Math.round(y) }
      }, [])

      const send = useCallback(
        async (kind, payload) => {
          try {
            const result = await api('/input', { method: 'POST', body: { kind, event: payload } })
            if (result?.ok !== true) throw new Error(result?.error ?? 'the input was refused')
            setStatus({ kind: 'live', text: '' })
          } catch (cause) {
            setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          }
        },
        [],
      )

      const modifiersOf = event =>
        (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

      const annotateAt = useCallback(
        async point => {
          setBusy('annotate')
          setArmed(point)
          try {
            const result = await api(`/element?x=${point.x}&y=${point.y}`)
            if (result?.element === null || result?.element === undefined) {
              setArmed(null)
              setStatus({ kind: 'error', text: 'Nothing is at that point — the element may have moved.' })
              return
            }
            if (typeof onElement === 'function') onElement(result.element)
          } catch (cause) {
            setArmed(null)
            setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          } finally {
            setBusy('')
          }
        },
        [onElement],
      )

      const onPointerDown = useCallback(
        async event => {
          const point = toPagePoint(event)
          if (point === null) return
          if (mode === 'annotate') {
            await annotateAt(point)
            return
          }
          event.currentTarget.focus()
          await send('mouse', {
            type: 'mousePressed',
            x: point.x,
            y: point.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
            modifiers: modifiersOf(event),
          })
          await send('mouse', {
            type: 'mouseReleased',
            x: point.x,
            y: point.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            modifiers: modifiersOf(event),
          })
        },
        [annotateAt, mode, send, toPagePoint],
      )

      const onMove = useCallback(
        event => {
          if (mode === 'annotate') return
          const point = toPagePoint(event)
          if (point === null) return
          send('mouse', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0, modifiers: modifiersOf(event) })
        },
        [mode, send, toPagePoint],
      )

      const onWheel = useCallback(
        event => {
          if (mode === 'annotate') return
          const point = toPagePoint(event)
          if (point === null) return
          event.preventDefault()
          send('wheel', {
            x: point.x,
            y: point.y,
            deltaX: Math.round(event.deltaX),
            deltaY: Math.round(event.deltaY),
            modifiers: modifiersOf(event),
          })
        },
        [mode, send, toPagePoint],
      )

      const onKeyDown = useCallback(
        event => {
          // Modifier-only presses carry no text and would arrive as empty keystrokes.
          if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return
          event.preventDefault()
          const printable = event.key.length === 1
          send('key', {
            type: 'keyDown',
            key: event.key,
            code: event.code,
            keyCode: event.keyCode,
            modifiers: modifiersOf(event),
            text: printable && !event.ctrlKey && !event.metaKey ? event.key : undefined,
          })
          send('key', { type: 'keyUp', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) })
        },
        [send],
      )

      /**
       * Put the human's own Chrome in front of them, with this tab focused.
       *
       * This is the panel declining to imitate a browser. Everything above the page —
       * the tab strip, the address bar, back and forward, extensions, the password
       * manager — belongs to the real window, and the protocol cannot draw it. So the
       * panel offers the real window instead of a picture of one.
       */
      const showInChrome = useCallback(async () => {
        setBusy('activate')
        try {
          const result = await api('/activate', { method: 'POST', body: { tabId: state.snapshot?.tab?.id } })
          if (result?.ok !== true) throw new Error(result?.error ?? 'Chrome did not come forward')
          setStatus({ kind: 'live', text: 'Chrome is in front' })
        } catch (cause) {
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          setBusy('')
        }
      }, [state.snapshot?.tab?.id])

      /**
       * Hand the pane's rectangle to the desktop shell, when there is one.
       *
       * This is the whole contract between the page and the shell: the page owns the
       * layout and reports the rectangle; the shell owns a native browser view and puts
       * it there. Neither guesses at the other. Outside a shell — a plain browser tab —
       * `window.dshDesktop` is absent and nothing here runs.
       *
       * The rectangle is watched rather than computed once, because the pane moves when
       * the sidebar is resized, collapsed, expanded to fullscreen, or when the window
       * itself is. `ResizeObserver` covers the element's own size and `scroll`/`resize`
       * cover its position, and a native view left behind at an old rectangle is a
       * rectangle of browser floating over the conversation.
       */
      useEffect(() => {
        const shell = globalThis.dshDesktop
        if (shell === undefined || shell.isShell !== true) return undefined
        const node = paneRef.current
        if (node === null || node === undefined) return undefined

        // The pane's body, not the tab's body. The tab body is the strip and the toolbar
        // and a canvas; the pane body is everything the sidebar devotes to this tab,
        // which is the rectangle a browser belongs in. Walking up to it is what makes the
        // native view the size of the pane instead of the size of a form.
        const paneAncestor = () => {
          let current = node
          while (current !== null && current.parentElement !== null) {
            const parent = current.parentElement
            if (parent === document.body) break
            const name = String(parent.className ?? '')
            if (/paneBody|pane_body/i.test(name)) return parent
            // A region of the sidebar rather than the frame around it: once an ancestor
            // is nearly the whole window, the walk has gone too far.
            const box = parent.getBoundingClientRect()
            if (box.height > globalThis.innerHeight * 0.9 && box.width > globalThis.innerWidth * 0.6) break
            current = parent
          }
          return node
        }
        const measured = paneAncestor()

        let last = ''
        const report = () => {
          const box = measured.getBoundingClientRect()
          const next = JSON.stringify({
            x: Math.round(box.left),
            y: Math.round(box.top),
            width: Math.round(box.width),
            height: Math.round(box.height),
          })
          if (next === last) return
          last = next
          shell.setPaneBox(JSON.parse(next))
          // The rectangle is the whole answer, and deliberately not `props.visible`: a
          // pane that is on screen can still be reported as not visible while the tab's
          // own info settles, and a browser hidden by a signal that lags is a browser
          // that is not there when the human looks. A hidden pane is rendered with no
          // size, so its own box already says so.
          shell.setPaneVisible(box.width > 40 && box.height > 60)
        }

        report()
        const observer = new ResizeObserver(report)
        observer.observe(node)
        if (measured !== node) observer.observe(measured)
        globalThis.addEventListener('resize', report)
        globalThis.addEventListener('scroll', report, true)
        // The pane's position changes when the panes beside it do, and neither event
        // fires for a sibling's layout change, so the frame loop is the backstop.
        const tick = setInterval(report, 400)
        return () => {
          observer.disconnect()
          globalThis.removeEventListener('resize', report)
          globalThis.removeEventListener('scroll', report, true)
          clearInterval(tick)
          shell.setPaneVisible(false)
        }
      }, [])

      /**
       * Open a blank tab in the browser the human is looking at.
       *
       * The strip is not a list of places the panel can go; it is a list of pages the
       * browser has open. Making one makes a real tab, in the real window.
       */
      const newTab = useCallback(async () => {
        setBusy('newTab')
        try {
          const result = await api('/tabs', { method: 'POST', body: { action: 'new' } })
          if (result?.ok !== true) throw new Error(result?.error ?? 'the tab was not created')
          setStatus({ kind: 'live', text: 'New tab' })
        } catch (cause) {
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          setBusy('')
        }
      }, [])

      /** Make one of the browser's tabs the one in front — which the stream follows. */
      const switchTab = useCallback(async tabId => {
        setBusy(`switch:${tabId}`)
        try {
          const result = await api('/tabs', { method: 'POST', body: { action: 'switch', tabId } })
          if (result?.ok !== true) throw new Error(result?.error ?? 'the tab did not come forward')
          setStatus({ kind: 'live', text: '' })
        } catch (cause) {
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          setBusy('')
        }
      }, [])

      /** Close one of the browser's tabs. The browser decides what comes next. */
      const closeTab = useCallback(async tabId => {
        setBusy(`close:${tabId}`)
        try {
          const result = await api('/tabs', { method: 'POST', body: { action: 'close', tabId } })
          if (result?.ok !== true) throw new Error(result?.error ?? 'the tab did not close')
        } catch (cause) {
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          setBusy('')
        }
      }, [])

      const h = React.createElement
      const button = (label, title, onClick, disabled) =>
        h(
          'button',
          {
            type: 'button',
            title,
            onClick,
            disabled: disabled === true || busy !== '',
            style: styles.toolButton,
          },
          label,
        )

      // The browser's own tabs, the active one marked. This is the strip a browser has,
      // built from the browser's list rather than from anything the panel remembers, so
      // a tab opened or closed anywhere else shows up here too.
      const strip = h(
        'div',
        { style: styles.tabStrip },
        ...tabs.map(tab => {
          const active = tab.id === activeTabId
          return h(
            'span',
            {
              key: String(tab.id),
              role: 'tab',
              'aria-selected': active,
              title: tab.url === '' ? tab.title : `${tab.title}\n${tab.url}`,
              style: active ? styles.tabChipActive : styles.tabChip,
            },
            h(
              'span',
              {
                style: styles.tabTitle,
                onClick: () => {
                  if (!active) switchTab(tab.id)
                },
              },
              tab.title === '' ? (tab.url === '' ? 'Untitled' : tab.url) : tab.title,
            ),
            h(
              'button',
              {
                type: 'button',
                title: 'Close this tab',
                'aria-label': `Close ${tab.title === '' ? 'tab' : tab.title}`,
                style: styles.tabClose,
                onClick: event => {
                  event.stopPropagation()
                  closeTab(tab.id)
                },
              },
              '×',
            ),
          )
        }),
        h(
          'button',
          {
            type: 'button',
            title: 'Open a new tab in your Chrome window',
            'aria-label': 'New tab',
            style: styles.toolButton,
            disabled: busy !== '',
            onClick: () => newTab(),
          },
          '+',
        ),
      )

      return h(
        'div',
        {
          style: styles.liveWrap,
          // The pane's own element, so the shell can be told where the pane is. Inside a
          // desktop shell this whole body is replaced by a native browser view; in a plain
          // browser the shell is absent and this is inert.
          ref: element => {
            paneRef.current = element
          },
        },
        tabs.length > 0 ? strip : null,
        h(
          'div',
          { style: styles.liveBar },
          // No back, forward, reload or address field here, and none is missing: the
          // DevTools Protocol hands over the page, never the browser window around it,
          // so a toolbar built here could only ever be an imitation of chrome the human
          // already has. The real window is one click away instead.
          h(
            'button',
            {
              type: 'button',
              title: 'Bring your Chrome window to the front with this tab focused',
              onClick: () => showInChrome(),
              disabled: busy !== '',
              style: styles.toolButton,
            },
            'Show in Chrome',
          ),
          h(
            'span',
            { style: styles.address, title: address },
            address === '' ? 'no page reported yet' : address,
          ),
          h(
            'button',
            {
              type: 'button',
              title:
                mode === 'annotate'
                  ? 'Back to controlling the page'
                  : 'Click an element in the view to annotate it',
              onClick: () => {
                setArmed(null)
                setMode(current => (current === 'annotate' ? 'interact' : 'annotate'))
              },
              style: mode === 'annotate' ? styles.toolButtonOn : styles.toolButton,
            },
            mode === 'annotate' ? 'Annotating' : 'Annotate',
          ),
        ),
        h(
          'div',
          { style: styles.liveStage },
          h('canvas', {
            ref: canvasRef,
            tabIndex: 0,
            style: mode === 'annotate' ? styles.canvasAnnotate : styles.canvas,
            onMouseDown: onPointerDown,
            onMouseMove: onMove,
            onWheel,
            onKeyDown,
            onContextMenu: event => event.preventDefault(),
          }),
          armed === null
            ? null
            : h('div', {
                style: {
                  ...styles.armed,
                  left: armed.left ?? 0,
                  top: armed.top ?? 0,
                },
              }),
          status.text === ''
            ? null
            : h('div', { style: styles.liveStatus(status.kind) }, status.text),
        ),
      )
    }

    function BrowserAnnotateBody(props) {
      const { ctx: pluginCtx } = props
      const { snapshot, streamError, refresh } = useBridgeState()
      const [mode, setMode] = useState('off')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      // Which annotations have already been handed to the composer, so the card can
      // say so and a second click does not silently duplicate the image.
      const [added, setAdded] = useState({})
      const annotations = snapshot.annotations ?? []
      // What the footer's bulk action would actually take.
      const outstanding = annotations.filter(annotation => added[annotation.id] !== true).length
      // `useTabInfo` is what says whether this tab is the one in front. It is not in
      // the documented standard props, but the live pane receives it, and it reports
      // `tab.visible` outright — which is the signal the stream must follow.
      const useTabInfo = props?.useTabInfo
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo(info => info) : undefined
      const tabVisible = tabInfo?.tab?.visible

      const inputActions = props?.inputActions
      const sessionId = props?.sessionId
      const useInput = props?.useInput
      // `useInput` is a session-scope hook, so it is called unconditionally and
      // guarded only on its RESULT: a conditional hook call would change the hook
      // order between the states where the panel has a session and where it does not.
      const draft = useInput === undefined ? '' : (useInput(state => state.draft) ?? '')

      const flash = useCallback(message => {
        setNotice(message)
        setTimeout(() => setNotice(current => (current === message ? '' : current)), 3200)
      }, [])

      /**
       * Record an element picked in the live view.
       *
       * A click on the streamed frame produces an element description and nothing
       * else — no comment yet, because the human has not typed one. The card appears
       * immediately so they can see what they hit and say what is wrong with it,
       * which is the difference between annotating and guessing.
       */
      const annotateElement = useCallback(
        async element => {
          setBusy('queue')
          try {
            const result = await api('/annotations', {
              method: 'POST',
              body: {
                comment: '',
                url: snapshot.tab?.url ?? '',
                title: snapshot.tab?.title ?? '',
                element,
                origin: 'live-view',
              },
            })
            if (result?.ok === false) throw new Error(result.error ?? 'the annotation was refused')
            const id = result?.annotation?.id
            const rect = element.rect
            let shotTaken = false
            if (typeof id === 'string' && rect !== undefined) {
              try {
                const shot = await api('/capture', { method: 'POST', body: { rect, annotationId: id } })
                shotTaken = typeof shot?.result?.dataUrl === 'string'
              } catch {
                // The annotation is already queued, and a missing crop is a visible,
                // recoverable state — the card says so and Capture can still be used.
              }
            }
            flash(
              shotTaken
                ? `Queued <${element.tag ?? 'element'}> with its screenshot.`
                : `Queued <${element.tag ?? 'element'}>, but its screenshot could not be taken.`,
            )
          } catch (cause) {
            flash(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy('')
          }
        },
        [flash, snapshot.tab?.title, snapshot.tab?.url],
      )

      const setAnnotateMode = useCallback(
        async next => {
          setBusy('mode')
          try {
            const result = await api('/annotate-mode', { method: 'POST', body: { mode: next } })
            setMode(result.mode ?? next)
            flash(next === 'off' ? 'Annotation mode off.' : `Annotation mode: ${next}. Mark up the page in Chrome.`)
          } catch (cause) {
            flash(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy('')
          }
        },
        [flash],
      )

      const capture = useCallback(async () => {
        setBusy('capture')
        try {
          await api('/capture', { method: 'POST', body: {} })
          flash('Captured the visible tab into the queue.')
        } catch (cause) {
          flash(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy('')
        }
      }, [flash])

      const removeOne = useCallback(async id => {
        try {
          await api('/annotations', { method: 'DELETE', body: { ids: [id] } })
        } catch (cause) {
          flash(cause instanceof Error ? cause.message : String(cause))
        }
      }, [flash])

      const clearAll = useCallback(async () => {
        try {
          await api('/annotations', { method: 'DELETE', body: { ids: [] } })
          flash('Queue cleared.')
        } catch (cause) {
          flash(cause instanceof Error ? cause.message : String(cause))
        }
      }, [flash])

      /**
       * Put annotations into the message the human is writing, images and all.
       *
       * This is the whole hand-off. Each annotation becomes ordinary composer
       * input — its note and its selector as text, its cropped screenshot as a
       * real draft image — so the human can add one, add five, and send them with
       * whatever else they wanted to say. Nothing is auto-sent: the draft stays
       * theirs to edit, and sending is still the gesture they already know.
       *
       * The image is registered as a browser-owned draft through the conversation
       * service rather than uploaded here, because that is the only path that
       * produces a draft id the composer will accept, and it is also the path that
       * survives the human switching session before they press Enter.
       *
       * @param list - the annotations to add.
       */
      const addToInput = useCallback(
        async list => {
          if (inputActions === undefined || sessionId === undefined) {
            flash('This panel has no composer to add to in this view.')
            return
          }
          if (list.length === 0) {
            flash('There is nothing to add yet.')
            return
          }
          const conversation = pluginCtx.get('conversation')
          if (conversation === undefined) {
            flash('The conversation service is unavailable, so the screenshots cannot be attached.')
            return
          }
          setBusy('add')
          try {
            const texts = []
            const files = []
            for (const annotation of list) {
              texts.push(annotationPrompt(annotation))
              if (annotation.hasScreenshot !== true) continue
              const shot = await api(`/screenshot?id=${encodeURIComponent(annotation.id)}`)
              if (typeof shot?.dataUrl !== 'string') continue
              const file = fileFromDataUrl(shot.dataUrl, `annotation-${annotation.id}.png`)
              if (file !== null) files.push(file)
            }
            const drafts = files.length === 0 ? [] : conversation.createDrafts(sessionId, files)
            const accepted = drafts.length === 0 ? true : inputActions.addAttachments(drafts.map(entry => entry.id))
            if (!accepted) {
              // A busy composer refuses attachments rather than dropping them on the
              // floor; the text still belongs in the draft, so it goes alone and the
              // human is told why the pixels are missing.
              flash('The composer is busy, so the screenshots were not attached — the text was added.')
            }
            const appended = [draft.trim(), texts.join('\n\n')].filter(Boolean).join('\n\n')
            inputActions.setDraft(appended)
            setAdded(current => {
              const next = { ...current }
              for (const annotation of list) next[annotation.id] = true
              return next
            })
            if (accepted) {
              flash(
                `Added ${list.length} annotation${list.length === 1 ? '' : 's'}${drafts.length > 0 ? ` with ${drafts.length} screenshot${drafts.length === 1 ? '' : 's'}` : ''} to your message.`,
              )
            }
          } catch (cause) {
            flash(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy('')
          }
        },
        [draft, flash, inputActions, pluginCtx, sessionId],
      )

      const addOne = useCallback(annotation => addToInput([annotation]), [addToInput])
      // The bulk action takes only what is still outstanding. Re-adding a card the
      // human already added would duplicate its screenshot and repeat its note in
      // their message, which is the one thing this hand-off must not do.
      const addAll = useCallback(
        () => addToInput(annotations.filter(annotation => added[annotation.id] !== true)),
        [addToInput, added, annotations],
      )

      // Two engines can be behind these tools and the panel must not confuse them. The extension
      // streams frames into this panel; the desktop app does not, because its browser is a real
      // window beside this one and there is nothing to stream — the human is already looking at
      // it. Showing a screencast of a browser that is not being streamed is how a panel ends up
      // insisting there is no browser while one answers every call.
      const appAttached = snapshot.app?.attached === true
      const connected = snapshot.connected || appAttached

      const header = h(
        'div',
        { style: styles.header },
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.dot(connected) }),
          h(
            'span',
            { style: { ...styles.title, flex: 1 } },
            snapshot.connected
              ? `Connected${snapshot.client?.browser ? ` · ${snapshot.client.browser}` : ''}`
              : appAttached
                ? `Connected · desktop browser on port ${snapshot.app.port}`
                : 'Extension not connected',
          ),
          h('button', { style: styles.iconButton, title: 'Refresh', onClick: refresh }, '⟳'),
        ),
        snapshot.connected && snapshot.tab
          ? h('div', { style: { ...styles.muted, wordBreak: 'break-all' } }, `${snapshot.tab.title ? `${snapshot.tab.title} — ` : ''}${snapshot.tab.url ?? ''}`)
          : null,
        // The app's tabs, read from the app, so the panel and the window beside it agree.
        appAttached && !snapshot.connected
          ? h(
              'div',
              { style: { ...styles.muted, wordBreak: 'break-all' } },
              (snapshot.app.tabs ?? [])
                .filter(entry => entry.conversation !== true)
                .map(entry => `${entry.active ? '▸ ' : '· '}${entry.title || entry.url || '(untitled)'}`)
                .join('\n') || 'No page is open in the browser pane.',
            )
          : null,
        h(
          'div',
          { style: styles.row },
          h('button', { style: styles.button(mode === 'quick'), disabled: busy !== '', onClick: () => setAnnotateMode(mode === 'quick' ? 'off' : 'quick') }, 'Quick annotate'),
          h('button', { style: styles.button(mode === 'inspect'), disabled: busy !== '', onClick: () => setAnnotateMode(mode === 'inspect' ? 'off' : 'inspect') }, 'Inspect'),
          h('button', { style: styles.button(false), disabled: busy !== '', onClick: capture }, busy === 'capture' ? 'Capturing…' : 'Capture'),
        ),
        h(
          'div',
          { style: styles.muted },
          'Quick annotate marks one element in a single step. Inspect keeps a picker open so you can browse elements first. Add takes an annotation into the message you are writing, screenshot and all — add as many as you like before sending.',
        ),
        // No screencast when the app is the engine: there is no frame stream to draw, and a
        // canvas that never fills is a worse answer than saying where the browser actually is.
        appAttached && !snapshot.connected
          ? h(
              'div',
              { style: styles.muted },
              'The browser is the desktop app\'s right pane, in its own window beside this one. Annotate there — right-click any element and choose "Add comment to this element" — and the annotations below are the same queue the app is holding.',
            )
          : h(LiveView, { onElement: annotateElement, visible: tabVisible }),
        streamError ? h('div', { style: { ...styles.muted, color: '#ff9f0a' } }, streamError) : null,
        notice ? h('div', { style: { ...styles.muted, color: 'var(--dsh-accent, #4d6bfe)' } }, notice) : null,
      )

      const list =
        annotations.length === 0
          ? h(
              'div',
              { style: styles.empty },
              h('div', null, connected ? 'No annotations yet.' : 'Waiting for the Chrome extension.'),
              h(
                'div',
                { style: styles.muted },
                connected
                  ? 'Press Quick annotate, then right-click any element in the browser and type what you want changed.'
                  : 'Load the Browser Annotate extension in Chrome and click its toolbar icon to connect to this DSH, or start the desktop app and use its browser pane.',
              ),
            )
          : h(
              'div',
              { style: styles.list },
              annotations.map((annotation, index) =>
                h(AnnotationCard, {
                  key: annotation.id,
                  index,
                  annotation,
                  onRemove: removeOne,
                  onAdd: addOne,
                  added: added[annotation.id] === true,
                }),
              ),
            )

      const footer = h(
        'div',
        { style: styles.footer },
        h(
          'button',
          { style: styles.button(outstanding > 0), disabled: outstanding === 0 || busy === 'add', onClick: addAll },
          busy === 'add' ? 'Adding…' : `Add ${outstanding || 'all'} to input`.trim(),
        ),
        h('button', { style: styles.button(false), disabled: annotations.length === 0, onClick: clearAll }, 'Clear'),
      )

      return h('div', { style: styles.root }, header, list, footer)
    }

    /**
     * The static definition of this tab type.
     *
     * The contract is stage one of tab-type registration: what the type IS. It is
     * a page type — no `patterns` — so it is opened by kind and recognizes no
     * resource address, which is what lets the panel open with nothing selected.
     * `priority: 'extension'` puts it in the band that ranks above shipped
     * viewers, and the guide entry is what makes it discoverable from the guide
     * page when the human has not opened it yet.
     * @returns the definition to register.
     */
    function browserDefinition() {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => 'Browser',
        guide: [
          {
            order: 40,
            title: () => 'Browser annotations',
            description: () => 'Mark up the running app in Chrome and add the exact elements, with screenshots, to your message',
          },
        ],
      }
    }

    /**
     * Bring the panel forward the first time the extension reports in.
     *
     * This rides the panel's own stream rather than opening a second one: the
     * snapshot event already carries both facts the decision needs, and a
     * plugin that holds two subscriptions to the same feed is a plugin that can
     * disagree with itself. The pane is usually closed when the extension
     * attaches, so nothing has fetched `/state` yet — the pushed snapshot is the
     * only copy of that information available at the moment it matters.
     *
     * Opening is deliberately best-effort. A tab can only be opened while a
     * session seat is mounted, and the extension may well connect before the
     * human has opened a session. A refused open is not an error: the guide entry
     * and the tab type still make the panel reachable by hand.
     *
     * @param controller - the sidebar navigation controller.
     * @returns a disposer releasing the subscription.
     */
    function revealOnFirstContact(controller) {
      let revealed = false
      return bridgeFeed(event => {
        if (revealed) return
        const connected = event.type === 'connection' ? event.connected === true : event.type === 'snapshot' && event.connected === true
        if (!connected) return
        revealed = true
        try {
          controller.openTab(TAB_KIND, { params: {} })
        } catch {
          // A panel that cannot open itself is still reachable from the guide.
        }
      })
    }

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition()), 'browser-annotate: tab type')
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            // The panel closes over this plugin's own context so it can reach the
            // conversation service, which is what turns a screenshot into a draft
            // image. The slot's own props arrive alongside it.
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, props =>
              h(BrowserAnnotateBody, { ...props, ctx }),
            ),
          ),
        'browser-annotate: tab body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () => 'Browser'),
          ),
        'browser-annotate: tab title',
      )
      // `sidebarRight` is read optionally: a deployment may ship the sidebar
      // without its navigation controller, and the panel is still worth having.
      ctx.effect(() => {
        const controller = ctx.get('sidebarRight')
        if (controller === undefined) return undefined
        return revealOnFirstContact(controller)
      }, 'browser-annotate: first-contact reveal')
    }

    // `slots` and `sidebarRightTabs` are hard requirements — without either the
    // panel has no seat to fill. `sidebarRight` is read optionally above, because
    // a deployment may ship the sidebar without its navigation controller.
    exports.inject = ['slots', 'sidebarRightTabs']

    return module.exports
  },
})
