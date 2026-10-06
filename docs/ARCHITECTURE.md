# NEXUS Architecture (Milestone 2)

## Layers

Each layer talks only to the layer directly below it.

```
 cli.ts / runTask()         declarative tasks: validate → run steps → StepResult per step
    │
 expect()                   verification: retry an observation until it holds
    │
 Locator                    "how to find it": lazy, strict, chainable, auto-waiting
    │
 ElementHandle              "this exact node, now": click / hover / type / fill / press / check / select
    │
 DomSnapshot + aria/match   what is on the page: stitched frames, text, boxes, visibility, roles, state
    │
 NexusPage                  one tab: navigation, evaluate, screenshot, snapshot, DOM-change + network signals
    │
 BrowserContext             isolated storage (cookies, localStorage, cache)
    │
 NexusBrowser               one Chromium process: targets, sessions, contexts, lifecycle
    │
 CdpClient / CdpSession     JSON messages ↔ promises and events
    │
 Transport (WebSocket)      raw text frames
    │
 Chromium (--remote-debugging-port=0)
```

## How CDP communication works

1. **Launch.** `launchChromium()` starts the browser with `--remote-debugging-port=0`, which lets the OS pick a free port, and a fresh temporary `--user-data-dir`. The launcher reads the `DevTools listening on ws://…` line from stderr to get the endpoint.
2. **Connect.** `CdpClient.connect()` opens a single WebSocket to the **browser-level** endpoint.
3. **Commands.** Every command is sent as `{ id, method, params, sessionId? }`. Pending commands are kept in a map keyed by `id`. A reply resolves the matching promise, or rejects it with a `ProtocolError`. Each command has a deadline (`TimeoutError`). A response that arrives after its command timed out is dropped.
4. **Events.** Messages without an `id` are events. Handlers are registered per `(sessionId, method)`.
5. **Sessions.** Pages are created with `Target.createTarget`, optionally inside a `browserContextId`, and attached with `Target.attachToTarget({ flatten: true })`. All traffic shares one socket, and each message is tagged with its page's `sessionId`.
6. **Disconnects.** When the socket closes, every pending command and wait rejects with `DisconnectedError`.

## Page setup

When a page is created, NEXUS enables these CDP domains and features:

| Command | Why |
|---|---|
| `Page.enable`, `Page.setLifecycleEventsEnabled` | navigation and lifecycle events (`load`, `DOMContentLoaded`, `networkIdle`) |
| `Runtime.enable`, `Runtime.addBinding` | the DOM-change signal (see below) |
| `Network.enable` | in-flight request tracking for `waitForNetworkIdle` |
| `Page.addScriptToEvaluateOnNewDocument` | installs the DOM-change observer in every document and frame |

## Key flows

### Navigation

```
subscribe Page.lifecycleEvent ─► Page.navigate ─► { loaderId } ─► wait for lifecycle <waitUntil> with that loaderId
```

Every new document gets a unique `loaderId`. NEXUS buffers lifecycle events from *before* the navigation command is sent, then waits for the event that matches this navigation's `loaderId`. A stale event from the previous document can't satisfy the wait, and an event that arrives early isn't missed. `waitUntil: 'networkidle'` waits for Chromium's own `networkIdle` lifecycle event: no network connections for 500 ms after `load`.

### DOM inspection

`DOMSnapshot.captureSnapshot` returns one entry in `documents[]` for each **same-process frame**. `DomSnapshot.fromCdp` stitches them into a single tree:
- Each `<iframe>` element's child is its content document, using `contentDocumentIndex`.
- Nodes are numbered depth-first, so iframe content comes in document order right after its `<iframe>`.
- Every node records its `frameId`.
- Open and closed **shadow-root content** already appears as children of its host. User-agent shadow DOM, such as an `<input>`'s internals, is excluded.

The snapshot also includes live form state:
- `inputValue` for inputs and textareas,
- `checked` for checkboxes and radios,
- `selected` for `<option>`s.

Chromium omits empty values and has no `inputValue` for `<select>`, so `formValue()` works these out the same way `element.value` would.

### Locating

| Locator | Resolution |
|---|---|
| `locator(css)` | `DOM.getDocument({ pierce: true })`, then `DOM.querySelectorAll` in **every scope**: the document, each open or closed shadow root, and each iframe document. Results are joined with the snapshot by `backendNodeId`. A single selector doesn't cross a shadow or frame boundary. |
| `getByText` / `getByRole` | Pure functions over the stitched snapshot, so they see into frames and shadow roots automatically. |
| `parent.getByRole(...)` (chaining) | Matches only descendants of the parent locator's matches. Chaining through an `<iframe>` element scopes the search to that frame. |

Locators are **lazy** (a fresh snapshot on every attempt). They are **strict**: ambiguity throws immediately, and `.nth(i)` opts out. And they **auto-wait** until the element is visible and, for clicks and fills, enabled.

### Waiting: change-driven polling

Waits re-run their condition against a fresh snapshot. Since Milestone 2, they don't just poll on a timer:

```
page: MutationObserver ──(throttled, 16ms)──► window.__nexusDomChanged()  ── Runtime.bindingCalled ──► NexusPage.onDomChange
                                                                                                         │
Locator.waitFor / #resolve ─► poll(probe, { wake: onDomChange, intervalMs: 250 }) ◄──────────────────────┘
```

