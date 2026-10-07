import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClaudeClient } from '../../src/ai/model.ts';
import { createModelClient } from '../../src/ai/openai-compatible.ts';
import { PrivacyError, ActionError, AmbiguousLocatorError, ElementNotFoundError } from '../../src/errors.ts';
import { pageOutline } from '../../src/heal/outline.ts';
import { MacDesktop } from '../../src/mac/desktop.ts';
import { MacRecorder, type RecordedInput } from '../../src/mac/recorder.ts';
import { AppSnapshot, appOutline, macRole, matchMacRole, matchMacText } from '../../src/mac/snapshot.ts';
import { macTargetFor } from '../../src/mac/targets.ts';
import { assertAiAllowed, isPrivate, withPrivacy } from '../../src/privacy.ts';
import { parseTask } from '../../src/task/schema.ts';
import { h, snapshotOf } from '../helpers/dom.ts';
import { appTree, axNode, FakeHelper } from '../helpers/fake-helper.ts';

describe('privacy mode', () => {
  it('blocks every model request inside a private scope, before anything is sent', async () => {
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const params = { model: 'gpt-4.1', max_tokens: 5, messages: [{ role: 'user' as const, content: 'secret page outline' }] };

    await withPrivacy(async () => {
      assert.equal(isPrivate(), true);
      assert.throws(() => assertAiAllowed('a test'), PrivacyError);
      await assert.rejects(createModelClient({ fetch: fetchImpl }).create(params), PrivacyError);
      const claude = await createClaudeClient({ apiKey: 'k', fetch: fetchImpl });
      await assert.rejects(claude.create({ ...params, model: 'claude-opus-4-6' }), /Privacy mode is on/);
    });
    assert.equal(fetched, 0, 'nothing reached the network');
    assert.equal(isPrivate(), false, 'the scope ends with the call');
  });

  it('is switched on by NEXUS_PRIVATE', () => {
    process.env.NEXUS_PRIVATE = '1';
    try {
      assert.equal(isPrivate(), true);
    } finally {
      delete process.env.NEXUS_PRIVATE;
    }
  });

  it('task files can declare themselves private', () => {
    assert.equal(parseTask({ name: 't', private: true, steps: [{ wait: 1 }] }).private, true);
    assert.throws(() => parseTask({ name: 't', private: 'yes', steps: [{ wait: 1 }] }), /task\.private: must be true or false/);
  });

  it('never shows password values in outlines, private mode or not', () => {
    const web = snapshotOf(h('input', { type: 'password', 'aria-label': 'Password', 'data-value': 'hunter2' }), h('input', { 'aria-label': 'User', 'data-value': 'ada' }));
    assert.equal(pageOutline(web), 'textbox "Password" value=•••\ntextbox "User" value="ada"');
    const tree = appTree('Bank', [axNode('AXTextField', { subrole: 'AXSecureTextField', description: 'PIN', secure: true }), axNode('AXTextField', { description: 'Account', value: '1234' })]);
    const outline = appOutline(new AppSnapshot(tree.app, tree.nodes));
    assert.match(outline, /textbox "PIN" value=•••/);
    assert.doesNotMatch(outline, /hunter2/);
  });
});

