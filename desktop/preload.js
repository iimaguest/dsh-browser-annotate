// The DSH page's handle on the shell.
//
// The web page cannot see a native window, so the shell hands it a narrow, explicit
// surface instead: where the pane is, whether the browser should be showing, and where
// to point it. Everything the shell can do is on this list and nothing else is reachable
// from the page.
//
// `getBoundingClientRect` is used rather than `offsetWidth` because the pane is measured
// relative to the window, which is the coordinate space the native views are placed in.

const { contextBridge, ipcRenderer } = require('electron')

// The pane hand-off is the one contract between the page and the shell, and when it goes
// quiet there is nothing to read: a native view that is not showing looks the same whether
// the page never reported a rectangle or reported one and then withdrew it. So the last
// few calls are kept, in order, for a human to look at.
const trace = []
const record = entry => {
  trace.push(entry)
  if (trace.length > 24) trace.shift()
}

contextBridge.exposeInMainWorld('dshDesktop', {
  trace: () => trace.slice(),
  isShell: true,
  platform: process.platform,

  /** Report the pane rectangle, in the window's own CSS pixels. */
  setPaneBox(box) {
    record({ call: 'setPaneBox', box, at: Date.now() })
    return ipcRenderer.invoke('pane-box', box)
  },

  /** Show or hide the native browser over the pane. */
  setPaneVisible(visible) {
    record({ call: 'setPaneVisible', visible: visible === true, at: Date.now() })
    return ipcRenderer.invoke('pane-visible', visible === true)
  },

  /** Point the native browser at a URL. */
  go(url) {
    return ipcRenderer.invoke('browser-go', url)
  },

  /** Where the shell put the native browser, and whether it is showing. */
  viewBounds() {
    return ipcRenderer.invoke('view-bounds')
  },

  /** Hear what the native browser is doing: url, title, history, loading. */
  onState(listener) {
    const wrapped = (_event, state) => listener(state)
    ipcRenderer.on('browser-state', wrapped)
    return () => ipcRenderer.removeListener('browser-state', wrapped)
  },
})
