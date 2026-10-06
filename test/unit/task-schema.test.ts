import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskValidationError } from '../../src/errors.ts';
import { resolveUrl } from '../../src/task/runner.ts';
import { parseTask } from '../../src/task/schema.ts';

function issuesOf(input: unknown): string[] {
  try {
    parseTask(input);
  } catch (error) {
    assert.ok(error instanceof TaskValidationError);
    return error.issues;
  }
  assert.fail('expected TaskValidationError');
}

describe('parseTask', () => {
  it('parses every step kind into typed steps', () => {
    const task = parseTask({
      name: 'Everything',
      steps: [
        { goto: 'page.html' },
        { click: { role: 'button', name: 'Go', exact: true }, waitForNavigation: true, name: 'submit', timeoutMs: 500 },
        { hover: { text: 'Menu' } },
        { type: { target: { css: '#q' }, text: 'hello' } },
        { fill: { target: { css: '#q' }, value: '' } },
        { press: { target: { css: '#q' }, key: 'Enter' } },
        { check: { role: 'checkbox', name: 'Agree' } },
        { uncheck: { css: '#news' } },
        { select: { target: { css: 'select' }, option: ['a', 'b'] } },
        { waitFor: { target: { css: '#late' }, state: 'attached' } },
        { waitForNetworkIdle: true },
        { waitForNetworkIdle: { idleMs: 200 } },
        { wait: 100 },
        { expectText: 'Done' },
        { expectText: { text: 'Done', exact: true } },
        { expectVisible: { css: '#ok' } },
        { expectValue: { target: { css: '#q' }, value: 'x' } },
        { expectElementText: { target: { role: 'status' }, text: 'ok' } },
        { screenshot: 'shots/final.png' },
      ],
    });
    assert.equal(task.steps.length, 19);
    assert.deepEqual(task.steps[1], {
      action: 'click',
      target: { role: 'button', name: 'Go', exact: true },
      waitForNavigation: true,
      name: 'submit',
      timeoutMs: 500,
    });
    assert.deepEqual(task.steps[10], { action: 'waitForNetworkIdle', idleMs: undefined });
    assert.deepEqual(task.steps[13], { action: 'expectText', text: 'Done', exact: false });
    assert.deepEqual(task.steps[9], { action: 'waitFor', target: { css: '#late' }, state: 'attached' });
  });

  it('parses nested "within" targets and nth', () => {
    const task = parseTask({
      name: 'Scoped',
      steps: [{ click: { role: 'button', name: 'Pay', within: { css: 'iframe#payment' }, nth: 0 } }],
    });
    assert.deepEqual(task.steps[0], {
      action: 'click',
      target: { role: 'button', name: 'Pay', nth: 0, within: { css: 'iframe#payment' } },
      waitForNavigation: false,
    });
  });

  it('reports every problem with its location', () => {
    const issues = issuesOf({
      name: '',
      extra: 1,
      steps: [
        { clik: { css: '#a' } },
        { click: { css: '#a' }, type: { target: { css: '#b' }, text: 'x' } },
        { click: { css: '#a', role: 'button' } },
        { click: { text: 'Go', name: 'Go' } },
        { type: { target: { css: '#a' } } },
        { hover: { css: '#a' }, waitForNavigation: true },
        { wait: -5 },
        { screenshot: '../escape.png' },
        { click: { css: '#a', nth: 1.5 } },
        'not a step',
      ],
    });
    const expected = [
      /^task: unknown key "extra"/,
      /^task\.name: must be a non-empty string/,
      /^steps\[0\]: unknown action "clik"/,
      /^steps\[1\]: has several actions: click, type/,
      /^steps\[2\]\.click: needs exactly one of "css", "text" or "role"/,
      /^steps\[3\]\.click\.name: only allowed with "role"/,
      /^steps\[4\]\.type\.text: must be a non-empty string/,
      /^steps\[5\]\.waitForNavigation: only allowed on click and press/,
      /^steps\[6\]\.wait: must be a non-negative number/,
      /^steps\[7\]\.screenshot: must be a relative file name/,
      /^steps\[8\]\.click\.nth: must be a non-negative integer/,
      /^steps\[9\]: must be an object/,
    ];
    for (const pattern of expected) assert.ok(issues.some((issue) => pattern.test(issue)), `missing issue ${pattern}\n${issues.join('\n')}`);
  });

  it('rejects a task without steps', () => {
    assert.deepEqual(issuesOf({ name: 'Empty', steps: [] }), ['task.steps: must be a non-empty array']);
    assert.deepEqual(issuesOf([]), ['task: must be a JSON object']);
  });
});

describe('resolveUrl', () => {
  it('keeps URLs with a scheme and resolves paths against the base directory', () => {
    assert.equal(resolveUrl('https://example.com/a', '/tmp'), 'https://example.com/a');
    assert.equal(resolveUrl('about:blank', '/tmp'), 'about:blank');
    assert.equal(resolveUrl('../fixtures/form.html', '/work/tasks'), 'file:///work/fixtures/form.html');
  });
});
