# NEXUS

A deterministic browser automation runtime that talks to Chromium directly over the
**Chrome DevTools Protocol (CDP)** — no Playwright, Puppeteer, or Selenium.

- **Milestone 1:** CDP client, browser, page, DOM snapshot, locators, real input events, waits, and verification.
- **Milestone 2:**
  - iframes and shadow DOM
  - waits that react to DOM changes, plus network-idle waits
  - `fill`, `hover`, `check`, `selectOption`, and key chords
  - clicks that retry when an element is briefly covered
  - isolated browser contexts
  - a declarative **task runner** with a CLI
- **Milestone 3:**
  - a **recorder**: `nexus record <url>` turns what you do in the browser into a task file
  - `{{params}}` in tasks
  - cross-site (out-of-process) iframes
  - dialogs, popups and new tabs, and file uploads
  - an HTML report for every run
- **Milestone 5:**
  - **Mac desktop automation**: read any app's accessibility tree, click and type with the real mouse and keyboard, menus, and `nexus record-mac`
  - **privacy mode**: nothing is ever sent to an AI model
- **Milestone 4:**
  - **self-healing replay**: a step whose target broke is repaired by rules first, then optionally by Claude. Every repair is verified against the live page and written out for review.
  - **`nexus draft "<goal>"`**: Claude works out a task by using the browser through NEXUS, one validated step at a time

```ts
import { expect, NexusBrowser } from './src/index.ts';

const browser = await NexusBrowser.launch();
const context = await browser.newContext();          // isolated cookies/storage
const page = await context.newPage();

await page.goto('https://example.test/checkout', { waitUntil: 'networkidle' });
await page.getByRole('textbox', { name: 'Email' }).fill('ada@example.test');
await page.locator('iframe#payment').getByRole('textbox', { name: 'Card number' }).fill('4242');
await page.getByRole('checkbox', { name: 'Accept terms' }).check();
await page.getByRole('combobox', { name: 'Country' }).selectOption('Norway');
await page.getByRole('button', { name: 'Pay' }).click();
await expect(page).toHaveText('Payment received');

await browser.close();
```

## Requirements

- **Node.js ≥ 22.18**: NEXUS uses Node's built-in `WebSocket`, test runner, and TypeScript type stripping. There is no build step. The only runtime dependency is `@anthropic-ai/sdk`, which is loaded only when an AI feature is used.
- **A Chromium-based browser**: Chrome, Chromium, Brave, or Edge. NEXUS looks in the standard install locations. To use a specific binary, set:

  ```bash
  export NEXUS_CHROMIUM_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ```

## Mac desktop automation

NEXUS can drive native Mac apps (Notes, Finder, Slack, System Settings…) as well as web pages. Desktop steps name an `app`; web and desktop steps can be mixed in one task:

```json
{
  "name": "Note from Keka",
  "steps": [
    { "launch": "Notes" },
    { "menu": { "app": "Notes", "path": ["File", "New Note"] } },
    { "type": { "target": { "app": "Notes" }, "text": "Clocked in" } },
    { "click": { "app": "Notes", "role": "button", "name": "Done" } }
  ]
}
```

| Desktop target | Meaning |
|---|---|
| `{ "app": "Notes", "role": "button", "name": "Done" }` | role and accessible name (preferred) |
| `{ "app": "Notes", "id": "title" }` | accessibility identifier |
| `{ "app": "Notes", "text": "Groceries" }` | visible text |
| `{ "app": "Notes" }` | whatever has keyboard focus in the app (for `type` / `press`) |

- **Actions:** `click` (real pointer), `hover`, `type`, `fill`, `press` (keys like `"Command+S"`), `check`, `uncheck`, `select` (pop-up menus), `waitFor`, `expectVisible`, `expectValue`, `expectElementText`.
- **App steps:** `launch` opens an app by name, bundle id or `.app` path. `menu` picks a menu item by its path.
- **Self-healing works for desktop targets too.**

```bash
npm run nexus -- mac-setup                 # check / request macOS permissions
npm run nexus -- record-mac --out recordings/notes.json   # record; Ctrl+C here to stop
npm run nexus -- run recordings/notes.json
```

**Permissions:** grant them to the app you run NEXUS from (for example Terminal) in **System Settings → Privacy & Security**:
- **Accessibility** is required.
- **Input Monitoring** is needed for `record-mac`.
- **Screen Recording** is optional: it's used for screenshots of desktop steps.

**Things to know:**
- **Desktop steps use *your* mouse and keyboard.** Don't use the Mac while they run.
- **Passwords are never recorded,** and the values of password fields are never read. The recording gets a `{{password}}` placeholder, which you pass at run time with `--param password=…`.
- **Apps with poor accessibility information** (some games, custom-drawn interfaces) can't be targeted by role and name.

