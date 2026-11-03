/** Errors from Meta's Model API, sorted into the kinds the gateway reacts to. */
export type AiErrorKind = 'timeout' | 'rate_limited' | 'upstream' | 'network' | 'bad_request' | 'invalid_response';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | undefined;

  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = status;
  }

  /** Worth one more try inside the time budget. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'upstream' || this.kind === 'network';
  }
}

export interface ChatJsonOptions {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  body: Record<string, unknown>;
}

/**
 * POST {baseUrl}/chat/completions with a JSON-schema response format and return the JSON object
 * the model wrote (choices[0].message.content). Never logs or returns the API key.
 */
export async function chatJson({ baseUrl, apiKey, fetch: fetchFn, signal, body }: ChatJsonOptions): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw signal.aborted ? new AiError('timeout', 'No reply in time') : new AiError('network', `Request failed: ${errorText(err)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const status = response.status;
    const kind: AiErrorKind =
      status === 429 ? 'rate_limited' : status === 408 || status === 504 ? 'timeout' : status >= 500 ? 'upstream' : 'bad_request';
    throw new AiError(kind, `HTTP ${status}: ${detail.slice(0, 300)}`, status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw signal.aborted ? new AiError('timeout', 'Reply cut off by the time limit') : new AiError('invalid_response', 'Reply was not JSON');
  }
  const choice = (payload as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null)?.choices?.[0];
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== 'stop') {
    throw new AiError('invalid_response', `Reply stopped early (${choice.finish_reason})`);
  }
  const content = choice?.message?.content;
  if (typeof content !== 'string') throw new AiError('invalid_response', 'Reply had no content');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AiError('invalid_response', 'Reply content was not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AiError('invalid_response', 'Reply content was not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
