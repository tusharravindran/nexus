import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DomSnapshot } from '../../src/dom/snapshot.ts';
import { ActionError, AmbiguousLocatorError, ElementNotFoundError, ProtocolError } from '../../src/errors.ts';
import { Locator, type LocatorHost, type LocatorQuery } from '../../src/locator/locator.ts';
import { byId, h, snapshotOf } from '../helpers/dom.ts';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A LocatorHost backed by a fixed snapshot. CDP commands are recorded and
 * answered by `responders`, defaulting to an element that is hit-testable
 * at the center of a 100×40 quad.
 */
class FakePage implements LocatorHost {
  readonly defaultTimeoutMs = 150;
  readonly calls: Call[] = [];
  snapshots = 0;
  current: DomSnapshot;
  css: Record<string, number[]> = {};
  hitTarget: number | undefined;
  responders: Record<string, (params: Record<string, unknown>) => unknown> = {
    'DOM.getContentQuads': () => ({ quads: [[0, 0, 100, 0, 100, 40, 0, 40]] }),
    'DOM.getNodeForLocation': (params) => ({ backendNodeId: this.hitTarget ?? this.lastTarget(params) }),
  };

  constructor(snapshot: DomSnapshot) {
    this.current = snapshot;
  }

  readonly session = {
    send: async <T>(method: string, params: object = {}): Promise<T> => {
      this.calls.push({ method, params: params as Record<string, unknown> });
      const respond = this.responders[method];
      return (respond ? respond(params as Record<string, unknown>) : {}) as T;
    },
  };

  async snapshot(): Promise<DomSnapshot> {
    this.snapshots++;
    return this.current;
  }