## Privacy mode

```bash
npm run nexus -- run task.json --private     # this command
NEXUS_PRIVATE=1                               # in .env: always
{ "name": "...", "private": true, ... }       # in a task: whenever it runs
```

In privacy mode, **nothing is sent to any AI model**: no page or app outlines, no screenshots, no task contents.
- It's enforced where model requests are made, not only by features choosing not to call one, so even a code path that forgets to check can't send anything.
- Rule-based self-healing still works, because it never leaves your Mac. `draft` refuses to run.
- Desktop screenshots aren't taken, and the report shows 🔒 *Private run*.
- **Always on, private mode or not:** password fields never show their value in anything sent to a model.

## AI features (optional)

NEXUS works without any AI. A model (Claude by default, or another model through a gateway) is used only when you ask for it, and **the model only proposes; NEXUS acts**. Every proposal is validated (`parseTask`) and checked against the live page before anything is clicked.

**Credentials:** set `ANTHROPIC_API_KEY`, or run `ant auth login`. The default model is `claude-opus-5-5`; override it with `--model`.

**Through the GateLLM gateway:** copy `.env.example` to `.env` (git-ignored; this repository is public, so never commit a key) and set:

```bash
ANTHROPIC_BASE_URL=https://gatellm.sedintechnologies.com/api
ANTHROPIC_API_KEY=gatellm_live_…
```

**Other models:** any model whose id doesn't start with `claude` (for example `gpt-4.1` on GateLLM) goes to the gateway's OpenAI-format endpoint (`/api/v1/chat/completions`). NEXUS translates its tools, structured output and images automatically. Choose the model in `.env` with `NEXUS_MODEL=gpt-4.1`, or per run with `--model`. Claude models use the gateway's Anthropic-format endpoint (`/api/v1/messages`).

To see which models your gateway offers, `GET $ANTHROPIC_BASE_URL/v1/models`. As of 2026-10-06, the GateLLM Claude keys were at their spend cap and `vllm/Qwen/Qwen3.5-9B` returned errors; `gpt-4.1` works, and both live checks (a repair and a draft) were run with it. The refusal fallback below is an Anthropic API feature, so it's switched off automatically for gateways.

**What is sent:** a compact text outline of the page, such as `button "Pay" #pay` or `textbox "Email" value="…"`. NEXUS doesn't send the page's HTML, and only sends a screenshot if you pass `--ai-screenshots`. Field values that are on the page appear in the outline, so don't use AI features on pages showing data you can't share.

**Refusals:** on Anthropic's API, if Claude's safety classifiers decline a request, it is re-run server-side on Anthropic's recommended fallback model (`fallbacks: "default"`).

### Self-healing replay

```bash
npm run nexus -- run task.json --heal=apply          # rule-based repairs only (no AI, no cost)
npm run nexus -- run task.json --heal=suggest        # record repairs but still fail the step
npm run nexus -- run task.json --ai                  # rules first, then Claude (implies --heal=apply)
```

```
  ✔ 3. click getByRole('button', { name: 'Submit form' })  (412ms)
      🩹 repaired (rule): "Submit form" is gone; the closest button is "Submit" (similarity 0.74)
         {"role":"button","name":"Submit form"} → {"role":"button","name":"Submit"}
✔ PASSED  4/4 steps in 1290ms
  repairs: 1 applied, 0 suggested → review artifacts/runs/…/task.repaired.json
```

- **Only broken targets are repaired.** That means `ElementNotFoundError` (the element is gone or renamed) and `AmbiguousLocatorError` (the target now matches several elements). Failed checks (`expect…`), timeouts and action errors are **never** repaired: they may be real bugs.
- **Rules come first and are free:**
  - an ambiguous target becomes `exact`, when that's unique
  - a missing element is matched to the clearly most similar one of the same role
- **Claude is asked only when no rule works.** It sees the step, the error, the earlier steps and the page outline, and is told to say "not found" rather than guess.
- **Every proposal must match exactly one visible element** on the live page, or it's rejected and the reason recorded.
- **Repairs are never written back to your task file.** They go to `task.repaired.json` in the artifacts directory, and to the report, for you to review and adopt.

### Drafting a task

```bash
npm run nexus -- draft "Sign up for the newsletter with ada@example.test" --url=https://shop.test --headed
```

1. Claude gets the goal and the page outline.
2. It proposes one step at a time with a `run_step` tool, and NEXUS validates and runs each one.
3. NEXUS returns the outcome and the new page outline.
4. Only the steps that worked are kept, so the draft is a task that has already run once.

