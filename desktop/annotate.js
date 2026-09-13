// Turning an annotation into something the agent can read.
//
// The page-side picker already supplies the part that matters most: the element, its
// selector, its computed styles, its box. What it cannot supply is a picture, and what the
// agent cannot get from text is which of forty buttons on a page the human meant. So each
// annotation is completed here with a crop of the region the human pointed at, taken from
// the engine rather than by asking the page to draw itself.
//
// The capture goes through the same Chromium that is showing the page, so what is captured
// is what is on screen — including anything a page would refuse to draw for a script.

const { nativeImage } = require('electron')

/**
 * Capture the page's visible pixels, asking again if the first answer is "not yet".
 *
 * Chromium refuses the first capture on a view whose compositor has not produced a frame, with
 * `UnknownVizError`. That is a true answer to a question asked a moment too early — and a
 * permanent failure to anyone who treats it as final, which is what happened the first time a
 * screenshot was taken through the app's API rather than from the toolbar.
 *
 * @param webContents - the view to capture.
 * @returns the captured image.
 * @throws when every attempt is refused.
 */
async function captureImage(webContents, attempts = 4) {
  let last = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await webContents.capturePage()
    } catch (error) {
      last = error
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  throw last
}

/**
 * Whether an image is one flat colour everywhere.
 *
 * A window that is behind another window has no display surface, and the capture comes back as a
 * uniform grey rectangle rather than as an error: `isEmpty()` is false, no exception is thrown,
 * and a picture of nothing is delivered as though it were a picture of the page. Sampling rather
 * than scanning keeps this cheap; a page with any content at all differs somewhere.
 */
function isUniform(image) {
  const bitmap = image.toBitmap()
  if (bitmap.length < 8) return true
  const first = bitmap.readUInt32LE(0)
  const stride = Math.max(4, Math.floor(bitmap.length / 4096 / 4) * 4)
  for (let offset = 0; offset + 4 <= bitmap.length; offset += stride) {
    if (bitmap.readUInt32LE(offset) !== first) return false
  }
  return true
}

/**
 * Capture the page's visible pixels, asking again if the answer is not yet a picture.
 *
 * Chromium refuses the first capture on a view whose compositor has not produced a frame, with
 * `UnknownVizError`. That is a true answer to a question asked a moment too early — and a
 * permanent failure to anyone who treats it as final. It also hands back a blank placeholder for
 * a window that is not in front, which is the more dangerous of the two because it looks like
 * success. Both are retried, and a placeholder that never becomes a picture is raised as the
 * failure it is so the caller can take the picture another way.
 *
 * @param webContents - the view to capture.
 * @returns the captured image.
 * @throws when every attempt is refused or blank.
 */
async function captureImage(webContents, attempts = 4) {
  let last = new Error('the capture was never attempted')
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const image = await webContents.capturePage()
      if (!image.isEmpty() && !isUniform(image)) return image
      last = new Error('the window has no display surface, so its pixels are a blank placeholder')
    } catch (error) {
      last = error
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw last
}

/**
 * Capture the region of a page that an annotation refers to.
 *
 * The picker reports CSS pixels in viewport coordinates. `capturePage` returns device pixels, so
 * the box is scaled by the ratio between the picture and the view it came from. Without that, a
 * crop on a retina display lands at half the offset it should — a picture of the wrong part of
 * the page, which reads as a screenshot of nothing in particular rather than as a bug.
 *
 * @param webContents - the view to capture.
 * @param rect - the box, in CSS pixels relative to the viewport.
 * @param options.padding - how much around the box to include, in CSS pixels.
 * @param options.maxWidth - the widest the returned picture may be, in device pixels.
 * @param options.cssSize - the view's size in CSS pixels, for the scale factor.
 * @returns a data URL, or null when the capture could not be taken.
 */
