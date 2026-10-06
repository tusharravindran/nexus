import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DisconnectedError, TimeoutError } from '../../src/errors.ts';
import { NetworkTracker, type NetworkEventSource } from '../../src/page/network.ts';

/** Event source the test drives directly. */
class FakeSource implements NetworkEventSource {
  readonly handlers = new Map<string, Set<(params: never) => void>>();
  readonly disconnects = new Set<(reason: string) => void>();

  on<T>(method: string, handler: (params: T) => void): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(handler as (params: never) => void);
    this.handlers.set(method, set);
    return () => set.delete(handler as (params: never) => void);
  }
  onDisconnect(handler: (reason: string) => void): () => void {
    this.disconnects.add(handler);
    return () => this.disconnects.delete(handler);
  }
  emit(method: string, params: object): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params as never);
  }
  start(id: string, url = `https://example.test/${id}`): void {
    this.emit('Network.requestWillBeSent', { requestId: id, request: { url } });
  }
  finish(id: string): void {
    this.emit('Network.loadingFinished', { requestId: id });
  }
  fail(id: string): void {
    this.emit('Network.loadingFailed', { requestId: id });
  }
}

describe('NetworkTracker', () => {
  it('tracks requests until they finish or fail, counting redirects once', () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker(source);
    source.start('1');
    source.start('1', 'https://example.test/redirected'); // redirect reuses the id
    source.start('2');
    assert.equal(tracker.inflight.length, 2);
    source.finish('1');
    source.fail('2');
    assert.deepEqual(tracker.inflight, []);
  });

  it('resolves once the network has been quiet for idleMs', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker(source);
    source.start('1');
    const started = Date.now();
    const idle = tracker.waitForIdle({ idleMs: 40, timeoutMs: 2_000 });
    setTimeout(() => source.finish('1'), 30);
    await idle;
    assert.ok(Date.now() - started >= 65, 'waited for request plus quiet period');
  });

  it('restarts the quiet period when a new request starts', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker(source);
    const started = Date.now();
    const idle = tracker.waitForIdle({ idleMs: 50, timeoutMs: 2_000 });
    setTimeout(() => source.start('late'), 30);
    setTimeout(() => source.finish('late'), 60);
    await idle;
    assert.ok(Date.now() - started >= 105, 'quiet period restarted after the late request');
  });

  it('allows maxInflight long-lived requests', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker(source);
    source.start('long-poll');
    await tracker.waitForIdle({ idleMs: 10, maxInflight: 1, timeoutMs: 500 });
  });

  it('times out naming the requests still in flight', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker(source);
    source.start('stuck', 'https://example.test/stuck');
    await assert.rejects(tracker.waitForIdle({ idleMs: 10, timeoutMs: 50 }), (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.match(error.message, /1 request\(s\) in flight: https:\/\/example\.test\/stuck/);
      return true;
    });
  });

  it('rejects on disconnect and stops listening after dispose', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker(source);
    source.start('1');
    const idle = tracker.waitForIdle({ timeoutMs: 1_000 });
    for (const handler of source.disconnects) handler('gone');
    await assert.rejects(idle, DisconnectedError);

    tracker.dispose();
    source.start('2');
    assert.deepEqual(tracker.inflight, []);
  });
});