Limits on the draft:
- `goto` may only visit the start URL's origin.
- `--max-steps` caps the attempts (default 20).
- Claude is told never to invent credentials or personal data.

Review the file in `drafts/`, then run it like any other task.

## Recording tasks

```bash
npm run nexus -- record https://example.test/login --out recordings/login.json
npm run nexus -- record fixtures/form.html          # local files work too
```

A browser window opens. Use it normally. Each action is turned into a step and
printed as you go, and the file is saved after every step:

```
● Recording "form" → recordings/form.json
  + {"goto":"../fixtures/form.html"}
  + {"fill":{"target":{"role":"textbox","name":"Name"},"value":"Ada"}}
  + {"click":{"role":"button","name":"Submit"}}
■ Recorded 3 step(s) to recordings/form.json
  Replay: npm run nexus -- run recordings/form.json
```

- **Targets are picked for robustness, not position.** The recorder tries these in order:
  1. role and accessible name
  2. a hand-written `#id` (generated-looking ids are skipped)
  3. visible text
  4. `[name=…]`
  5. position, as a last resort

  Each candidate is checked against NEXUS's own matchers, so the step matches only the element you used. Elements inside an iframe get a `within` scope only when the page-wide target would be ambiguous.
- **Intent, not raw events.** Typing becomes one `fill` with the final value. Checkboxes become `check`/`uncheck`. Dropdowns become `select` by label. Enter becomes `press`.
- **Navigations, popups and dialogs** are attributed to the action that caused them (`waitForNavigation`, `opensPopup`). A dialog you answer becomes `onDialog` before the action that opened it and `expectDialog` after.
- **Assertions:** Alt/Option-click an element to record `expectVisible` instead of clicking it.
- **Uploads** record file names only; the recorder warns you to replace them with real paths.
- Close the window or press Ctrl+C to finish. Afterwards, edit the file freely: replace values with `{{params}}` and add `expect…` steps.

## Staying logged in (profiles)

By default every run starts in a fresh, empty browser: no cookies, never logged in. To keep a login, use a named **profile**:

```bash
npm run nexus -- open https://site.com --profile work          # log in by hand once, then close the window
npm run nexus -- record https://site.com/inbox --profile work  # record while logged in
npm run nexus -- run recordings/inbox.json --profile work      # replays start logged in
```

- **Where they're stored:** a name like `work` is stored in `~/.nexus/profiles/work`, outside the repository and readable only by you. You can also pass a path instead of a name.
- **Session cookies survive.** Cookies, local storage and other site data are kept. Session cookies (no expiry date, which many logins use) are kept too: NEXUS saves all cookies every 2 seconds and on close, and restores them at launch.
- **Old tabs don't reopen.** Previous tabs are never restored when a profile starts, so pages don't silently run again.
- **One browser at a time per profile.** A second run on the same profile fails with a clear message.
- **Runs share one session.** With `--profile`, a run uses the profile directly, so anything a task changes (logging out, settings) carries over to the next run. Without `--profile`, runs stay fully isolated.
- **Treat a profile like a password.** Anyone with the folder can use your logged-in sessions. To log out everywhere, delete `~/.nexus/profiles/<name>`.

## Desktop shortcuts (macOS)

Small apps on the Desktop mean you don't have to open a terminal in this folder. Double-click them, or ask Siri ("Hey Siri, open Keka Clock In"):

```bash
scripts/install-shortcuts.sh                                                       # NEXUS.app: menu to run, record, or log in (in Terminal)
scripts/install-shortcuts.sh "Keka Clock In" recordings/sedin-clockin.json work   # one-click task with the "work" profile
```

- **Task apps:** they run in the background with a visible browser, then show a notification. If the task fails, a dialog offers **Open Report**.
- **Why apps:** they're apps rather than `.command` files because macOS doesn't let Siri open documents in Terminal.
- **One-time macOS prompts:** a new app asks once for access to the **Desktop folder** (this project lives there) and, for `NEXUS.app`, to **control Terminal**. Click Allow / OK. Re-running the installer creates a new app, which asks again.
- **Your tasks stay private:** `recordings/` and `drafts/` are git-ignored, so they stay out of this public repository.

## Running tasks

A task is a JSON file of steps. The runner executes the steps in a fresh, isolated browser context. Each step's result records what it did, what the page looked like afterwards, whether it passed, and (optionally) a screenshot.

```bash
npm run nexus -- run examples/tasks/greet.json
npm run nexus -- run examples/tasks/controls.json --headed --screenshots=every-step
```

