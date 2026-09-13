// Putting an annotation into the conversation.
//
// The conversation is a real DSH page in a real browser, started by the human in their own
// terminal, and this app has no plugin inside it and no way to call its internals. That is
// the point of it being a browser, and it is also the constraint: an annotation has to arrive
// through the same door a human's own typing and dragging arrive through.
//
// So it does. DSH's composer is a Lexical plain-text editor with a hidden file input beside
// it, and both are reachable over the Chrome DevTools Protocol, which this app can speak to
// the pages it owns:
//
//   the image  → DOM.setFileInputFiles on the composer's own file input, which fires the
//                change event DSH already listens for and becomes an attachment
//   the words  → Input.insertText into the focused editor, which is how any text arrives
//
// Nothing is faked: the same events fire as when a human attaches a file and types. That is
// also why this works against a DSH the human started themselves, on their own port, with
// their own session — no cooperation from the server is required or assumed.

const { app } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

/** Where annotation screenshots are written before being attached. */
function screenshotDirectory() {
  const directory = join(app.getPath('temp'), 'dsh-desktop-annotations')
  mkdirSync(directory, { recursive: true })
  return directory
}

/**
 * Write a data URL to a file, because a file input takes files.
 *
 * @returns the path, or null when the data is not an image this can write.
 */
function writeScreenshot(dataUrl, name) {
  if (typeof dataUrl !== 'string') return null
  const marker = dataUrl.indexOf(',')
  if (marker === -1 || !dataUrl.startsWith('data:image/')) return null
  const path = join(screenshotDirectory(), name)
  writeFileSync(path, Buffer.from(dataUrl.slice(marker + 1), 'base64'))
  return path
}

/**
 * A handle on one page's debugger, opened once and reused.
 *
 * Attaching is not free and the debugger is a single resource per page, so a delivery that
 * detached and reattached on every annotation would fight itself the moment two annotations
 * were added quickly.
 */
class PageDriver {
  constructor(webContents) {
    this.webContents = webContents
    this.attached = false
  }

  attach() {
    // One debugger per page, and it is a shared resource: the app's own tool bridge attaches to
    // the same page for its own reasons, and attaching a second time throws. Asking whether the
    // page is already attached is the question that matters — whether *this* object attached it
    // is not, and treating it as though it were made every delivery that followed a tool call
    // fail with a message about the composer, which had nothing to do with it.
    if (this.webContents.debugger.isAttached()) {
      this.attached = true
      return
    }
    this.webContents.debugger.attach('1.3')
    this.attached = true
  }

  send(method, params = {}) {
    this.attach()
    return this.webContents.debugger.sendCommand(method, params)
  }

  /** Evaluate in the page and keep the remote reference, so the result can be used as a node. */
  async handle(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: false })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
    return result.result
  }

  async value(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
    return result.result.value
  }
}

/**
 * Deliver one annotation into the conversation.
 *
 * The text goes in first and the image second, deliberately. If the attachment fails — a DSH
 * whose composer has changed shape, a page that has navigated away — the human is left with
 * the annotation as words, which is the part that carries the selector and the comment. The
 * reverse order would leave them with a picture and no explanation of what it is.
 */
async function deliver(driver, annotation, text) {
  const report = { text: false, image: false, errors: [] }

  // The composer may not be mounted yet on a freshly loaded page, and DSH mounts it late
  // enough that a delivery racing the page would find nothing. A page that cannot be read at
  // all is a different failure with a different cause, and saying "no composer" for it sends
  // the reader looking at the composer.
  let editorReady = false
  try {
    editorReady = await driver.value(
      `(() => { const e = document.querySelector('[contenteditable="true"][role="textbox"]'); return e !== null })()`,
    )
  } catch (error) {
    report.errors.push(`the conversation could not be reached: ${error.message}`)
    return report
  }
  if (editorReady !== true) {
    report.errors.push('the DSH composer is not on this page')
    return report
  }

  try {
    await driver.value(`(() => {
      const editor = document.querySelector('[contenteditable="true"][role="textbox"]')
      editor.focus()
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    })()`)
    await driver.send('Input.insertText', { text })
    report.text = true
  } catch (error) {
    report.errors.push(`text: ${error.message}`)
  }

  if (annotation.screenshot != null) {
    try {
      const path = writeScreenshot(annotation.screenshot, `annotation-${annotation.id ?? Date.now()}.png`)
      if (path === null) {
        report.errors.push('image: the screenshot is not a usable data URL')
      } else {
        // The input lives in the composer's own tool row and is hidden, which is exactly why
        // it has to be addressed as a node rather than clicked.
        const handle = await driver.handle(`document.querySelector('input[type="file"]')`)
        if (handle.subtype === 'null' || handle.objectId === undefined) {
          report.errors.push('image: this DSH has no file input in its composer')
        } else {
          await driver.send('DOM.setFileInputFiles', { files: [path], objectId: handle.objectId })
          report.image = true
        }
      }
    } catch (error) {
      report.errors.push(`image: ${error.message}`)
    }
  }

  return report
}

module.exports = { PageDriver, deliver, writeScreenshot, screenshotDirectory }
