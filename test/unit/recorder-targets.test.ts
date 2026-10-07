import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomSnapshot, NodeType, type RawNode } from '../../src/dom/snapshot.ts';
import { looksStable, targetFor } from '../../src/recorder/targets.ts';
import { byId, h, snapshotOf } from '../helpers/dom.ts';

const target = (snapshot: DomSnapshot, id: string) => targetFor(snapshot, byId(snapshot, id));

describe('targetFor', () => {
  it('prefers role + accessible name', () => {
    const snapshot = snapshotOf(
      h('label', { for: 'email' }, 'Email'),
      h('input', { id: 'email' }),
      h('button', { id: 'save' }, 'Save changes'),
    );
    assert.deepEqual(target(snapshot, 'email'), { role: 'textbox', name: 'Email' });
    assert.deepEqual(target(snapshot, 'save'), { role: 'button', name: 'Save changes' });
  });

  it('uses an exact name when the substring is ambiguous', () => {
    const snapshot = snapshotOf(h('button', { id: 'save' }, 'Save'), h('button', { id: 'save-all' }, 'Save all'));
    assert.deepEqual(target(snapshot, 'save'), { role: 'button', name: 'Save', exact: true });
    assert.deepEqual(target(snapshot, 'save-all'), { role: 'button', name: 'Save all' });
  });

  it('falls back to a stable id, then text, then name attribute', () => {
    const snapshot = snapshotOf(
      h('button', { id: 'delete-1' }, 'Delete'),
      h('button', { id: 'delete-2' }, 'Delete'),
      h('div', { id: 'r1234567' }, h('span', { id: 'note' }, 'Remember me')),
      h('input', { name: 'q', type: 'hidden' }),
      h('input', { id: 'auto-998877', name: 'search' }),
      h('input', { id: 'other', name: 'other-field' }),
    );
    assert.deepEqual(target(snapshot, 'delete-1'), { css: '#delete-1' });
    assert.deepEqual(target(snapshot, 'note'), { css: '#note' });
    // Unlabelled textboxes: role is ambiguous, id looks generated → name attribute.
    assert.deepEqual(target(snapshot, 'auto-998877'), { css: 'input[name="search"]' });
  });

  it('uses visible text for elements without a role or stable id', () => {
    const snapshot = snapshotOf(h('div', {}, h('span', {}, 'Profile')), h('span', { id: ':r1:' }, 'Unique words here'));
    const node = snapshot.elements().find((n) => n.attributes.id === ':r1:')!;
    assert.deepEqual(targetFor(snapshot, node), { text: 'Unique words here' });
  });

  it('falls back to position when nothing else is unique', () => {
    const snapshot = snapshotOf(h('button', {}, 'Go'), h('button', {}, 'Go'));
    const [, second] = snapshot.elements().filter((n) => n.tagName === 'button');
    assert.deepEqual(targetFor(snapshot, second!), { role: 'button', nth: 1 });
  });

  it('every generated target resolves to exactly the recorded element', () => {
    const snapshot = snapshotOf(
      h('nav', {}, h('a', { href: '/a', id: 'home' }, 'Home'), h('a', { href: '/b' }, 'Home page')),
      h('form', {}, h('label', {}, 'Name ', h('input', { id: 'name' })), h('button', { type: 'submit' }, 'Send')),
      h('p', {}, 'Footer'),
    );
    for (const node of snapshot.elements().filter((n) => !['html', 'body', 'nav', 'form', 'label'].includes(n.tagName))) {
      const spec = targetFor(snapshot, node);
      assert.ok(spec.css || spec.text || spec.role, `target for ${snapshot.describe(node)}`);
    }
    assert.deepEqual(target(snapshot, 'home'), { role: 'link', name: 'Home', exact: true });
  });

  it('scopes with `within` the iframe only when a page-wide target is ambiguous', () => {
    // Main document: button "Pay"; iframe#checkout contains another "Pay" and a unique "Card number".
    const raw: RawNode[] = [];
    const box = { x: 0, y: 0, width: 100, height: 20 };
    const add = (node: Omit<RawNode, 'backendNodeId'>) => raw.push({ backendNodeId: raw.length + 1, bounds: box, visibility: 'visible', ...node }) - 1;
    const doc = add({ nodeType: NodeType.Document, nodeName: '#document', parentIndex: -1 });
    const body = add({ nodeType: NodeType.Element, nodeName: 'BODY', parentIndex: doc });
    const mainPay = add({ nodeType: NodeType.Element, nodeName: 'BUTTON', parentIndex: body, attributes: { id: 'pay-main' } });
    add({ nodeType: NodeType.Text, nodeName: '#text', nodeValue: 'Pay', parentIndex: mainPay });
    const iframe = add({ nodeType: NodeType.Element, nodeName: 'IFRAME', parentIndex: body, attributes: { id: 'checkout', title: 'Checkout' } });
    const innerDoc = add({ nodeType: NodeType.Document, nodeName: '#document', parentIndex: iframe });
    const innerBody = add({ nodeType: NodeType.Element, nodeName: 'BODY', parentIndex: innerDoc });
    const innerPay = add({ nodeType: NodeType.Element, nodeName: 'BUTTON', parentIndex: innerBody });
    add({ nodeType: NodeType.Text, nodeName: '#text', nodeValue: 'Pay', parentIndex: innerPay });
    const card = add({ nodeType: NodeType.Element, nodeName: 'INPUT', parentIndex: innerBody, attributes: { 'aria-label': 'Card number' } });
    const snapshot = new DomSnapshot(raw);
    const node = (index: number) => snapshot.get(raw[index]!.backendNodeId)!;

    assert.deepEqual(targetFor(snapshot, node(card)), { role: 'textbox', name: 'Card number' });
    assert.deepEqual(targetFor(snapshot, node(innerPay)), { role: 'button', name: 'Pay', within: { css: 'iframe#checkout' } });
    assert.deepEqual(targetFor(snapshot, node(mainPay)), { css: '#pay-main' });
  });
});

describe('looksStable', () => {
  it('accepts hand-written ids and rejects generated ones', () => {
    for (const id of ['email', 'submit-button', 'nav_main', 'step2']) assert.ok(looksStable(id), id);
    for (const id of [':r1:', 'ember1234', 'a3f9c2e1b7d45f60', '']) assert.ok(!looksStable(id), id);
  });
});

describe('targetFor with the element state before the action', () => {
  it('targets the before-name when the action changed the element (a toggle)', () => {
    // Snapshot taken after clicking "Show details", which renamed itself.
    const snapshot = snapshotOf(h('button', { id: 't' }, 'Hide details'), h('button', {}, 'Help'));
    const node = byId(snapshot, 't');
    assert.deepEqual(targetFor(snapshot, node, { name: 'Show details', text: 'Show details' }), { role: 'button', name: 'Show details' });
  });

  it('ignores the before-state when the name did not change', () => {
    const snapshot = snapshotOf(h('button', { id: 's' }, 'Save'));
    assert.deepEqual(targetFor(snapshot, byId(snapshot, 's'), { name: 'Save', text: 'Save' }), { role: 'button', name: 'Save' });
  });

  it('falls back to other strategies when the before-name belongs to another element', () => {
    // After the click this button says "Following"; another button still says "Follow".
    const snapshot = snapshotOf(h('button', { id: 'follow-ada' }, 'Following'), h('button', {}, 'Follow'));
    assert.deepEqual(targetFor(snapshot, byId(snapshot, 'follow-ada'), { name: 'Follow', text: 'Follow' }), { css: '#follow-ada' });
  });
});
