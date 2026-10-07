import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeAdvisor } from '../../src/ai/advisor.ts';
import { AmbiguousLocatorError, ElementNotFoundError, VerificationError } from '../../src/errors.ts';
import { pageOutline } from '../../src/heal/outline.ts';
import { deterministicRepair, isRepairable, similarity, type RepairContext } from '../../src/heal/repair.ts';
import type { NexusPage } from '../../src/page/page.ts';
import { parseTarget, replaceRawTarget, stepTarget, withTarget, parseTask } from '../../src/task/schema.ts';
import { DomSnapshot, NodeType, type RawNode } from '../../src/dom/snapshot.ts';
import { h, snapshotOf } from '../helpers/dom.ts';
import { reply, ScriptedModel, text } from '../helpers/fake-model.ts';

/** deterministicRepair only touches the page to resolve `within`; these tests have none. */
const noPage = {} as NexusPage;

describe('pageOutline', () => {
  it('lists visible, usable elements with names, state and stable ids, and leftover text', () => {
    const snapshot = snapshotOf(
      h('h1', {}, 'Checkout'),
      h('label', { for: 'email' }, 'Email'),
      h('input', { id: 'email', 'data-value': 'ada@example.test' }),
      h('label', {}, h('input', { type: 'checkbox', 'data-checked': '' }), ' Accept terms'),
      h('button', { id: 'pay' }, 'Pay'),
      h('button', { id: 'r1234567', disabled: '' }, 'Later'),
      h('p', {}, 'Your card was declined'),
      h('button', { style: 'display:none' }, 'Hidden'),
      h('script', {}, 'ignored()'),
    );
    assert.equal(
      pageOutline(snapshot),
      [
        'heading "Checkout" level=1',
        'textbox "Email" value="ada@example.test" #email',
        'checkbox "Accept terms" checked',
        'button "Pay" #pay',
        'button "Later" disabled',
        'text "Your card was declined"',
      ].join('\n'),
    );
  });

  it('collapses repeated lines and truncates long outlines', () => {
    const snapshot = snapshotOf(...Array.from({ length: 5 }, () => h('button', {}, 'Delete')), h('a', { href: '/' }, 'Home'));
    assert.equal(pageOutline(snapshot), 'button "Delete" ×5\nlink "Home"');
    assert.equal(pageOutline(snapshotOf(h('p', {}, 'a'), h('p', {}, 'b'), h('p', {}, 'c')), { maxLines: 2 }), 'text "a"\ntext "b"\n… 1 more lines');
  });

  it('indents iframe content under its iframe', () => {
    const raw: RawNode[] = [];
    const box = { x: 0, y: 0, width: 100, height: 20 };
    const add = (node: Omit<RawNode, 'backendNodeId'>) => raw.push({ backendNodeId: raw.length + 1, bounds: box, ...node }) - 1;
    const doc = add({ nodeType: NodeType.Document, nodeName: '#document', parentIndex: -1 });
    const frame = add({ nodeType: NodeType.Element, nodeName: 'IFRAME', parentIndex: doc, attributes: { id: 'payment', title: 'Payment' } });
    const inner = add({ nodeType: NodeType.Document, nodeName: '#document', parentIndex: frame });
    add({ nodeType: NodeType.Element, nodeName: 'INPUT', parentIndex: inner, attributes: { 'aria-label': 'Card number' } });
    assert.equal(pageOutline(new DomSnapshot(raw)), 'iframe#payment "Payment"\n  textbox "Card number"');
  });
});

describe('deterministic repair', () => {
  it('only treats locator failures as repairable', () => {
    assert.ok(isRepairable(new ElementNotFoundError('x')));
    assert.ok(isRepairable(new AmbiguousLocatorError('x', 2)));
    assert.ok(!isRepairable(new VerificationError('x')), 'a failed check may be a real bug');
  });

  it('retargets a renamed element to the clearly most similar one of the same role', async () => {
    const snapshot = snapshotOf(h('button', { id: 'submit' }, 'Submit'), h('button', {}, 'Delete'), h('a', { href: '#' }, 'Submit form'));
    const proposal = await deterministicRepair(noPage, snapshot, { role: 'button', name: 'Submit form' }, new ElementNotFoundError('gone'));
    assert.deepEqual(proposal?.target, { role: 'button', name: 'Submit' });
    assert.equal(proposal?.source, 'deterministic');
    assert.match(proposal!.reason, /closest button is "Submit"/);
  });

  it('refuses when nothing is clearly similar, or two candidates are equally close', async () => {
    const snapshot = snapshotOf(h('button', {}, 'Delete'), h('button', {}, 'Archive'));
    assert.equal(await deterministicRepair(noPage, snapshot, { role: 'button', name: 'Submit' }, new ElementNotFoundError('gone')), undefined);
    const twins = snapshotOf(h('button', {}, 'Save draft'), h('button', {}, 'Save drafts'));
    assert.equal(await deterministicRepair(noPage, twins, { role: 'button', name: 'Save draft!' }, new ElementNotFoundError('gone')), undefined);
  });

  it('makes an ambiguous substring target exact when that is unique', async () => {
    const snapshot = snapshotOf(h('button', {}, 'Save'), h('button', {}, 'Save all'));
    const proposal = await deterministicRepair(noPage, snapshot, { role: 'button', name: 'Save' }, new AmbiguousLocatorError('2', 2));
    assert.deepEqual(proposal?.target, { role: 'button', name: 'Save', exact: true });
    const same = snapshotOf(h('button', {}, 'Delete'), h('button', {}, 'Delete'));
    assert.equal(await deterministicRepair(noPage, same, { role: 'button', name: 'Delete' }, new AmbiguousLocatorError('2', 2)), undefined);
  });

  it('similarity is case- and whitespace-insensitive', () => {
    assert.equal(similarity('Sign  in', 'sign in'), 1);
    assert.ok(similarity('Submit form', 'Submit') > 0.7);
    assert.ok(similarity('Submit', 'Delete') < 0.3);
    assert.equal(similarity('', 'x'), 0);
  });
});

