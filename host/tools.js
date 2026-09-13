// The model-facing browser toolset.
//
// Twelve tools, and each one is traceable to something that was asked for:
//
//   the ten browser tools  — named exactly as Codex names them, so a tool list written for
//                            Codex works here without translation
//   annotations            — the human's annotated feedback, which is the reason this exists
//   cdp                    — full Chrome DevTools Protocol, asked for in the first sentence
//   runPlaywrightCode      — Playwright itself, over the desktop app's own protocol port
//
// Everything else that was once here — a status tool, a tab list, a get, a scroll, a wait, a
// console reader, a network reader, an eval, a snapshot, a domain list, a mode setter — was
// invented rather than asked for, and has been deleted. `cdp` reaches all of it and more.
//
// Nothing in this file touches a browser directly. Every call goes through the bridge, which
// finds whichever engine is answering — the Chrome extension if the human connected one, the
// desktop app otherwise — so the tools behave the same either way.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import { annotationForModel, composeAnnotationBlock, splitDataUrl } from './bridge.js'

/** Ready-made `{ type: 'text', text }` content block. */
const text = value => [{ type: 'text', text: value }]

/**
 * Cap one model-facing string so a single tool result cannot dominate context.
 * @param value - the raw string.
 * @param limit - maximum retained characters.
 * @returns the string, truncated with a marker when it exceeded the limit.
 */
function clamp(value, limit) {
  const string = String(value ?? '')
  return string.length <= limit ? string : `${string.slice(0, limit)}\n…[truncated ${string.length - limit} characters]`
}

/**
 * Marshal one raw CDP result for the model. CDP payloads embed screenshots as base64, which
 * would blow the context budget as text, so an image-bearing result is described rather than
 * inlined.
 * @param value - the raw protocol result.
 * @returns a JSON string safe to return as tool text.
 */
function marshalCdpResult(value) {
  const json = JSON.stringify(
    value,
    (key, item) => {
      if (key === 'data' && typeof item === 'string' && item.length > 256) {
        return `«base64 image omitted: ${item.length} characters — use screenshotPage instead»`
      }
      if (typeof item === 'string' && item.length > 20000) return `${item.slice(0, 20000)}…[truncated]`
      return item
    },
    2,
  )
  return json === undefined ? 'null' : json
}

/**
 * Describe one annotation to the model in the same compact form the injected block uses, so
 * both entry points agree on numbering and vocabulary.
 * @param annotation - the stored annotation.
 * @param index - zero-based queue position.
 * @returns the formatted record text.
 */
function formatAnnotation(annotation, index) {
  const record = annotationForModel(annotation, index)
  const lines = [`Annotation ${record.n}`]
  if (record.comment) lines.push(`  Comment: ${record.comment}`)
  if (record.url) lines.push(`  Page: ${record.url}`)
  if (record.selector) lines.push(`  Selector: ${record.selector}`)
  if (record.domPath && record.domPath !== record.selector) lines.push(`  DOM path: ${record.domPath}`)
  if (record.tag) lines.push(`  Element: <${record.tag}>${record.role ? ` role=${record.role}` : ''}`)
  if (record.text) lines.push(`  Text: ${clamp(record.text, 300)}`)
  if (record.rect) lines.push(`  Rect: x=${record.rect.x} y=${record.rect.y} w=${record.rect.width} h=${record.rect.height}`)
  // `framework` and `componentHint` are the two names the page can fill; the hint is the more
  // specific one, so it is what gets printed.
  const hint = record.componentHint || record.framework
  if (hint) lines.push(`  Framework: ${hint}`)
  if (record.styles && record.styles !== '(none captured)') {
    lines.push('  Computed styles:')
    lines.push(
      record.styles
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n'),
    )
  }
  if (record.html) lines.push(`  HTML: ${record.html}`)
  lines.push(`  Screenshot: ${record.hasScreenshot ? 'captured — read it with annotations' : 'none'}`)
  return lines.join('\n')
}

