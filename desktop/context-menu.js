// The right-click menu on a page.
//
// In the extension this gesture belonged to Chrome: the human right-clicked, Chrome drew its
// menu, and an item in it opened the annotation composer. Here there is no Chrome menu to add
// an item to, so the app draws the menu — and it draws it with the platform's own menu, not an
// HTML imitation, because this menu is the one place where "does it feel like the real thing"
// is the entire question.
//
// The read-only part of that handler in the page still runs: it records the element under the
// cursor while the click is still in the page, which is the only way to annotate an element on
// a page that fights for its own events. This file is what turns that recording into a choice.

const { Menu, MenuItem, clipboard } = require('electron')

/**
 * Build and show the menu for one right-click.
 *
 * @param options.send - deliver a command to the page-side picker.
 * @param options.describe - read the recorded element, for the parts of the menu that need it.
 * @param options.onAnnotate - arm the picker and open the composer on the recorded element.
 */
async function showContextMenu({ webContents, params, send, describe, onAnnotate, onInspect }) {
  const template = []

  if (params.isEditable === true) {
    template.push(
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    )
  } else if (String(params.selectionText ?? '').trim() !== '') {
    template.push({ role: 'copy' }, { type: 'separator' })
  }

  // What the human actually right-clicked. The picker recorded it during the click; asking
  // now is the only way to label the menu with the thing being annotated.
  const element = await describe().catch(() => null)

  if (element !== null) {
    // Two entries, because these are the two gestures the human has: say something about this,
    // or walk the DOM looking for the right node first.
    template.push(
      {
        label: 'Add comment to this element',
        accelerator: 'CmdOrCtrl+Shift+A',
        click: () => onAnnotate(),
      },
      {
        label: 'Inspect this element',
        accelerator: 'CmdOrCtrl+Shift+C',
        click: () => onInspect(),
      },
      { type: 'separator' },
      {
        label: element.selector === undefined ? 'Copy selector' : `Copy selector  ${truncate(element.selector, 40)}`,
        click: () => clipboard.writeText(String(element.selector ?? '')),
      },
      {
        label: 'Copy element details',
        click: () => clipboard.writeText(formatElement(element)),
      },
      { type: 'separator' },
    )
  }

  template.push(
    { label: 'Back', enabled: webContents.navigationHistory.canGoBack(), click: () => webContents.navigationHistory.goBack() },
    { label: 'Forward', enabled: webContents.navigationHistory.canGoForward(), click: () => webContents.navigationHistory.goForward() },
    { label: 'Reload', click: () => webContents.reload() },
    { type: 'separator' },
    {
      label: 'Inspect in DevTools',
      click: () => {
        webContents.inspectElement(Math.round(params.x), Math.round(params.y))
      },
    },
  )

  return new Promise(resolve => {
    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: require('electron').BrowserWindow.fromWebContents(webContents) ?? undefined, callback: () => resolve() })
  })
}

/** Menu labels are read at a glance, so a long selector is shortened rather than wrapped. */
function truncate(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * The element details as text, for pasting into a conversation by hand.
 *
 * The same facts the annotation carries, because this is the escape hatch for the times the
 * human wants to write the message themselves.
 */
function formatElement(element) {
  const lines = []
  if (element.selector !== undefined) lines.push(`selector: ${element.selector}`)
  if (element.domPath !== undefined) lines.push(`path: ${element.domPath}`)
  if (element.role !== undefined && element.role !== '') lines.push(`role: ${element.role}`)
  if (element.accessibleName !== undefined && element.accessibleName !== '') lines.push(`name: ${element.accessibleName}`)
  if (element.text !== undefined && element.text !== '') lines.push(`text: ${String(element.text).slice(0, 200)}`)
  if (element.rect !== undefined) lines.push(`box: ${element.rect.width}×${element.rect.height} at (${element.rect.x}, ${element.rect.y})`)
  if (element.styles !== undefined) {
    for (const [property, value] of Object.entries(element.styles)) lines.push(`  ${property}: ${value}`)
  }
  return lines.join('\n')
}

module.exports = { showContextMenu, formatElement, MenuItem }
