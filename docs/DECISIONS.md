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

# Milestone 3 decisions

## D19. Node identity is (session, backendNodeId)

**Decision.** Every `DomNode` carries an `owner`: `''` for the page's own renderer, otherwise the `sessionId` of a cross-site iframe. `NodeRef = { owner, backendNodeId }` is the identity used everywhere: snapshots, CSS results, element handles.

**Why.** A `backendNodeId` is only unique within one renderer process, and two processes can produce the same id. Treating ids as global would make a click inside a cross-site frame target an unrelated node in the page.

## D20. One NexusPage = many sessions, all set up identically

**Decision.** Cross-site iframes are auto-attached as sessions of the page, recursively, and get the same setup as the page: domains, bindings, init scripts, dialog handling, and network tracking. DOM commands go to the node's own session. Input always goes to the page session, in page coordinates.

**Why.** It makes cross-site iframes invisible to higher layers: locators, the recorder and the runner don't change. Sending input through the page session is the only reliable way to get trusted events with the browser's own routing between frames.

## D21. Pages are attached paused and set up before they run

**Decision.** Browser-level `Target.setAutoAttach({ waitForDebuggerOnStart: true })` for page targets. Setup commands are *sent*, then the page is resumed, then both are awaited. Popups inherit their opener's bindings, init scripts and dialog policy.

**Why.** Without this, a popup's first actions happen before NEXUS has installed anything. Recording missed clicks in popups, and the test suite showed it intermittently. Sending before awaiting avoids a deadlock: a `noopener` popup has no renderer until it is resumed, and commands to a session are processed in order anyway.

## D22. Bring the target tab to the front before input

**Decision.** `NexusBrowser` tracks which tab is in front and sends `Page.bringToFront` before input goes to a different page. Chromium is also launched with background throttling disabled.

**Why.** Chromium doesn't process input events for background tabs; `Input.dispatchMouseEvent` simply never returns. Opening a `target=_blank` link moves the opener to the background, so continuing on the opener hung until this was in place. The launch switches alone didn't fix it.

## D23. Three input-delivery details, each found by a failing test

1. **`DOM.getNodeForLocation` takes document coordinates.** NEXUS adds the frame document's scroll offset. Before this, every hit test on a scrolled page checked the wrong spot; Milestone 1's fixtures never scrolled.
2. **Wait for a compositor frame before pointer input into a cross-site iframe.** The browser picks which frame receives each mouse event using hit-test data the compositor refreshes per frame. Right after a scroll, a press went to the parent page while the release reached the iframe. The widget fixture logged `mouseup` with no `mousedown`.
3. **Wait for a cross-site iframe to report `document.hasFocus()` before typing.** Key events go to the frame the browser considers focused, and that updates asynchronously after `DOM.focus`.

**Why record these.** They are invisible in single-frame, unscrolled tests and intermittent elsewhere. Each now has a deterministic test that reproduced it.

## D24. Recorder: mark-and-snapshot, not evaluate-and-describe

**Decision.** The page script tags the element with a temporary `data-nexus-recording` mark, and NEXUS immediately requests one DOM snapshot and finds the mark in it. For clicks, this starts at `pointerdown`.

**Why.** Looking up a live element takes two round trips: `Runtime.evaluate`, then `DOM.describeNode`. A link click on localhost navigates *between* them; we measured the context gone within about 20 ms. One round trip, sent before the click is even released, is answered before the navigation commits.

**Cost.** The page can observe the attribute for about a second. A per-element fingerprint (id, role, text) is kept as a fallback, and the recorder warns whenever it had to use it.

## D25. Recorded targets are generated by the replay matchers, and checked by them

**Decision.** `targetFor` builds candidate targets in a fixed order of preference: role and name, stable id, text, name attribute, then position. It keeps the first one that NEXUS's own `matchByRole` / `matchByText` / attribute matching resolves to *exactly* the recorded node. Each strategy is tried page-wide first, then within the enclosing iframe.

