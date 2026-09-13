// The divider's handle on the shell. It reports where the split should be; the shell is the
// only thing that moves the views, because only the shell knows the window's size.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('divider', {
  /** Set the split as a fraction of the window width. */
  set: ratio => ipcRenderer.invoke('split-set', ratio),
  /** Move the split by a small fraction, for the keyboard. */
  nudge: delta => ipcRenderer.invoke('split-nudge', delta),
})