```
▶ Greet form  (7 steps)
  ✔ 1. goto ../../fixtures/form.html  (15ms)
  ✔ 2. fill getByRole('textbox', { name: 'Name' }) with "Ada Lovelace"  (20ms)
  ✔ 4. click getByRole('button', { name: 'Submit' })  (6ms)
  …
✔ PASSED  7/7 steps in 1232ms
  report: artifacts/runs/greet-form-20261006-062918/report.html
```

| Option | Meaning |
|---|---|
| `--headed` | Show the browser window |
| `--screenshots=on-failure \| every-step \| off` | When to capture screenshots (default `on-failure`) |
| `--out=<dir>` | Artifacts directory (default `artifacts/runs/<task>-<timestamp>`) |
| `--timeout=<ms>` | Default timeout per step (default 10000) |
| `--param name=value` | Value for a `{{name}}` placeholder (repeatable) |
| `--profile=<name\|path>` | Use a persistent profile: start logged in, keep logins and site data |
| `--heal=suggest\|apply` | Self-heal broken targets (see *AI features*) |
| `--ai`, `--ai-screenshots`, `--model=<id>` | Let Claude propose repairs; optionally send screenshots; choose the model |
| `--json` | Print the full result as JSON |

Exit codes: `0` passed, `1` a step failed, `2` usage error or invalid task. Each run writes `result.json`, a self-contained `report.html`, and its screenshots to the artifacts directory.

### Task format

```json
{
  "name": "Greet form",
  "steps": [
    { "goto": "../../fixtures/form.html" },
    { "fill": { "target": { "role": "textbox", "name": "Name" }, "value": "Ada" } },
    { "click": { "role": "button", "name": "Submit" }, "waitForNavigation": false },
    { "expectText": "Success" }
  ]
}
```

**Params:** declare placeholders with their defaults, or `null` if a value is required, and use them in any string value:

```json
{
  "name": "Greet anyone",
  "params": { "name": "Ada Lovelace", "email": null },
  "steps": [{ "fill": { "target": { "role": "textbox", "name": "Name" }, "value": "{{name}}" } }]
}
```

```bash
npm run nexus -- run examples/tasks/greet-anyone.json --param name=Grace
```

An undeclared placeholder, an unknown `--param`, or a missing required value is reported before the browser starts.

**Targets** use exactly one of `css`, `text` or `role`, plus these optional fields:

| Field | Meaning |
|---|---|
| `name` | Accessible name; only with `role` |
| `exact` | Exact, case-sensitive match; only with `text` or `role` |
| `nth` | Pick the nth match (0-based) when several elements match |
| `within` | Another target to search inside, e.g. `{ "css": "iframe#payment" }` |

**Steps**: each step has one action key.

| Action | Value |
|---|---|
| `goto` | URL, or a file path relative to the task file |
| `click` / `hover` / `check` / `uncheck` | target |
| `type` | `{ target, text }`. Appends at the caret. |
| `fill` | `{ target, value }`. Replaces the content. |
| `press` | `{ target, key }`. A key such as `"Enter"` or a chord such as `"ControlOrMeta+a"`. |
| `select` | `{ target, option }`. Matches option value or label; pass an array for multi-selects. |
| `waitFor` | `{ target, state? }`. `state` is `"visible"` (default) or `"attached"`. |
| `waitForNetworkIdle` | `true`, or `{ idleMs }` |
| `wait` | milliseconds. A fixed delay; prefer condition-based waits. |
| `expectText` | `"text"`, or `{ text, exact? }`. Checks text anywhere on the page. |
| `expectVisible` | target |
| `expectValue` | `{ target, value }` |
| `expectElementText` | `{ target, text, exact? }` |
| `screenshot` | file name inside the artifacts directory |
| `upload` | `{ target, files }`. One path or an array, relative to the task file. |
| `onDialog` | `"accept"`, `"dismiss"` (the default), or `{ "accept": "prompt answer" }`. Applies to later dialogs. |
| `expectDialog` | Text a dialog shown since the last `expectDialog` must contain |
| `closePopup` | `true`. Closes the current popup and returns to the page that opened it. |

Optional keys on any step:

| Key | Meaning |
|---|---|
| `name` | A report label that replaces the generated description |
| `timeoutMs` | Timeout for this step |
| `waitForNavigation: true` | Wait for the navigation the action triggers; `click` and `press` only |
| `opensPopup: true` | The action opens a tab or window; later steps act on it until `closePopup`. `click` and `press` only. |

## Other scripts