describe('desktop snapshot and matching', () => {
  const tree = appTree('Notes', [
    axNode('AXButton', { title: 'New Note', identifier: 'new-note', actions: ['AXPress'] }),
    axNode('AXButton', { title: 'Delete' }),
    axNode('AXButton', { title: 'Delete All' }),
    axNode('AXTextField', { description: 'Search', subrole: 'AXSearchField', value: 'groceries' }),
    axNode('AXCheckBox', { title: 'Pinned', value: '0' }),
    axNode('AXStaticText', { value: '3 notes' }),
    axNode('AXButton', { title: 'Hidden', frame: { x: 0, y: 0, width: 0, height: 0 } }),
    axNode('AXButton', { title: '', identifier: '_NS:42' }),
  ]);
  const snapshot = new AppSnapshot(tree.app, tree.nodes);

  it('maps accessibility roles to web-style roles and derives names', () => {
    assert.equal(macRole('AXButton'), 'button');
    assert.equal(macRole('AXTextField', 'AXSearchField'), 'searchbox');
    assert.equal(macRole('AXCheckBox', 'AXSwitch'), 'switch');
    assert.equal(macRole('AXPopUpButton'), 'combobox');
    assert.equal(macRole('AXSplitGroup'), 'splitgroup');
    const text = snapshot.nodes.find((node) => node.axRole === 'AXStaticText')!;
    assert.equal(text.name, '3 notes', 'static text is named by its value');
  });

  it('matches visible elements by role and name, and by text', () => {
    assert.equal(matchMacRole(snapshot, 'button', 'Delete').length, 2);
    assert.equal(matchMacRole(snapshot, 'button', 'Delete', true).length, 1);
    assert.equal(matchMacRole(snapshot, 'button', 'Hidden').length, 0, 'zero-size elements are not visible');
    assert.equal(matchMacText(snapshot, '3 notes')[0]?.role, 'text');
  });

  it('generates the most robust unique target', () => {
    const find = (name: string) => snapshot.nodes.find((node) => node.name === name)!;
    assert.deepEqual(macTargetFor(snapshot, find('New Note')), { app: 'Notes', role: 'button', name: 'New Note' });
    assert.deepEqual(macTargetFor(snapshot, find('Delete')), { app: 'Notes', role: 'button', name: 'Delete', exact: true });
    const unnamed = snapshot.nodes.find((node) => node.identifier === '_NS:42')!;
    assert.deepEqual(macTargetFor(snapshot, unnamed), { app: 'Notes', role: 'button', nth: 3 }, 'generated ids are not used; position among visible buttons');
  });
});

