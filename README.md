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

- **Node.js ≥ 22.18**: NEXUS uses Node's built-in `WebSocket`, test runner, and TypeScript type stripping. There is no build step and there are no runtime dependencies.
- **A Chromium-based browser**: Chrome, Chromium, Brave, or Edge. NEXUS looks in the standard install locations. To use a specific binary, set:

  ```bash
  export NEXUS_CHROMIUM_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ```

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
  artifacts: artifacts/runs/greet-form-20261006-062918
```

| Option | Meaning |
|---|---|
| `--headed` | Show the browser window |
| `--screenshots=on-failure \| every-step \| off` | When to capture screenshots (default `on-failure`) |
| `--out=<dir>` | Artifacts directory (default `artifacts/runs/<task>-<timestamp>`) |
| `--timeout=<ms>` | Default timeout per step (default 10000) |
| `--json` | Print the full result as JSON |

Exit codes: `0` passed, `1` a step failed, `2` usage error or invalid task. Each run writes `result.json` and its screenshots to the artifacts directory.

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

Optional keys on any step:

| Key | Meaning |
|---|---|
| `name` | A report label that replaces the generated description |
| `timeoutMs` | Timeout for this step |
| `waitForNavigation: true` | Wait for the navigation the action triggers; `click` and `press` only |

## Other scripts

```bash
npm install            # dev dependencies only: typescript, @types/node
npm run demo           # scripted Milestone 1 flow; writes artifacts/milestone1.png
NEXUS_HEADLESS=0 NEXUS_SLOWMO=500 npm run demo   # visible and slowed down

npm run typecheck          # tsc --noEmit
npm run test:unit          # no browser needed; CDP and pages are faked
npm run test:integration   # launches real headless Chromium against fixtures/
npm test                   # unit + integration
```

The integration tests use only `fixtures/` and a local HTTP server started on `127.0.0.1` by the tests. They never contact an external website.

## API at a glance

| Layer | API |
|---|---|
| Browser | `NexusBrowser.launch(opts)`, `.connect(wsEndpoint)`, `version()`, `targets()`, `newPage()`, `newContext()`, `pages()`, `close()` |
| Context | `newPage()`, `pages()`, `close()`. Isolated cookies, storage, and cache. |
| Page | `goto(url, { waitUntil: 'load' \| 'domcontentloaded' \| 'networkidle' })`, `waitForNavigation()`, `waitForNetworkIdle()`, `evaluate()`, `content()`, `url()`, `title()`, `screenshot()`, `snapshot()`, `on(...)`, `onDomChange()`, `close()` |
| Locators | `page.locator(css)`, `getByText(text)`, `getByRole(role, { name })`. Chainable: `locator.locator()`, `locator.getByRole()`, … Also `.nth(i)` and `.count()`. |
| Actions | `click()`, `hover()`, `type()`, `fill()`, `press(key or chord)`, `focus()`, `check()`, `uncheck()`, `selectOption()` |
| Waiting | `waitForSelector()`, `waitForVisible()`, `waitForNavigation()`, `waitForNetworkIdle()`, `waitForTimeout()`, `locator.waitFor()` |
| Verification | `expect(page).toHaveText()`; `expect(locator).toBeVisible()`, `.toHaveText()`, `.toHaveValue()` |
| Tasks | `parseTask(json)`, `loadTask(file)`, `runTask(task, options)` |

## Project layout

```
src/
  cdp/         transport (WebSocket) + protocol client (ids, events, timeouts, disconnects)
  browser/     Chromium launcher, NexusBrowser, BrowserContext
  page/        NexusPage (navigation, evaluate, screenshot, snapshot, waits) + network tracker
  dom/         DomSnapshot (frames stitched), ARIA role/name subset, text/role matching
  locator/     lazy, strict, chainable, auto-waiting Locator
  element/     ElementHandle: actions via CDP Input/DOM domains
  input/       keyboard (keys, chords, editor commands) + mouse
  task/        task schema/validation + runner
  cli.ts       `nexus run <task.json>`
  wait.ts      condition polling with change-driven wake-ups
  expect.ts    retrying assertions
fixtures/      deterministic local HTML test pages
examples/      demo script + example tasks
test/          unit (fakes) and integration (real Chromium) tests
docs/          ARCHITECTURE.md, DECISIONS.md
```

For how the pieces fit together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For why NEXUS is built this way, see [docs/DECISIONS.md](docs/DECISIONS.md).
