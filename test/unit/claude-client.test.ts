import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeAdvisor } from '../../src/ai/advisor.ts';
import { createClaudeClient } from '../../src/ai/model.ts';
import { AiError } from '../../src/errors.ts';

/** A fetch that records the request and answers like the Messages API, so nothing leaves the machine. */
function fakeFetch(status: number, body: object) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const message = (textBody: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: textBody }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('createClaudeClient (real SDK, fake transport)', () => {
  it('sends a structured-output request to Claude Opus 5.5 with refusal fallbacks enabled', async () => {
    const { fetchImpl, calls } = fakeFetch(200, message('{"found": true, "reason": "r", "target": {"role": "button", "name": "Go"}}'));
    const model = await createClaudeClient({ apiKey: 'test-key', fetch: fetchImpl });
    const proposal = await new ClaudeAdvisor(model).proposeTarget({
      task: 't', stepIndex: 0, step: { click: { css: '#gone' } }, description: 'click', error: { type: 'ElementNotFoundError', message: 'x' },
      url: 'https://a.test', title: 'A', outline: 'button "Go"', previousSteps: [],
    });
    assert.deepEqual(proposal.target, { role: 'button', name: 'Go' });

    const [call] = calls;
    assert.match(call!.url, /\/v1\/messages\?beta=true$/);
    assert.equal(call!.headers.get('x-api-key'), 'test-key');
    assert.match(call!.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    assert.equal(call!.body.model, 'claude-opus-5-5');
    assert.equal(call!.body.fallbacks, 'default');
    assert.deepEqual((call!.body.output_config as { format: { type: string } }).format.type, 'json_schema');
    assert.equal(call!.body.betas, undefined, 'betas travel as a header, not in the body');
  });

  it('can go through a gateway such as GateLLM, without Anthropic-only fields', async () => {
    const { fetchImpl, calls } = fakeFetch(200, message('{"found": false, "reason": "n/a"}'));
    const model = await createClaudeClient({ apiKey: 'gatellm_live_test', baseURL: 'https://gatellm.sedintechnologies.com/api', fetch: fetchImpl });
    await model.create({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

    const [call] = calls;
    assert.match(call!.url, /^https:\/\/gatellm\.sedintechnologies\.com\/api\/v1\/messages/);
    assert.equal(call!.headers.get('x-api-key'), 'gatellm_live_test');
    assert.equal(call!.body.fallbacks, undefined, 'fallbacks are an Anthropic API feature');
    assert.doesNotMatch(call!.headers.get('anthropic-beta') ?? '', /server-side-fallback/);
  });

  it('turns API errors into AiError with a useful message', async () => {
    const { fetchImpl } = fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const model = await createClaudeClient({ apiKey: 'bad', fetch: fetchImpl });
    await assert.rejects(model.create({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.match(error.message, /rejected the credentials/);
      return true;
    });
  });
});
