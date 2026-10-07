import type { Locator } from '../locator/locator.ts';
import type { NexusPage } from '../page/page.ts';
import type { TargetSpec } from './schema.ts';

/** Turns a task target into a Locator on `page` (scoping through `within` targets). */
export function toLocator(page: NexusPage, spec: TargetSpec): Locator {
  const scope = spec.within ? toLocator(page, spec.within) : page;
  let locator: Locator;
  if (spec.css !== undefined) locator = scope.locator(spec.css);
  else if (spec.text !== undefined) locator = scope.getByText(spec.text, { exact: spec.exact });
  else locator = scope.getByRole(spec.role!, { name: spec.name, exact: spec.exact });
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}