describe('ClaudeAdvisor', () => {
  const context: RepairContext = {
    task: 'Checkout',
    stepIndex: 2,
    step: { click: { role: 'button', name: 'Proceed' } },
    description: "click getByRole('button', { name: 'Proceed' })",
    error: { type: 'ElementNotFoundError', message: 'no element matched' },
    url: 'https://shop.test/cart',
    title: 'Cart',
    outline: 'button "Continue to payment" #continue',
    previousSteps: ['goto https://shop.test', 'click getByRole(\'link\', { name: \'Cart\' })'],
  };

  it('sends the failure as structured context and asks for a JSON-constrained reply', async () => {
    const model = new ScriptedModel([reply([text('{"found": true, "reason": "renamed", "target": {"role": "button", "name": "Continue to payment"}}')])]);
    const proposal = await new ClaudeAdvisor(model).proposeTarget(context);
    assert.deepEqual(proposal, { target: { role: 'button', name: 'Continue to payment' }, source: 'ai', reason: 'renamed' });

    const [request] = model.requests;
    assert.equal(request!.model, 'claude-opus-5-5');
    assert.equal(request!.output_config?.effort, 'medium');
    assert.equal(request!.output_config?.format?.type, 'json_schema');
    assert.match(String(request!.system), /If several candidates are plausible[\s\S]*set "found" to false/);
    const prompt = request!.messages[0]!.content as string;
    for (const part of ['Task: Checkout', 'Failed step 3: {"click":{"role":"button","name":"Proceed"}}', 'Error: ElementNotFoundError', '2. click', 'button "Continue to payment" #continue']) {
      assert.ok(prompt.includes(part), `prompt includes ${part}`);
    }
  });

  it('includes a screenshot only when one is provided', async () => {
    const model = new ScriptedModel([reply([text('{"found": false, "reason": "not there"}')])]);
    await new ClaudeAdvisor(model).proposeTarget({ ...context, screenshot: Buffer.from('png') });
    const content = model.requests[0]!.messages[0]!.content as Array<{ type: string }>;
    assert.deepEqual(content.map((block) => block.type), ['image', 'text']);
  });

  it('reports "not found", refusals, bad JSON and invalid targets as reasons, never as targets', async () => {
    const cases: Array<[ReturnType<typeof reply>, RegExp]> = [
      [reply([text('{"found": false, "reason": "the button was removed"}')]), /found no matching element: the button was removed/],
      [reply([], 'refusal', 'cyber'), /declined the request \(cyber\)/],
      [reply([text('not json')]), /not JSON/],
      [reply([text('{"found": true, "reason": "x", "target": {"role": "button", "css": "#a"}}')]), /invalid target.*exactly one of/],
    ];
    for (const [message, pattern] of cases) {
      const proposal = await new ClaudeAdvisor(new ScriptedModel([message])).proposeTarget(context);
      assert.equal(proposal.target, undefined);
      assert.match(proposal.reason, pattern);
    }
  });

  it('drops empty optional fields the model fills in', async () => {
    const model = new ScriptedModel([reply([text('{"found": true, "reason": "r", "target": {"role": "button", "name": "Go", "css": "", "within": {"css": "iframe#x", "text": null}}}')])]);
    const proposal = await new ClaudeAdvisor(model).proposeTarget(context);
    assert.deepEqual(proposal.target, { role: 'button', name: 'Go', within: { css: 'iframe#x' } });
  });
});

describe('task target helpers', () => {
  it('reads, replaces and validates step targets', () => {
    const [click, fill, wait] = parseTask({
      name: 't',
      steps: [{ click: { css: '#a' } }, { fill: { target: { css: '#b' }, value: 'x' } }, { wait: 5 }],
    }).steps;
    assert.deepEqual(stepTarget(click!), { css: '#a' });
    assert.deepEqual(stepTarget(withTarget(fill!, { role: 'textbox' })), { role: 'textbox' });
    assert.equal(stepTarget(wait!), undefined);
    assert.throws(() => parseTarget({ css: '#a', role: 'button' }), /exactly one of/);
  });

  it('patches the target inside task-file JSON, keeping everything else', () => {
    assert.deepEqual(replaceRawTarget({ click: { css: '#old' }, waitForNavigation: true, name: 'go' }, { role: 'link', name: 'Next' }), {
      click: { role: 'link', name: 'Next' },
      waitForNavigation: true,
      name: 'go',
    });
    assert.deepEqual(replaceRawTarget({ fill: { target: { css: '#old' }, value: '{{email}}' } }, { role: 'textbox', name: 'Email' }), {
      fill: { target: { role: 'textbox', name: 'Email' }, value: '{{email}}' },
    });
    assert.deepEqual(replaceRawTarget({ wait: 100 }, { css: '#x' }), { wait: 100 });
  });
});

