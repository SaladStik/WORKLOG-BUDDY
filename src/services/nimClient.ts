import OpenAI from 'openai';

export interface NimConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SYSTEM_PROMPT =
  'You are a concise software-engineering assistant. Given git activity (diff, commits, ' +
  'changed files), you write a factual work-log update for a Jira ticket. Use past tense, ' +
  'read the actual diff to describe what changed in each file, and focus on what changed ' +
  'and why. No preamble, no fluff, no invented changes — only what the diff shows.';

/**
 * Verifies the NIM endpoint, key and model with a minimal 1-token request.
 * Returns the model name on success; throws with the API error message otherwise.
 */
export async function testNim(cfg: NimConfig): Promise<string> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  const params = {
    model: cfg.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    chat_template_kwargs: { thinking: false },
    stream: false,
  } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  await client.chat.completions.create(params);
  return cfg.model;
}

/**
 * Calls the NVIDIA NIM OpenAI-compatible endpoint and returns the full summary text.
 * `chat_template_kwargs` is a NIM-specific extra body field, so the params object is
 * cast — the OpenAI SDK forwards unknown fields to the request body.
 */
export async function summarize(cfg: NimConfig, userPrompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });

  const params = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    top_p: 0.95,
    max_tokens: 500,
    chat_template_kwargs: { thinking: false },
    stream: false,
  } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  const completion = await client.chat.completions.create(params);
  return completion.choices[0]?.message?.content?.trim() || '(model returned no content)';
}

/**
 * Streaming variant — invokes `onChunk` for each piece of generated text so the UI
 * can show tokens live. Returns the full assembled text once the stream ends.
 */
export async function summarizeStream(
  cfg: NimConfig,
  userPrompt: string,
  onChunk: (text: string) => void | Promise<void>,
): Promise<string> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });

  const params = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    top_p: 0.95,
    max_tokens: 500,
    chat_template_kwargs: { thinking: false },
    stream: true,
  } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

  const stream = await client.chat.completions.create(params);
  let full = '';
  for await (const chunk of stream) {
    const piece = chunk.choices?.[0]?.delta?.content ?? '';
    if (piece) {
      full += piece;
      await onChunk(piece);
    }
  }
  return full.trim();
}

export function buildPrompt(
  issueKey: string,
  activeMinutes: number,
  filesTouched: string[],
  evidence: { statText: string; commits: string; diff: string },
  style?: string,
): string {
  const fileList = filesTouched.length
    ? filesTouched.map((f) => `- ${f}`).join('\n')
    : '(none tracked)';

  const styleLine = style?.trim()
    ? ['', `Style & formatting instructions (follow these closely): ${style.trim()}`]
    : [];

  return [
    `Write a work-log summary for Jira ticket ${issueKey}.`,
    `The developer was actively coding for about ${activeMinutes} minutes.`,
    '',
    'Files edited this session:',
    fileList,
    '',
    'Working-tree change stat:',
    evidence.statText || '(no uncommitted changes)',
    '',
    'Commits made during this session:',
    evidence.commits || '(no commits)',
    '',
    'Unified diff (may be truncated):',
    '```diff',
    evidence.diff || '(empty)',
    '```',
    '',
    'Produce, in markdown:',
    '1. A one-line **Summary** of the overall work.',
    '2. A **Changes by file** section: one bullet per changed file as `path` — what changed and why.',
    '   Group trivially-related files if there are many. Base every point on the diff above.',
    'Keep each bullet to one or two lines. Do not invent changes not present in the diff.',
    ...styleLine,
  ].join('\n');
}