async function captureElement(webContents, rect, { padding = 8, maxWidth = 1400, cssSize = null } = {}) {
  if (webContents.isDestroyed()) return null
  const image = await captureImage(webContents)
  const size = image.getSize()
  const ratio = cssSize !== null && cssSize !== undefined && cssSize.width > 0 ? size.width / cssSize.width : 1

  // A rectangle that has collapsed to nothing — a hidden node, or one scrolled away — is
  // widened to a small box around its own corner rather than refused, because "this element
  // is not on screen" is itself worth seeing.
  const x = Math.max(0, Math.floor(((rect?.x ?? 0) - padding) * ratio))
  const y = Math.max(0, Math.floor(((rect?.y ?? 0) - padding) * ratio))
  const right = Math.min(size.width, Math.ceil(((rect?.x ?? 0) + (rect?.width ?? 0) + padding) * ratio))
  const bottom = Math.min(size.height, Math.ceil(((rect?.y ?? 0) + (rect?.height ?? 0) + padding) * ratio))
  const minimum = Math.round(24 * ratio)
  const cropWidth = Math.max(minimum, right - x)
  const cropHeight = Math.max(minimum, bottom - y)
  if (x >= size.width || y >= size.height) return null

  let cropped = image.crop({ x, y, width: Math.min(cropWidth, size.width - x), height: Math.min(cropHeight, size.height - y) })

  // A very tall element — a whole page's worth of list — is a picture nobody can read and a
  // token cost nobody asked for. It is scaled down rather than truncated, so the shape stays
  // recognisable and the human can still see they annotated the right thing.
  if (cropped.getSize().width > maxWidth) {
    const scale = maxWidth / cropped.getSize().width
    cropped = cropped.resize({ width: maxWidth, height: Math.round(cropped.getSize().height * scale), quality: 'good' })
  }
  return cropped.toDataURL()
}

/**
 * A viewport-wide capture, for the "annotate the whole screen" case.
 *
 * Annotation screenshots are the difference between the agent guessing and the agent
 * knowing, so the full-page case is deliberately available and deliberately expensive.
 */
async function captureViewport(webContents, { maxWidth = 1600 } = {}) {
  if (webContents.isDestroyed()) return null
  const image = await captureImage(webContents)
  if (image.isEmpty()) return null
  return image.getSize().width > maxWidth
    ? image.resize({ width: maxWidth, quality: 'good' }).toDataURL()
    : image.toDataURL()
}

/**
 * The text that carries an annotation into a conversation.
 *
 * Written for the model, not for a log: the selector and the styles come first because they
 * are what the human meant, and the numbers are labelled so nothing has to be inferred from
 * position in a list.
 */
function describeAnnotation(annotation, index) {
  const element = annotation.element ?? {}
  const lines = []
  lines.push(`### Annotation ${index + 1}: ${annotation.comment?.trim() || '(no comment)'}`)
  lines.push('')
  lines.push(`Page: ${annotation.title || '(untitled)'} — ${annotation.url}`)
  if (element.selector !== undefined) lines.push(`Element: \`${element.selector}\``)
  if (element.domPath !== undefined && element.domPath !== '') lines.push(`Path: ${element.domPath}`)
  if (element.role !== undefined && element.role !== '') lines.push(`Role: ${element.role}`)
  if (element.accessibleName !== undefined && element.accessibleName !== '') {
    lines.push(`Accessible name: ${JSON.stringify(String(element.accessibleName).slice(0, 200))}`)
  }
  if (element.framework !== undefined && element.framework !== null && element.framework !== '') {
    lines.push(`Framework: ${element.framework}`)
  }
  if (element.text !== undefined && element.text !== '') lines.push(`Text: ${JSON.stringify(String(element.text).slice(0, 200))}`)
  if (element.rect !== undefined) {
    const box = element.rect
    lines.push(`Box: ${Math.round(box.width)}×${Math.round(box.height)} at (${Math.round(box.x)}, ${Math.round(box.y)})`)
  }
  if (element.html !== undefined && element.html !== '') {
    const html = String(element.html)
    lines.push('')
    lines.push('Markup:')
    lines.push('```html')
    lines.push(html.length > 900 ? `${html.slice(0, 900)}…` : html)
    lines.push('```')
  }
  if (element.styles !== undefined && typeof element.styles === 'object') {
    const entries = Object.entries(element.styles).filter(([, value]) => value !== undefined && value !== '')
    if (entries.length > 0) {
      lines.push('')
      lines.push('Computed styles:')
      for (const [property, value] of entries) lines.push(`- ${property}: ${value}`)
    }
  }
  if (Array.isArray(annotation.console) && annotation.console.length > 0) {
    lines.push('')
    lines.push('Console at capture time:')
    for (const entry of annotation.console.slice(-8)) lines.push(`- [${entry.level}] ${String(entry.text).slice(0, 240)}`)
  }
  if (Array.isArray(annotation.network) && annotation.network.length > 0) {
    lines.push('')
    lines.push('Failed requests at capture time:')
    for (const entry of annotation.network.filter(item => item.ok === false).slice(-8)) {
      lines.push(`- ${entry.status} ${entry.method} ${String(entry.url).slice(0, 160)}`)
    }
  }
  return lines.join('\n')
}

module.exports = { captureElement, captureViewport, captureImage, describeAnnotation, nativeImage }
