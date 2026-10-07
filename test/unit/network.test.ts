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
    const tracker = new NetworkTracker();
    tracker.track(source);
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
    const tracker = new NetworkTracker();
    tracker.track(source);
    source.start('1');
    const started = Date.now();
    const idle = tracker.waitForIdle({ idleMs: 40, timeoutMs: 2_000 });
    setTimeout(() => source.finish('1'), 30);
    await idle;
    assert.ok(Date.now() - started >= 65, 'waited for request plus quiet period');
  });

  it('restarts the quiet period when a new request starts', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker();
    tracker.track(source);
    const started = Date.now();
    const idle = tracker.waitForIdle({ idleMs: 50, timeoutMs: 2_000 });
    setTimeout(() => source.start('late'), 30);
    setTimeout(() => source.finish('late'), 60);
    await idle;
    assert.ok(Date.now() - started >= 105, 'quiet period restarted after the late request');
  });

  it('allows maxInflight long-lived requests', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker();
    tracker.track(source);
    source.start('long-poll');
    await tracker.waitForIdle({ idleMs: 10, maxInflight: 1, timeoutMs: 500 });
  });

  it('times out naming the requests still in flight', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker();
    tracker.track(source);
    source.start('stuck', 'https://example.test/stuck');
    await assert.rejects(tracker.waitForIdle({ idleMs: 10, timeoutMs: 50 }), (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.match(error.message, /1 request\(s\) in flight: https:\/\/example\.test\/stuck/);
      return true;
    });
  });

  it('tracks several sessions and forgets a detached one', async () => {
    const page = new FakeSource();
    const frame = new FakeSource();
    const tracker = new NetworkTracker();
    tracker.track(page);
    const untrackFrame = tracker.track(frame, 'frame');
    page.start('1.1');
    frame.start('2.1'); // request ids carry the renderer's process id, so they are unique
    assert.equal(tracker.inflight.length, 2);
    page.finish('1.1');
    assert.equal(tracker.inflight.length, 1);
    untrackFrame();
    assert.deepEqual(tracker.inflight, []);

    // A frame's document request can start in the parent and finish in the frame's own process.
    const child = new FakeSource();
    tracker.track(child, 'child');
    page.start('NAV-1');
    child.finish('NAV-1');
    assert.deepEqual(tracker.inflight, []);

    // ...or finish before NEXUS attaches to that process: forget it by frame.
    page.emit('Network.requestWillBeSent', { requestId: 'NAV-2', request: { url: 'https://other.test/' }, frameId: 'F2', type: 'Document' });
    tracker.forgetFrameDocument('F2');
    assert.deepEqual(tracker.inflight, []);
    await tracker.waitForIdle({ idleMs: 5, timeoutMs: 200 });
  });

  it('rejects on disconnect and stops listening after dispose', async () => {
    const source = new FakeSource();
    const tracker = new NetworkTracker();
    tracker.track(source);
    source.start('1');
    const idle = tracker.waitForIdle({ timeoutMs: 1_000 });
    for (const handler of source.disconnects) handler('gone');
    await assert.rejects(idle, DisconnectedError);

    tracker.dispose();
    source.start('2');
    assert.deepEqual(tracker.inflight, []);
  });
});
