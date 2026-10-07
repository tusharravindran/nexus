import { TaskValidationError } from '../errors.ts';

/**
 * How a task step finds an element. Exactly one of css / text / role.
 * `within` scopes the search to another target (e.g. an iframe or a panel).
 */
export interface TargetSpec {
  /**
   * A macOS app ("Notes", or a bundle id like "com.apple.Notes"): the target is
   * a desktop element in that app instead of a web element. With no role,
   * text or id, it means "whatever has keyboard focus in the app".
   */
  app?: string;
  /** Accessibility identifier of a desktop element; only with `app`. */
  id?: string;
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
    | { action: 'click'; target: TargetSpec; waitForNavigation: boolean; opensPopup: boolean }
    | { action: 'hover'; target: TargetSpec }
    | { action: 'type'; target: TargetSpec; text: string }
    | { action: 'fill'; target: TargetSpec; value: string }
    | { action: 'press'; target: TargetSpec; key: string; waitForNavigation: boolean; opensPopup: boolean }
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
    | { action: 'upload'; target: TargetSpec; files: string[] }
    | { action: 'onDialog'; policy: 'accept' | 'dismiss' | { accept: string } }
    | { action: 'expectDialog'; text: string }
    | { action: 'closePopup' }
    | { action: 'launch'; app: string }
    | { action: 'menu'; app: string; path: string[] }
  );

export type StepAction = Step['action'];

export interface Task {
  name: string;
  description?: string;
  /** Privacy mode for this task: nothing from it is ever sent to an AI model. */
  private?: boolean;
  /** Declared `{{placeholders}}`: name → default value, or null if the value is required. */
  params?: Record<string, string | null>;
  steps: Step[];
}

const ACTIONS: readonly StepAction[] = [
  'goto', 'click', 'hover', 'type', 'fill', 'press', 'check', 'uncheck', 'select',
  'waitFor', 'waitForNetworkIdle', 'wait', 'expectText', 'expectVisible', 'expectValue',
  'expectElementText', 'screenshot', 'upload', 'onDialog', 'expectDialog', 'closePopup', 'launch', 'menu',
];
const STEP_OPTION_KEYS = new Set(['name', 'timeoutMs', 'waitForNavigation', 'opensPopup']);
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
const PARAM_NAME = /^[A-Za-z_][\w-]*$/;
const TARGET_KEYS = new Set(['app', 'id', 'css', 'text', 'role', 'name', 'exact', 'nth', 'within']);

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
    if (!['name', 'description', 'private', 'params', 'steps'].includes(key)) issues.add('task', `unknown key "${key}"`);
  }
  const params = parseParams(input.params, issues);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name : undefined;
  if (!name) issues.add('task.name', 'must be a non-empty string');
  if (input.description !== undefined && typeof input.description !== 'string') {
    issues.add('task.description', 'must be a string');
  }
  if (input.private !== undefined && typeof input.private !== 'boolean') issues.add('task.private', 'must be true or false');

  const steps: Step[] = [];
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    issues.add('task.steps', 'must be a non-empty array');
  } else {
    input.steps.forEach((raw, i) => {
      const step = parseStep(raw, `steps[${i}]`, issues);
      if (step) steps.push(step);
      for (const [at, text] of strings(raw, `steps[${i}]`)) {
        for (const [, param] of text.matchAll(PLACEHOLDER)) {
          if (!params || !(param! in params)) issues.add(at, `uses undeclared parameter {{${param}}}; add it to "params"`);
        }
      }
    });
  }

  if (issues.list.length > 0) throw new TaskValidationError(issues.list);
  return {
    name: name!,
    description: input.description as string | undefined,
    ...(input.private === true ? { private: true } : {}),
    ...(params ? { params } : {}),
    steps,
  };
}

/**
 * Substitutes `{{name}}` placeholders with `values` (falling back to each
 * param's default). Throws TaskValidationError for unknown or missing values.
 */
export function bindParams(task: Task, values: Record<string, string> = {}): Task {
  const declared = task.params ?? {};
  const issues: string[] = [];
  for (const name of Object.keys(values)) if (!(name in declared)) issues.push(`param "${name}": not declared by the task`);
  const resolved: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(declared)) {
    const value = values[name] ?? fallback;
    if (value === null) issues.push(`param "${name}": required, pass --param ${name}=<value>`);
    else resolved[name] = value;
  }
  if (issues.length > 0) throw new TaskValidationError(issues);

  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(PLACEHOLDER, (_, name: string) => resolved[name]!);
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
    return value;
  };
  return { ...task, steps: task.steps.map((step) => substitute(step) as Step) };
}

function parseParams(value: Json, issues: Issues): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    issues.add('task.params', 'must be an object of name → default string (or null when required)');
    return undefined;
  }
  const params: Record<string, string | null> = {};
  for (const [name, fallback] of Object.entries(value)) {
    if (!PARAM_NAME.test(name)) issues.add(`task.params.${name}`, 'names must be letters, digits, _ or - (not starting with a digit)');
    else if (fallback !== null && typeof fallback !== 'string') issues.add(`task.params.${name}`, 'default must be a string or null');
    else params[name] = fallback;
  }
  return params;
}