**Why.** If the recorder used its own logic to describe elements, recorded tasks could be ambiguous when replayed. Using the replay matchers makes recording and replay agree by construction. User-facing targets (role and name) survive restyling and refactoring far better than CSS paths.

## D26. Record intent, not events

**Decision.**
- Typing becomes one `fill` with the final value, recorded on `change`, or before Enter or Escape.
- Toggles become `check`/`uncheck`, from `change`, not from clicks.
- Selects become `select` by label.
- Clicks on form fields themselves aren't recorded.

**Why.** Raw event logs replay brittlely and read badly. A task is meant to be edited by people (and later by an agent), so it should read like what a person meant to do.

## D27. `{{params}}` are declared, and checked before launch

**Decision.** Tasks declare `"params"` with a default, or `null` when a value is required. Undeclared placeholders are a validation error, and unknown or missing `--param` values exit with code 2 before the browser starts.

**Why.** A typo in a placeholder should never send the literal text `{{nmae}}` to a real form.

## D28. Recorded targets use the element's state *before* the action

**Decision.** The page script captures the element's accessible name and visible text synchronously, in the capture phase, before any page handler runs. If the snapshot shows a different name (the action renamed the element), `targetFor` targets the *before* name. It requires that no *other* element has that name.

**Why.** The snapshot can only be taken after the page's click handler has run, and a toggle ("Show details" → "Hide details", "Follow" → "Following") would otherwise be recorded by its *after* name, which doesn't exist when replay starts. The test suite found this intermittently on a popup button that renames itself. Keyboard-activated clicks, which have no `pointerdown`, hit it every time.

---

# Milestone 4 decisions

## D29. Claude proposes, NEXUS acts

**Decision.** The model never drives the browser directly. Its outputs are *proposals*: a target, or a task step. NEXUS validates each one (`parseTarget` / `parseTask`), checks it against the live page (`rejectProposal`), and executes it with the same code as replay.

**Why.** Model output can be wrong, and pages can contain text written to manipulate a model. Routing everything through the deterministic layer means a bad proposal fails the way a bad hand-written step would, with a typed error, instead of doing something unexpected. It also keeps every AI decision visible in the result, the report, and a reviewable file.

## D30. One runtime dependency, loaded lazily

**Decision.** `@anthropic-ai/sdk` is the first runtime dependency. It's imported dynamically by `createClaudeClient()` and nowhere else. Types use `import type`, which disappears at runtime.

**Why.** The official SDK handles authentication (API key, auth token, `ant auth login` profiles), retries, typed errors and current API shapes. Using it avoids maintaining a hand-written HTTP client that drifts from the API. Loading it lazily keeps the deterministic runtime free of it.

## D31. Repair only locator failures; rules before models; review before adoption

**Decision.**
- Only `ElementNotFoundError` and `AmbiguousLocatorError` are repairable.
- Rule-based repair runs first, and Claude is consulted only when no rule applies.
- `--heal=suggest` records repairs without passing the step.
- Repaired targets are written to `task.repaired.json`, never back into the task file.

**Why.**
- A failed `expect` or a timeout can be a genuine regression, and "healing" it would hide the bug the task exists to catch.
- Rules are free, instant and deterministic.
- Silently rewriting someone's task file would make test history impossible to trust.

## D32. The model sees an outline, not HTML

**Decision.** AI features send `pageOutline(snapshot)`: roles, accessible names, state, stable ids and visible text. They don't send HTML, and send screenshots only with `--ai-screenshots`.

**Why.** The outline uses the same vocabulary as task targets, so a proposal can be copied and checked directly. It's a small fraction of the HTML's size (cost, speed), and it shares only what a person viewing the page could see. Hidden inputs, scripts and attributes are left out.

## D33. Structured output for repairs, a tool loop for drafting

**Decision.**
- Repairs use one request with `output_config.format` (a JSON schema for `{found, reason, target?}`) at `medium` effort.
- Drafting uses a manual tool-use loop (`run_step`, `finish`) at `high` effort, with the full reply appended each turn and the growing prefix cached.

