import { CdpClient } from '../cdp/client.ts';
import type { TextMatcher } from '../dom/match.ts';
import { ActionError, AmbiguousLocatorError, ElementNotFoundError, PermissionError, ProtocolError } from '../errors.ts';
import type { TargetSpec } from '../task/schema.ts';
import { poll, sleep } from '../wait.ts';
import { ensureHelper } from './build.ts';
import { AppSnapshot, matchMacId, matchMacRole, matchMacText, type MacAppInfo, type MacNode, type RawMacNode } from './snapshot.ts';
import { ProcessTransport } from './transport.ts';

export type MacPermission = 'accessibility' | 'screenRecording' | 'inputMonitoring';

const PERMISSION_NAMES: Record<MacPermission, string> = {
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
  inputMonitoring: 'Input Monitoring',
};

/** Anything that can send helper commands (CdpClient; a fake in tests). */
export interface HelperClient {
  send<T = unknown>(method: string, params?: object, options?: { timeoutMs?: number }): Promise<T>;
  on<T = unknown>(method: string, handler: (params: T) => void): () => void;
  close(): void;
}

/**
 * NEXUS's handle on the Mac desktop, through the nexus-mac helper. Reads apps
 * via the Accessibility API and drives them with real mouse and keyboard
 * events — so while desktop steps run, they use *your* pointer and keyboard.
 */
export class MacDesktop {
  readonly client: HelperClient;
  defaultTimeoutMs = 10_000;

  /** Builds (if needed) and starts the helper. */
  static async start(): Promise<MacDesktop> {
    const binary = await ensureHelper();
    const desktop = new MacDesktop(new CdpClient(new ProcessTransport(binary), { timeoutMs: 30_000 }));
    await desktop.client.send('ping');
    return desktop;
  }

  constructor(client: HelperClient) {
    this.client = client;
  }

  permissions(): Promise<Record<MacPermission, boolean>> {
    return this.client.send('permissions');
  }

  /** Shows macOS's permission prompts for what is missing. */
  requestPermissions(options: { screenRecording?: boolean; inputMonitoring?: boolean } = {}): Promise<Record<MacPermission, boolean>> {
    return this.client.send('requestPermissions', options);
  }

  /** Throws PermissionError explaining how to grant whatever is missing. */
  async requirePermissions(...needed: MacPermission[]): Promise<void> {
    const granted = await this.permissions();
    const missing = needed.filter((permission) => !granted[permission]);
    if (missing.length === 0) return;
    const names = missing.map((permission) => PERMISSION_NAMES[permission]).join(' and ');
    throw new PermissionError(
      `Desktop automation needs ${names}. Open System Settings → Privacy & Security → ${names}, ` +
        'switch on the app you run NEXUS from (e.g. Terminal), then quit and reopen that app.',
    );
  }

  async apps(): Promise<MacAppInfo[]> {
    return (await this.client.send<{ apps: MacAppInfo[] }>('apps')).apps;
  }

  /** Opens an app (by name, bundle id or .app path) and brings it to the front. */
  launch(app: string): Promise<MacAppInfo> {
    return this.client.send('launch', { app });
  }

  async activate(app: string): Promise<void> {
    await this.client.send('activate', { app });
  }

  quit(app: string): Promise<{ terminated: boolean }> {
    return this.client.send('quit', { app });
  }

  async snapshot(app: string, options: { menus?: boolean } = {}): Promise<AppSnapshot> {
    const tree = await this.client.send<{ app: MacAppInfo; nodes: RawMacNode[] }>('tree', { app, menus: options.menus ?? false });
    return new AppSnapshot(tree.app, tree.nodes);
  }

  /** Name and focused window title of an app, for step observations. */
  window(app: string): Promise<MacAppInfo & { title?: string }> {
    return this.client.send('window', { app });
  }

  locate(target: TargetSpec): MacLocator {
    if (!target.app) throw new ActionError('A desktop target needs "app"');
    return new MacLocator(this, target);
  }

  /** Sends a key or chord ("Enter", "Command+N") to the frontmost app. */
  async key(combo: string): Promise<void> {
    await this.client.send('key', { key: combo });
  }

  async type(text: string): Promise<void> {
    await this.client.send('type', { text }, { timeoutMs: 30_000 + text.length * 50 });
  }

  /** Full-screen PNG. Needs the Screen Recording permission to include other apps' windows. */
  async screenshot(path: string): Promise<void> {
    await this.client.send('screenshot', { path });
  }