```bash
npm install            # dev dependencies only: typescript, @types/node
npm run demo           # scripted Milestone 1 flow; writes artifacts/milestone1.png
NEXUS_HEADLESS=0 NEXUS_SLOWMO=500 npm run demo   # visible and slowed down

npm run typecheck          # tsc --noEmit
npm run test:unit          # no browser needed; CDP, pages and Claude are faked
npm run test:integration   # launches real headless Chromium against fixtures/
npm test                   # unit + integration
```

Desktop tests drive a small test app (NexusFixture) with the real mouse and keyboard, so they only run when asked: `NEXUS_DESKTOP_TESTS=1 npm run test:integration` (needs Accessibility and Input Monitoring; hands off while they run).

The integration tests use only `fixtures/` and a local HTTP server started on `127.0.0.1` by the tests. They never contact an external website, and they never call Claude: AI behaviour is tested against a scripted model and a fake `fetch`.

## API at a glance

| Layer | API |
|---|---|
| Browser | `NexusBrowser.launch(opts)`, `.connect(wsEndpoint)`, `version()`, `targets()`, `newPage()`, `newContext()`, `pages()`, `close()` |
| Context | `newPage()`, `pages()`, `close()`. Isolated cookies, storage, and cache. |
| Page | `goto(url, { waitUntil: 'load' \| 'domcontentloaded' \| 'networkidle' })`, `waitForNavigation()`, `waitForNetworkIdle()`, `waitForLoadState()`, `evaluate()`, `content()`, `url()`, `title()`, `screenshot()`, `snapshot()`, `on(...)`, `onDomChange()`, `close()` |
| Popups & dialogs | `page.waitForPopup()`, `page.opener`, `page.setDialogPolicy('accept' \| 'dismiss' \| 'manual' \| { accept })`, `page.dialogs` |
| Extending pages | `page.exposeBinding(name, handler)`, `page.addInitScript(source)`. Both apply to every frame and to popups. |
| Locators | `page.locator(css)`, `getByText(text)`, `getByRole(role, { name })`. Chainable: `locator.locator()`, `locator.getByRole()`, … Also `.nth(i)` and `.count()`. |
| Actions | `click()`, `hover()`, `type()`, `fill()`, `press(key or chord)`, `focus()`, `check()`, `uncheck()`, `selectOption()`, `setInputFiles()` |
| Waiting | `waitForSelector()`, `waitForVisible()`, `waitForNavigation()`, `waitForNetworkIdle()`, `waitForTimeout()`, `locator.waitFor()` |
| Verification | `expect(page).toHaveText()`; `expect(locator).toBeVisible()`, `.toHaveText()`, `.toHaveValue()` |
| Tasks | `parseTask(json)`, `bindParams(task, values)`, `loadTask(file)`, `runTask(task, options)`, `renderReport(result)` |
| Recording | `Recorder.start(page)`, `recorder.flush()`, `recorder.steps`, `recorder.warnings`, `targetFor(snapshot, node)` |
| Healing & AI | `runTask(task, { heal: { mode, advisor } })`, `pageOutline(snapshot)`, `deterministicRepair()`, `ClaudeAdvisor`, `draftTask()`, `createClaudeClient()` |

## Project layout

```
src/
  cdp/         transport (WebSocket) + protocol client (ids, events, timeouts, disconnects)
  browser/     Chromium launcher, NexusBrowser, BrowserContext
  page/        NexusPage (sessions incl. cross-site iframes, navigation, popups, dialogs, waits) + network tracker
  dom/         DomSnapshot (frames stitched), ARIA role/name subset, text/role matching
  locator/     lazy, strict, chainable, auto-waiting Locator
  element/     ElementHandle: actions via CDP Input/DOM domains
  input/       keyboard (keys, chords, editor commands) + mouse
  task/        task schema/validation, params, runner, HTML report
  recorder/    recorder, page-side recording script, robust target generation
  heal/        page outline for models, rule-based repair, proposal verification
  mac/         desktop driver (helper client, app snapshots, locators, recorder, targets)
  privacy.ts   privacy mode (no AI)
  ai/          Claude client (SDK), repair advisor, task drafter
  cli.ts       `nexus run <task.json>` and `nexus record <url>`
  wait.ts      condition polling with change-driven wake-ups
  expect.ts    retrying assertions
fixtures/      deterministic local HTML test pages
native/mac/    nexus-mac Swift helper and the NexusFixture test app (built on demand)
examples/      demo script + example tasks
test/          unit (fakes) and integration (real Chromium) tests
docs/          ARCHITECTURE.md, DECISIONS.md
```

For how the pieces fit together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For why NEXUS is built this way, see [docs/DECISIONS.md](docs/DECISIONS.md).
