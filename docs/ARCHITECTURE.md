# NEXUS Architecture (Milestone 4)

## Layers

Each layer talks only to the layer directly below it.

```
 cli.ts                     `nexus run [--heal] [--ai]` / `nexus record` / `nexus draft`
    │
 Recorder   runTask()   draftTask()     record: actions → task · run (+ self-heal) → results · draft: goal → task
    │          │  └── heal/ (outline, rules, verify) ── ai/ (ClaudeAdvisor, ModelClient → Claude)
    │          │
    │               │
 expect()                   verification: retry an observation until it holds
    │
 Locator                    "how to find it": lazy, strict, chainable, auto-waiting
    │
 ElementHandle              "this exact node, now": click / hover / type / fill / press / check / select / upload
    │
 DomSnapshot + aria/match   what is on the page: every frame stitched, text, boxes, visibility, roles, state
    │
 NexusPage                  one tab = a set of CDP sessions (page + cross-site iframes): navigation,
    │                       popups, dialogs, bindings/init scripts, DOM-change + network signals
 BrowserContext             isolated storage (cookies, localStorage, cache)
    │
 NexusBrowser               one Chromium process: auto-attaches every new page paused, sets it up, resumes it
    │
 CdpClient / CdpSession     JSON messages ↔ promises and events
    │
 Transport (WebSocket)      raw text frames
    │
 Chromium (--remote-debugging-port=0)
```

## How CDP communication works

1. **Launch.** Chromium is started with `--remote-debugging-port=0` and a fresh temporary profile. NEXUS also passes switches that stop background tabs being throttled.
2. **Connect.** A single WebSocket connects to the browser-level endpoint.
3. **Commands and events.**
   - Every command is sent as `{ id, method, params, sessionId? }`, and its reply is matched by `id`.
   - Errors become a `ProtocolError`; commands that take too long become a `TimeoutError`.
   - Events are routed by `(sessionId, method)`.
   - **Order is only guaranteed within one session**, not across sessions; see *Flushing* below.
4. **Disconnects.** When the socket closes, every pending command and wait rejects with `DisconnectedError`.

## Page lifecycle: paused until set up

`NexusBrowser` calls `Target.setAutoAttach({ waitForDebuggerOnStart: true, flatten: true, filter: [page] })` at the browser level. **Every** new page target is attached *paused* before any of its scripts run. That includes tabs NEXUS creates and popups that pages open.

```
Target.createTarget / window.open / target=_blank
        │
Target.attachedToTarget (paused) ──► NexusPage.create:
        send setup (Page/Runtime/Network enable, lifecycle events, bindings,
                    init scripts, iframe auto-attach)
        send Runtime.runIfWaitingForDebugger
        await both          ◄── setup is sent *before* resuming but awaited after:
                                a noopener popup has no renderer until it runs, so
                                awaiting first would deadlock; one session processes
                                its commands in order, so setup still lands first
```

- **Popups inherit** their opener's bindings, init scripts, dialog policy and default timeout, so whatever the opener was doing (such as recording) covers the popup from its first script.
- **Pages NEXUS doesn't manage** (for example, a user's own tabs after `NexusBrowser.connect`) are resumed and detached right away.

## Sessions: the page plus out-of-process iframes

A *cross-site* iframe runs in a separate renderer process, as a separate CDP target. Each page session calls `Target.setAutoAttach({ filter: [iframe], waitForDebuggerOnStart: true })`, so these iframes are attached paused and get the **same setup as the page**. This applies recursively, for cross-site frames inside cross-site frames.

`NexusPage` keeps a map of these **frame sessions**, keyed by owner: `''` for the page itself, and the `sessionId` for each iframe target.

| Concern | Across sessions |
|---|---|
| Node identity | A `backendNodeId` is only unique within one renderer, so nodes are identified by `(owner, backendNodeId)`: a `NodeRef`. |
| Snapshot | `DOMSnapshot.captureSnapshot` runs in each session in parallel. `DomSnapshot.fromCdpParts` stitches each iframe's document under its `<iframe>` element, found with `DOM.getFrameOwner` in the parent session. |
| CSS locators | `DOM.querySelectorAll` runs in each session, in every document and shadow root. |
| DOM commands | Go to the session that owns the node (`sessionFor(owner)`). |
| Input events | **Always go to the page session**, in page-viewport coordinates. The browser routes them to the right frame. |
| Bindings, init scripts, dialogs | Set up in every session. Binding calls report `{ page, owner, executionContextId }`. |
| Network idle | One tracker across all sessions, keyed by `requestId` (which is unique across renderers). An iframe's document request can start in the parent and finish in the child, or before NEXUS attaches to the child; it's dropped once the child attaches. |

