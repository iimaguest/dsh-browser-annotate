// Browser Annotate — host half.
//
// One row owns the whole host surface: the HTTP and SSE routes under
// `/browser-annotate` (which the sidebar panel reads), the upgrade route the
// Chrome extension dials, and the model-facing toolset.
//
// The browser half of this package is a separate artifact, `client/index.js`,
// declared through `dsh.client` in package.json. Nothing here imports it: the
// host tree and the browser tree never share a module instance. The two halves
// meet over the routes below, not over a service.

import { BrowserBridge } from './bridge.js'
import { PlaywrightRunner } from './playwright.js'
import { registerRoutes } from './routes.js'
import { registerBrowserTools } from './tools.js'

/** Loader row id, used for diagnostics. */
export const name = 'browser-annotate'

/**
 * Hard dependencies.
 *
 * `webServer` carries the routes and the socket upgrade. `tools` is the
 * registry the toolset is published into; because a tool registry belongs to a
 * session rather than to the process, it is injected below rather than held
 * here, so this row stays mounted while the panel and the extension socket
 * work with no session open.
 *
 * The Chrome extension is the only browser that runs a command, and it
 * attaches to `webServer` from outside the process. Nothing here needs a
 * browser service.
 */
export const inject = ['webServer']

/**
 * Host plugin body.
 *
 * @param ctx - the host-plane context for this row.
 */
export function apply(ctx) {
  const logger = ctx.logger('browser-annotate')
  const bridge = new BrowserBridge(logger)
  // Playwright attaches over the desktop app's protocol port. It is constructed here rather than
  // imported lazily inside the tool so the row has somewhere to hang its teardown, and so a host
  // without Playwright installed still mounts — only the one tool says what is missing.
  const playwright = new PlaywrightRunner(bridge.app, logger)

  ctx.effect(() => registerRoutes(ctx, bridge, logger), 'browser-annotate: routes')
  ctx.effect(
    () => () => {
      playwright.dispose()
      bridge.dispose()
    },
    'browser-annotate: teardown',
  )

  // `tools` appears when a session mounts and disappears with it. Registering
  // through `inject` means the toolset follows that lifetime exactly, instead of
  // being registered once against a registry that may not exist yet.
  ctx.inject(['tools'], scope => {
    registerBrowserTools(scope, bridge, playwright, logger)
  })

  logger.info(
    'ready — the Browser tab is in the right sidebar, and the extension dials ws://<this host>/browser-annotate/ws',
  )
}

/**
 * The module's own face, as the Cordis loader reads it.
 *
 * Some rows in a composition are consumed through the module namespace and others
 * through its default export; `dsh-host-webserver` ships both, so this row does
 * the same and cannot be mis-mounted by whichever convention the loader uses.
 */
export default { name, inject, apply }
