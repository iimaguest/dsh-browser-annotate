// A pane toolbar's handle on the shell.
//
// The toolbar is a separate Chromium document from the page it describes, so it reaches the
// shell through an explicit, small surface. It asks for an action, asks for the menu, and
// listens for redraws. It cannot reach Electron, and it cannot reach the other pane.

const { contextBridge, ipcRenderer } = require('electron')

/** Which pane this toolbar belongs to, passed in by the shell at construction. */
const pane = (process.argv.find(argument => argument.startsWith('--pane=')) ?? '--pane=right').slice('--pane='.length)

contextBridge.exposeInMainWorld('browserBar', {
  pane,

  /** Ask for an action: new, close, switch, back, forward, reload, stop, go, zoom, list. */
  command: (action, payload) => ipcRenderer.invoke('pane-command', pane, action, payload),

  /** The small native menu behind ⋮. */
  menu: () => ipcRenderer.invoke('pane-menu', pane),

  /** The shell asking for the address field to take the focus, as ⌘L does. */
  onFocusAddress: listener => {
    const wrapped = () => listener()
    ipcRenderer.on('focus-address', wrapped)
    return () => ipcRenderer.removeListener('focus-address', wrapped)
  },

  /** Arm the picker: `quick` annotates the next click, `inspect` walks the DOM, `off` neither. */
  annotate: mode => ipcRenderer.invoke('annotate-mode', pane, mode),

  /** Ask the page whether the annotator is installed and what it is doing. */
  ping: () => ipcRenderer.invoke('annotate-ping', pane),

  /** What is waiting to be sent into the conversation. */
  annotations: () => ipcRenderer.invoke('annotations-list'),

  /** Send everything waiting into the conversation's composer. */
  sendAnnotations: () => ipcRenderer.invoke('annotations-send'),

  /** Forget one annotation, or all of them when no id is given. */
  clearAnnotation: id => ipcRenderer.invoke('annotations-clear', id),

  /** The queue changed, in either pane, because either pane can annotate. */
  onAnnotations: listener => {
    const wrapped = (_event, list) => listener(list)
    ipcRenderer.on('annotations', wrapped)
    return () => ipcRenderer.removeListener('annotations', wrapped)
  },

  /** One annotation was just added, so the human can be told without reading the queue. */
  onAnnotationAdded: listener => {
    const wrapped = (_event, id) => listener(id)
    ipcRenderer.on('annotation-added', wrapped)
    return () => ipcRenderer.removeListener('annotation-added', wrapped)
  },

  /** Every time the strip should be redrawn. */
  onTabs: listener => {
    const wrapped = (_event, state) => {
      // One channel carries both panes; a toolbar only draws its own.
      if (state?.pane !== undefined && state.pane !== pane) return
      listener(state)
    }
    ipcRenderer.on('tabs', wrapped)
    return () => ipcRenderer.removeListener('tabs', wrapped)
  },
})
