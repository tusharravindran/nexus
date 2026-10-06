# NEXUS

A deterministic browser automation runtime that talks to Chromium directly over the
**Chrome DevTools Protocol (CDP)** — no Playwright, Puppeteer, or Selenium.

Milestone 1 provides the foundation: launch Chromium, connect over CDP, open a page,
navigate, inspect the DOM, locate elements, click and type with real input events,
wait on conditions, verify state, and take screenshots.

```ts
import { expect, NexusBrowser } from './src/index.ts';

const browser = await NexusBrowser.launch();
const page = await browser.newPage();

await page.goto('file:///path/to/form.html');
await page.getByRole('textbox', { name: 'Name' }).type('Ada');
await page.getByRole('button', { name: 'Submit' }).click();
await expect(page).toHaveText('Success');
await page.screenshot({ path: 'artifacts/result.png' });

await browser.close();
```

## Requirements

- **Node.js ≥ 22.18**: NEXUS uses Node's built-in `WebSocket`, test runner, and TypeScript type stripping. There is no build step and there are no runtime dependencies.
- **A Chromium-based browser**: Chrome, Chromium, Brave, or Edge. NEXUS looks in the standard install locations. To use a specific binary, set:

  ```bash
  export NEXUS_CHROMIUM_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  ```

## Running

```bash
npm install            # dev dependencies only: typescript, @types/node
npm run demo           # end-to-end Milestone 1 flow; writes artifacts/milestone1.png
NEXUS_HEADLESS=0 npm run demo   # same, with a visible browser window
NEXUS_HEADLESS=0 NEXUS_SLOWMO=500 npm run demo   # visible and slowed down: 500ms between steps and keystrokes
```

## Testing

```bash
npm run typecheck          # tsc --noEmit
npm run test:unit          # no browser needed; CDP and pages are faked
npm run test:integration   # launches real headless Chromium against fixtures/
npm test                   # unit + integration
```

The integration tests use only the local HTML files in `fixtures/` and never touch an external website.

## API at a glance

| Layer | API |
|---|---|
| Browser | `NexusBrowser.launch(opts)`, `NexusBrowser.connect(wsEndpoint)`, `version()`, `targets()`, `newPage()`, `pages()`, `close()` |
| Page | `goto(url)`, `waitForNavigation()`, `evaluate(expr)`, `content()`, `screenshot({ path })`, `snapshot()`, `on('load' \| 'domcontentloaded' \| 'navigated')`, `close()` |
| Locators | `page.locator(css)`, `page.getByText(text, { exact })`, `page.getByRole(role, { name, exact })`, `.nth(i)`, `.count()` |
| Actions | `click()`, `type(text)`, `press(key)`, `focus()` |
| Waiting | `waitForSelector(css, { state })`, `waitForVisible(target)`, `waitForNavigation()`, `waitForTimeout(ms)`, `locator.waitFor()` |
| Verification | `expect(page).toHaveText()`, `expect(locator).toBeVisible()`, `.toHaveText()`, `.toHaveValue()` |

## Project layout

```
src/
  cdp/         transport (WebSocket) + protocol client (ids, events, timeouts, disconnects)
  browser/     Chromium launcher + NexusBrowser (targets, pages, shutdown)
  page/        NexusPage (navigation, evaluate, screenshot, DOM snapshot, locators, waits)
  dom/         DomSnapshot, ARIA role/name subset, text/role matching
  locator/     lazy, strict, auto-waiting Locator
  element/     ElementHandle: actions via CDP Input/DOM domains
  input/       keyboard + mouse event dispatch
  wait.ts      condition polling primitive
  expect.ts    retrying assertions
fixtures/      deterministic local HTML test pages
examples/      runnable end-to-end demo
test/unit/     fast tests with fake transport / fake page
test/integration/  real-Chromium tests
docs/          ARCHITECTURE.md, DECISIONS.md
```

For how the pieces fit together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For why NEXUS is built this way, see [docs/DECISIONS.md](docs/DECISIONS.md).
