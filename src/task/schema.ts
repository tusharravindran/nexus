import { TaskValidationError } from '../errors.ts';

/**
 * How a task step finds an element. Exactly one of css / text / role.
 * `within` scopes the search to another target (e.g. an iframe or a panel).
 */
export interface TargetSpec {
  css?: string;
  text?: string;
  role?: string;
  /** Accessible name; only with `role`. */
  name?: string;
  /** Exact, case-sensitive text/name match; only with `text` or `role`. */
  exact?: boolean;
  /** Pick the nth match (0-based) instead of requiring exactly one. */
  nth?: number;
  within?: TargetSpec;
}

interface StepOptions {
  /** Label shown in reports instead of the generated description. */
  name?: string;
  /** Overrides the runner's default timeout for this step. */
  timeoutMs?: number;
}

export type Step = StepOptions &
  (
    | { action: 'goto'; url: string }
    | { action: 'click'; target: TargetSpec; waitForNavigation: boolean }
    | { action: 'hover'; target: TargetSpec }
    | { action: 'type'; target: TargetSpec; text: string }
    | { action: 'fill'; target: TargetSpec; value: string }
    | { action: 'press'; target: TargetSpec; key: string; waitForNavigation: boolean }
    | { action: 'check'; target: TargetSpec }
    | { action: 'uncheck'; target: TargetSpec }
    | { action: 'select'; target: TargetSpec; option: string | string[] }
    | { action: 'waitFor'; target: TargetSpec; state: 'attached' | 'visible' }
    | { action: 'waitForNetworkIdle'; idleMs: number | undefined }
    | { action: 'wait'; ms: number }
    | { action: 'expectText'; text: string; exact: boolean }
    | { action: 'expectVisible'; target: TargetSpec }
    | { action: 'expectValue'; target: TargetSpec; value: string }
    | { action: 'expectElementText'; target: TargetSpec; text: string; exact: boolean }
    | { action: 'screenshot'; file: string }
  );

export type StepAction = Step['action'];

export interface Task {
  name: string;
  description?: string;
  steps: Step[];
}

const ACTIONS: readonly StepAction[] = [
  'goto', 'click', 'hover', 'type', 'fill', 'press', 'check', 'uncheck', 'select',
  'waitFor', 'waitForNetworkIdle', 'wait', 'expectText', 'expectVisible', 'expectValue',
  'expectElementText', 'screenshot',
];
const STEP_OPTION_KEYS = new Set(['name', 'timeoutMs', 'waitForNavigation']);
const TARGET_KEYS = new Set(['css', 'text', 'role', 'name', 'exact', 'nth', 'within']);

type Json = unknown;