**Why.**
- A repair is a single decision, and a schema-constrained reply makes it parseable by construction. NEXUS still validates the content.
- Drafting is multi-step and needs feedback from the page after each action.
- Owning the loop, rather than using an SDK tool runner, lets NEXUS validate, origin-check and execute each step with the replay executor and decide what to keep.

## D34. AI is tested without calling AI

**Decision.**
- Repair and drafting logic is tested against a `ScriptedModel` that replays canned replies and records requests.
- The real SDK client is tested by injecting a `fetch` that answers like the Messages API.
- The suite never needs credentials or spends money.

**Why.** Tests must be deterministic and free to run. The scripted model can also produce cases that are hard to trigger on demand: refusals, invalid targets, malformed JSON, step limits.

**Cost.** Whether Claude makes *good* proposals isn't measured by the suite. That needs an evaluation set of broken tasks with known answers, run against the real model. It's listed under next steps.

## D35. Non-Claude models through an adapter, not a second AI layer

**Decision.** `createModelClient()` routes by model id:
- `claude-*` goes to the Anthropic SDK (directly, or through a gateway's `/v1/messages`).
- Anything else goes to `openai-compatible.ts`, which translates the same request and reply shape to and from `/v1/chat/completions` with plain `fetch`.

Thinking, effort, cache hints and refusal fallbacks have no equivalent there, so they are dropped. Structured output is sent as non-strict `json_schema`, because NEXUS's schemas have optional fields.

**Why.** The company gateway (GateLLM) had no Claude budget left, but served GPT-4.1. Keeping one internal shape means the advisor, the drafter, their tests and their safety checks are shared by every model. Only the transport differs. No new dependency was added.

**Observed.** With the original "do not substitute a plausible element" wording, GPT-4.1 refused even an obvious rename ("Proceed" → "Submit" as the form's only submit button). The prompt now accepts a replacement when exactly one element clearly does the same job at that point in the flow, and still refuses when several are plausible. This is the kind of tuning the Milestone 5 evaluation should measure, not leave to one example.

## D36. Persistent profiles: opt-in, outside the repo, no session restore

**Decision.** `--profile=<name>` uses a persistent Chromium profile in `~/.nexus/profiles/<name>`, with owner-only permissions. With a profile:
- Runs use the browser's own context instead of an isolated one.
- All cookies are saved every 2 s and on close, and restored at launch.
- The profile's saved-session files are deleted before each launch.
- Chromium uses a mock keychain.

**Why.**
- Real sites need logins, and logging in on every run is slow and trips 2FA and bot checks.
- Chromium drops session cookies on exit, so saving them explicitly is what actually keeps most logins.
- The periodic save covers a window closed by hand.
- Brave reopened the previous session's tabs on relaunch, which would re-run their pages. Its startup preference is signature-protected, so NEXUS removes the session files instead; a test now checks that no old tab reappears.
- The mock keychain avoids macOS keychain prompts and reads back consistently.
- Profiles live outside the repository because the repository is public and profiles are credentials.

**Cost.** Runs on the same profile share state, so a task that logs out affects the next one. Isolation stays the default.

---

# Milestone 5 decisions

## D37. A Swift helper speaking CDP-shaped JSON

**Decision.** Desktop control lives in `nexus-mac`, a small Swift program. NEXUS spawns it and exchanges newline-delimited JSON (`{id, method, params}` → `{id, result|error}`, plus events). NEXUS's existing `CdpClient` drives it unchanged through a `ProcessTransport`. The helper is compiled on first use and recompiled only when its source changes.

**Why.** The macOS Accessibility API and CGEvent input are C/Objective-C APIs, and Node can't call them without a native add-on. A separate process keeps NEXUS free of native builds, reuses all of the client's machinery (ids, timeouts, disconnects, events), and keeps the privileged code small and readable.

## D38. Desktop targets use the same vocabulary and rules as web targets

**Decision.** Accessibility roles are mapped to web-style roles (`AXButton` → `button`, `AXTextField` → `textbox`, …). Names come from title, description, label or placeholder. Locators are lazy, strict and auto-waiting, the recorder uses a role-and-name-first target picker, and self-healing works the same way.

**Why.** One task format and one mental model for web and desktop. Steps can be mixed, and everything built on targets (recorder, self-healing, AI outlines, reports) works for both.

## D39. Real input for clicks and typing; accessibility actions only where input can't do it

**Decision.**
- `click` moves the real pointer and clicks the element's centre.
- `type` sends real keystrokes.
- `fill` sets a value through accessibility, then *verifies* it, falling back to select-all plus typing.
- Pop-up items and menu paths are pressed through accessibility, because their menus are drawn outside the window.

**Why.** Real input exercises the app as a person would. The fallbacks cover controls that don't accept accessibility values, and menus that would otherwise need fragile pointer travel.

**Cost.** Desktop steps take over the Mac's pointer and keyboard while they run.

## D40. Wait for the app to confirm, not for time to pass

Three issues the real-Mac tests found:
1. **App lists:** the helper first ran a bare run loop, so NSWorkspace never updated its list of running apps, and a just-launched app appeared "not running". It now runs as an invisible AppKit application and also remembers apps it launched by process id.
2. **Pop-up menus:** a pop-up updates its value first and runs the app's action only after the menu closes. `selectOption` waits for both.
3. **Keyboard focus:** focusing completes asynchronously. `focus()` now waits until the app reports the element focused, clicking it if needed.
4. **Stuck modifiers:** typed characters are posted on key code 0 (the "A" key) with the text attached. After a shortcut such as Command+A or Command+R, the system could still consider Command held, so every typed character became *select all*: a password arrived as 0 or 1 characters. Typed events now carry explicitly empty modifier flags, and every chord is followed by a "modifiers released" event. A probe of three typing paths went from mostly 0 to 4/4/4 characters every time.

## D41. Privacy mode is enforced at the model boundary; passwords are never exposed

**Decision.** `assertAiAllowed()` runs inside every `ModelClient.create()`: the Claude SDK client, the OpenAI-format adapter and the router. Privacy mode is switched on by:
- `--private`
- `NEXUS_PRIVATE`
- `"private": true` in a task
- `withPrivacy()` in code

Private runs never consult the AI advisor, `draft` refuses, desktop screenshots aren't taken, and the report is marked.

Independent of privacy mode, password fields are protected:
- The helper never reports a secure field's value.
- Outlines show `value=•••`.
- The recorder writes a `{{password}}` placeholder instead of keystrokes.
- `fill` never sets a secure field programmatically.

**Why.** "The AI won't take anything" has to hold even when a future feature forgets to check, so the check sits at the one point all model traffic passes through. A test verifies that no request reaches the network. Passwords need protection in every mode, not only private mode.

**Note.** Privacy scopes are process-wide while active, so they fail closed: a non-private task running concurrently in the same process is also blocked from AI. This is preferable to leaking.

---

# Recommended next milestone

**Milestone 6: an assistant you can talk to**

1. **Voice:** a push-to-talk hotkey, then on-device speech-to-text (the Speech framework or whisper.cpp; on-device, so privacy mode can stay on), then intent matching against your saved tasks ("start my workday" → `Keka Clock In`), then a spoken result.
2. **A task library with parameters and phrases:** each task declares the phrases that trigger it and the `{{params}}` to fill from speech ("note that I'm out on Friday" → the Notes task with `text=…`).
3. **Desktop drafting:** `draft` for desktop goals, using app outlines and the same step-by-step loop (not in privacy mode).
4. **Scheduling and history:** run tasks on a schedule ("every weekday at 9:30"), keep a run history, and notify on failure.
5. **Live AI evaluation** (carried over): measure repair and draft accuracy on a fixed set of broken tasks before tuning prompts further.
