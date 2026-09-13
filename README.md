# DSH Desktop — a browser and its annotations, beside your agent

Two pieces that meet on loopback:

| piece | what it is |
| --- | --- |
| this repo's root | the DSH plugin (`dsh-browser-annotate`): the agent's twelve browser tools, one `dsh plugin` command to install. It talks to the app over `http://127.0.0.1:7391` — no service is shared, nothing is loaded into DSH beyond the plugin itself. |
| `desktop/` | an Electron app. Left pane: your DSH web UI, started by you, in its own tab. Right pane: real Chromium, any number of tabs. |

The DSH in the left pane is yours: you run it in your terminal (`dsh web --port 3090`), copy the tokenised URL it prints, and paste it into the app. The app never starts or owns DSH.

## Run

```sh
./dev.sh 'http://127.0.0.1:3090/?token=…'   # first start, or to change the conversation URL
./dev.sh                                      # every later start; the URL persists in .dev-url
```

`dev.sh` kills only this app's Electron (other Electron apps and your `dsh web` are untouched), starts the app, waits for the annotation bridge, and prints the log path (`/tmp/dsh-desktop.log`).

To build a macOS disk image instead of running from source:

```sh
cd desktop && npm install && npm run dist    # unsigned DSH-<version>-arm64.dmg in desktop/dist/
```

The DMG is unsigned: the first launch needs *right-click → Open* (or System Settings → Privacy & Security → Open Anyway), after which it opens normally.

## The window

- **Left pane** — one tab, the conversation. It is guarded: nothing can navigate it away from DSH, because a conversation moved off its URL is a conversation lost.
- **Right pane** — as many tabs as you like. The address bar takes any URL. `⌘T` new tab, `⌘W` close, `⌘L` address, `⌘R` reload, `⌘[`/`⌘]` back/forward — in whichever pane the pointer is.
- The app always opens a Chrome DevTools Protocol port for itself; it is published as `debugPort` in `GET /health`, which is how the plugin's Playwright finds it.

## Annotating

The gesture the app exists for:

- **Quick** — right-click anything → *Add comment to this element*. A comment box opens anchored to the element; type, press Enter. The element is recorded during the right-click itself, so pages that fight for their own events still annotate.
- **Inspect** — right-click → *Inspect this element*. Hovering walks the DOM with a DevTools-style panel (selector, size, position, computed styles); `↑`/`↓` walk to the parent/first child and move the selection with them; `Enter` annotates the selected node.

Every annotation carries the comment plus exact frontend facts: CSS selector, DOM path, tag, role, accessible name, bounding rect, computed styles, element HTML, page URL/title, and a screenshot cropped to the element.

Annotations **queue** rather than fire: the toolbar shows what is waiting, you can drop any of them, and *Add to input* delivers the whole batch into the conversation's composer — formatted text plus each screenshot as a real attachment, entering through the same events a human's typing and file-drop produce. Any number can accumulate first.

The agent reads the same queue through its `annotations` tool: `list` reports it with the screenshot attached to the result, `inject` additionally delivers it into the session as a context block, `clear` removes it once you have taken responsibility for the batch.

## The agent's twelve tools

| tool | what it does |
| --- | --- |
| `openBrowserPage` | open a URL in a new tab (and refuse, with the real error, when the host cannot be reached) |
| `navigatePage` | url / reload / back / forward |
| `readPage` | accessibility-tree snapshot of a tab, optionally scoped to a selector |
| `screenshotPage` | viewport or element crop, attached as an image |
| `clickElement` / `hoverElement` / `typeInPage` | act on elements by `@ref` or selector; typing can submit |
| `dragElement` | real drag via the engine, falling back to Playwright's `dragAndDrop`, reporting which ran |
| `handleDialog` | report / accept / dismiss `alert`/`confirm`/`prompt` (the app no longer auto-answers) |
| `runPlaywrightCode` | a real Playwright function over CDP against the app's Chromium — the honest route for anything bespoke |
| `cdp` | any Chrome DevTools Protocol method against any tab |
| `annotations` | the human's annotated feedback, as above |

Two engines answer this vocabulary: the desktop app (HTTP `POST /rpc`) and, if you attach the Chrome extension from `extension/`, that Chrome too. When both are attached the extension wins. Playwright exists only through the app — an extension exposes no CDP port — and `runPlaywrightCode` says so.

## Chrome DevTools Protocol

`cdp` forwards any method to any tab (`Input`, `DOM`, `Runtime`, `Network`, `Emulation`, …). The app's own port is a normal Chromium one, so the usual client libraries work; Electron does not implement `Target.createTarget` or `Target.createBrowserContext`, and the tools say so rather than guessing — open tabs with `openBrowserPage` instead.

## Installing the plugin

The plugin is a normal profile dependency of DSH, and this repository installs directly from GitHub:

```sh
dsh plugin --profile web add github:iimaguest/dsh-browser-annotate
```

Then restart DSH. `dsh plugin --profile web remove dsh-browser-annotate` undoes it, dependency and bundle layer together; the profile's own `cordis.patch.yml` is never touched.

What that command installs: a package whose `package.json` declares itself a DSH plugin — `dsh.bundle.patch` points at `cordis.patch.yml` (one insert row carrying the host half: service, HTTP routes, tools) and `dsh.client.inject` mounts the browser sidebar into the web client. `host/` is the DSH-side half, `client/` the web-client half, `extension/` an optional Chrome MV3 extension that can act as a second engine.

For developing on a checkout of this repo instead, the same wiring can be pointed at the working tree: symlink the profile's `node_modules/dsh-browser-annotate` at your checkout (or `dsh plugin --profile web add <path>`), and run `npm run link-peers` in the repo to re-link the `@deepseek-ai/*` peers if an install ever wipes them. Every edit is live the next time DSH starts.

## Each half without the other

Neither piece assumes the other exists:

- **Plugin without the app** — DSH starts and works normally; the twelve tools register and answer with a plain "the desktop browser is not attached" (or the Chrome-extension equivalent) instead of hanging or crashing. Start the app and the next call works.
- **App without the plugin** — the app is a plain two-pane browser: tabs, address bar, annotations, the queue, delivery into the conversation's composer. It never calls DSH; it only answers HTTP on loopback, so nothing degrades when no plugin is installed anywhere.

## What has been verified live

Against the real app and a real DSH, not fixtures:

- the twelve tools driving real pages, including a failed DNS lookup refused with Chromium's own error, scoped `readPage`, dialogs that genuinely block, and a drag verified by its drop effect;
- quick annotate from a trusted right-click: recorded element → composer → comment → queue with screenshot, selector, path, role, rect, styles, HTML;
- inspect annotate: hover walk, arrow keys moving the selection, `Enter` annotating the walked-to node (`h1`, not the hovered `p`);
- two annotations delivered into the conversation's composer as formatted text plus blob image attachments, then removed through their real chip buttons;
- the `annotations` tool against a populated queue from a real session: `list` with the screenshot attached to the result, `inject` delivering the context block, queue preserved.

## Limits, stated plainly

- Closing a tab is a human affordance (`⌘W`, the tab strip); no tool verb closes one yet.
- `Target.createTarget` / `Target.createBrowserContext` are not implemented by Electron's CDP endpoint.
- The Chrome extension engine cannot serve `runPlaywrightCode`; only the app can.
