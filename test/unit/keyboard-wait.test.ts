import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Modifier, parseChord, pressChord } from '../../src/input/keyboard.ts';
import { poll } from '../../src/wait.ts';

describe('parseChord', () => {
  it('parses single keys and characters', () => {
    assert.equal(parseChord('Enter')!.key.keyCode, 13);
    assert.equal(parseChord('a')!.key.text, 'a');
    assert.equal(parseChord('a')!.mask, 0);
  });

  it('parses modifier combinations into a bitmask', () => {
    const chord = parseChord('Control+Shift+ArrowLeft')!;
    assert.equal(chord.mask, Modifier.Control | Modifier.Shift);
    assert.deepEqual(chord.modifiers.map((m) => m.key), ['Control', 'Shift']);
    assert.equal(chord.key.key, 'ArrowLeft');
  });

  it('resolves ControlOrMeta per platform', () => {
    assert.equal(parseChord('ControlOrMeta+a', 'darwin')!.mask, Modifier.Meta);
    assert.equal(parseChord('ControlOrMeta+a', 'linux')!.mask, Modifier.Control);
  });

  it('attaches editor commands to shortcuts and strips their text', () => {
    const selectAll = parseChord('Meta+a', 'darwin')!;
    assert.deepEqual(selectAll.commands, ['selectAll']);
    assert.equal(selectAll.key.text, undefined);
    assert.deepEqual(parseChord('Control+Shift+z')!.commands, ['redo']);
    assert.deepEqual(parseChord('Alt+a')!.commands, []);
  });

  it('uppercases letters with Shift', () => {
    const chord = parseChord('Shift+a')!;
    assert.equal(chord.key.key, 'A');
    assert.equal(chord.key.text, 'A');
  });

  it('supports "+" as the key itself', () => {
    const chord = parseChord('Shift++')!;
    assert.equal(chord.key.text, '+');
    assert.equal(parseChord('+')!.key.text, '+');
  });

  it('rejects unknown keys and modifiers', () => {
    assert.equal(parseChord('Hyperdrive'), undefined);
    assert.equal(parseChord('Super+a'), undefined);
    assert.equal(parseChord('a+b'), undefined);
  });
});

describe('pressChord', () => {
  it('presses modifiers, then the key, then releases in reverse with correct masks', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await pressChord({ send: async (_method, params) => void sent.push(params as Record<string, unknown>) as never }, parseChord('Control+Shift+ArrowLeft')!);
    assert.deepEqual(
      sent.map((e) => [e.type, e.key, e.modifiers]),
      [
        ['rawKeyDown', 'Control', Modifier.Control],
        ['rawKeyDown', 'Shift', Modifier.Control | Modifier.Shift],
        ['rawKeyDown', 'ArrowLeft', Modifier.Control | Modifier.Shift],
        ['keyUp', 'ArrowLeft', Modifier.Control | Modifier.Shift],
        ['keyUp', 'Shift', Modifier.Control],
        ['keyUp', 'Control', 0],
      ],
    );
  });

  it('sends editor commands with the key event', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await pressChord({ send: async (_method, params) => void sent.push(params as Record<string, unknown>) as never }, parseChord('Meta+a', 'darwin')!);
    assert.deepEqual(sent.find((e) => e.key === 'a' && e.type === 'rawKeyDown')!.commands, ['selectAll']);
  });
});

describe('poll', () => {
  it('returns the first defined value', async () => {
    let calls = 0;
    const value = await poll(async () => (++calls === 3 ? 'ready' : undefined), { timeoutMs: 1_000, intervalMs: 5 });
    assert.equal(value, 'ready');
    assert.equal(calls, 3);
  });

  it('resolves undefined at the deadline, after at least one probe', async () => {
    let calls = 0;
    assert.equal(await poll(async () => void calls++, { timeoutMs: 30, intervalMs: 10 }), undefined);
    assert.ok(calls >= 1);
  });

  it('propagates probe errors immediately', async () => {
    await assert.rejects(poll(async () => { throw new Error('fatal'); }, { timeoutMs: 1_000 }), /fatal/);
  });

  it('re-probes as soon as the wake signal fires, without waiting out the interval', async () => {
    let notify = (): void => {};
    let ready = false;
    let unsubscribed = false;
    const started = Date.now();
    const result = poll(async () => (ready ? 'woke' : undefined), {
      timeoutMs: 5_000,
      intervalMs: 2_000,
      wake: (callback) => {
        notify = callback;
        return () => {
          unsubscribed = true;
        };
      },
    });
    setTimeout(() => {
      ready = true;
      notify();
    }, 30);
    assert.equal(await result, 'woke');
    assert.ok(Date.now() - started < 1_000, 'did not wait for the 2s interval');
    assert.ok(unsubscribed, 'wake listener removed');
  });
});