  /**
   * Chooses a menu item by its path, e.g. ["File", "New Window"]. Items are
   * found in the app's (closed) menus and pressed directly via accessibility.
   */
  async menu(app: string, path: string[]): Promise<void> {
    await this.activate(app);
    const snapshot = await this.snapshot(app, { menus: true });
    let scope: MacNode[] = snapshot.nodes.filter((node) => node.role === 'menubar');
    let found: MacNode | undefined;
    for (const [depth, title] of path.entries()) {
      const candidates = snapshot.nodes.filter(
        (node) => node.role === 'menuitem' && node.name.toLowerCase() === title.toLowerCase() && scope.some((parent) => snapshot.contains(parent, node)),
      );
      // Prefer the shallowest match: "File" the menu-bar item, not a "File" item deep inside a submenu.
      found = candidates.sort((a, b) => depthOf(a) - depthOf(b))[0];
      if (!found) {
        throw new ElementNotFoundError(`${app} has no menu item "${title}"${depth > 0 ? ` under ${path.slice(0, depth).join(' → ')}` : ''}`);
      }
      scope = [found];
    }
    if (!found!.enabled) throw new ActionError(`Menu item ${path.join(' → ')} in ${app} is disabled`);
    await this.client.send('press', { ref: found!.ref });
  }

  close(): void {
    this.client.close();
  }
}

function depthOf(node: MacNode): number {
  let depth = 0;
  for (let current = node.parent; current; current = current.parent) depth++;
  return depth;
}

/**
 * A lazy description of a desktop element, resolved against a fresh
 * accessibility snapshot on every action — strict (ambiguity is an error)
 * and auto-waiting, like the web Locator.
 */
export class MacLocator {
  readonly #desktop: MacDesktop;
  readonly #target: TargetSpec;

  constructor(desktop: MacDesktop, target: TargetSpec) {
    this.#desktop = desktop;
    this.#target = target;
  }

  get app(): string {
    return this.#target.app!;
  }

  toString(): string {
    const t = this.#target;
    const what = t.id ? `#${t.id}` : t.role ? `${t.role}${t.name ? ` "${t.name}"` : ''}` : t.text ? `text "${t.text}"` : 'focused element';
    return `${t.app}: ${what}${t.nth !== undefined ? ` [${t.nth}]` : ''}`;
  }

  /** True when the target names an element (not just "whatever has focus in the app"). */
  get pointsAtElement(): boolean {
    return Boolean(this.#target.role || this.#target.text || this.#target.id);
  }

  /** Matches in the app right now (ignores nth). */
  async matches(snapshot?: AppSnapshot): Promise<{ snapshot: AppSnapshot; nodes: MacNode[] }> {
    const current = snapshot ?? (await this.#desktop.snapshot(this.app));
    const t = this.#target;
    let nodes: MacNode[];
    if (t.id) nodes = matchMacId(current, t.id);
    else if (t.role) nodes = matchMacRole(current, t.role, t.name as TextMatcher | undefined, t.exact);
    else if (t.text) nodes = matchMacText(current, t.text, t.exact);
    else nodes = current.nodes.filter((node) => node.focused);
    return { snapshot: current, nodes };
  }

  /** The single matching element right now, or undefined. Strict. Does not wait. */
  async inspect(): Promise<{ node: MacNode; snapshot: AppSnapshot } | undefined> {
    const { snapshot, nodes } = await this.matches();
    const node = this.#select(nodes, snapshot);
    return node ? { node, snapshot } : undefined;
  }

  async count(): Promise<number> {
    return (await this.matches()).nodes.length;
  }

  /** Waits until exactly one element matches and is visible (and enabled, for actions). */
  async resolve(options: { timeoutMs?: number; enabled?: boolean } = {}): Promise<{ node: MacNode; snapshot: AppSnapshot }> {
    const timeoutMs = options.timeoutMs ?? this.#desktop.defaultTimeoutMs;
    let blocked: string | undefined;
    let appRunning = true;
    const found = await poll(async () => {
      let result;
      try {
        result = await this.matches();
      } catch (error) {
        if (error instanceof ProtocolError && /is not running/.test(error.message)) {
          appRunning = false;
          return undefined;
        }
        throw error;
      }
      appRunning = true;
      const node = this.#select(result.nodes, result.snapshot);
      if (!node) {
        blocked = undefined;
        return undefined;
      }
      if (!node.visible && this.pointsAtElement) {
        blocked = `${result.snapshot.describe(node)} is not visible`;
        return undefined;
      }
      if (options.enabled && !node.enabled) {
        blocked = `${result.snapshot.describe(node)} is disabled`;
        return undefined;
      }
      return { node, snapshot: result.snapshot };
    }, { timeoutMs, intervalMs: 200 });
    if (found) return found;
    if (!appRunning) throw new ElementNotFoundError(`${this.app} is not running (add a "launch" step before this one)`);
    if (blocked) throw new ActionError(`${this}: ${blocked} (waited ${timeoutMs}ms)`);
    throw new ElementNotFoundError(`${this}: no element matched within ${timeoutMs}ms`);
  }

  /** Moves the real pointer to the element and clicks. Falls back to the accessibility press if it has no position. */
  async click(options: { timeoutMs?: number; count?: number; button?: 'left' | 'right' } = {}): Promise<void> {
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs, enabled: true });
    await this.#desktop.activate(this.app);
    const point = centre(node);
    if (point) {
      await this.#desktop.client.send('click', { ...point, count: options.count ?? 1, button: options.button ?? 'left' });
    } else if (node.actions.includes('AXPress')) {
      await this.#desktop.client.send('press', { ref: node.ref });
    } else {
      throw new ActionError(`${this} has no position to click and cannot be pressed`);
    }
  }