/**
 * Build the model-facing envelope for one screenshot plus its attachable refs.
 * @param screenshot - the capture result from the engine.
 * @param refs - durable attachment references for the captured images.
 * @param extra - additional context lines to prepend.
 * @returns the content blocks for the tool result.
 */
function screenshotContent(screenshot, refs, extra = []) {
  const lines = [...extra]
  lines.push(`Captured ${refs.length === 1 ? '1 image' : `${refs.length} images`}.`)
  if (screenshot?.url) lines.push(`Page: ${screenshot.url}`)
  if (screenshot?.viewport) {
    lines.push(`Viewport: ${screenshot.viewport.width}x${screenshot.viewport.height} px`)
  }
  if (screenshot?.selector) lines.push(`Element: ${screenshot.selector}`)
  if (screenshot?.rect) {
    lines.push(`Region: x=${screenshot.rect.x} y=${screenshot.rect.y} w=${screenshot.rect.width} h=${screenshot.rect.height}`)
  }
  lines.push('The image is attached above. It is cropped to the named element when one was given.')
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  for (const ref of refs) blocks.push({ type: 'image', attachment: ref })
  return blocks
}

/**
 * Render the app's page roster as one line per page.
 * @param pages - the `tabs` result.
 * @returns the summary text.
 */
function pageList(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return 'No browser page is open.'
  return pages
    .map(page => `  ${page.active ? '▸' : ' '} ${page.id}  ${page.title || '(untitled)'} — ${page.url || ''}${page.dialog ? `  [WAITING ON A ${String(page.dialog.type).toUpperCase()}]` : ''}`)
    .join('\n')
}

/**
 * Register every browser tool on the composing context.
 *
 * @param ctx - the agent-plane context carrying the `tools` registry, the `attachments` store,
 *   and the bridge service.
 * @param bridge - the live browser bridge instance.
 * @param playwright - the Playwright runner, or null when it could not be loaded.
 * @param logger - optional logger for tool-level diagnostics.
 */
