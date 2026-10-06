/**
 * Milestone 1 end-to-end flow:
 * launch → connect → page → navigate → inspect → locate → type → click → verify → screenshot → close
 *
 * Run: npm run demo
 *   NEXUS_HEADLESS=0   show the browser window
 *   NEXUS_SLOWMO=500   pause this many ms between steps (and between typed keys) so you can watch
 */
import { expect, NexusBrowser } from '../src/index.ts';

const fixture = new URL('../fixtures/form.html', import.meta.url).href;
const screenshotPath = new URL('../artifacts/milestone1.png', import.meta.url).pathname;
const slowMo = Number(process.env.NEXUS_SLOWMO ?? 0);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, slowMo));

const browser = await NexusBrowser.launch({ headless: process.env.NEXUS_HEADLESS !== '0' });
try {
  const { product } = await browser.version();
  console.log(`connected to ${product}`);

  const page = await browser.newPage();
  await page.goto(fixture);
  console.log(`navigated to ${await page.evaluate<string>('document.title')}`);
  await pause();

  const snapshot = await page.snapshot();
  console.log(`DOM snapshot: ${snapshot.nodes.length} nodes, ${snapshot.elements().length} elements`);

  const name = page.getByRole('textbox', { name: 'Name' });
  if (slowMo > 0) {
    // One key at a time so the typing is visible.
    for (const character of 'Ada') {
      await name.type(character);
      await pause();
    }
  } else {
    await name.type('Ada');
  }
  await expect(name).toHaveValue('Ada');
  console.log('typed "Ada" into', String(name));
  await pause();

  const submit = page.getByRole('button', { name: 'Submit' });
  await submit.click();
  console.log('clicked', String(submit));

  await expect(page).toHaveText('Success');
  await expect(page.getByRole('status')).toHaveText('Success: Hello, Ada', { exact: true });
  console.log('verified: "Success: Hello, Ada" is visible');

  await page.screenshot({ path: screenshotPath });
  console.log(`screenshot saved to ${screenshotPath}`);
  await pause();
  await pause(); // Linger on the result before closing.
} finally {
  await browser.close();
  console.log('browser closed');
}
