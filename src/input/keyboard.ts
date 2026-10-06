export interface KeyDefinition {
  /** DOM KeyboardEvent.key */
  key: string;
  /** DOM KeyboardEvent.code */
  code: string;
  /** Legacy keyCode; Chromium uses it to run default actions such as form submission. */
  keyCode: number;
  /** Character the key inserts, if any. */
  text?: string;
}

/** Anything that can send CDP commands; satisfied by CdpSession. */
export interface CommandSender {
  send<T = unknown>(method: string, params?: object): Promise<T>;
}

/** CDP modifier bit flags (Input.dispatchKeyEvent `modifiers`). */
export const Modifier = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type ModifierName = keyof typeof Modifier;

const MODIFIER_KEYS: Record<ModifierName, KeyDefinition> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/**
 * Editing shortcuts are applied by the OS text system, which CDP key events
 * bypass. Chromium accepts the matching editor command alongside the key
 * event instead, so Ctrl/Cmd+A really selects all, on every platform.
 */
const SHORTCUT_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  x: 'cut',
  v: 'paste',
  z: 'undo',
};

/** Resolves a key name ("Enter") or a single character ("a") to its definition. */
export function keyDefinition(key: string): KeyDefinition | undefined {
  const named = NAMED_KEYS[key];
  if (named) return named;
  if ([...key].length !== 1) return undefined;

  if (key === ' ') return NAMED_KEYS.Space;
  const upper = key.toUpperCase();
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  // Punctuation, symbols, non-Latin characters: the inserted text is what matters.
  return { key, code: '', keyCode: 0, text: key };
}

export interface KeyChord {
  /** Modifier keys in the order they are pressed. */
  modifiers: KeyDefinition[];
  /** Bitmask of Modifier flags held while `key` is pressed. */
  mask: number;
  key: KeyDefinition;
  /** Editor commands Chromium should run for this chord (e.g. selectAll). */
  commands: string[];
}

/**
 * Parses "Enter", "a", "Shift+ArrowLeft", "Control+Shift+z" or "ControlOrMeta+a".
 * ControlOrMeta is Meta on macOS and Control elsewhere. Returns undefined if invalid.
 */
export function parseChord(combo: string, platform: NodeJS.Platform = process.platform): KeyChord | undefined {
  // Split on '+' only when followed by another character, so "Shift++" means Shift and "+".
  const parts = combo.length > 1 ? combo.split(/\+(?=.)/) : [combo];
  const keyName = parts.pop()!;
  const modifiers: KeyDefinition[] = [];
  let mask = 0;
  for (const part of parts) {
    const name: string = part === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : part;
    if (!(name in Modifier)) return undefined;
    const modifier = name as ModifierName;
    if (mask & Modifier[modifier]) continue;
    mask |= Modifier[modifier];
    modifiers.push(MODIFIER_KEYS[modifier]);
  }

  const base = keyDefinition(keyName);
  if (!base) return undefined;

  let key = base;
  const commands: string[] = [];
  if (mask & (Modifier.Control | Modifier.Meta | Modifier.Alt)) {
    // Shortcuts never insert text.
    key = { key: base.key, code: base.code, keyCode: base.keyCode };
    const command = SHORTCUT_COMMANDS[base.key.toLowerCase()];
    if (command && !(mask & Modifier.Alt)) commands.push(command === 'undo' && mask & Modifier.Shift ? 'redo' : command);
  } else if (mask & Modifier.Shift && base.text && /^[a-z]$/.test(base.key)) {
    const upper = base.key.toUpperCase();
    key = { ...base, key: upper, text: upper };
  }
  return { modifiers, mask, key, commands };
}

/** Sends a real keyDown/keyUp pair through Input.dispatchKeyEvent. */
export async function pressKey(sender: CommandSender, definition: KeyDefinition): Promise<void> {
  await pressChord(sender, { modifiers: [], mask: 0, key: definition, commands: [] });
}

/** Presses modifiers in order, then the key (with editor commands), then releases in reverse. */
export async function pressChord(sender: CommandSender, chord: KeyChord): Promise<void> {
  let mask = 0;
  for (const modifier of chord.modifiers) {
    mask |= modifierFlag(modifier);
    await sender.send('Input.dispatchKeyEvent', { ...eventBase(modifier), type: 'rawKeyDown', modifiers: mask });
  }

  const { key } = chord;
  await sender.send('Input.dispatchKeyEvent', {
    ...eventBase(key),
    // 'keyDown' also produces keypress + text input; 'rawKeyDown' does not.
    type: key.text ? 'keyDown' : 'rawKeyDown',
    text: key.text,
    unmodifiedText: key.text,
    modifiers: chord.mask,
    ...(chord.commands.length > 0 ? { commands: chord.commands } : {}),
  });
  await sender.send('Input.dispatchKeyEvent', { ...eventBase(key), type: 'keyUp', modifiers: chord.mask });

  for (const modifier of [...chord.modifiers].reverse()) {
    mask &= ~modifierFlag(modifier);
    await sender.send('Input.dispatchKeyEvent', { ...eventBase(modifier), type: 'keyUp', modifiers: mask });
  }
}

function eventBase(definition: KeyDefinition) {
  return { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
}

function modifierFlag(definition: KeyDefinition): number {
  return Modifier[definition.key as ModifierName] ?? 0;
}
