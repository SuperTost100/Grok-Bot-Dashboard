// Jev, TypeSafe's decision model on OpenRouter. It answers typed questions about a "state" with
// probabilities and never writes text. You pay per input token; answers are free.
// https://openrouter.ai/docs/guides/community/jev

type Fetch = typeof fetch;

export const JEV_URL = "https://openrouter.ai/api/alpha/decisions";

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export interface ChoiceAnswer { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> }
export interface NoulAnswer { type: "noul"; noul: number }
export interface ScoreAnswer { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number> }
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface JevResult {
  answers: Record<string, Answer>;
  cost: number;
  model: string;
}

export class JevError extends Error {
  /** Worth trying again later: rate limits, server errors, network trouble. */
  retry: boolean;
  constructor(message: string, retry: boolean) {
    super(message);
    this.retry = retry;
  }
}

export async function askJev(
  key: string,
  model: string,
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  fetchImpl: Fetch = fetch,
): Promise<JevResult> {
  let res: Response;
  try {
    res = await fetchImpl(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Grok Bot Dashboard" },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new JevError(`Couldn't reach OpenRouter: ${(err as Error).message}`, true);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      detail = text.slice(0, 200);
    }
    const hint = res.status === 401 ? " Check the OpenRouter API key." : res.status === 402 ? " The OpenRouter credit may have run out." : "";
    throw new JevError(`OpenRouter answered ${res.status}${detail ? `: ${detail}` : ""}.${hint}`, res.status === 429 || res.status >= 500);
  }
  let body: { model?: string; answers?: Record<string, Answer>; usage?: { cost?: number } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new JevError("OpenRouter sent something that isn't JSON.", true);
  }
  for (const [name, q] of Object.entries(questions)) {
    const a = body.answers?.[name];
    const ok =
      a?.type === q.type &&
      ((a.type === "choice" && typeof a.choice === "string" && a.choice in (q as { criteria: Record<string, string> }).criteria) ||
        (a.type === "noul" && typeof a.noul === "number") ||
        (a.type === "score" && typeof a.score === "number"));
    if (!ok) throw new JevError(`Jev's answer to "${name}" is missing or malformed.`, true);
  }
  return { answers: body.answers!, cost: Number(body.usage?.cost ?? 0), model: body.model ?? model };
}
