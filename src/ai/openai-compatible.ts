import { AiError } from '../errors.ts';
import { assertAiAllowed } from '../privacy.ts';
import { createClaudeClient, type Message, type MessageParams, type ModelClient } from './model.ts';

/**
 * Non-Claude models (e.g. GPT-4.1) through an OpenAI-compatible gateway such
 * as GateLLM. NEXUS's AI code is written against one request/reply shape
 * (the Messages API's); this adapter translates it to
 * POST {baseURL}/v1/chat/completions and back, so the advisor and drafter
 * work unchanged.
 *
 * Translated: system prompt, text and image content, tools and tool calls,
 * tool results, structured output (json_schema), stop reasons, usage.
 * Dropped (no equivalent): thinking, effort, prompt-cache hints, betas,
 * refusal fallbacks.
 */
export interface OpenAICompatibleOptions {
  /** Default: $OPENAI_BASE_URL, else $ANTHROPIC_BASE_URL (one gateway serves both formats). */
  baseURL?: string;
  /** Default: $OPENAI_API_KEY, else $ANTHROPIC_API_KEY. Sent as a Bearer token. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request deadline. Default: 120s. */
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAICompatibleClient(options: OpenAICompatibleOptions = {}): ModelClient {
  const baseURL = (options.baseURL ?? process.env.OPENAI_BASE_URL ?? process.env.ANTHROPIC_BASE_URL)?.replace(/\/+$/, '');
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = options.fetch ?? fetch;
  if (!baseURL) throw new AiError('Non-Claude models need a gateway URL: set OPENAI_BASE_URL (or ANTHROPIC_BASE_URL).');
  if (!apiKey) throw new AiError('Non-Claude models need a gateway key: set OPENAI_API_KEY (or ANTHROPIC_API_KEY).');

  return {
    async create(params) {
      assertAiAllowed(`a request to ${params.model}`);
      let response: Response;
      try {
        response = await fetchImpl(`${baseURL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(toChatRequest(params)),
          signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        });
      } catch (error) {
        throw new AiError(`Could not reach ${baseURL}: ${(error as Error).message}`, { cause: error });
      }
      const text = await response.text();
      if (!response.ok) {
        let detail = text.slice(0, 300);
        try {
          const body = JSON.parse(text) as { message?: string; error?: { message?: string } | string };
          detail = body.message ?? (typeof body.error === 'object' ? body.error?.message : body.error) ?? detail;
        } catch {
          // Not JSON; keep the raw text.
        }
        if (response.status === 401 || response.status === 403) throw new AiError(`The gateway rejected the request (${response.status}): ${detail}`);
        throw new AiError(`Model API error ${response.status}: ${detail}`);
      }
      return fromChatResponse(JSON.parse(text) as ChatResponse, params.model);
    },
  };
}

/** Claude models go to the Anthropic SDK, everything else to the OpenAI-compatible endpoint. */
export function createModelClient(options: { fetch?: typeof fetch } = {}): ModelClient {
  let claude: Promise<ModelClient> | undefined;
  let other: ModelClient | undefined;
  return {
    async create(params) {
      assertAiAllowed(`a request to ${params.model}`);
      if (String(params.model).startsWith('claude')) {
        claude ??= createClaudeClient(options);
        return (await claude).create(params);
      }
      other ??= createOpenAICompatibleClient(options);
      return other.create(params);
    },
  };
}

type Block = Record<string, unknown> & { type: string };

export function toChatRequest(params: MessageParams): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  const system = typeof params.system === 'string' ? params.system : params.system?.map((block) => block.text).join('\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const message of params.messages) {
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as Block] : (message.content as Block[]);
    if (message.role === 'assistant') {
      const text = content.filter((block) => block.type === 'text').map((block) => block.text as string).join('');
      const calls = content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id as string, type: 'function' as const, function: { name: block.name as string, arguments: JSON.stringify(block.input ?? {}) } }));
      // Thinking blocks have no equivalent and are dropped.
      messages.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }

    // User turn: tool results become `tool` messages; the rest stays a user message.
    const parts: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block.type === 'tool_result') {
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id as string, content: block.is_error ? `ERROR: ${body}` : body });
      } else if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const source = block.source as { type: string; media_type?: string; data?: string; url?: string };
        const url = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length > 0) {
      const onlyText = parts.every((part) => part.type === 'text');
      messages.push({ role: 'user', content: onlyText ? parts.map((part) => part.text as string).join('\n') : parts });
    }
  }

  const request: Record<string, unknown> = { model: params.model, max_tokens: params.max_tokens, messages };
  if (params.tools?.length) {
    request.tools = params.tools.map((tool) => {
      const definition = tool as { name: string; description?: string; input_schema: unknown; strict?: boolean };
      return {
        type: 'function',
        function: {
          name: definition.name,
          ...(definition.description ? { description: definition.description } : {}),
          parameters: definition.input_schema,
          ...(definition.strict ? { strict: true } : {}),
        },
      };
    });
  }
  const format = params.output_config?.format;
  if (format?.type === 'json_schema') {
    // Not strict: OpenAI's strict mode requires every property to be required, and NEXUS's schemas have optional fields.
    request.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: format.schema } };
  }
  return request;
}

const STOP_REASONS: Record<string, Message['stop_reason']> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export function fromChatResponse(response: ChatResponse, requestedModel: string): Message {
  const choice = response.choices?.[0];
  if (!choice?.message) throw new AiError('The model API returned no choices');
  const content: Array<Record<string, unknown>> = [];
  const text = choice.message.content ?? choice.message.refusal;
  if (text) content.push({ type: 'text', text, citations: null });
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = { _unparseable_arguments: call.function.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const stopReason = choice.message.refusal ? 'refusal' : (STOP_REASONS[choice.finish_reason ?? 'stop'] ?? 'end_turn');
  return {
    id: response.id ?? 'chatcmpl',
    type: 'message',
    role: 'assistant',
    model: response.model ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: choice.message.refusal ?? null } : null,
    usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 },
  } as unknown as Message;
}
