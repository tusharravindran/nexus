import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CdpClient } from '../../src/cdp/client.ts';
import { DisconnectedError, ProtocolError, TimeoutError } from '../../src/errors.ts';
import { FakeTransport } from '../helpers/fake-transport.ts';

function setup(timeoutMs = 1_000) {
  const transport = new FakeTransport();
  const client = new CdpClient(transport, { timeoutMs });
  return { transport, client };
}

describe('CdpClient request/response correlation', () => {
  it('assigns increasing ids and resolves each response to its own request', async () => {
    const { transport, client } = setup();
    const first = client.send('Browser.getVersion');
    const second = client.send('Target.getTargets', { filter: [] });

    assert.deepEqual(
      transport.sent.map(({ id, method }) => ({ id, method })),
      [
        { id: 1, method: 'Browser.getVersion' },
        { id: 2, method: 'Target.getTargets' },
      ],
    );

    // Answer out of order: correlation is by id, not arrival order.
    transport.respond(2, { targetInfos: [] });
    transport.respond(1, { product: 'Chrome/1' });

    assert.deepEqual(await first, { product: 'Chrome/1' });
    assert.deepEqual(await second, { targetInfos: [] });
  });

  it('tags commands sent through a session with its sessionId', async () => {
    const { transport, client } = setup();
    const pending = client.session('S1').send('Page.navigate', { url: 'about:blank' });
    assert.equal(transport.sent[0]!.sessionId, 'S1');
    assert.deepEqual(transport.sent[0]!.params, { url: 'about:blank' });
    transport.respond(1, { frameId: 'F' });
    assert.deepEqual(await pending, { frameId: 'F' });
  });

  it('rejects with ProtocolError carrying the method and code', async () => {
    const { transport, client } = setup();
    const pending = client.send('DOM.focus', { backendNodeId: 7 });
    transport.receive({ id: 1, error: { code: -32000, message: 'Element is not focusable' } });

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.method, 'DOM.focus');
      assert.equal(error.code, -32000);
      assert.match(error.message, /not focusable/);
      return true;
    });
  });

  it('ignores malformed messages and responses to unknown ids', async () => {
    const { transport, client } = setup();
    const pending = client.send('Browser.getVersion');
    transport.receive('this is not json');
    transport.respond(999, {});
    transport.respond(1, { ok: true });
    assert.deepEqual(await pending, { ok: true });
  });
});

describe('CdpClient timeouts', () => {
  it('rejects a command with TimeoutError when no response arrives', async () => {
    const { client } = setup();
    await assert.rejects(client.send('Page.navigate', {}, { timeoutMs: 20 }), TimeoutError);
  });

  it('drops a late response after the command timed out', async () => {
    const { transport, client } = setup();
    await assert.rejects(client.send('Page.navigate', {}, { timeoutMs: 20 }), TimeoutError);
    assert.doesNotThrow(() => transport.respond(1, {}));
    // The client still works afterwards.
    const next = client.send('Browser.getVersion');
    transport.respond(2, { product: 'x' });
    assert.deepEqual(await next, { product: 'x' });
  });

  it('rejects waitForEvent with TimeoutError when the event never comes', async () => {
    const { client } = setup();
    await assert.rejects(client.waitForEvent('Page.loadEventFired', { timeoutMs: 20 }), TimeoutError);
  });
});

describe('CdpClient events', () => {
  it('delivers events to handlers for the matching session only', () => {
    const { transport, client } = setup();
    const browserLevel: unknown[] = [];
    const sessionOne: unknown[] = [];
    client.on('Target.targetCreated', (params) => browserLevel.push(params));
    client.session('S1').on('Page.loadEventFired', (params) => sessionOne.push(params));

    transport.emit('Target.targetCreated', { targetInfo: { targetId: 'T' } });
    transport.emit('Page.loadEventFired', { timestamp: 1 }, 'S1');
    transport.emit('Page.loadEventFired', { timestamp: 2 }, 'S2');
    transport.emit('Page.loadEventFired', { timestamp: 3 }); // no session

    assert.deepEqual(browserLevel, [{ targetInfo: { targetId: 'T' } }]);
    assert.deepEqual(sessionOne, [{ timestamp: 1 }]);
  });

  it('stops delivering after unsubscribe', () => {
    const { transport, client } = setup();
    let calls = 0;
    const off = client.on('Page.loadEventFired', () => calls++);
    transport.emit('Page.loadEventFired');
    off();
    transport.emit('Page.loadEventFired');
    assert.equal(calls, 1);
  });

  it('waitForEvent resolves with the first event that satisfies the predicate', async () => {
    const { transport, client } = setup();
    const waiting = client.waitForEvent<{ name: string }>('Page.lifecycleEvent', {
      sessionId: 'S1',
      predicate: (event) => event.name === 'load',
    });
    transport.emit('Page.lifecycleEvent', { name: 'init' }, 'S1');
    transport.emit('Page.lifecycleEvent', { name: 'load' }, 'S2');
    transport.emit('Page.lifecycleEvent', { name: 'load' }, 'S1');
    assert.deepEqual(await waiting, { name: 'load' });
  });

  it('waitForEvent can be aborted', async () => {
    const { client } = setup();
    const controller = new AbortController();
    const waiting = client.waitForEvent('Page.loadEventFired', { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, /aborted/);
  });
});

describe('CdpClient disconnect handling', () => {
  it('rejects in-flight commands and event waits with DisconnectedError', async () => {
    const { transport, client } = setup();
    const command = client.send('Page.navigate');
    const event = client.waitForEvent('Page.loadEventFired');
    transport.drop('browser crashed');

    await assert.rejects(command, (error: unknown) => error instanceof DisconnectedError && /browser crashed/.test(error.message));
    await assert.rejects(event, DisconnectedError);
  });

  it('rejects new commands immediately once disconnected', async () => {
    const { transport, client } = setup();
    transport.drop();
    assert.equal(client.connected, false);
    await assert.rejects(client.send('Browser.getVersion'), DisconnectedError);
    assert.equal(transport.sent.length, 0);
  });

  it('notifies disconnect listeners exactly once', () => {
    const { transport, client } = setup();
    const reasons: string[] = [];
    client.onDisconnect((reason) => reasons.push(reason));
    transport.drop('first');
    transport.drop('second');
    assert.deepEqual(reasons, ['first']);
  });

  it('close() closes the transport and marks the client disconnected', async () => {
    const { transport, client } = setup();
    const pending = client.send('Browser.getVersion');
    client.close();
    assert.equal(transport.closed, true);
    await assert.rejects(pending, /closed by client/);
  });
});
