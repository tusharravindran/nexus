import type { Message, MessageParams, ModelClient } from '../../src/ai/model.ts';

type Block = Message['content'][number];
type Reply = Message | ((params: MessageParams) => Message);

/**
 * A ModelClient that returns scripted replies in order and records every
 * request, so AI features are tested without credentials, network or cost.
 */
export class ScriptedModel implements ModelClient {
  readonly requests: MessageParams[] = [];
  readonly #replies: Reply[];

  constructor(replies: Reply[]) {
    this.#replies = [...replies];
  }

  async create(params: MessageParams): Promise<Message> {
    this.requests.push(structuredClone(params));
    const next = this.#replies.shift();
    if (!next) throw new Error('ScriptedModel: no reply left for this request');
    return typeof next === 'function' ? next(params) : next;
  }
}

let counter = 0;

/** A reply message with the given content blocks. */
export function reply(content: Block[], stopReason: Message['stop_reason'] = 'end_turn', category?: string): Message {
  return {
    id: `msg_${++counter}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopReason === 'refusal' ? { type: 'refusal', category: category ?? null, explanation: null } : null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Message;
}

export const text = (value: string): Block => ({ type: 'text', text: value, citations: null }) as unknown as Block;

export const toolUse = (name: string, input: unknown): Block =>
  ({ type: 'tool_use', id: `toolu_${++counter}`, name, input }) as unknown as Block;
