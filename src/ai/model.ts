import type Anthropic from '@anthropic-ai/sdk';
import { AiError } from '../errors.ts';

export type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Beta.Messages.BetaMessage;
export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type Tool = Anthropic.Beta.Messages.BetaTool;
export type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Claude Opus 5.5: the default model for every NEXUS AI feature. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** $NEXUS_MODEL when set (e.g. a model your gateway offers), else DEFAULT_MODEL. */
export function defaultModel(): string {
  return process.env.NEXUS_MODEL || DEFAULT_MODEL;
}

/**
 * The single model call NEXUS makes. The real implementation talks to
 * Claude through the official SDK; tests substitute a scripted fake, so no
 * test ever spends money or needs credentials.
 */
export interface ModelClient {
  create(params: MessageParams): Promise<Message>;
}

/** Server-side refusal fallback: a declined request is re-run on Anthropic's recommended fallback model. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Claude via @anthropic-ai/sdk. The SDK is loaded on first use, so NEXUS's
 * deterministic runtime never loads it. Credentials come from the
 * environment: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
 */
export interface ClaudeClientOptions {
  /** Overrides credential discovery. Prefer the environment. */
  apiKey?: string;
  /**
   * Send requests to a gateway instead of Anthropic's API, e.g. GateLLM at
   * https://gatellm.sedintechnologies.com/api. Default: $ANTHROPIC_BASE_URL, else Anthropic.
   */
  baseURL?: string;
  /**
   * Server-side refusal fallbacks. An Anthropic API feature, so the default is
   * on for Anthropic's API and off for gateways, which may reject unknown fields.
   */
  fallbacks?: boolean;
  /** Custom fetch, e.g. to inspect requests in tests. */
  fetch?: typeof fetch;
}

/** True when requests go to Anthropic's own API rather than a gateway. */
function isAnthropicApi(baseURL: string | undefined): boolean {
  if (!baseURL) return true;
  try {
    return new URL(baseURL).hostname.endsWith('anthropic.com');
  } catch {
    return false;
  }
}

export async function createClaudeClient(options: ClaudeClientOptions = {}): Promise<ModelClient> {
  let sdk: typeof import('@anthropic-ai/sdk');
  try {
    sdk = await import('@anthropic-ai/sdk');
  } catch (error) {
    throw new AiError('AI features need the Anthropic SDK: npm install @anthropic-ai/sdk', { cause: error });
  }
  const { default: AnthropicSdk } = sdk;

  let client: Anthropic;
  try {
    client = new AnthropicSdk({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (error) {
    throw new AiError(`Could not create the Claude client: ${(error as Error).message}. Set ANTHROPIC_API_KEY or run \`ant auth login\`.`, {
      cause: error,
    });
  }

  const fallbacks = options.fallbacks ?? isAnthropicApi(options.baseURL ?? process.env.ANTHROPIC_BASE_URL);

  return {
    async create(params) {
      try {
        return await client.beta.messages.create(
          fallbacks
            ? { ...params, betas: [...new Set([...(params.betas ?? []), FALLBACK_BETA])], fallbacks: params.fallbacks ?? 'default' }
            : params,
        );
      } catch (error) {
        if (error instanceof AnthropicSdk.AuthenticationError) {
          throw new AiError('Claude rejected the credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.', { cause: error });
        }
        if (error instanceof AnthropicSdk.RateLimitError) throw new AiError('Claude rate limit reached; try again shortly.', { cause: error });
        if (error instanceof AnthropicSdk.APIError) throw new AiError(`Claude API error ${error.status ?? ''}: ${error.message}`, { cause: error });
        if (error instanceof AnthropicSdk.AnthropicError) throw new AiError(error.message, { cause: error });
        // Anything else is a client configuration problem, most often missing credentials
        // (the SDK only resolves them when the first request is made).
        throw new AiError(`Could not call Claude: ${(error as Error).message}. Set ANTHROPIC_API_KEY or run \`ant auth login\`.`, {
          cause: error,
        });
      }
    },
  };
}

/** Concatenated text blocks of a reply. */
export function textOf(message: Message): string {
  return message.content
    .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Why the model declined, or undefined if it did not. Always check before reading content. */
export function refusalOf(message: Message): string | undefined {
  if (message.stop_reason !== 'refusal') return undefined;
  const category = message.stop_details?.category;
  return `the model declined the request${category ? ` (${category})` : ''}`;
}