/** Collects every problem with its JSON path, so one run reports all mistakes. */
class Issues {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates parsed JSON and returns a typed Task. Throws TaskValidationError
 * listing every problem found.
 *
 * Step format: one action key, plus optional "name", "timeoutMs", and (for
 * click/press) "waitForNavigation". For example:
 *
 *   { "click": { "role": "button", "name": "Submit" }, "waitForNavigation": true }
 *   { "type": { "target": { "css": "#q" }, "text": "nexus" } }
 */
export function parseTask(input: Json): Task {
  const issues = new Issues();
  if (!isObject(input)) throw new TaskValidationError(['task: must be a JSON object']);

  for (const key of Object.keys(input)) {
    if (!['name', 'description', 'steps'].includes(key)) issues.add('task', `unknown key "${key}"`);
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name : undefined;
  if (!name) issues.add('task.name', 'must be a non-empty string');
  if (input.description !== undefined && typeof input.description !== 'string') {
    issues.add('task.description', 'must be a string');
  }

  const steps: Step[] = [];
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    issues.add('task.steps', 'must be a non-empty array');
  } else {
    input.steps.forEach((raw, i) => {
      const step = parseStep(raw, `steps[${i}]`, issues);
      if (step) steps.push(step);
    });
  }

  if (issues.list.length > 0) throw new TaskValidationError(issues.list);
  return { name: name!, description: input.description as string | undefined, steps };
}

function parseStep(raw: Json, path: string, issues: Issues): Step | undefined {
  if (!isObject(raw)) {
    issues.add(path, 'must be an object');
    return undefined;
  }
  const actionKeys = Object.keys(raw).filter((key) => !STEP_OPTION_KEYS.has(key));
  if (actionKeys.length !== 1) {
    issues.add(path, actionKeys.length === 0 ? `needs one action (${ACTIONS.join(', ')})` : `has several actions: ${actionKeys.join(', ')}`);
    return undefined;
  }
  const action = actionKeys[0]! as StepAction;
  if (!ACTIONS.includes(action)) {
    issues.add(path, `unknown action "${action}"`);
    return undefined;
  }
  const at = `${path}.${action}`;
  const value = raw[action];

  const options: StepOptions = {};
  if (raw.name !== undefined) {
    if (typeof raw.name === 'string') options.name = raw.name;
    else issues.add(`${path}.name`, 'must be a string');
  }
  if (raw.timeoutMs !== undefined) {
    if (isNonNegativeNumber(raw.timeoutMs)) options.timeoutMs = raw.timeoutMs;
    else issues.add(`${path}.timeoutMs`, 'must be a non-negative number');
  }
  let waitForNavigation = false;
  if (raw.waitForNavigation !== undefined) {
    if (action !== 'click' && action !== 'press') issues.add(`${path}.waitForNavigation`, 'only allowed on click and press');
    else if (typeof raw.waitForNavigation !== 'boolean') issues.add(`${path}.waitForNavigation`, 'must be true or false');
    else waitForNavigation = raw.waitForNavigation;
  }

  const before = issues.list.length;
  let step: Step | undefined;
  switch (action) {
    case 'goto':
      step = { action, url: string(value, at, issues) };
      break;
    case 'click':
      step = { action, target: target(value, at, issues), waitForNavigation };
      break;
    case 'hover':
    case 'check':
    case 'uncheck':
    case 'expectVisible':
      step = { action, target: target(value, at, issues) };
      break;
    case 'type': {
      const fields = object(value, at, issues, ['target', 'text']);
      step = { action, target: target(fields.target, `${at}.target`, issues), text: string(fields.text, `${at}.text`, issues) };
      break;
    }
    case 'fill': {
      const fields = object(value, at, issues, ['target', 'value']);
      step = { action, target: target(fields.target, `${at}.target`, issues), value: string(fields.value, `${at}.value`, issues, true) };
      break;
    }
    case 'press': {
      const fields = object(value, at, issues, ['target', 'key']);
      step = { action, target: target(fields.target, `${at}.target`, issues), key: string(fields.key, `${at}.key`, issues), waitForNavigation };
      break;
    }
    case 'select': {
      const fields = object(value, at, issues, ['target', 'option']);
      const option = fields.option;
      const valid = typeof option === 'string' || (Array.isArray(option) && option.length > 0 && option.every((o) => typeof o === 'string'));
      if (!valid) issues.add(`${at}.option`, 'must be a string or a non-empty array of strings');
      step = { action, target: target(fields.target, `${at}.target`, issues), option: option as string | string[] };
      break;
    }
    case 'waitFor': {
      const fields = object(value, at, issues, ['target', 'state']);
      const state = fields.state ?? 'visible';
      if (state !== 'attached' && state !== 'visible') issues.add(`${at}.state`, 'must be "attached" or "visible"');
      step = { action, target: target(fields.target, `${at}.target`, issues), state: state as 'attached' | 'visible' };
      break;
    }
    case 'waitForNetworkIdle': {
      let idleMs: number | undefined;
      if (isObject(value)) {
        const fields = object(value, at, issues, ['idleMs']);
        if (fields.idleMs !== undefined) {
          if (isNonNegativeNumber(fields.idleMs)) idleMs = fields.idleMs;
          else issues.add(`${at}.idleMs`, 'must be a non-negative number');
        }
      } else if (value !== true) {
        issues.add(at, 'must be true or { "idleMs": number }');
      }
      step = { action, idleMs };
      break;
    }
    case 'wait':
      if (!isNonNegativeNumber(value)) issues.add(at, 'must be a non-negative number of milliseconds');
      step = { action, ms: value as number };
      break;
    case 'expectText': {
      if (typeof value === 'string') step = { action, text: value, exact: false };
      else {
        const fields = object(value, at, issues, ['text', 'exact']);
        step = { action, text: string(fields.text, `${at}.text`, issues), exact: boolean(fields.exact, `${at}.exact`, issues) };
      }
      break;
    }
    case 'expectValue': {
      const fields = object(value, at, issues, ['target', 'value']);
      step = { action, target: target(fields.target, `${at}.target`, issues), value: string(fields.value, `${at}.value`, issues, true) };
      break;
    }
    case 'expectElementText': {
      const fields = object(value, at, issues, ['target', 'text', 'exact']);
      step = {
        action,
        target: target(fields.target, `${at}.target`, issues),
        text: string(fields.text, `${at}.text`, issues),
        exact: boolean(fields.exact, `${at}.exact`, issues),
      };
      break;
    }
    case 'screenshot': {
      const file = string(value, at, issues);
      if (file && (file.includes('..') || file.startsWith('/') || file.startsWith('\\'))) {
        issues.add(at, 'must be a relative file name inside the run directory');
      }
      step = { action, file };
      break;
    }
  }
  return issues.list.length === before ? { ...options, ...step! } : undefined;
}

function target(value: Json, path: string, issues: Issues): TargetSpec {
  if (!isObject(value)) {
    issues.add(path, 'must be a target object, e.g. { "role": "button", "name": "Submit" }');
    return {};
  }
  for (const key of Object.keys(value)) if (!TARGET_KEYS.has(key)) issues.add(path, `unknown target key "${key}"`);

  const kinds = (['css', 'text', 'role'] as const).filter((kind) => value[kind] !== undefined);
  if (kinds.length !== 1) issues.add(path, 'needs exactly one of "css", "text" or "role"');
  for (const kind of kinds) if (typeof value[kind] !== 'string' || !(value[kind] as string)) issues.add(`${path}.${kind}`, 'must be a non-empty string');

  if (value.name !== undefined) {
    if (value.role === undefined) issues.add(`${path}.name`, 'only allowed with "role"');
    else if (typeof value.name !== 'string') issues.add(`${path}.name`, 'must be a string');
  }
  if (value.exact !== undefined) {
    if (value.css !== undefined) issues.add(`${path}.exact`, 'not allowed with "css"');
    else if (typeof value.exact !== 'boolean') issues.add(`${path}.exact`, 'must be true or false');
  }
  if (value.nth !== undefined && !(Number.isInteger(value.nth) && (value.nth as number) >= 0)) {
    issues.add(`${path}.nth`, 'must be a non-negative integer');
  }

  const spec: TargetSpec = {};
  if (typeof value.css === 'string') spec.css = value.css;
  if (typeof value.text === 'string') spec.text = value.text;
  if (typeof value.role === 'string') spec.role = value.role;
  if (typeof value.name === 'string') spec.name = value.name;
  if (typeof value.exact === 'boolean') spec.exact = value.exact;
  if (typeof value.nth === 'number') spec.nth = value.nth;
  if (value.within !== undefined) spec.within = target(value.within, `${path}.within`, issues);
  return spec;
}

function object(value: Json, path: string, issues: Issues, allowed: string[]): Record<string, Json> {
  if (!isObject(value)) {
    issues.add(path, `must be an object with ${allowed.map((key) => `"${key}"`).join(', ')}`);
    return {};
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.add(path, `unknown key "${key}"`);
  return value;
}

function string(value: Json, path: string, issues: Issues, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    issues.add(path, allowEmpty ? 'must be a string' : 'must be a non-empty string');
    return '';
  }
  return value;
}

function boolean(value: Json, path: string, issues: Issues): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') issues.add(path, 'must be true or false');
  return value === true;
}

function isNonNegativeNumber(value: Json): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