  async querySelectorAll(selector: string): Promise<number[]> {
    return this.css[selector] ?? [];
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** By default the click lands on whatever element was last scrolled into view. */
  private lastTarget(_params: Record<string, unknown>): number {
    const scroll = [...this.calls].reverse().find((call) => call.method === 'DOM.scrollIntoViewIfNeeded');
    return scroll?.params.backendNodeId as number;
  }
}

const role = (r: string, name?: string): LocatorQuery => ({ kind: 'role', role: r, name, exact: false });

describe('Locator laziness', () => {
  it('does nothing until an action runs, then resolves against a fresh snapshot each time', async () => {
    const page = new FakePage(snapshotOf(h('button', { id: 'a' }, 'Go')));
    const locator = new Locator(page, role('button', 'Go'));
    assert.equal(page.snapshots, 0);
    assert.equal(page.calls.length, 0);

    await locator.click();
    assert.equal(page.snapshots, 1);

    // Re-render: the same locator finds the new element.
    page.current = snapshotOf(h('div', {}, h('button', { id: 'b' }, 'Go')));
    await locator.click();
    const clicked = page.calls.filter((c) => c.method === 'DOM.scrollIntoViewIfNeeded').map((c) => c.params.backendNodeId);
    assert.deepEqual(clicked, [byId(snapshotOf(h('button', { id: 'a' }, 'Go')), 'a').backendNodeId, byId(page.current, 'b').backendNodeId]);
  });

  it('describes itself readably', () => {
    const page = new FakePage(snapshotOf());
    assert.equal(String(new Locator(page, role('button', 'Submit'))), "getByRole('button', { name: 'Submit' })");
    assert.equal(String(new Locator(page, { kind: 'text', text: /ok/i, exact: false }).nth(2)), 'getByText(/ok/i).nth(2)');
    assert.equal(String(new Locator(page, { kind: 'css', selector: '#name' })), "locator('#name')");
  });
});

describe('Locator ambiguity', () => {
  const twoDeletes = () => snapshotOf(h('button', { id: 'd1' }, 'Delete'), h('button', { id: 'd2' }, 'Delete'));

  it('throws AmbiguousLocatorError immediately and sends no input', async () => {
    const page = new FakePage(twoDeletes());
    const started = Date.now();
    await assert.rejects(new Locator(page, role('button', 'Delete')).click({ timeoutMs: 5_000 }), (error: unknown) => {
      assert.ok(error instanceof AmbiguousLocatorError);
      assert.equal(error.count, 2);
      assert.match(error.message, /#d1/);
      assert.match(error.message, /#d2/);
      assert.match(error.message, /nth/);
      return true;
    });
    assert.ok(Date.now() - started < 1_000, 'ambiguity is not retried');
    assert.equal(page.calls.length, 0);
  });

  it('also applies to read operations', async () => {
    const page = new FakePage(twoDeletes());
    await assert.rejects(new Locator(page, role('button', 'Delete')).textContent(), AmbiguousLocatorError);
  });

  it('nth() picks one match and clicks it', async () => {
    const page = new FakePage(twoDeletes());
    await new Locator(page, role('button', 'Delete')).nth(1).click();
    const target = page.calls.find((c) => c.method === 'DOM.scrollIntoViewIfNeeded')!;
    assert.equal(target.params.backendNodeId, byId(page.current, 'd2').backendNodeId);
  });

  it('count() reports every match without throwing', async () => {
    const page = new FakePage(twoDeletes());
    assert.equal(await new Locator(page, role('button', 'Delete')).count(), 2);
  });
});

describe('Locator actions', () => {
  it('click scrolls, hit-tests, then sends trusted mouse events at the quad center', async () => {
    const page = new FakePage(snapshotOf(h('button', { id: 'go' }, 'Go')));
    await new Locator(page, role('button', 'Go')).click();

    assert.deepEqual(page.methods(), [
      'DOM.scrollIntoViewIfNeeded',
      'DOM.getContentQuads',
      'DOM.getNodeForLocation',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    const mouse = page.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params);
    assert.deepEqual(mouse.map((p) => p.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.deepEqual(mouse.map((p) => [p.x, p.y]), [[50, 20], [50, 20], [50, 20]]);
  });

  it('type focuses the element and sends a keyDown/keyUp pair per character', async () => {
    const page = new FakePage(snapshotOf(h('input', { id: 'n', 'aria-label': 'Name' })));
    await new Locator(page, role('textbox', 'Name')).type('Hi');

    assert.equal(page.calls[0]!.method, 'DOM.focus');
    const keys = page.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => [c.params.type, c.params.key, c.params.text]);
    assert.deepEqual(keys, [
      ['keyDown', 'H', 'H'],
      ['keyUp', 'H', undefined],
      ['keyDown', 'i', 'i'],
      ['keyUp', 'i', undefined],
    ]);
  });

  it('press sends named keys with their key codes', async () => {
    const page = new FakePage(snapshotOf(h('input', { id: 'n', 'aria-label': 'Name' })));
    await new Locator(page, role('textbox')).press('Enter');
    const down = page.calls.find((c) => c.method === 'Input.dispatchKeyEvent')!;
    assert.equal(down.params.key, 'Enter');
    assert.equal(down.params.windowsVirtualKeyCode, 13);
    assert.equal(down.params.text, '\r');
  });
});

describe('Locator action errors', () => {
  it('throws ElementNotFoundError when nothing matches before the timeout', async () => {
    const page = new FakePage(snapshotOf(h('button', {}, 'Other')));
    await assert.rejects(new Locator(page, role('button', 'Missing')).click({ timeoutMs: 80 }), (error: unknown) => {
      assert.ok(error instanceof ElementNotFoundError);
      assert.match(error.message, /getByRole\('button', \{ name: 'Missing' \}\)/);
      return true;
    });
    assert.ok(page.snapshots > 1, 'resolution was retried while waiting');
  });

  it('throws ActionError when the element stays invisible', async () => {
    const page = new FakePage(snapshotOf(h('button', { id: 'x', style: 'visibility:hidden' }, 'Ghost')));
    page.css['#x'] = [byId(page.current, 'x').backendNodeId];
    await assert.rejects(new Locator(page, { kind: 'css', selector: '#x' }).click({ timeoutMs: 80 }), (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.match(error.message, /not visible/);
      return true;
    });
  });

  it('throws ActionError for a disabled button', async () => {
    const page = new FakePage(snapshotOf(h('button', { disabled: '' }, 'Pay')));
    await assert.rejects(new Locator(page, role('button', 'Pay')).click({ timeoutMs: 80 }), /is disabled/);
  });

  it('throws ActionError when another element would receive the click', async () => {
    const page = new FakePage(snapshotOf(h('button', { id: 'b' }, 'Buy'), h('div', { id: 'overlay' })));
    page.hitTarget = byId(page.current, 'overlay').backendNodeId;
    await assert.rejects(new Locator(page, role('button', 'Buy')).click(), (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.match(error.message, /covered by <div#overlay>/);
      return true;
    });
    assert.ok(!page.methods().includes('Input.dispatchMouseEvent'));
  });

  it('accepts a hit on a descendant of the target', async () => {
    const page = new FakePage(snapshotOf(h('button', { id: 'b' }, h('span', { id: 'icon' }, 'Buy'))));
    page.hitTarget = byId(page.current, 'icon').backendNodeId;
    await new Locator(page, role('button', 'Buy')).click();
    assert.ok(page.methods().includes('Input.dispatchMouseEvent'));
  });

  it('throws ActionError when the element has no clickable area', async () => {
    const page = new FakePage(snapshotOf(h('button', {}, 'Flat')));
    page.responders['DOM.getContentQuads'] = () => ({ quads: [[5, 5, 5, 5, 5, 5, 5, 5]] });
    await assert.rejects(new Locator(page, role('button')).click(), /no clickable area/);
  });

  it('throws ActionError when typing into a non-editable element, sending no keys', async () => {
    const page = new FakePage(snapshotOf(h('p', { id: 'p' }, 'Plain')));
    page.css['#p'] = [byId(page.current, 'p').backendNodeId];
    await assert.rejects(new Locator(page, { kind: 'css', selector: '#p' }).type('x'), /not editable/);
    assert.ok(!page.methods().includes('Input.dispatchKeyEvent'));
  });

  it('throws ActionError for an unknown key name', async () => {
    const page = new FakePage(snapshotOf(h('input', { 'aria-label': 'Q' })));
    await assert.rejects(new Locator(page, role('textbox')).press('Hyperdrive'), (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.match(error.message, /Unknown key "Hyperdrive"/);
      return true;
    });
  });

  it('converts a protocol failure while focusing into ActionError', async () => {
    const page = new FakePage(snapshotOf(h('input', { 'aria-label': 'Q' })));
    page.responders['DOM.focus'] = () => {
      throw new ProtocolError('DOM.focus', -32000, 'Element is not focusable');
    };
    await assert.rejects(new Locator(page, role('textbox')).type('x'), (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.match(error.message, /Cannot focus .*not focusable/);
      return true;
    });
  });
});

describe('Locator.waitFor', () => {
  it('resolves once the element appears', async () => {
    const page = new FakePage(snapshotOf());
    setTimeout(() => {
      page.current = snapshotOf(h('p', { id: 'late' }, 'Loaded later'));
    }, 40);
    await new Locator(page, { kind: 'text', text: 'Loaded later', exact: false }).waitFor({ timeoutMs: 1_000 });
  });

  it('distinguishes attached from visible', async () => {
    const page = new FakePage(snapshotOf(h('p', { id: 'h', style: 'display:none' }, 'x')));
    page.css['#h'] = [byId(page.current, 'h').backendNodeId];
    const locator = new Locator(page, { kind: 'css', selector: '#h' });
    await locator.waitFor({ state: 'attached', timeoutMs: 50 });
    await assert.rejects(locator.waitFor({ state: 'visible', timeoutMs: 50 }), ElementNotFoundError);
  });
});
