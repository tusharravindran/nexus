# NEXUS Architecture (Milestone 1)

## Layers

Each layer talks only to the layer directly below it.

```
 expect()                   verification: retry an observation until it holds
    │
 Locator                    "how to find it": lazy, strict, auto-waiting
    │
 ElementHandle              "this exact node, now": click / type / press / focus
    │
 DomSnapshot + aria/match   what is on the page: tree, text, boxes, visibility, roles
    │
 NexusPage                  one tab: navigation, evaluate, screenshot, snapshot
    │
 NexusBrowser               one Chromium process: targets, sessions, lifecycle
    │
 CdpClient / CdpSession     JSON messages ↔ promises and events
    │
 Transport (WebSocket)      raw text frames
    │
 Chromium (--remote-debugging-port=0)
```

## How CDP communication works

1. **Launch.** `launchChromium()` starts the browser with `--remote-debugging-port=0`, which lets the OS pick a free port, and a fresh temporary `--user-data-dir`. Chromium prints `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/<id>` to stderr, and the launcher reads that line to get the endpoint.
2. **Connect.** `CdpClient.connect()` opens a single WebSocket to that **browser-level** endpoint.
3. **Commands.** Every command is sent as `{ id, method, params, sessionId? }`. The client keeps a map of pending commands keyed by `id`. When the browser replies with `{ id, result }` or `{ id, error }`, the matching promise resolves, or rejects with a `ProtocolError`. Each command has a deadline (`TimeoutError`). A response that arrives after its command timed out is dropped.
4. **Events.** Messages without an `id` are events: `{ method, params, sessionId? }`. Handlers are registered per `(sessionId, method)`, so events from one tab never reach another tab's listeners.
5. **Sessions.** `NexusBrowser.newPage()` calls `Target.createTarget` and then `Target.attachToTarget({ flatten: true })`. "Flattened" mode means the page's commands and events travel over the same WebSocket and are tagged with a `sessionId`. `CdpSession` is the client with that `sessionId` already filled in.
6. **Disconnects.** When the socket closes, every pending command and event wait rejects with `DisconnectedError`. Later sends fail immediately, and `onDisconnect` listeners are notified once.

## Key flows

### Navigation (`page.goto`)

```
subscribe Page.lifecycleEvent ─► Page.navigate ─► { loaderId } ─► wait for lifecycle 'load' with that loaderId
```

Every new document gets a unique `loaderId`. NEXUS starts listening *before* it sends `Page.navigate`, buffers incoming events, and then waits for the `load` event of *that* `loaderId`. This means:

- a late `load` event from the previous document can never satisfy the wait, and
- a `load` event that arrives before the `Page.navigate` response is not missed.

A `#hash` navigation returns no `loaderId`, so `goto` resolves immediately. `waitForNavigation()` works the same way, but takes the `loaderId` from the next main-frame `Page.frameNavigated` event, or resolves on `Page.navigatedWithinDocument`.

### DOM inspection (`page.snapshot`)

A single `DOMSnapshot.captureSnapshot` call returns the whole main-frame tree in a compact, string-table format: node types, names, values, attributes, the live values of form inputs, `backendNodeId`s, and layout boxes with computed `visibility`. `DomSnapshot.fromCdp` converts this into linked `DomNode` objects (parent/children). A node counts as **visible** when it has a layout box larger than zero and is not `visibility: hidden`.

`backendNodeId` is the node identity used everywhere. Unlike `DOM.nodeId`, it stays the same without first calling `DOM.getDocument`, and the `DOM`, `Input`, and `DOMSnapshot` domains all accept it.

### Locating

| Locator | Resolution |
|---|---|
| `locator(css)` | Chromium evaluates the selector (`DOM.querySelectorAll` → `DOM.describeNode` → `backendNodeId`), then the result is joined with the snapshot. |
| `getByText(text)` | Pure function over the snapshot. Matches visible elements by *rendered* text and keeps only the innermost match. |
| `getByRole(role, { name })` | Pure function over the snapshot. Uses a small, deterministic subset of ARIA implicit roles and accessible-name rules, and excludes hidden or `aria-hidden` elements. |

Locators are **lazy**: creating one does nothing. On every action, the locator takes a fresh snapshot and matches against it.

Locators are **strict**: if more than one element matches, `AmbiguousLocatorError` is thrown immediately, because waiting can't fix ambiguity. Use `.nth(i)` to pick one.

Locators **auto-wait**: if nothing matches, or the match isn't actionable yet (hidden or disabled), the locator retries until its timeout. It then throws `ElementNotFoundError` or `ActionError` with the reason it last observed.

### Acting

All actions go through CDP's `Input` and `DOM` domains, so the page receives trusted events (`event.isTrusted === true`).

- **click:** `DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads` (to find the center of the first non-empty quad) → `DOM.getNodeForLocation` hit test (throws `ActionError` if another element covers the point) → `Input.dispatchMouseEvent` (move, press, release).
- **focus:** `DOM.focus`.
- **type:** checks that the element is editable → focus → one `Input.dispatchKeyEvent` keyDown/keyUp pair per character.
- **press:** looks the key up in a table of named keys (`Enter`, `Tab`, arrows, …) or treats it as a single character → focus → keyDown/keyUp. `Enter` carries `\r`, so it submits forms just as a real keypress does.

### Verifying

`expect(page).toHaveText()` and `expect(locator).toBeVisible() / toHaveText() / toHaveValue()` repeat an observation until it holds or the timeout passes. On failure they throw `VerificationError`, which includes the last observed value. Together these give the loop **action → observation → verification**.

## Errors

Every error extends `NexusError`. `ProtocolError`, `TimeoutError`, `DisconnectedError`, `LaunchError`, `NavigationError`, `EvaluationError`, `ElementNotFoundError`, `AmbiguousLocatorError`, `ActionError`, and `VerificationError` each identify a different kind of failure, so later layers (and eventually an agent) can react to the failure type instead of parsing message strings.

## Testability seams

- `Transport` interface: unit tests drive `CdpClient` with an in-memory `FakeTransport`.
- `RawNode[]` → `DomSnapshot`: unit tests build DOM trees directly, with no browser.
- `LocatorHost` interface: unit tests run `Locator` and `ElementHandle` against a fake page that records CDP commands.

## Current limitations

- **Main frame only.** Iframes and shadow DOM are not part of the snapshot, so locators cannot see into them.
- **Polling, not mutation events.** Waits re-check every 50 ms. That's deterministic, but it costs a snapshot per check.
- **Full snapshot per resolution.** Fine for normal pages; slow on very large DOMs (tens of thousands of nodes).
- **ARIA subset only.** About a dozen implicit roles and the common name sources. This is not a complete implementation of the WAI-ARIA accessible-name computation.
- **No retry when a click is covered.** Clicking a covered element fails immediately instead of waiting for, say, an animated overlay to leave.
- **`type()` appends** at the caret and does not clear the field first. There's no `fill()` yet.
- **Keyboard:** no modifier keys (Shift, Ctrl, Meta) and no key combinations.
- **One default browser context.** Pages share cookies and storage within a launch, and there are no isolated contexts yet.
- **Viewport-only screenshots**, PNG only.
- **No network control**: no request interception, no waiting for network idle.
- **Single-page waits:** `waitForNavigation` doesn't follow popups or new tabs.