A DOM change wakes the waiter immediately. The 250 ms timer is only a fallback for changes that don't mutate the DOM, such as CSS transitions, scrolling, or checked state changing through a property.

`waitForNetworkIdle()` is fully event-driven. `NetworkTracker` counts in-flight requests:
- A request starts on `Network.requestWillBeSent`. Redirects reuse the same `requestId`, so they aren't counted twice.
- It ends on `Network.loadingFinished` or `Network.loadingFailed`.
- The wait resolves once the count stays at or below `maxInflight` for `idleMs`. On timeout, the error names the URLs still pending.

### Acting

All pointer and keyboard input goes through CDP's `Input` domain, so the page receives trusted events.

| Action | Mechanism |
|---|---|
| `click` | `DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads` (find the center point) → `DOM.getNodeForLocation` (hit test) → mouse move, press, release. Quads are already in main-viewport coordinates, iframes included. |
| `hover` | Same targeting as `click`, then only `mouseMoved` |
| `type` | One keyDown/keyUp pair per character |
| `fill` | Focus → `ControlOrMeta+A` with the `selectAll` editor command → type the value, or press `Delete` for an empty value |
| `press` | A key or chord. Modifiers are pressed in order and released in reverse, each event carrying the right modifier bitmask. Shortcuts carry the matching editor command (`selectAll`, `copy`, `cut`, `paste`, `undo`, `redo`) because the operating system's text handling, which normally turns these keys into edits, never sees CDP key events. |
| `check` / `uncheck` | Click only if the state differs, then **verify** the state changed. A click a page script cancels is reported, not silently accepted. |
| `selectOption` | Validated against the snapshot: the option exists, isn't disabled, and multiple values are only used on a multi-select. Then `Runtime.callFunctionOn` sets `option.selected` and dispatches `input` and `change`. Native `<select>` popups are drawn outside the page, so input events can't drive them. |

**Transient overlays:** if the hit test finds a different element on top, the action throws `ElementCoveredError`. The locator then re-resolves the element and retries every 100 ms until its timeout. Other `ActionError`s are not retried.

### Contexts

`browser.newContext()` calls `Target.createBrowserContext({ disposeOnDetach: true })`. Pages created in that context share cookies and storage with each other but not with any other context. `context.close()` closes its pages and calls `Target.disposeBrowserContext`. `browser.newPage()` uses the default context.

### Tasks

```
task.json ──parseTask()──► Task (typed, validated; all issues reported at once)
                              │
runTask() ─► new BrowserContext ─► for each step:
                                     execute (locate → act / wait / expect)
                                     observe (url, title)
                                     screenshot (policy: off | on-failure | every-step)
                                     → StepResult { status, durationMs, description, observation, screenshot, error{type,message} }
                                   first failure ⇒ remaining steps 'skipped'
          ─► result.json in the artifacts directory
```

Errors are recorded by their type name (`ElementNotFoundError`, `AmbiguousLocatorError`, `ElementCoveredError`, `VerificationError`, …). That lets later layers react to the kind of failure without parsing messages. `cli.ts` wraps `runTask` and exits with `0` (passed), `1` (a step failed) or `2` (invalid task or usage).

## Errors

Every error extends `NexusError`:
- `ProtocolError`
- `TimeoutError`
- `DisconnectedError`
- `LaunchError`
- `NavigationError`
- `EvaluationError`
- `ElementNotFoundError`
- `AmbiguousLocatorError`
- `ActionError`, and its subclass `ElementCoveredError`
- `VerificationError`
- `TaskValidationError`, which carries an `issues[]` list

## Testability seams

| Seam | Used by |
|---|---|
| `Transport` | `CdpClient` unit tests drive it with an in-memory fake |
| `RawNode[]` → `DomSnapshot` | DOM trees are built directly in tests, with no browser |
| `LocatorHost` | `Locator` and `ElementHandle` unit tests use a fake page that records CDP commands |
| `NetworkEventSource` | `NetworkTracker` is tested with a scripted event source |
| `test/helpers/server.ts` | a local HTTP server for real network traffic and an http origin (for cookies and storage) |

## Current limitations

- **Out-of-process iframes (OOPIFs)** are not supported. These are cross-site iframes that Chromium runs in a separate renderer process: they get their own CDP target, and the snapshot doesn't include them. Same-origin, `srcdoc`, and `file://` frames work.
- **CSS selectors don't cross boundaries.** Each selector matches within a single document or shadow root; use chaining to cross one.
- **Full snapshot on every check.** DOM-change wake-ups mean fewer checks, but each one still captures the whole page, which is expensive on very large DOMs.
- **ARIA subset only.** About a dozen implicit roles and the common name sources. `<select multiple>` reports the `combobox` role, not `listbox`.
- **No support yet for** browser dialogs (`alert`, `confirm`), file uploads, downloads, popups or new tabs, drag-and-drop, double-click, or right-click.
- **`selectOption` sets the selection through the DOM.** It doesn't drive the native popup (a deliberate choice; see DECISIONS D15).
- **Tasks are static.** No variables or parameters, no conditionals, no loops, no reusable sub-tasks.
- **The DOM-change observer is visible to page scripts** as `window.__nexusDomChanged`. Hiding automation from the page is not a goal.