/** Every string inside a JSON value, with its path. */
function* strings(value: Json, at: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [at, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* strings(item, `${at}[${i}]`);
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) yield* strings(item, `${at}.${key}`);
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
  const actionFlag = (key: 'waitForNavigation' | 'opensPopup'): boolean => {
    const flag = raw[key];
    if (flag === undefined) return false;
    if (action !== 'click' && action !== 'press') issues.add(`${path}.${key}`, 'only allowed on click and press');
    else if (typeof flag !== 'boolean') issues.add(`${path}.${key}`, 'must be true or false');
    return flag === true;
  };
  const waitForNavigation = actionFlag('waitForNavigation');
  const opensPopup = actionFlag('opensPopup');

  const before = issues.list.length;
  let step: Step | undefined;
  switch (action) {
    case 'goto':
      step = { action, url: string(value, at, issues) };
      break;
    case 'click':
      step = { action, target: target(value, at, issues), waitForNavigation, opensPopup };
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
      step = { action, target: target(fields.target, `${at}.target`, issues), key: string(fields.key, `${at}.key`, issues), waitForNavigation, opensPopup };
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
    case 'upload': {
      const fields = object(value, at, issues, ['target', 'files']);
      const files = typeof fields.files === 'string' ? [fields.files] : fields.files;
      const valid = Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === 'string' && file !== '');
      if (!valid) issues.add(`${at}.files`, 'must be a file path or a non-empty array of file paths');
      step = { action, target: target(fields.target, `${at}.target`, issues), files: valid ? (files as string[]) : [] };
      break;
    }
    case 'onDialog': {
      let policy: 'accept' | 'dismiss' | { accept: string } = 'dismiss';
      if (value === 'accept' || value === 'dismiss') policy = value;
      else if (isObject(value) && Object.keys(value).length === 1 && typeof value.accept === 'string') policy = { accept: value.accept };
      else issues.add(at, 'must be "accept", "dismiss", or { "accept": "prompt answer" }');
      step = { action, policy };
      break;
    }
    case 'expectDialog':
      step = { action, text: string(value, at, issues) };
      break;
    case 'closePopup':
      if (value !== true) issues.add(at, 'must be true');
      step = { action };
      break;
    case 'launch':
      step = { action, app: string(value, at, issues) };
      break;
    case 'menu': {
      const fields = object(value, at, issues, ['app', 'path']);
      const menuPath = fields.path;
      const valid = Array.isArray(menuPath) && menuPath.length > 0 && menuPath.every((item) => typeof item === 'string' && item !== '');
      if (!valid) issues.add(`${at}.path`, 'must be a non-empty array of menu titles, e.g. ["File", "New Window"]');
      step = { action, app: string(fields.app, `${at}.app`, issues), path: valid ? (menuPath as string[]) : [] };
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

  const desktop = value.app !== undefined;
  if (desktop) {
    if (typeof value.app !== 'string' || !value.app) issues.add(`${path}.app`, 'must be a non-empty app name or bundle id');
    if (value.css !== undefined) issues.add(`${path}.css`, 'not available for desktop targets; use "id" (accessibility identifier)');
    if (value.within !== undefined) issues.add(`${path}.within`, 'not available for desktop targets');
    const desktopKinds = (['text', 'role', 'id'] as const).filter((kind) => value[kind] !== undefined);
    if (desktopKinds.length > 1) issues.add(path, 'a desktop target uses at most one of "text", "role" or "id"');
    for (const kind of desktopKinds) if (typeof value[kind] !== 'string' || !(value[kind] as string)) issues.add(`${path}.${kind}`, 'must be a non-empty string');
  } else {
    if (value.id !== undefined) issues.add(`${path}.id`, 'only allowed with "app" (for web elements use {"css": "#id"})');
    const kinds = (['css', 'text', 'role'] as const).filter((kind) => value[kind] !== undefined);
    if (kinds.length !== 1) issues.add(path, 'needs exactly one of "css", "text" or "role"');
    for (const kind of kinds) if (typeof value[kind] !== 'string' || !(value[kind] as string)) issues.add(`${path}.${kind}`, 'must be a non-empty string');
  }

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
  if (typeof value.app === 'string') spec.app = value.app;
  if (typeof value.id === 'string') spec.id = value.id;
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

/** The element a step acts on or checks, if its action has one. */
export function stepTarget(step: Step): TargetSpec | undefined {
  return 'target' in step ? step.target : undefined;
}

/** A copy of `step` aimed at a different element. Steps without a target are returned unchanged. */
export function withTarget(step: Step, target: TargetSpec): Step {
  return 'target' in step ? ({ ...step, target } as Step) : step;
}

/** Validates a stand-alone target (e.g. one proposed by a model). Throws TaskValidationError. */
export function parseTarget(value: unknown, path = 'target'): TargetSpec {
  const issues = new Issues();
  const spec = target(value, path, issues);
  if (issues.list.length > 0) throw new TaskValidationError(issues.list);
  return spec;
}

/** Actions whose task-file value *is* the target, rather than an object holding `target`. */
const TARGET_VALUED = new Set<StepAction>(['click', 'hover', 'check', 'uncheck', 'expectVisible']);

/**
 * Returns a copy of a task-file step (JSON form) with its target replaced,
 * keeping every other field as written. Steps without a target are returned as-is.
 */
export function replaceRawTarget(raw: Record<string, unknown>, replacement: TargetSpec): Record<string, unknown> {
  const action = Object.keys(raw).find((key) => !STEP_OPTION_KEYS.has(key)) as StepAction | undefined;
  if (!action) return raw;
  if (TARGET_VALUED.has(action)) return { ...raw, [action]: replacement };
  const value = raw[action];
  if (isObject(value) && 'target' in value) return { ...raw, [action]: { ...value, target: replacement } };
  return raw;
}