### Pointer input into a cross-site iframe

```
child:  DOM.scrollIntoViewIfNeeded(node)
page:   framePath(owner) — for each <iframe> from outermost in: scroll it into view in its parent,
        DOM.getBoxModel → content-box offset (accumulated into page-viewport coordinates)
page:   nextFrame() — wait for a compositor frame (2 × requestAnimationFrame, max 250 ms)
child:  DOM.getContentQuads(node) → center point (frame coordinates) + offset → page point
        hit-test every level: each parent must hit the next <iframe>, the child must hit the node
page:   Input.dispatchMouseEvent (move, press, release)
```

The `nextFrame()` wait is needed because the browser decides which frame receives each mouse event using hit-test data that the compositor refreshes only when it produces a frame. Right after a scroll, that data is stale, and a press can land on the parent page while the release reaches the iframe. A test showed exactly this (see DECISIONS D23).

### Keyboard input into a cross-site iframe

`DOM.focus` runs in the child session. But key events go to whichever frame the **browser** considers focused, and that updates asynchronously. So NEXUS waits until the child reports `document.hasFocus()` before sending keys.

### Hit-testing coordinates

`DOM.getNodeForLocation` takes **document** coordinates, so NEXUS adds the document's scroll offset to the viewport point. Before Milestone 3, hit tests on a scrolled page checked the wrong spot; `fixtures/tall.html` now covers this.

## Key flows

### Navigation

```
subscribe Page.lifecycleEvent ─► Page.navigate ─► { loaderId } ─► wait for lifecycle <waitUntil> with that loaderId
```

Lifecycle events are keyed by `loaderId` and buffered from before the navigation command is sent, so a stale or early `load` can't satisfy the wait. `waitUntil: 'networkidle'` uses Chromium's own `networkIdle` lifecycle event.

### Popups and tabs

- `page.waitForPopup()` resolves with the `NexusPage` of the next tab or window this page opens, whether by `window.open` or a `target=_blank` link.
- The popup is filed under its opener's `BrowserContext`, and `popup.opener` is set.
- Chromium only processes input for the **tab in front**. `NexusBrowser` tracks which tab that is and sends `Page.bringToFront` before input goes to a different page, so NEXUS can keep driving the opener while a popup is open.
- A tab that closes itself (`window.close()`) is noticed through `Target.targetDestroyed`.

### Dialogs

Every page has a **dialog policy**: `'dismiss'` (the default, so dialogs never block automation), `'accept'`, `{ accept: 'prompt answer' }`, or `'manual'` (left open for a person, as when recording).
- `Page.javascriptDialogOpening` is answered from the policy, in whichever session raised it.
- Every dialog is recorded in `page.dialogs`.
- The `dialog` and `dialogclosed` page events report dialogs opening and closing.

### Uploads

`locator.setInputFiles(paths)` uses `DOM.setFileInputFiles`. Chromium fires a trusted `change` event, exactly as a person choosing files would. The element only needs to be present: file inputs are often hidden behind a styled label. NEXUS rejects missing files, multiple files on a single-file input, and elements that aren't file inputs.

### DOM inspection and locating

These work as in Milestone 2:
- One snapshot gives structure, text, live form values, layout boxes, and visibility.
- Role and text locators are pure functions over the snapshot.
- Chaining (`locator.getByRole(…)`) scopes a search, including through an `<iframe>` element.
- Locators are lazy, strict, and auto-waiting.
- Waits wake up on DOM changes, reported by a MutationObserver through a CDP binding.

### Tasks