  /** Presses the element through accessibility, without moving the pointer. */
  async press(options: { timeoutMs?: number } = {}): Promise<void> {
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs, enabled: true });
    try {
      await this.#desktop.client.send('press', { ref: node.ref });
    } catch (error) {
      if (error instanceof ProtocolError) throw new ActionError(`Cannot press ${this}: ${error.message}`);
      throw error;
    }
  }

  async hover(options: { timeoutMs?: number } = {}): Promise<void> {
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs });
    const point = centre(node);
    if (!point) throw new ActionError(`${this} has no position to hover over`);
    await this.#desktop.activate(this.app);
    await this.#desktop.client.send('move', point);
  }

  /**
   * Gives the element keyboard focus and waits until the app confirms it:
   * focusing is asynchronous, and keystrokes sent before it completes are
   * lost (password fields, which switch on secure input, are the slowest).
   */
  async focus(options: { timeoutMs?: number } = {}): Promise<void> {
    await this.#desktop.activate(this.app);
    if (!this.pointsAtElement) return; // "Whatever has focus in the app".
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs, enabled: true });
    await this.#desktop.client.send('focus', { ref: node.ref }).catch(() => {});
    if (await this.#hasFocus(node)) return;
    // Some controls ignore programmatic focus; clicking them focuses them.
    const point = centre(node);
    if (!point) throw new ActionError(`Cannot focus ${this}`);
    await this.#desktop.client.send('click', point);
    if (!(await this.#hasFocus(node))) throw new ActionError(`${this} did not take keyboard focus`);
  }

  async #hasFocus(node: MacNode): Promise<boolean> {
    const same = (focused: { role?: string; identifier?: string; title?: string; description?: string; frame?: MacNode['frame'] }): boolean =>
      focused.role === node.axRole &&
      (node.identifier ? focused.identifier === node.identifier : (focused.title ?? focused.description ?? '') === node.name) &&
      (!node.frame || !focused.frame || (Math.abs(focused.frame.x - node.frame.x) < 2 && Math.abs(focused.frame.y - node.frame.y) < 2));
    const focused = await poll(async () => {
      const current = await this.#desktop.client.send<{ role?: string }>('focused', { app: this.app });
      return same(current) ? true : undefined;
    }, { timeoutMs: 1_000, intervalMs: 50 });
    return focused === true;
  }

  /** Types with the real keyboard into the element (focusing it first). */
  async type(text: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.focus(options);
    await this.#desktop.type(text);
  }

  /** Presses a key or chord ("Enter", "Command+S") with the element (or the app) focused. */
  async key(combo: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.focus(options);
    await this.#desktop.key(combo);
  }

  /**
   * Replaces the field's content. Sets the value through accessibility when
   * the app allows it (and verifies it); otherwise selects all and types.
   */
  async fill(value: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs, enabled: true });
    if (!['textbox', 'searchbox', 'combobox'].includes(node.role)) throw new ActionError(`Cannot fill ${this}: it is a ${node.role}, not a text field`);
    if (!node.secure) {
      try {
        await this.#desktop.client.send('setValue', { ref: node.ref, value });
        const after = await this.#desktop.client.send<{ value?: string }>('describe', { ref: node.ref });
        if ((after.value ?? '') === value) return;
      } catch {
        // Fall through to keyboard input.
      }
    }
    await this.focus(options);
    await this.#desktop.key('Command+a');
    if (value === '') await this.#desktop.key('Backspace');
    else await this.#desktop.type(value);
  }

  /** Ensures a checkbox/switch is in the wanted state, clicking if needed, and verifies it. */
  async setChecked(checked: boolean, options: { timeoutMs?: number } = {}): Promise<void> {
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs, enabled: true });
    if (!['checkbox', 'switch', 'radio'].includes(node.role)) throw new ActionError(`${this} is a ${node.role}, not a checkbox`);
    const isChecked = (value: string | undefined): boolean => value === '1' || value === 'true';
    if (isChecked(node.value) === checked) return;
    if (!checked && node.role === 'radio') throw new ActionError(`Cannot uncheck ${this}: choose another option instead`);
    await this.click(options);
    const settled = await poll(async () => {
      const now = await this.inspect();
      return now && isChecked(now.node.value) === checked ? true : undefined;
    }, { timeoutMs: 2_000, intervalMs: 150 });
    if (!settled) throw new ActionError(`Clicked ${this} but it is still ${checked ? 'unchecked' : 'checked'}`);
  }

  /** Chooses an item of a pop-up menu (combobox) by its title. */
  async selectOption(option: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const { node } = await this.resolve({ timeoutMs: options.timeoutMs, enabled: true });
    if (node.role !== 'combobox') throw new ActionError(`Cannot select in ${this}: it is a ${node.role}`);
    await this.#desktop.activate(this.app);
    await this.#desktop.client.send('press', { ref: node.ref }); // Opens the pop-up menu.
    const item = await poll(async () => {
      const snapshot = await this.#desktop.snapshot(this.app);
      return snapshot.nodes.find((candidate) => candidate.role === 'menuitem' && candidate.name === option);
    }, { timeoutMs: 3_000, intervalMs: 150 });
    if (!item) {
      await this.#desktop.key('Escape');
      throw new ActionError(`${this} has no option "${option}"`);
    }
    await this.#desktop.client.send('press', { ref: item.ref });
    // The pop-up updates its value first, and the app's own action runs only once the
    // menu has finished closing; wait for both so the next step sees the result.
    const done = await poll(async () => {
      const snapshot = await this.#desktop.snapshot(this.app);
      const popup = snapshot.get(node.ref) ?? snapshot.nodes.find((candidate) => candidate.role === 'combobox' && candidate.name === node.name);
      const menuOpen = snapshot.nodes.some((candidate) => candidate.role === 'menuitem' && candidate.visible);
      return popup?.value === option && !menuOpen ? true : undefined;
    }, { timeoutMs: 3_000, intervalMs: 100 });
    if (!done) throw new ActionError(`Chose "${option}" in ${this}, but the pop-up did not take it`);
    await sleep(50);
  }

  /** The element's visible text: its name, or value for text elements. */
  async textContent(): Promise<string | undefined> {
    const found = await this.inspect();
    return found ? found.snapshot.textOf(found.node) : undefined;
  }

  /** The field's value (never available for password fields). */
  async inputValue(): Promise<string | undefined> {
    const found = await this.inspect();
    return found ? (found.node.value ?? '') : undefined;
  }

  async isVisible(): Promise<boolean> {
    return (await this.inspect())?.node.visible ?? false;
  }

  #select(nodes: MacNode[], snapshot: AppSnapshot): MacNode | undefined {
    if (this.#target.nth !== undefined) return nodes[this.#target.nth];
    if (nodes.length > 1) {
      const listed = nodes.slice(0, 5).map((node, i) => `  ${i}: ${snapshot.describe(node)}`).join('\n');
      throw new AmbiguousLocatorError(`${this} matched ${nodes.length} elements; expected exactly one:\n${listed}\nAdd "nth", or a more specific name or id.`, nodes.length);
    }
    return nodes[0];
  }
}

function centre(node: MacNode): { x: number; y: number } | undefined {
  if (!node.frame || node.frame.width <= 0 || node.frame.height <= 0) return undefined;
  return { x: node.frame.x + node.frame.width / 2, y: node.frame.y + node.frame.height / 2 };
}
