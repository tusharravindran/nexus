import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MessageParams } from '../../src/ai/model.ts';
import { createModelClient, createOpenAICompatibleClient, fromChatResponse, toChatRequest } from '../../src/ai/openai-compatible.ts';
import { AiError } from '../../src/errors.ts';

describe('toChatRequest', () => {
  it('translates system, text, images, tool calls, tool results, tools and structured output', () => {
    const params = {
      model: 'gpt-4.1',
      max_tokens: 500,
      system: 'You operate a browser.',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
      cache_control: { type: 'ephemeral' },
      tools: [
        { name: 'run_step', description: 'Run one step', input_schema: { type: 'object', properties: { step: { type: 'object' } } } },
        { name: 'finish', input_schema: { type: 'object' }, strict: true },
      ],
      messages: [
        { role: 'user', content: 'Goal: greet Ada' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'x' },
            { type: 'text', text: 'Filling the name.' },
            { type: 'tool_use', id: 'call_1', name: 'run_step', input: { step: { fill: {} } } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'OK. Page…' },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'nope', is_error: true },
          ],
        },
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'Look' }] },
      ],
    } as unknown as MessageParams;

    const request = toChatRequest(params) as { messages: Array<Record<string, unknown>>; tools: unknown[]; response_format: unknown };
    assert.deepEqual(request.messages, [
      { role: 'system', content: 'You operate a browser.' },
      { role: 'user', content: 'Goal: greet Ada' },
      { role: 'assistant', content: 'Filling the name.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_step', arguments: '{"step":{"fill":{}}}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'OK. Page…' },
      { role: 'tool', tool_call_id: 'call_2', content: 'ERROR: nope' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'Look' }] },
    ]);
    assert.deepEqual(request.tools, [
      { type: 'function', function: { name: 'run_step', description: 'Run one step', parameters: { type: 'object', properties: { step: { type: 'object' } } } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' }, strict: true } },
    ]);
    assert.deepEqual(request.response_format, { type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' } } });
    for (const dropped of ['thinking', 'output_config', 'cache_control', 'system']) assert.equal(dropped in request, false, `${dropped} is not sent`);
  });
});

describe('fromChatResponse', () => {
  it('turns tool calls into tool_use blocks and maps stop reasons', () => {
    const message = fromChatResponse(
      {
        id: 'chatcmpl-1',
        choices: [{ finish_reason: 'tool_calls', message: { content: 'Clicking.', tool_calls: [{ id: 'call_9', function: { name: 'run_step', arguments: '{"step":{"click":{"css":"#a"}}}' } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      },
      'gpt-4.1',
    );
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.content, [
      { type: 'text', text: 'Clicking.', citations: null },
      { type: 'tool_use', id: 'call_9', name: 'run_step', input: { step: { click: { css: '#a' } } } },
    ]);
    assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 7 });
    assert.equal(fromChatResponse({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }, 'm').stop_reason, 'max_tokens');
  });

  it('reports refusals and keeps unparseable tool arguments visible', () => {
    const refused = fromChatResponse({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }] }, 'm');
    assert.equal(refused.stop_reason, 'refusal');
    const broken = fromChatResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'run_step', arguments: '{oops' } }] } }] }, 'm');
    assert.deepEqual((broken.content[0] as { input: unknown }).input, { _unparseable_arguments: '{oops' });
    assert.throws(() => fromChatResponse({ choices: [] }, 'm'), AiError);
  });
});

describe('model routing', () => {
  function recordingFetch(reply: object) {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { urls, fetchImpl };
  }

  it('sends claude-* to the Messages endpoint and other models to chat/completions on the gateway', async () => {
    const saved = { ...process.env };
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_BASE_URL = 'https://gatellm.test/api';
    process.env.ANTHROPIC_API_KEY = 'gatellm_live_test';
    try {
      const chat = recordingFetch({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] });
      await createModelClient({ fetch: chat.fetchImpl }).create({ model: 'gpt-4.1', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
      assert.deepEqual(chat.urls, ['https://gatellm.test/api/v1/chat/completions']);

      const messages = recordingFetch({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-4-6', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      await createModelClient({ fetch: messages.fetchImpl }).create({ model: 'claude-opus-4-6', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
      assert.match(messages.urls[0]!, /^https:\/\/gatellm\.test\/api\/v1\/messages/);
    } finally {
      for (const key of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('explains gateway errors', async () => {
    const fetchImpl = (async () => new Response('{"message":"Provider key is not configured for provider: gemini"}', { status: 403 })) as unknown as typeof fetch;
    const client = createOpenAICompatibleClient({ baseURL: 'https://gatellm.test/api', apiKey: 'k', fetch: fetchImpl });
    await assert.rejects(client.create({ model: 'gemini-2.5-pro', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }), /rejected the request \(403\): Provider key is not configured/);
    assert.throws(() => createOpenAICompatibleClient({ apiKey: 'k', baseURL: '' }), /gateway URL/);
  });
});
