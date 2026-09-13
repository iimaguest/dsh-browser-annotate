// The toolbar's handle on the shell.
//
// The toolbar is a separate Chromium view from the page it describes, so it reaches the
// shell the same way the DSH page does: through an explicit, small surface. It can ask
// what the tabs are, ask for an action, and ask for the menu. It cannot reach Electron.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserBar', {
  /** Ask for an action: new, close, switch, back, forward, reload, stop, go, zoom, list. */
  command: (action, payload) => ipcRenderer.invoke('browser-command', action, payload),

  /** The small native menu behind ⋮. */
  menu: () => ipcRenderer.invoke('browser-menu'),

  /** Every time the strip should be redrawn. */
  onTabs: listener => {
    const wrapped = (_event, state) => listener(state)
    ipcRenderer.on('tabs', wrapped)
    return () => ipcRenderer.removeListener('tabs', wrapped)
  },
})
