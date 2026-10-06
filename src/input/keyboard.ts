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

/** Sends a real keyDown/keyUp pair through Input.dispatchKeyEvent. */
export async function pressKey(sender: CommandSender, definition: KeyDefinition): Promise<void> {
  const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
  await sender.send('Input.dispatchKeyEvent', {
    ...base,
    // 'keyDown' also produces keypress + text input; 'rawKeyDown' does not.
    type: definition.text ? 'keyDown' : 'rawKeyDown',
    text: definition.text,
    unmodifiedText: definition.text,
  });
  await sender.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}
