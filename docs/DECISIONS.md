# Design Decisions

Each entry records the decision, why it was made, and what it costs.

---

## D1. No Playwright, Puppeteer, or Selenium

**Decision.** NEXUS talks to Chromium over raw CDP that it implements itself.

**Why.** The browser-control layer is the core of the product. Later milestones (agents, self-healing, recording) need to control things the frameworks hide: which events count as "loaded", how elements are identified, which snapshot data is collected, and how errors are classified. Owning the protocol layer means:

- a full understanding of every round trip and every failure mode,
- the ability to shape the DOM model around what agents need, not around what a test framework needs,
- no third-party release schedule or bundled-browser versioning (the newer Playwright from earlier in this project failed because its pinned Chromium build wasn't installed), and
- no large dependency tree. NEXUS has zero runtime dependencies.

**Cost.** Behaviour that frameworks already handle has to be rebuilt: iframes, shadow DOM, a complete ARIA implementation, popups, and network interception. NEXUS adds these only when a milestone needs them.

## D2. Zero runtime dependencies; Node ≥ 22.18

**Decision.** NEXUS uses Node's built-in `WebSocket`, `node:test`, and native TypeScript type stripping (`node file.ts`). The only dev dependencies are `typescript` (for typechecking) and `@types/node`.

**Why.** Fewer moving parts, and no build step for development or tests.

**Cost.** Source must use only *erasable* TypeScript syntax: no `enum`, no parameter properties, no namespaces. `erasableSyntaxOnly` in `tsconfig.json` enforces this. Imports use `.ts` extensions. If NEXUS is later published as a package, it will need an emit step.

## D3. One browser-level WebSocket with flattened sessions

**Decision.** NEXUS connects once to `/devtools/browser/<id>` and attaches pages with `Target.attachToTarget({ flatten: true })`.

**Why.** One socket handles all pages and browser-level events, and the browser always knows about every target. The alternative, a separate socket per page through `/devtools/page/<id>`, can't create targets and duplicates connection handling.

## D4. Launch with `--remote-debugging-port=0` and read the endpoint from stderr

**Decision.** The OS assigns the debugging port, and NEXUS reads the `DevTools listening on ws://…` line from stderr.

**Why.** No port collisions, so parallel launches are safe, and NEXUS doesn't need to poll `/json/version`. Each launch also gets a fresh temporary profile, which is deleted on `close()`. The profile is a security boundary: NEXUS never touches the user's real browser profile, cookies, or credentials.

## D5. `backendNodeId` as element identity

**Decision.** Elements are identified by `backendNodeId`, never by `DOM.nodeId` or a JavaScript object handle.

**Why.** It stays the same for the node's lifetime without first calling `DOM.getDocument`, and the `DOM`, `Input`, `DOMSnapshot`, and `Accessibility` domains all accept it. JavaScript handles need lifetime management, and `nodeId`s are reset by each `DOM.getDocument` call.

## D6. Snapshot-based DOM inspection (`DOMSnapshot.captureSnapshot`)

**Decision.** NEXUS observes the page with one snapshot call. It does not walk the DOM through repeated `DOM.*` calls or with injected JavaScript.

**Why.** One round trip returns structure, text, input values, layout boxes, and computed visibility, all from the same instant. Matching then becomes a **pure function over plain data**, which makes it deterministic, unit-testable without a browser, and later serializable (for example, to give an agent a stable view of the page).

**Cost.** Each resolution captures the whole document. That's acceptable at current page sizes, and scoped snapshots are possible later.

## D7. ARIA roles and names computed locally (deterministic subset)

**Decision.** `getByRole` uses NEXUS's own small implementation of implicit roles and accessible names (in `src/dom/aria.ts`). It does not use Chromium's `Accessibility.queryAXTree`.

**Why.** The AX-tree API is marked experimental, behaves differently across Chromium versions and forks, and can't be unit tested. The local subset is predictable and fully covered by tests.

**Cost.** It is incomplete. Adding the `Accessibility` domain as an optional cross-check is a reasonable later step.

## D8. Real input events, not `element.click()`

**Decision.** Clicks and typing go through `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`, aimed at coordinates from `DOM.getContentQuads`.

**Why.** Pages see trusted events with real hit-testing, focus changes, and default actions such as form submission on Enter. Calling `element.click()` from JavaScript bypasses overlays, `pointer-events`, and `isTrusted` checks, so tests would pass while a real user would fail. The integration test checks `event.isTrusted === true`.

**Supporting check.** Before clicking, NEXUS hit-tests the point with `DOM.getNodeForLocation` and throws `ActionError` if another element covers it. This stops it from silently clicking the wrong thing.

## D9. Strict locators that fail fast on ambiguity

**Decision.** Single-element operations throw `AmbiguousLocatorError` as soon as more than one element matches. `.nth(i)` is the explicit opt-out.

**Why.** Silently picking the first match is the main source of non-deterministic automation. Ambiguity is a mistake in the locator, not a timing problem, so retrying won't fix it.

## D10. Condition polling for element waits; loaderId-keyed events for navigation

**Decision.** Waits on DOM state poll every 50 ms against fresh snapshots. Navigation waits are driven by events and keyed on `loaderId` (see ARCHITECTURE.md).

**Why.** Polling an explicit condition is simple and correct. Navigation is the case where event ordering really matters (a stale `load` event or one that arrives early), so it uses events.

**Next.** Use DOM mutation events (`DOM.childNodeInserted` and related events) to wake the poller sooner and reduce the number of snapshots.

## D11. Typed error taxonomy

**Decision.** Every failure category has its own `NexusError` subclass.

**Why.** Later milestones will react to failures in code ("ambiguous → refine the locator", "covered → dismiss the overlay", "not found → re-plan"). That needs error types, not message parsing.

---

# Milestone 2 decisions

## D12. Stitch iframe documents into one snapshot tree

**Decision.** `DomSnapshot.fromCdp` makes each same-process frame's document a child of its `<iframe>` element and numbers nodes depth-first.

**Why.** Locators, text and role matching, ancestry checks, and descriptions all work across frames with no special cases. Chaining through the `<iframe>` element becomes the way to scope a search to a frame. No separate frame API (such as a `frameLocator`) is needed.

**Cost.** Out-of-process iframes are separate CDP targets and aren't included. Supporting them needs auto-attach (`Target.setAutoAttach`) and a snapshot per session.

## D13. CSS selectors are evaluated per scope; role and text see everything

**Decision.** `locator(css)` runs `DOM.querySelectorAll` on the document, every shadow root (open or closed), and every frame document, then combines the results. Role and text matching run over the stitched snapshot.

**Why.** Real pages put controls inside web components and embedded frames. Searching each scope keeps CSS semantics standard within a scope without writing a CSS engine. Closed shadow roots are included because NEXUS automates on behalf of the user and isn't constrained like a page script. User-agent shadow DOM is excluded because it's the browser's internal implementation, not page content.

## D14. DOM-change signal through a CDP binding and a MutationObserver

**Decision.** A small observer script is injected into every document. It calls a `Runtime.addBinding` function, throttled to once per 16 ms, and the resulting `Runtime.bindingCalled` event wakes any pending waits.

**Why.** CDP's own `DOM.*` mutation events only cover nodes the client has already requested, which would mean keeping a live mirror of the DOM. The observer is about 15 lines, covers every frame, and turns the poll interval into a fallback (250 ms) instead of the main mechanism (50 ms). This is **observation**, not action, so it doesn't conflict with D8.

**Cost.** The page can see `window.__nexusDomChanged`. Changes that don't mutate the DOM (CSS transitions, `.checked` set through script) fall back to the 250 ms timer.

## D15. `selectOption` sets the selection through the DOM; everything else uses real input

**Decision.** Choosing an `<option>` is the one action that uses `Runtime.callFunctionOn`. It sets `option.selected` and dispatches `input` and `change`.

**Why.** Chromium draws the native `<select>` popup outside the page, so CDP input events can't reliably drive it. Before running any script, NEXUS checks against the snapshot that the option exists, isn't disabled, and that multiple values are only used on a multi-select. Failures give the same specific errors as the other actions.

## D16. Editor commands with keyboard shortcuts

**Decision.** Chords such as `ControlOrMeta+A`, `C`, `X`, `V`, `Z` and `Shift+Z` send Chromium's matching editor command (`selectAll`, `copy`, `cut`, `paste`, `undo`, `redo`) along with the key event. `ControlOrMeta` resolves to Meta on macOS and Control elsewhere.

**Why.** Normally the operating system's text handling turns these keys into edits, and CDP key events bypass it. Without the command, `Cmd+A` does nothing in headless Chromium on macOS. `fill()` relies on select-all working.

## D17. Retry only covered clicks; verify state-changing actions

**Decision.** `ElementCoveredError` (a subclass of `ActionError`) is retried until the locator's timeout. Other action errors fail immediately. `check()` and `uncheck()` re-read the state after clicking and fail if it didn't change.

**Why.** Overlays such as toasts, animations, and cookie banners are usually transient, so waiting fixes them. Errors like "not editable" or "no such option" are mistakes that waiting can't fix. Verifying after the click catches pages that cancel the click, which would otherwise pass silently.

## D18. Tasks are JSON, validated up front, and run in a fresh context

**Decision.** Task files are JSON with exactly one action key per step. `parseTask` reports **every** problem with its JSON path before anything runs. Each run gets its own `BrowserContext`, the first failure skips the remaining steps, and every step produces a `StepResult`.

**Why.**
- JSON needs no parser dependency, and it's also the natural format for a recorder (or later an agent) to write.
- Validating up front turns typos into exit code 2 instead of a confusing failure halfway through.
- A fresh context keeps runs from affecting each other.
- Structured results (action, observation, verification, screenshot, error type) are what a later self-healing or agent layer needs as input.

**Cost.** JSON has no comments. A YAML front end can be added later on top of the same `parseTask`.

---

# Recommended next milestone

**Milestone 3 — Recording and reusable tasks**

1. **Recorder:** `nexus record <url>` opens a headed browser, captures the user's clicks, typing, selections and navigations through a binding (the same approach as D14), and writes a task JSON file. For each element it picks the most robust target in this order: role and name, then label, then text, then a CSS id. This is the record-and-replay feature from the original idea, built on the existing runner.
2. **Parameterized tasks:** `{{variables}}` in step values, supplied with `--param key=value`. A recording of "search for pizza" then becomes `search for {{query}}`.
3. **Out-of-process iframes:** `Target.setAutoAttach` with flattened child sessions, plus a snapshot per frame target, for cross-site embeds such as payment widgets.
4. **Page-level events tasks need:** dialogs (`Page.javascriptDialogOpening`, with a policy to accept or dismiss), new tabs and popups (`Target.targetCreated`), and file uploads (`DOM.setFileInputFiles`).
5. **Run report:** a static HTML report built from `result.json` and the screenshots, showing each step's action, observation and verification.
