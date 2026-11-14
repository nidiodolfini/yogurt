import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import Anthropic from '@anthropic-ai/sdk'
import type { ClaudeVia } from '../../shared/types'
import type { Llm } from './enhance'

/**
 * Claude in place of the local notes model, when the person turned it on in Settings. Two ways in:
 * api: their own API key, through Anthropic's SDK.
 * cli: the Claude Code they already signed in to on this computer, run as it is (`claude -p`), so their subscription
 *      pays and Yogurt never sees a credential. Yogurt must not sign in to claude.ai itself or read Claude Code's
 *      credentials: Anthropic's terms keep subscription sign-in to its own apps.
 * No readAhead on purpose: callers skip reading ahead without it, so nothing leaves the computer during a recording.
 */
export const CLAUDE_MODEL = 'claude-opus-5-5'
/** well under what the model reads (1M): a cap on what one answer can cost, and room for estimate() to be off */
const CONTEXT = 200_000
/** thinking shares this with the answer, so the local model's small caps (40 for a title) are not passed on */
const MAX_TOKENS = 16_000

/**
 * Tokens in a text, guessed from its length: count() is called with a meeting's every line, so asking the API would be
 * a request per line. It decides when a long meeting is split into parts and how much history Ask keeps.
 *
 * TODO(you): your call. length / 3 is safe for Portuguese and transcripts full of names, and wastes some room;
 * length / 4 fits more per request and can run over on dense text.
 * ponytail: a guess, not a count; client.messages.countTokens once per prompt if prompts get cut in the wrong place.
 */
export const estimate = (text: string): number => Math.ceil(text.length / 3)

type Chat = Llm['chat']

/** an earlier prompt and answer, as the conversation they were (as notes/model.ts does; kept apart so this file needs no engine) */
const before = (pairs: string[] = []) => pairs.map((content, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content }))

/** the person's API key: billed to them by Anthropic, per token */
const viaApi = (apiKey: string | undefined, signal?: AbortSignal): Chat => async (prompt, onToken, o) => {
  if (!apiKey) throw new Error('No Claude API key is saved')
  try {
    // temperature is left out: this model rejects sampling settings
    const stream = new Anthropic({ apiKey }).beta.messages.stream({
      model: CLAUDE_MODEL, max_tokens: MAX_TOKENS,
      // a request the model declines is tried once more on another model, in the same call
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      messages: [...before(o?.before), { role: 'user', content: prompt }],
    }, { signal })
    stream.on('text', (delta) => onToken(delta))
    const message = await stream.finalMessage()
    // never saved as notes: the job fails and says so
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this')
    return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  } catch (e) {
    if (signal?.aborted) throw e
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude did not accept the API key', { cause: e })
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is rate limiting this key; try again in a moment', { cause: e })
    if (e instanceof Anthropic.APIError) throw new Error(`Claude could not answer (${e.status ?? 'no connection'}): ${e.message}`, { cause: e })
    throw e
  }
}

/** no tools, none of the person's own Claude Code settings, hooks, plugins or MCP servers: only the model answers */
const CLI_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', CLAUDE_MODEL,
  '--system-prompt', 'You write meeting notes and answer questions about meetings. Reply with only what is asked for.',
  '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']

/** earlier turns as text: `claude -p` takes one prompt */
const flat = (prompt: string, pairs?: string[]) => (pairs?.length
  ? `${before(pairs).map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join('\n')}\n\nThe conversation so far is above. Now:\n${prompt}`
  : prompt)

/**
 * Claude Code as installed, signed in by the person themselves.
 * ponytail: found on PATH; a Mac app opened from the Finder doesn't get the shell's PATH, so add a path setting there.
 */
const viaCli = (signal?: AbortSignal, run: typeof spawn = spawn): Chat => (prompt, onToken, o) => new Promise<string>((resolve, reject) => {
  // an API key in the environment would win over the subscription login and bill the API without saying so
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...env } = process.env
  const child = run('claude', CLI_ARGS, { cwd: tmpdir(), env, windowsHide: true })
  /** a line of what Claude Code prints: text as it is written, then one result */
  type Line = { type?: string; event?: { delta?: { type?: string; text?: string } }; is_error?: boolean; result?: unknown }
  let result: Line | undefined
  let said = ''
  const stop = () => { child.kill() }
  signal?.addEventListener('abort', stop, { once: true })
  child.stderr.on('data', (d) => { if (said.length < 2000) said += d })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let e: Line
    try { e = JSON.parse(line) } catch { return }
    if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta' && e.event.delta.text) onToken(e.event.delta.text)
    else if (e.type === 'result') result = e
  })
  child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error('Claude Code is not installed on this computer (claude was not found)', { cause: e }) : e))
  child.on('close', (code) => {
    signal?.removeEventListener('abort', stop)
    if (signal?.aborted) reject(new Error('Stopped'))
    else if (result && !result.is_error && typeof result.result === 'string') resolve(result.result)
    else reject(new Error(`Claude Code could not answer: ${(typeof result?.result === 'string' && result.result) || said.trim() || `exit ${code}`}`))
  })
  // a claude that never started has no stdin to take the prompt: the 'error' above already says why
  child.stdin.on('error', () => {})
  child.stdin.end(flat(prompt, o?.before))
})

export function claudeLlm(o: { via: ClaudeVia; apiKey?: string; signal?: AbortSignal; /** tests: a stand-in for Claude Code */ run?: typeof spawn }): Llm {
  const ask = o.via === 'api' ? viaApi(o.apiKey, o.signal) : viaCli(o.signal, o.run)
  const how = o.via === 'api' ? 'an API key' : 'Claude Code'
  return {
    contextSize: CONTEXT,
    count: async (texts) => texts.map(estimate),
    chat: async (prompt, onToken, opts) => {
      const t0 = performance.now()
      const answer = await ask(prompt, onToken, opts)
      // the log says who answered, so it is plain that this one left the computer. Counts only, never the text
      console.info('NOTES', `Claude answered through ${how} in ${((performance.now() - t0) / 1000).toFixed(1)} s (${prompt.length.toLocaleString('en-US')} chars read, ${answer.length.toLocaleString('en-US')} written)`)
      return answer
    },
  }
}