export function registerBrowserTools(ctx, bridge, playwright, logger) {
  const register = definition => ctx.tools.register(definition)

  const requireAttachments = () => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('the attachment store is not mounted, so screenshots cannot be attached to this session')
    }
    return attachments
  }

  /**
   * Admit one data-URL screenshot into the durable attachment store.
   * @param dataUrl - the `data:image/...;base64,...` payload.
   * @param name - display name for the attachment.
   * @returns the durable image reference.
   */
  const admitScreenshot = async (dataUrl, name) => {
    const { mediaType, base64 } = splitDataUrl(dataUrl)
    if (base64.length === 0) throw new Error('the browser returned an empty screenshot')
    const refs = await admitImages(requireAttachments(), [{ mediaType, data: base64, name }])
    return refs[0]
  }

  /**
   * The page a call is about.
   *
   * A page id is the engine's own: `left:1` is the conversation pane, `right:2` the second tab
   * of the browser pane. Omitting it means the browser pane's active tab, which is what a human
   * looking at the window would call "the page".
   */
  const forPage = value => (typeof value === 'string' && value !== '' ? { tabId: value } : {})

  /** Ask the engine which pages exist, in the shape the model reads. */
  const pagesNow = async () => {
    try {
      const result = await bridge.call('tabs', {})
      return Array.isArray(result?.tabs) ? result.tabs : []
    } catch {
      return []
    }
  }

  // ── annotations: how the human's feedback reaches the model ───────────────

  /**
   * Image blocks produced by the most recent `annotations` call.
   *
   * The tool's declared output value is JSON — that is the contract the model sees in the
   * schema — so the screenshots travel beside it, through this cell, and `render` merges the two
   * into the content blocks the model actually reads.
   *
   * One slot is enough because of how the tool runtime schedules calls: a tool is `exclusive`
   * unless it declares `isConcurrencySafe` (see `executionMode` in `@deepseek-ai/dsh-tools`),
   * and this one declares nothing. Its `execute` and its `render` therefore cannot interleave
   * with another call's, so the value written by `execute` is always the value the matching
   * `render` reads. Declaring the tool concurrency-safe would silently invalidate this and must
   * not be done without moving the images into a per-call channel first.
   */
  let lastAnnotationImages = []

  register(
    defineTool({
      name: 'annotations',
      description:
        "The annotations waiting for you. Each carries the note the human typed plus the exact element they marked: CSS selector, DOM path, tag, role, accessible name, bounding rect, computed styles, element HTML, and a cropped screenshot. They are captured in the desktop app's browser pane or in an attached Chrome — this tool reports the same records either way, because the element facts are the point and not where they were collected. Reach for this INSTEAD of guessing what is wrong on a page, and instead of asking the human to describe an element in prose: the selector and styles are ground truth for finding the code and for knowing what is actually rendered. Actions: 'list' (the default) reports the queue and leaves it intact; 'inject' reports it AND injects it into this session as a user-role context block with the screenshots attached, which is what a human means when they say they annotated something for you; 'clear' reports it and removes it once you have taken responsibility for the batch. One workflow covers both halves of a fix: 'inject' to receive the annotations, then 'clear' when you are done with them.",
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'inject', 'clear'],
          description:
            "What to do with the queue. 'list' reports it and changes nothing. 'inject' also puts it into this session with screenshots attached. 'clear' also removes it.",
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'With clear, remove only these annotation ids instead of the whole queue.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            annotations: { type: 'array', required: true, items: { type: 'json' } },
            injected: { type: 'boolean', required: true },
            attachmentCount: { type: 'integer', required: true },
            source: { type: 'string', required: true },
            // Returned by every path, and rejected by this schema until now: with
            // additionalProperties false, the tool's own output failed validation, so the one
            // tool the whole feature exists for could not be called at all.
            summary: { type: 'string', required: true },
          },
        },
        // `text()` returns a block list, so it is spread: a renderer must return one flat list of
        // content blocks, never a list containing a list.
        render: (_args, value) => [...text(value.summary), ...lastAnnotationImages],
      },
      async execute(args, exec) {
        const action = args.action ?? 'list'
        // Where the queue lives depends on which engine captured it, and this is the only place
        // that has to know. The extension pushes to the host's own queue; the desktop app holds
        // its own, because its toolbar is what the human reads and a copy here could disagree.
        const gathered = await bridge.gatherAnnotations()
        const queue = gathered.annotations
        const records = queue.map((annotation, index) => annotationForModel(annotation, index))
        let injected = false
        // `render` receives only the returned value, and the value is the JSON the tool contract
        // declares — so the image blocks are handed over through this per-registration cell
        // instead of smuggled into the value.
        lastAnnotationImages = []

        // Screenshots ride along on every action, not only on `inject`. An annotation is a visual
        // claim — "this button is 4px too far left" — and the pixels are the whole point of
        // capturing it. Making the model ask a second time for something the human already handed
        // over is exactly the failure this plugin exists to remove. They are attached only when
        // the queue is non-empty, so an idle poll costs nothing.
        const refs = []
        for (const annotation of queue) {
          if (typeof annotation.screenshot !== 'string' || annotation.screenshot.length === 0) continue
          try {
            refs.push(await admitScreenshot(annotation.screenshot, `annotation-${annotation.id}.png`))
          } catch (error) {
            // A store that refuses an image must not lose the annotation text.
            logger?.warn?.(`annotation screenshot could not be attached: ${String(error)}`)
          }
        }

        if (action === 'inject' && queue.length > 0) {
          const agent = exec.agent
          if (agent === undefined) {
            throw new Error("annotations(action='inject') needs an owning agent session, and this call has none")
          }
          const block = composeAnnotationBlock(queue, 0)
          const content = [{ type: 'text', text: block }]
          for (const ref of refs) content.push({ type: 'image', attachment: ref })
          agent.inject(
            createUserMessage({
              content,
              source: { kind: 'plugin', plugin: 'dsh-browser-annotate' },
            }),
          )
          injected = true
        }
        if (action === 'clear' || Array.isArray(args.ids)) {
          await bridge.dropAnnotations(Array.isArray(args.ids) ? args.ids : [])
        }
        const shotNote =
          refs.length === 0
            ? ''
            : ` ${refs.length === 1 ? 'Its screenshot is' : 'Their screenshots are'} attached to this result.`
        const where = gathered.source === 'app' ? 'the desktop browser' : gathered.source === 'extension' ? 'the attached Chrome' : 'the browser'
        const heading =
          queue.length === 0
            ? 'No annotations are waiting. The human annotates by right-clicking an element in the browser and choosing "Add comment to this element", or with the annotate button on the toolbar.'
            : `${queue.length} annotation(s) from ${where}${injected ? ' — injected into this session as well' : ''}:${shotNote}`
        const summary = [heading, ...records.map((_record, index) => formatAnnotation(queue[index], index))].join('\n\n')
        lastAnnotationImages = refs.map(ref => ({ type: 'image', attachment: ref }))
        return {
          count: queue.length,
          annotations: records,
          injected,
          attachmentCount: refs.length,
          source: gathered.source,
          summary,
        }
      },
    }),
  )

  /** Image blocks for the most recent screenshotPage call; see the note on lastAnnotationImages. */
  let lastShotImages = []

  // ── pages ─────────────────────────────────────────────────────────────────

  register(
    defineTool({
      name: 'openBrowserPage',
      description:
        "Open a URL in the browser beside this conversation, in its own tab. Returns the page id, which every other tool accepts as `pageId`; omitting `pageId` anywhere means the browser's active tab. Use this rather than assuming a page is already open.",
      parameters: {
        url: { type: 'string', required: true, description: 'The URL to open. A bare host is treated as https.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            pages: { type: 'array', required: true, items: { type: 'json' } },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const result = await bridge.call('newTab', { url: String(args.url) })
        const tab = result?.tab ?? {}
        const pages = await pagesNow()
        return {
          pageId: String(tab.id ?? ''),
          url: String(tab.url ?? ''),
          title: String(tab.title ?? ''),
          pages,
          summary: `Opened ${tab.title || tab.url || args.url} as ${tab.id}.\n\nPages:\n${pageList(pages)}`,
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'navigatePage',
      description:
        'Move a browser page: to a URL, back, forward, or reload. With no URL and no action it reloads, which is how a stuck or stale page is recovered.',
      parameters: {
        pageId: { type: 'string', description: 'The page to move. Defaults to the browser\'s active tab.' },
        url: { type: 'string', description: 'Where to go. Omit to use `action` instead.' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'History movement, or a reload.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        // The engine takes one `action`, not a set of flags: `url`, `reload`, `back`, `forward`.
        // A URL means the first; anything else is the named action; a bare call reloads.
        const params = { ...forPage(args.pageId) }
        if (typeof args.url === 'string' && args.url !== '') {
          params.action = 'url'
          params.url = args.url
        } else {
          params.action = args.action ?? 'reload'
        }
        const result = await bridge.call('navigate', params)
        return {
          pageId: String(result?.id ?? args.pageId ?? ''),
          url: String(result?.url ?? ''),
          title: String(result?.title ?? ''),
          summary: `Now at ${result?.title || result?.url || '(unknown)'} — ${result?.url ?? ''}`,
        }
      },
    }),
  )

  // ── acting on a page ──────────────────────────────────────────────────────

  register(
    defineTool({
      name: 'clickElement',
      description:
        "Click an element with a real trusted mouse event at its centre, so the page's own handlers run exactly as they do for a human. `element` is a CSS selector or an @ref from readPage. An element outside the visible viewport is refused rather than clicked, because the click would land on whatever is really at those coordinates.",
      parameters: {
        pageId: { type: 'string', description: 'The page to click in. Defaults to the active tab.' },
        element: { type: 'string', required: true, description: 'CSS selector or @ref.' },
        expectNavigation: { type: 'boolean', description: 'Wait for the page to finish navigating after the click.' },
        force: { type: 'boolean', description: 'Click even though the element is not in the visible viewport.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            clicked: { type: 'string', required: true },
            url: { type: 'string', required: true },
            navigated: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const result = await bridge.call('click', {
          ...forPage(args.pageId),
          target: String(args.element),
          expectNavigation: args.expectNavigation === true,
          force: args.force === true,
        })
        return {
          clicked: String(result?.target ?? args.element),
          url: String(result?.url ?? ''),
          navigated: result?.navigated === true,
          summary: `Clicked ${result?.target ?? args.element}. The page is now at ${result?.url ?? ''}${result?.navigated === true ? ' (it navigated)' : ''}.`,
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'hoverElement',
      description:
        'Move the mouse over an element and leave it there, so hover-only UI — menus, tooltips, dropdowns — is open for whatever you do next.',
      parameters: {
        pageId: { type: 'string', description: 'The page to hover in. Defaults to the active tab.' },
        element: { type: 'string', required: true, description: 'CSS selector or @ref.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hovered: { type: 'string', required: true },
            at: { type: 'json' },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const result = await bridge.call('hover', { ...forPage(args.pageId), target: String(args.element) })
        return {
          hovered: String(result?.target ?? args.element),
          at: result?.at ?? null,
          summary: `Hovering ${result?.target ?? args.element} at ${result?.at ? `${result.at.x},${result.at.y}` : 'its centre'}.`,
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'dragElement',
      description:
        'Drag one element onto another with real pointer events, for drag-and-drop, sliders, and reordering. The source is pressed at its centre and moved to the target in steps, because a single jump does not produce the intermediate moves most drag handlers require.',
      parameters: {
        pageId: { type: 'string', description: 'The page to drag in. Defaults to the active tab.' },
        element: { type: 'string', required: true, description: 'What to drag: CSS selector or @ref.' },
        to: { type: 'string', required: true, description: 'Where to drop it: CSS selector or @ref.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dragged: { type: 'string', required: true },
            onto: { type: 'string', required: true },
            nativeDrag: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        // The engine names the two ends `from` and `to`, and reports them back under those
        // names. `element` and `to` are the tool's own vocabulary; the mapping stops here.
        const result = await bridge.call('drag', {
          ...forPage(args.pageId),
          from: String(args.element),
          to: String(args.to),
        })
        const from = String(result?.from ?? args.element)
        const onto = String(result?.to ?? args.to)

        // `intercepted` says whether Chromium recognised an HTML5 drag on its own. It does NOT
        // say why not, and this tool used to answer that question anyway — it told the caller
        // "this page drags with pointer events", which was invented. A reviewer disproved it on
        // a fixture with draggable="true" and real dragstart/drop handlers, where Playwright's
        // own dragAndDrop worked and this tool's explanation was false. A confident false reason
        // is worse than no reason: it sends whoever reads it off to fix a page that is fine.
        if (result?.intercepted === true) {
          return {
            dragged: from,
            onto,
            nativeDrag: true,
            summary: `Dragged ${from} onto ${onto} through the drag-and-drop protocol, so the page's own dragover and drop handlers ran.`,
          }
        }

        // Chromium did not pick the drag up. Playwright can drive one, and it is right here, so
        // the drag is finished rather than reported as done. If it is unavailable, the result
        // says the drag did not happen instead of implying that it did.
        if (playwright !== null && playwright !== undefined) {
          const fallback = await playwright
            .run({
              pageId: args.pageId,
              code: `await page.dragAndDrop(${JSON.stringify(from)}, ${JSON.stringify(onto)}); return 'dragged'`,
            })
            .catch(error => ({ ok: false, summary: error instanceof Error ? error.message : String(error) }))
          if (fallback?.ok === true) {
            return {
              dragged: from,
              onto,
              nativeDrag: true,
              summary: `Dragged ${from} onto ${onto}. Chromium did not recognise the drag itself, so Playwright dispatched the drag events for it.`,
            }
          }
          throw new Error(
            `the drag from "${from}" to "${onto}" did not happen: Chromium never recognised it as a drag, and the Playwright fallback failed too (${fallback?.summary ?? 'no reason given'})`,
          )
        }

        throw new Error(
          `the drag from "${from}" to "${onto}" did not happen: Chromium never recognised it as a drag, and Playwright is unavailable to drive one instead`,
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'typeInPage',
      description:
        "Type text into a page, or press a key. With `element` the field is focused first; without it the text goes to whatever already has focus, which is how you answer a picker the page opened itself. `submit` presses Enter after typing. `clear` empties the field first, which matters on editors that restore drafts. When the engine cannot deliver a key event, the page is told directly instead and the `dispatched` field says which happened.",
      parameters: {
        pageId: { type: 'string', description: 'The page to type in. Defaults to the active tab.' },
        element: { type: 'string', description: 'CSS selector or @ref to focus first. Omit to use the focused element.' },
        text: { type: 'string', description: 'The text to insert.' },
        key: { type: 'string', description: 'A single key to press instead of typing: Enter, Tab, Escape, Backspace, or any printable character.' },
        clear: { type: 'boolean', description: 'Empty the field before typing.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', required: true },
            typed: { type: 'string', required: true },
            key: { type: 'string', required: true },
            cleared: { type: 'boolean', required: true },
            dispatched: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const result = await bridge.call('type', {
          ...forPage(args.pageId),
          ...(typeof args.element === 'string' && args.element !== '' ? { target: args.element } : {}),
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(typeof args.key === 'string' && args.key !== '' ? { key: args.key } : {}),
          clear: args.clear === true,
          submit: args.submit === true,
        })
        const parts = []
        if (result?.typed) parts.push(`typed ${JSON.stringify(clamp(result.typed, 120))}`)
        if (result?.key) parts.push(`pressed ${result.key}`)
        if (result?.cleared) parts.push('after clearing the field')
        return {
          target: String(result?.target ?? args.element ?? '(focused element)'),
          typed: String(result?.typed ?? ''),
          key: String(result?.key ?? ''),
          cleared: result?.cleared === true,
          dispatched: String(result?.dispatched ?? ''),
          summary: `${parts.length === 0 ? 'Nothing was typed' : parts.join(', ')} in ${result?.target || args.element || 'the focused element'}.`,
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'handleDialog',
      description:
        "Answer the dialog a page is showing — alert, confirm, prompt, or beforeunload. A page with an open dialog has stopped responding, so a tool that hangs for no visible reason is usually this; call it with no `accept` to report what is being asked without answering.",
      parameters: {
        pageId: { type: 'string', description: 'The page with the dialog. Defaults to the active tab.' },
        accept: { type: 'boolean', description: 'True accepts (OK), false dismisses (Cancel). Omit to only report the dialog.' },
        promptText: { type: 'string', description: 'The text to enter when the dialog is a prompt.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dialog: { type: 'json' },
            answered: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const params = { ...forPage(args.pageId) }
        if (typeof args.accept === 'boolean') params.accept = args.accept
        if (typeof args.promptText === 'string') params.promptText = args.promptText
        const result = await bridge.call('dialog', params)
        const dialog = result?.dialog ?? null
        const answered = result?.accepted !== undefined || (dialog !== null && typeof args.accept === 'boolean')
        let summary
        if (dialog === null || dialog === undefined) {
          summary = 'No dialog is open on that page.'
        } else if (typeof args.accept !== 'boolean') {
          summary = `The page is waiting on a ${dialog.type}: ${JSON.stringify(dialog.message ?? '')}. Answer it with handleDialog and accept true or false.`
        } else {
          summary = `${args.accept ? 'Accepted' : 'Dismissed'} the ${dialog.type}: ${JSON.stringify(dialog.message ?? '')}.`
        }
        return { dialog, answered, summary }
      },
    }),
  )

  // ── reading a page ────────────────────────────────────────────────────────

  register(
    defineTool({
      name: 'readPage',
      description:
        "Read a page as text plus every interactive element with a stable @ref, its role, its accessible name, and its box. Use the @refs (or the CSS selectors) as the `element` of clickElement, typeInPage, hoverElement, and dragElement. This is the cheap way to understand a page: reach for screenshotPage when appearance matters, and readPage with `textOnly` when you only need prose.",
      parameters: {
        pageId: { type: 'string', description: 'The page to read. Defaults to the active tab.' },
        textOnly: { type: 'boolean', description: 'Return only the readable text, without the interactive element list.' },
        maxElements: { type: 'integer', description: 'Cap on interactive elements. Defaults to 120.' },
        maxChars: { type: 'integer', description: 'Cap on text characters. Defaults to 8000.' },
        selector: { type: 'string', description: 'Read only inside this element, as a CSS selector.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            elements: { type: 'array', required: true, items: { type: 'json' } },
            text: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const maxChars = args.maxChars ?? 8000
        const result = await bridge.call('snapshot', {
          ...forPage(args.pageId),
          includeText: true,
          maxElements: args.textOnly === true ? 0 : (args.maxElements ?? 120),
          maxText: maxChars,
          selector: args.selector,
        })
        const elements = Array.isArray(result.elements) ? result.elements : []
        // Which page this actually read is printed, not left to be inferred from a title two tabs
        // can share. A reviewer reported that pageId was ignored because it could not tell from
        // the answer which page it came from; the targeting was in fact correct, and the report
        // was unfalsifiable from the output. Naming the tab makes that impossible.
        const which = typeof args.pageId === 'string' && args.pageId !== '' ? args.pageId : "the browser pane's active tab"
        const lines = [`Page: ${result.title ?? ''} — ${result.url ?? ''} [${which}]`.trim()]
        if (args.textOnly !== true) {
          if (elements.length === 0) {
            lines.push('No interactive elements were found.')
          } else {
            lines.push(`${elements.length} interactive element(s):`)
            for (const element of elements) {
              const name = clamp(element.name ?? '', 120)
              const box = element.rect
                ? ` @(${Math.round(element.rect.x)},${Math.round(element.rect.y)} ${Math.round(element.rect.width)}x${Math.round(element.rect.height)})`
                : ''
              lines.push(`  @${element.ref}  <${element.tag}> role=${element.role ?? '-'}${name ? ` name="${name}"` : ''}${box}`)
            }
          }
        }
        if (typeof result.text === 'string' && result.text.length > 0) {
          lines.push('', 'Page text:', clamp(result.text, maxChars))
        }
        return {
          url: String(result.url ?? ''),
          title: String(result.title ?? ''),
          elements,
          text: typeof result.text === 'string' ? result.text : '',
          truncated: result.truncated === true,
          summary: lines.join('\n'),
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'screenshotPage',
      description:
        'Capture a picture of the page, of one element on it, or of the whole scrollable page. The image is attached to the result, so you see the pixels rather than a description of them. Use `element` to check one region, and `fullPage` for a page taller than the window.',
      parameters: {
        pageId: { type: 'string', description: 'The page to capture. Defaults to the active tab.' },
        element: { type: 'string', description: 'Capture only this element: a CSS selector or @ref.' },
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page rather than the visible viewport.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            selector: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [...text(value.summary), ...lastShotImages],
      },
      async execute(args) {
        const params = { ...forPage(args.pageId) }
        if (typeof args.element === 'string' && args.element !== '') params.selector = args.element
        if (args.fullPage === true) params.fullPage = true
        const result = await bridge.call('screenshot', params)
        const ref = await admitScreenshot(result.dataUrl, `page-${Date.now()}.png`)
        lastShotImages = [{ type: 'image', attachment: ref }]
        return {
          url: String(result.url ?? ''),
          selector: String(result.selector ?? ''),
          summary: screenshotContent(result, [ref])[0].text,
        }
      },
    }),
  )

  // ── Playwright ────────────────────────────────────────────────────────────

  register(
    defineTool({
      name: 'runPlaywrightCode',
      description:
        "Run Playwright code against the browser, for the things the other tools cannot express: reaching into iframes, locating by role or text with auto-waiting, intercepting routes, waiting on responses, and driving several pages at once. The code runs as an async function body with `page` (a Playwright Page for the tab you named), `context`, `browser`, and `console` in scope; whatever it returns is reported back. Example: `await page.getByRole('button', { name: 'Sign in' }).click(); return await page.title()`. This needs the desktop app, because Playwright connects over its protocol port; it is unavailable when the engine is a Chrome extension.",
      parameters: {
        pageId: { type: 'string', description: 'The page to bind `page` to. Defaults to the active tab.' },
        code: { type: 'string', required: true, description: 'The body of an async function. Use `return` to report a value.' },
        timeoutMs: { type: 'integer', description: 'How long to let the code run. Defaults to 30000.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            result: { type: 'json' },
            logs: { type: 'array', required: true, items: { type: 'json' } },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const outcome = await playwright.run({
          code: String(args.code),
          pageId: typeof args.pageId === 'string' ? args.pageId : undefined,
          timeoutMs: args.timeoutMs ?? 30000,
        })
        return outcome
      },
    }),
  )

  // ── protocol ──────────────────────────────────────────────────────────────

  register(
    defineTool({
      name: 'cdp',
      description:
        'Send any Chrome DevTools Protocol command to the page and get its raw result. The full protocol is reachable this way — every domain, every method — with no allow-list in between. The domain must be enabled first for its events to arrive: `cdp` with method "Page.enable" before relying on Page events, for instance. A method that does not exist returns the engine\'s own error rather than a guess. Use "Schema.getDomains" to list what this build supports.',
      parameters: {
        pageId: { type: 'string', description: 'The page to send to. Defaults to the active tab.' },
        method: { type: 'string', required: true, description: 'The protocol method, e.g. "Runtime.evaluate" or "Page.captureScreenshot".' },
        params: { type: 'json', description: 'The method parameters, as an object.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            method: { type: 'string', required: true },
            result: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.summary),
      },
      async execute(args) {
        const method = String(args.method)
        const params = args.params !== null && typeof args.params === 'object' ? args.params : {}
        const result = await bridge.call('cdp', { ...forPage(args.pageId), method, params })
        const rendered = marshalCdpResult(result)
        return { method, result: rendered, summary: `${method} returned:\n${clamp(rendered, 12000)}` }
      },
    }),
  )
}

/**
 * Admit a batch of images into the durable attachment store.
 *
 * The store is `ctx.attachments`, and the one entry point it publishes for wire images is
 * `admitEncodedImages(store, [{ mediaType, data, name? }])`, where `data` is canonical base64
 * with no `data:` prefix. This function used to guess at `store.admit` and `store.admitMany`;
 * neither exists, so every screenshot died with `store.admit is not a function` — an internal
 * TypeError that reads like a broken harness rather than like a wrong guess. It calls the real
 * function directly, so a change to that contract fails at load rather than at the moment a
 * human asks for a picture.
 *
 * @param store - the session's attachment store.
 * @param images - `{ mediaType, data, name }` records.
 * @returns the durable attachment references, in order.
 */
async function admitImages(store, images) {
  return admitEncodedImages(store, images)
}
