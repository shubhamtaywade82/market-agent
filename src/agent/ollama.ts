export interface OllamaOpts {
  host: string;
  model: string;
  think: boolean | undefined;
  temperature: number;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export class OllamaError extends Error {
  constructor(public readonly code: 'TIMEOUT' | 'HTTP' | 'NETWORK' | 'BAD_RESPONSE' | 'BAD_JSON', message: string) {
    super(message);
  }
}

/**
 * One non-streaming POST /api/chat with a JSON-schema `format`. Returns the parsed
 * JSON object from message.content. Throws OllamaError; callers must fail closed.
 * No retry here: a late answer on a trading decision is worse than no answer.
 */
export async function chatJson(opts: OllamaOpts, system: string, user: string, schema: object): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: false,
    format: schema,
    options: { temperature: opts.temperature },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (opts.think !== undefined) body.think = opts.think;

  let res: Response;
  try {
    res = await fetchFn(`${opts.host.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) throw new OllamaError('TIMEOUT', `Ollama timed out after ${opts.timeoutMs}ms`);
    throw new OllamaError('NETWORK', `Ollama unreachable: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new OllamaError('HTTP', `Ollama HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new OllamaError('BAD_RESPONSE', 'Ollama returned a non-JSON body');
  }
  const content = (payload as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new OllamaError('BAD_RESPONSE', 'Ollama response has no message.content');
  try {
    return JSON.parse(content);
  } catch {
    throw new OllamaError('BAD_JSON', `Model output is not JSON: ${content.slice(0, 120)}`);
  }
}
