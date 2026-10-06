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

# Recommended next milestone

**Milestone 2 — Robust observation and scripted tasks**

1. **Frames and shadow DOM:** extend the snapshot to child documents (`contentDocumentIndex`) and shadow roots, and let locators resolve inside them.
2. **Faster, event-driven waiting:** wake waits on DOM mutation events, and add network-idle tracking (`Network.requestWillBeSent` / `loadingFinished`).
3. **Fuller actions:** `fill()` (select all, then replace), modifier keys and key combinations, `hover()`, `selectOption()`, `check()`, and a retry option for clicks blocked by covering elements.
4. **Isolated contexts:** `browser.newContext()` via `Target.createBrowserContext`, so tasks don't share cookies or storage.
5. **Deterministic task runner:** a declarative task file (`goto` / `click` / `type` / `expect` steps) executed by the runtime, with a structured result per step (action, observation, verification, screenshot). This is the bridge to the recorder and, later, the agent layer.