```
task.json ─► parseTask() (all issues at once; undeclared {{params}} included)
          ─► bindParams(task, --param values)   (unknown / missing values rejected before launch)
          ─► runTask(): fresh BrowserContext, a page stack (opener → popups), dialog policy,
                        for each step: execute → observe (url, title) → screenshot per policy → StepResult
          ─► result.json + report.html (self-contained; escapes all page-controlled text)
```

### Recording

```
page script (every frame and popup, capture phase, trusted input only)
   pointerdown ─► mark element (data-nexus-recording) ─► binding 'prepare'
   click / change / keydown ─► mark element ─► binding {kind, mark, fingerprint, value…}
        │
Recorder (Node), on each binding call:
   immediately: page.snapshot() — one round trip, answered before a navigation can commit
   find the element by its mark ─► targetFor(snapshot, node)
   in arrival order: append / merge steps
        │
page events: navigated → waitForNavigation on the triggering step (or a new goto)
             popup     → opensPopup on the triggering step; follow the popup
             close     → closePopup
             dialog closed → onDialog before the trigger, expectDialog after it
```

- **Why mark instead of looking the element up?** Looking up a live element takes two round trips: evaluate, then describe. A link click can navigate in between, destroying the element before the second round trip. A mark plus a snapshot takes one. For clicks, inspection starts at `pointerdown`, before the click is released.
- **Before-state:** the page script also captures the element's name and visible text *before* page handlers run. If the action renamed the element (a toggle), the target uses the before-name; see D28.
- **`targetFor`** tries these strategies in order: role and accessible name, a stable `#id`, visible text, `[name=…]`. Each is tried page-wide first, then inside the enclosing iframe (with `within`). Position (`nth`) is the last resort. A candidate is used only if NEXUS's own matchers resolve it to **exactly** the recorded node.
- **Flushing:** `recorder.flush()` first round-trips every session of every recorded page (`page.flushEvents()`). Actions from cross-site iframes arrive on their own session and aren't ordered with the page's.

## AI layer (Milestone 4)

**Principle: Claude proposes, NEXUS acts.** The model never touches the browser. Everything it returns goes through the same validation and live-page checks as anything a person writes.

```
                     ┌──────────────── ModelClient.create(params) ────────────────┐
 heal/, ai/ ────────►│ real: createClaudeClient() → @anthropic-ai/sdk (lazy import) │──► Claude (claude-opus-5-5)
                     │ tests: ScriptedModel / fake fetch — no network, no cost     │
                     └──────────────────────────────────────────────────────────────┘
```

### Page outline

`pageOutline(snapshot)` is the model's view of the page. Each visible element with a role becomes a line: `role "accessible name" [value="…"] [checked] [disabled] [#id]`. Leftover visible text becomes `text "…"`, and iframe content is indented. Label text and text that is already an element's name are not repeated, and identical lines are collapsed (`×5`).

It uses the same vocabulary as task targets, so the model can copy `role` and `name` straight into a target. It's typically 20–50× smaller than the page's HTML.

### Self-healing in `runTask`

```
step fails ── not ElementNotFoundError / AmbiguousLocatorError? ──► stays failed (may be a real bug)
   │
   ├─ deterministicRepair(snapshot, target, error)
   │     ambiguous substring  → same target + exact (if unique)
   │     not found            → most similar same-role name (bigram Dice ≥ 0.6, clear margin) → targetFor()
   │
   ├─ else advisor.proposeTarget(context)        context = step JSON, error, earlier steps, url, title, outline
   │     ClaudeAdvisor: output_config.format = json_schema {found, reason, target?}; effort medium
   │     parseTarget() validates the shape; "found: false" is an answer, not a failure
   │
   └─ rejectProposal(page, target): must resolve to exactly ONE VISIBLE element right now
         │
         ├─ mode 'apply'   → re-run the step with the new target; pass ⇒ step passes, repair.applied = true
         └─ mode 'suggest' → record only; the step still fails
   all verified replacements → artifacts/task.repaired.json (patched copy of the task file) + report.html
```

### Drafting (`draftTask`)

A manual tool-use loop. NEXUS owns the loop, so each step can be validated and run with the replay executor:

```
messages = [goal + outline]
loop (≤ maxSteps tool calls):
  Claude ─► run_step { step }  ─► parseTask → origin check (goto) → StepExecutor.execute
                                  ◄─ "OK" + new outline   |   is_error: validation issues / error + outline
         ─► finish { success, summary } ─► stop
  stop also on: refusal, a reply without tool calls, step limit
kept steps = [goto start] + every run_step that succeeded
```

- **Append-only conversation:** every reply, including its thinking blocks, is appended unchanged, as current Claude models require.
- **Prompt caching:** `cache_control` caches the growing prefix (system prompt, tools, earlier turns) between turns.
- **Same executor as replay:** drafting uses `StepExecutor`, the same class `runTask` uses, so a drafted step behaves identically when replayed.

### Model routing

`createModelClient()` picks the transport from the model id:
- `claude-*` → `createClaudeClient()`: the Anthropic SDK, against Anthropic's API or a gateway's `/v1/messages`.
- Anything else → `createOpenAICompatibleClient()`: translates to a gateway's `/v1/chat/completions` and back. System prompts, text and images, tools and tool calls, tool results, structured output, stop reasons and usage are mapped; thinking, effort and cache hints are dropped.

The model is chosen with `--model`, then `NEXUS_MODEL`, then `claude-opus-5-5`. The CLI loads `.env` from the working directory without overriding real environment variables.

### Claude client

- `createClaudeClient()` imports `@anthropic-ai/sdk` on first use, so the deterministic runtime never loads it.
- It adds `fallbacks: "default"` (with the `server-side-fallback-2026-07-01` beta), so a request declined by Claude's safety classifiers is retried on Anthropic's recommended fallback model.
- It maps SDK errors (authentication, rate limits, API errors, missing credentials) to `AiError`.
- Callers check `stop_reason` for `refusal` and `max_tokens` before reading content.

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
- `AiError`: calling Claude failed or Claude declined

## Testability seams

| Seam | Used by |
|---|---|
| `Transport` | `CdpClient` unit tests drive it with an in-memory fake |
| `RawNode[]` → `DomSnapshot` | DOM trees, including iframes, are built directly in tests, with no browser |
| `LocatorHost` / `ElementHost` | `Locator` and `ElementHandle` unit tests use a fake page that records CDP commands |
| `NetworkEventSource` | `NetworkTracker` is tested with scripted event sources |
| `test/helpers/server.ts` | a local HTTP server. `127.0.0.1` and `localhost` count as different sites, so embedding one in the other creates real cross-site iframes. |
| Recorder round trips | NEXUS performs real input while recording; the recorded task is compared to the expected steps, then replayed in a fresh context |
| `ModelClient` / `TargetAdvisor` | AI flows run against a `ScriptedModel` (scripted replies, recorded requests) or a fake advisor. The real SDK client is tested with an injected `fetch`. No test calls Claude. |

## Current limitations

- **Recorder:**
  - Text editing in `contenteditable` isn't recorded.
  - Hover, drag-and-drop, and scrolling aren't recorded.
  - Uploads record file names only.
  - A navigation or popup is attributed to the click or key press up to 3 s before it.
  - Steps on an opener while its popup is still open can't be expressed.
- **The recorder marks elements** with a temporary `data-nexus-recording` attribute (about 1 s). The page can observe this.
- **Pages can see what NEXUS adds:** `window.__nexusDomChanged` and the recorder's script and binding. Hiding automation is not a goal.
- **ARIA subset only.** About a dozen implicit roles and the common name sources.
- **Full snapshot on every check.** Each check captures every frame. Fine for normal pages, expensive for huge DOMs.
- **Not yet supported:** downloads, drag-and-drop, double-click, right-click, HTTP authentication dialogs, `beforeunload` when closing a page, and service workers.
- **Tasks are linear:** no conditionals, loops, or reusable sub-tasks.
- **Self-healing limits:**
  - It repairs one target per failed step.
  - It doesn't repair a broken `within` (frame) target: if the frame is gone, it gives up.
  - Similarity matching is lexical, so a renamed element with completely different words needs Claude.
- **Drafting limits:**
  - Only `goto` is restricted to the start origin; a click can still lead elsewhere.
  - Each turn resends the outline, so long drafts cost more. Caching and `--max-steps` bound this.
- **No live Claude test in the suite.** The request shape is checked offline. A real end-to-end run needs your API key.