describe('desktop locator actions (fake helper, no real input)', () => {
  function setup(children: Parameters<typeof appTree>[1]) {
    const helper = new FakeHelper();
    const tree = appTree('Form', children);
    helper.handlers.tree = () => tree;
    const desktop = new MacDesktop(helper);
    desktop.defaultTimeoutMs = 300;
    return { helper, desktop, tree };
  }

  it('click activates the app and clicks the real pointer at the element centre', async () => {
    const { helper, desktop } = setup([axNode('AXButton', { title: 'Greet', frame: { x: 100, y: 200, width: 80, height: 30 } })]);
    await desktop.locate({ app: 'Form', role: 'button', name: 'Greet' }).click();
    assert.deepEqual(helper.methods(), ['tree', 'activate', 'click']);
    assert.deepEqual(helper.calls[2]!.params, { x: 140, y: 215, count: 1, button: 'left' });
  });

  it('fill sets the value through accessibility and verifies it', async () => {
    const { helper, desktop, tree } = setup([axNode('AXTextField', { description: 'Name' })]);
    const field = tree.nodes.at(-1)!;
    helper.handlers.describe = () => ({ value: 'Ada' });
    await desktop.locate({ app: 'Form', role: 'textbox', name: 'Name' }).fill('Ada');
    assert.deepEqual(helper.methods(), ['tree', 'setValue', 'describe']);
    assert.deepEqual(helper.calls[1]!.params, { ref: field.ref, value: 'Ada' });
  });

  it('fill falls back to select-all and real typing when the value does not stick', async () => {
    const { helper, desktop } = setup([axNode('AXTextField', { description: 'Name' })]);
    helper.handlers.describe = () => ({ value: '' });
    helper.handlers.focused = () => ({ role: 'AXTextField', description: 'Name', frame: { x: 10, y: 10, width: 100, height: 20 } });
    await desktop.locate({ app: 'Form', role: 'textbox', name: 'Name' }).fill('Ada');
    assert.deepEqual(helper.methods().slice(3), ['activate', 'tree', 'focus', 'focused', 'key', 'type'], 'types only once focus is confirmed');
    assert.deepEqual(helper.calls.find((call) => call.method === 'key')!.params, { key: 'Command+a' });
  });

  it('never sets a password field programmatically: it is typed, and its value is never read', async () => {
    const { helper, desktop } = setup([axNode('AXTextField', { subrole: 'AXSecureTextField', description: 'Password', secure: true })]);
    helper.handlers.focused = () => ({ role: 'AXTextField', description: 'Password', secure: true });
    await desktop.locate({ app: 'Form', role: 'textbox', name: 'Password' }).fill('s3cret');
    assert.ok(!helper.methods().includes('setValue'));
    assert.ok(!helper.methods().includes('describe'));
    assert.deepEqual(helper.calls.at(-1), { method: 'type', params: { text: 's3cret' } });
  });

  it('is strict about ambiguity and explains missing apps and elements', async () => {
    const { desktop, helper } = setup([axNode('AXButton', { title: 'Delete' }), axNode('AXButton', { title: 'Delete' })]);
    await assert.rejects(desktop.locate({ app: 'Form', role: 'button', name: 'Delete' }).click(), AmbiguousLocatorError);
    await desktop.locate({ app: 'Form', role: 'button', name: 'Delete', nth: 1 }).click();
    await assert.rejects(desktop.locate({ app: 'Form', role: 'button', name: 'Nope' }).click({ timeoutMs: 100 }), ElementNotFoundError);

    const { ProtocolError } = await import('../../src/errors.ts');
    helper.handlers.tree = () => {
      throw new ProtocolError('tree', -1, 'Mail is not running');
    };
    await assert.rejects(desktop.locate({ app: 'Mail', role: 'button', name: 'Send' }).click({ timeoutMs: 100 }), /Mail is not running \(add a "launch" step/);
  });

  it('setChecked clicks only when the state differs, and verifies the result', async () => {
    const { helper, desktop, tree } = setup([axNode('AXCheckBox', { title: 'Subscribe', value: '0' })]);
    helper.handlers.click = () => {
      tree.nodes.at(-1)!.value = '1';
      return {};
    };
    await desktop.locate({ app: 'Form', role: 'checkbox', name: 'Subscribe' }).setChecked(true);
    assert.equal(helper.methods().filter((method) => method === 'click').length, 1);
    await desktop.locate({ app: 'Form', role: 'checkbox', name: 'Subscribe' }).setChecked(true);
    assert.equal(helper.methods().filter((method) => method === 'click').length, 1, 'already checked: no click');
  });

  it('menu presses the item found along the path, without opening menus by mouse', async () => {
    const helper = new FakeHelper();
    const desktop = new MacDesktop(helper);
    const nodes = [
      { ref: 1, parent: -1, role: 'AXApplication' },
      { ref: 2, parent: 0, role: 'AXMenuBar' },
      { ref: 3, parent: 1, role: 'AXMenuBarItem', title: 'Form' },
      { ref: 4, parent: 2, role: 'AXMenu' },
      { ref: 5, parent: 3, role: 'AXMenuItem', title: 'Fill' },
      { ref: 6, parent: 4, role: 'AXMenu' },
      { ref: 7, parent: 5, role: 'AXMenuItem', title: 'Sample Name', enabled: true },
    ];
    helper.handlers.tree = (params) => {
      assert.equal(params.menus, true);
      return { app: { pid: 1, name: 'Form' }, nodes };
    };
    await desktop.menu('Form', ['Form', 'Fill', 'Sample Name']);
    assert.deepEqual(helper.calls.at(-1), { method: 'press', params: { ref: 7 } });
    await assert.rejects(desktop.menu('Form', ['Form', 'Nope']), /no menu item "Nope" under Form/);
  });

  it('turns permission gaps into instructions', async () => {
    const helper = new FakeHelper();
    helper.handlers.permissions = () => ({ accessibility: false, screenRecording: true, inputMonitoring: false });
    await assert.rejects(new MacDesktop(helper).requirePermissions('accessibility', 'inputMonitoring'), /needs Accessibility and Input Monitoring.*Privacy & Security/);
  });

  it('clicks the field when programmatic focus does not take, and fails clearly if nothing does', async () => {
    const { helper, desktop } = setup([axNode('AXTextField', { description: 'Name', frame: { x: 0, y: 0, width: 100, height: 20 } })]);
    let clicked = false;
    helper.handlers.click = () => {
      clicked = true;
      return {};
    };
    helper.handlers.focused = () => (clicked ? { role: 'AXTextField', description: 'Name' } : { role: 'AXButton', title: 'Other' });
    await desktop.locate({ app: 'Form', role: 'textbox', name: 'Name' }).type('x');
    assert.ok(clicked);
    assert.equal(helper.calls.at(-1)!.method, 'type');

    helper.handlers.focused = () => ({ role: 'AXButton', title: 'Other' });
    await assert.rejects(desktop.locate({ app: 'Form', role: 'textbox', name: 'Name' }).type('y'), /did not take keyboard focus/);
  });

  it('rejects actions that do not fit the element', async () => {
    const { desktop } = setup([axNode('AXButton', { title: 'Go' })]);
    await assert.rejects(desktop.locate({ app: 'Form', role: 'button', name: 'Go' }).fill('x'), ActionError);
  });
});

describe('desktop recorder (fake helper events)', () => {
  it('types into whatever has focus when a field is known only by its position', async () => {
    const helper = new FakeHelper();
    const body = axNode('AXTextArea', { frame: { x: 10, y: 10, width: 300, height: 200 } });
    const tree = appTree('Notes', [axNode('AXTextArea', { frame: { x: 400, y: 10, width: 100, height: 20 } }), body], 'com.apple.Notes');
    helper.handlers.tree = () => tree;
    const recorder = await MacRecorder.start(new MacDesktop(helper));
    for (const characters of 'Hi') {
      helper.emit('recorded', { type: 'key', time: 1, app: tree.app, element: { role: 'AXTextArea', frame: body.frame }, keyCode: 0, modifiers: [], characters });
    }
    await recorder.stop();
    assert.deepEqual(recorder.steps.at(-1), { type: { target: { app: 'Notes' }, text: 'Hi' } });
  });

  it('records launches, clicks, typing, keys, menus — and never a password', async () => {
    const helper = new FakeHelper();
    const name = axNode('AXTextField', { description: 'Name', identifier: 'name', frame: { x: 10, y: 10, width: 200, height: 22 } });
    const password = axNode('AXTextField', { subrole: 'AXSecureTextField', description: 'Password', secure: true, frame: { x: 10, y: 40, width: 200, height: 22 } });
    const greet = axNode('AXButton', { title: 'Greet', frame: { x: 10, y: 70, width: 80, height: 22 } });
    const tree = appTree('NexusFixture', [name, password, greet], 'dev.nexus.fixture');
    helper.handlers.tree = () => tree;
    const recorder = await MacRecorder.start(new MacDesktop(helper), { ignorePids: [99] });
    assert.deepEqual(helper.calls.at(-1), { method: 'startRecording', params: { ignorePids: [99] } });

    const app = tree.app;
    const strip = (node: typeof name) => ({ role: node.role, subrole: node.subrole, title: node.title, description: node.description, identifier: node.identifier, frame: node.frame, secure: node.secure });
    const dock = { pid: 5, name: 'Dock', bundleId: 'com.apple.dock' };
    const inputs: RecordedInput[] = [
      { type: 'click', time: 0, app: dock, element: { role: 'AXDockItem', title: 'NexusFixture' }, button: 'left', clickCount: 1 },
      { type: 'click', time: 1, app, element: strip(name), button: 'left', clickCount: 1 },
      ...[...'Adx'].map((characters) => ({ type: 'key' as const, time: 2, app, element: strip(name), keyCode: 0, modifiers: [], characters })),
      { type: 'key', time: 3, app, element: strip(name), keyCode: 51, modifiers: [] },
      { type: 'key', time: 3, app, element: strip(name), keyCode: 0, modifiers: ['Shift'], characters: 'A' },
      ...[1, 2, 3].map(() => ({ type: 'key' as const, time: 4, app, element: strip(password), keyCode: 0, modifiers: [], secure: true })),
      { type: 'key', time: 5, app, element: strip(password), keyCode: 36, modifiers: [] },
      { type: 'click', time: 6, app, element: strip(greet), button: 'left', clickCount: 1 },
      { type: 'click', time: 6, app, element: strip(greet), button: 'left', clickCount: 2 },
      { type: 'key', time: 7, app, element: strip(greet), keyCode: 1, modifiers: ['Command'], characters: 's' },
      { type: 'click', time: 8, app, element: { role: 'AXMenuBarItem', title: 'Form' }, button: 'left', clickCount: 1 },
      { type: 'click', time: 9, app, element: { role: 'AXMenuItem', title: 'Reset Form' }, button: 'left', clickCount: 1 },
    ];
    for (const input of inputs) helper.emit('recorded', input);
    await recorder.stop();

    const target = (extra: object) => ({ app: 'NexusFixture', ...extra });
    assert.deepEqual(recorder.steps, [
      { launch: 'dev.nexus.fixture' },
      { click: target({ role: 'textbox', name: 'Name' }) },
      { type: { target: target({ role: 'textbox', name: 'Name' }), text: 'AdA' } },
      { type: { target: target({ role: 'textbox', name: 'Password' }), text: '{{password}}' } },
      { press: { target: target({}), key: 'Enter' } },
      { click: target({ role: 'button', name: 'Greet' }) },
      { press: { target: target({}), key: 'Command+s' } },
      { menu: { app: 'NexusFixture', path: ['Form', 'Reset Form'] } },
    ]);
    const task = recorder.toTask('fixture');
    assert.deepEqual(task.params, { password: null });
    assert.doesNotThrow(() => parseTask(task), 'the recording is a valid task');
    assert.ok(recorder.warnings.some((warning) => /password was typed: it was not recorded/.test(warning)));
    assert.ok(recorder.warnings.some((warning) => /double-click/.test(warning)));
    assert.ok(helper.methods().includes('stopRecording'), 'input watching was stopped');
  });
});

describe('desktop task format', () => {
  it('accepts desktop targets, launch and menu steps', () => {
    const task = parseTask({
      name: 'Notes',
      steps: [
        { launch: 'Notes' },
        { menu: { app: 'Notes', path: ['File', 'New Note'] } },
        { click: { app: 'Notes', role: 'button', name: 'Done' } },
        { fill: { target: { app: 'Notes', id: 'title' }, value: 'Groceries' } },
        { press: { target: { app: 'Notes' }, key: 'Command+s' } },
      ],
    });
    assert.deepEqual(task.steps.map((step) => step.action), ['launch', 'menu', 'click', 'fill', 'press']);
  });

  it('rejects mixing web-only fields into desktop targets, and ids without an app', () => {
    assert.throws(() => parseTask({ name: 't', steps: [{ click: { app: 'Notes', css: '#x' } }] }), /not available for desktop targets/);
    assert.throws(() => parseTask({ name: 't', steps: [{ click: { app: 'Notes', role: 'button', text: 'x' } }] }), /at most one of "text", "role" or "id"/);
    assert.throws(() => parseTask({ name: 't', steps: [{ click: { id: 'x' } }] }), /only allowed with "app"/);
    assert.throws(() => parseTask({ name: 't', steps: [{ menu: { app: 'Notes', path: [] } }] }), /menu\.path: must be a non-empty array/);
  });
});
