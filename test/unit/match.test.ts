import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAccessibleName, getRole } from '../../src/dom/aria.ts';
import { matchByRole, matchByText, textMatches } from '../../src/dom/match.ts';
import { DomSnapshot } from '../../src/dom/snapshot.ts';
import { byId, h, snapshotOf } from '../helpers/dom.ts';

const ids = (nodes: readonly { attributes: Readonly<Record<string, string>> }[]) => nodes.map((node) => node.attributes.id);

describe('textMatches', () => {
  it('is case-insensitive substring by default, whitespace-normalized', () => {
    assert.ok(textMatches('  Hello,\n   World ', 'hello, world'));
    assert.ok(textMatches('Success: saved', 'success'));
    assert.ok(!textMatches('Saved', 'success'));
  });

  it('requires an exact, case-sensitive match with exact', () => {
    assert.ok(textMatches(' Submit ', 'Submit', true));
    assert.ok(!textMatches('Submit form', 'Submit', true));
    assert.ok(!textMatches('submit', 'Submit', true));
  });

  it('supports regular expressions, including stateful global ones', () => {
    const pattern = /^sub/gi;
    assert.ok(textMatches('Submit', pattern));
    assert.ok(textMatches('Submit', pattern)); // lastIndex is reset each time
  });
});

describe('DomSnapshot', () => {
  it('links parents and children and exposes attributes and text', () => {
    const snapshot = snapshotOf(h('form', { id: 'f' }, h('label', { id: 'l' }, 'Name '), h('button', { id: 'b' }, 'Go')));
    const form = byId(snapshot, 'f');
    assert.deepEqual(ids(form.children), ['l', 'b']);
    assert.equal(byId(snapshot, 'b').parent, form);
    assert.equal(snapshot.textContent(form), 'Name Go');
    assert.equal(snapshot.get(byId(snapshot, 'b').backendNodeId), byId(snapshot, 'b'));
  });

  it('skips script and style text', () => {
    const snapshot = snapshotOf(h('div', { id: 'd' }, 'Hi', h('script', {}, 'var x = 1'), h('style', {}, 'p{}')));
    assert.equal(snapshot.textContent(byId(snapshot, 'd')), 'Hi');
  });

  it('marks display:none subtrees and visibility:hidden elements as not visible', () => {
    const snapshot = snapshotOf(
      h('div', { id: 'gone', style: 'display:none' }, h('span', { id: 'inner' }, 'x')),
      h('div', { id: 'hidden', style: 'visibility:hidden' }, 'y'),
      h('div', { id: 'shown' }, 'z'),
    );
    assert.equal(byId(snapshot, 'gone').visible, false);
    assert.equal(byId(snapshot, 'inner').visible, false);
    assert.equal(byId(snapshot, 'hidden').visible, false);
    assert.equal(byId(snapshot, 'shown').visible, true);
  });

  it('parses the DOMSnapshot.captureSnapshot wire format', () => {
    // Shape and string-table indirection as returned by Chromium.
    const strings = ['#document', 'HTML', 'BODY', 'BUTTON', 'id', 'go', '#text', 'Go', 'visible', 'INPUT', 'q', 'typed'];
    const snapshot = DomSnapshot.fromCdp({
      strings,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 2, 3, 2],
            nodeType: [9, 1, 1, 1, 3, 1],
            nodeName: [0, 1, 2, 3, 6, 9],
            nodeValue: [-1, -1, -1, -1, 7, -1],
            backendNodeId: [10, 11, 12, 13, 14, 15],
            attributes: [[], [], [], [4, 5], [], [4, 10]],
            inputValue: { index: [5], value: [11] },
          },
          layout: {
            nodeIndex: [3, 4],
            bounds: [
              [8, 16, 40, 20],
              [10, 18, 20, 16],
            ],
            styles: [[8], [8]],
          },
        },
      ],
    });

    const button = snapshot.get(13)!;
    assert.equal(button.tagName, 'button');
    assert.deepEqual(button.attributes, { id: 'go' });
    assert.deepEqual(button.bounds, { x: 8, y: 16, width: 40, height: 20 });
    assert.equal(button.visible, true);
    assert.equal(button.parent?.tagName, 'body');
    assert.equal(snapshot.textContent(button), 'Go');

    const input = snapshot.get(15)!;
    assert.equal(input.inputValue, 'typed');
    assert.equal(input.visible, false, 'no layout entry means not rendered');
  });
});

describe('matchByText', () => {
  it('returns the innermost matching elements only', () => {
    const snapshot = snapshotOf(h('div', { id: 'outer' }, h('p', { id: 'p' }, 'Saved ', h('b', { id: 'b' }, 'Success'))));
    assert.deepEqual(ids(matchByText(snapshot, 'Success')), ['b']);
    assert.deepEqual(ids(matchByText(snapshot, 'Saved Success')), ['p']);
  });

  it('ignores hidden elements and non-content tags', () => {
    const snapshot = snapshotOf(
      h('p', { id: 'hidden', style: 'display:none' }, 'Success'),
      h('script', { id: 's' }, 'Success'),
    );
    assert.deepEqual(matchByText(snapshot, 'Success'), []);
  });

  it('does not let hidden descendants make an ancestor match', () => {
    const snapshot = snapshotOf(h('div', { id: 'wrap' }, h('span', { style: 'display:none' }, 'Success'), 'Pending'));
    assert.deepEqual(matchByText(snapshot, 'Success'), []);
    assert.deepEqual(ids(matchByText(snapshot, 'Pending')), ['wrap']);
  });

  it('honors exact', () => {
    const snapshot = snapshotOf(h('p', { id: 'a' }, 'Success'), h('p', { id: 'b' }, 'Success: Hello'));
    assert.deepEqual(ids(matchByText(snapshot, 'Success')), ['a', 'b']);
    assert.deepEqual(ids(matchByText(snapshot, 'Success', true)), ['a']);
  });
});

describe('getRole', () => {
  it('derives implicit roles from tags and input types', () => {
    const snapshot = snapshotOf(
      h('button', { id: 'button' }),
      h('a', { id: 'link', href: '/x' }),
      h('a', { id: 'anchor' }),
      h('input', { id: 'text' }),
      h('input', { id: 'email', type: 'email' }),
      h('input', { id: 'submit', type: 'submit' }),
      h('input', { id: 'check', type: 'checkbox' }),
      h('textarea', { id: 'area' }),
      h('h2', { id: 'heading' }),
      h('div', { id: 'div' }),
    );
    const roles = Object.fromEntries(snapshot.elements().map((node) => [node.attributes.id, getRole(node)]));
    assert.equal(roles.button, 'button');
    assert.equal(roles.link, 'link');
    assert.equal(roles.anchor, undefined, '<a> without href has no link role');
    assert.equal(roles.text, 'textbox');
    assert.equal(roles.email, 'textbox');
    assert.equal(roles.submit, 'button');
    assert.equal(roles.check, 'checkbox');
    assert.equal(roles.area, 'textbox');
    assert.equal(roles.heading, 'heading');
    assert.equal(roles.div, undefined);
  });

  it('prefers an explicit role attribute', () => {
    const snapshot = snapshotOf(h('div', { id: 'd', role: 'button' }, 'Go'));
    assert.equal(getRole(byId(snapshot, 'd')), 'button');
  });
});

describe('getAccessibleName', () => {
  const name = (snapshot: DomSnapshot, id: string) => getAccessibleName(snapshot, byId(snapshot, id));

  it('uses aria-labelledby, then aria-label', () => {
    const snapshot = snapshotOf(
      h('span', { id: 'lbl' }, 'From labelledby'),
      h('button', { id: 'a', 'aria-labelledby': 'lbl', 'aria-label': 'ignored' }, 'text'),
      h('button', { id: 'b', 'aria-label': 'Close dialog' }, '×'),
    );
    assert.equal(name(snapshot, 'a'), 'From labelledby');
    assert.equal(name(snapshot, 'b'), 'Close dialog');
  });

  it('labels form controls via <label for>, wrapping <label>, then placeholder', () => {
    const snapshot = snapshotOf(
      h('label', { for: 'n' }, 'Name'),
      h('input', { id: 'n' }),
      h('label', {}, 'Email ', h('input', { id: 'e', type: 'email' })),
      h('input', { id: 'p', placeholder: 'Search…' }),
    );
    assert.equal(name(snapshot, 'n'), 'Name');
    assert.equal(name(snapshot, 'e'), 'Email');
    assert.equal(name(snapshot, 'p'), 'Search…');
  });

  it('names buttons from content, input buttons from value', () => {
    const snapshot = snapshotOf(
      h('button', { id: 'b' }, '  Save  changes '),
      h('input', { id: 'i', type: 'submit', value: 'Send' }),
      h('input', { id: 'd', type: 'submit' }),
    );
    assert.equal(name(snapshot, 'b'), 'Save changes');
    assert.equal(name(snapshot, 'i'), 'Send');
    assert.equal(name(snapshot, 'd'), 'Submit');
  });
});

describe('matchByRole', () => {
  const snapshot = snapshotOf(
    h('button', { id: 'save' }, 'Save'),
    h('button', { id: 'save-all' }, 'Save all'),
    h('button', { id: 'hidden', style: 'display:none' }, 'Save'),
    h('div', { 'aria-hidden': 'true' }, h('button', { id: 'aria-hidden' }, 'Save')),
    h('a', { id: 'link', href: '#' }, 'Save'),
  );

  it('filters by role and substring name, excluding hidden elements', () => {
    assert.deepEqual(ids(matchByRole(snapshot, 'button', { name: 'save' })), ['save', 'save-all']);
  });

  it('filters by exact name', () => {
    assert.deepEqual(ids(matchByRole(snapshot, 'button', { name: 'Save', exact: true })), ['save']);
  });

  it('matches every element with the role when no name is given', () => {
    assert.deepEqual(ids(matchByRole(snapshot, 'link')), ['link']);
  });
});
