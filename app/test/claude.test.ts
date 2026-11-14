import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_MODEL, claudeLlm } from '../src/main/notes/claude'

type Message = { stop_reason: string; content: { type: string; text?: string }[] }
const sdk = vi.hoisted(() => ({
  requests: [] as { body: Record<string, unknown>; options: { signal?: AbortSignal }; key: string }[],
  message: undefined as Message | undefined,
  fail: undefined as (() => Error) | undefined,
}))
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { status?: number }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class Fake {
    static APIError = APIError
    static AuthenticationError = AuthenticationError
    static RateLimitError = RateLimitError
    constructor(private o: { apiKey: string }) {}
    beta = { messages: { stream: (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
      sdk.requests.push({ body, options, key: this.o.apiKey })
      let onText = (_t: string) => {}
      return {
        on(_event: string, f: (t: string) => void) { onText = f; return this },
        async finalMessage() {
          if (sdk.fail) throw sdk.fail()
          for (const b of sdk.message!.content) if (b.text) onText(b.text)
          return sdk.message
        },
      }
    } } }
  }
  return { default: Fake }
})

beforeEach(() => { sdk.requests.length = 0; sdk.fail = undefined; sdk.message = { stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: 'Shipped ' }, { type: 'text', text: 'on Tuesday.' }] } })
afterEach(() => vi.unstubAllEnvs())

/** a stand-in for Claude Code: takes the prompt on stdin, then prints these lines and exits */
function fakeClaude(lines: object[], o: { code?: number; stderr?: string; hangs?: boolean; missing?: boolean } = {}) {
  const calls: { cmd: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv }; stdin: string; killed: boolean }[] = []
  const run = ((cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const call = { cmd, args, opts, stdin: '', killed: false }
    calls.push(call)
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => { call.killed = true; exit(null); return true } })
    let code: number | null = o.code ?? 0
    // closed only after everything it printed was read, as a real process is
    child.stdout.on('end', () => setImmediate(() => child.emit('close', code)))
    const exit = (c: number | null) => { code = c; child.stderr.end(); child.stdout.end() }
    if (o.missing) { setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))); return child }
    child.stdin.on('data', (d) => { call.stdin += d })
    child.stdin.on('end', () => {
      if (o.stderr) child.stderr.write(o.stderr)
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`)
      if (!o.hangs) exit(code)
    })
    return child
  }) as unknown as typeof spawn
  return { run, calls }
}
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const answered = [{ type: 'system', subtype: 'init' }, delta('Shipped '), { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } }, delta('on Tuesday.'), { type: 'result', is_error: false, result: 'Shipped on Tuesday.' }]

describe('Claude through Claude Code', () => {
  it('writes the answer as it comes, with no tools and none of the person\'s own Claude Code setup', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-would-be-billed')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token')
    const { run, calls } = fakeClaude(answered)
    const tokens: string[] = []
    const out = await claudeLlm({ via: 'cli', run }).chat('When does it ship?', (t) => tokens.push(t), { maxTokens: 40, temperature: 0, before: ['Summarise.', 'It ships soon.'] })
    expect(out).toBe('Shipped on Tuesday.')
    expect(tokens).toEqual(['Shipped ', 'on Tuesday.'])
    const [{ cmd, args, opts, stdin }] = calls
    expect(cmd).toBe('claude')
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', CLAUDE_MODEL])
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']))
    // --bare would skip the subscription login; an API key in the environment would be billed instead of it
    expect(args).not.toContain('--bare')
    expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(opts.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(stdin).toContain('<user>\nSummarise.\n</user>\n<assistant>\nIt ships soon.\n</assistant>')
    expect(stdin.endsWith('When does it ship?')).toBe(true)
  })

  it('fails with what Claude Code said, never with an empty answer', async () => {
    const said = fakeClaude([{ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }], { code: 1 })
    await expect(claudeLlm({ via: 'cli', run: said.run }).chat('Hi', () => {})).rejects.toThrow('Not logged in')
    const died = fakeClaude([], { code: 2, stderr: 'error: unknown option' })
    await expect(claudeLlm({ via: 'cli', run: died.run }).chat('Hi', () => {})).rejects.toThrow('unknown option')
    const missing = fakeClaude([], { missing: true })
    await expect(claudeLlm({ via: 'cli', run: missing.run }).chat('Hi', () => {})).rejects.toThrow('not installed')
  })

  it('stops Claude Code when the job is stopped', async () => {
    const { run, calls } = fakeClaude([delta('Half ')], { hangs: true })
    const stop = new AbortController()
    const tokens: string[] = []
    const answer = claudeLlm({ via: 'cli', run, signal: stop.signal }).chat('Hi', (t) => { tokens.push(t); stop.abort() })
    await expect(answer).rejects.toThrow('Stopped')
    expect(tokens).toEqual(['Half '])
    expect(calls[0].killed).toBe(true)
  })
})

describe('Claude through an API key', () => {
  it('asks the model with the earlier turns, and leaves out the local model\'s sampling and small caps', async () => {
    const stop = new AbortController()
    const tokens: string[] = []
    const out = await claudeLlm({ via: 'api', apiKey: 'sk-ant-test', signal: stop.signal }).chat('A title?', (t) => tokens.push(t), { maxTokens: 40, temperature: 0.3, before: ['Summarise.', '# Notes'] })
    expect(out).toBe('Shipped on Tuesday.')
    expect(tokens).toEqual(['Shipped ', 'on Tuesday.'])
    const [{ body, options, key }] = sdk.requests
    expect(key).toBe('sk-ant-test')
    expect(options.signal).toBe(stop.signal)
    expect(body.model).toBe(CLAUDE_MODEL)
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarise.' }, { role: 'assistant', content: '# Notes' }, { role: 'user', content: 'A title?' }])
    expect(body.fallbacks).toBe('default')
    expect(body).not.toHaveProperty('temperature')
    // thinking shares the budget: 40 tokens would leave no title
    expect(body.max_tokens).toBeGreaterThan(1000)
  })

  it('fails when Claude declines, the key is refused, or none is saved', async () => {
    sdk.message = { stop_reason: 'refusal', content: [] }
    await expect(claudeLlm({ via: 'api', apiKey: 'k' }).chat('Hi', () => {})).rejects.toThrow('declined')
    sdk.fail = () => new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', undefined as never)
    await expect(claudeLlm({ via: 'api', apiKey: 'k' }).chat('Hi', () => {})).rejects.toThrow('did not accept the API key')
    await expect(claudeLlm({ via: 'api' }).chat('Hi', () => {})).rejects.toThrow('No Claude API key')
    // nothing was asked without a key
    expect(sdk.requests).toHaveLength(2)
  })
})

it('sizes prompts without the local model: no reading ahead, a guess for tokens', async () => {
  const llm = claudeLlm({ via: 'cli' })
  expect(llm.readAhead).toBeUndefined()
  expect(llm.contextSize).toBeGreaterThan(32_768)
  const [empty, short, long] = await llm.count(['', 'abc', 'a'.repeat(3000)])
  expect(empty).toBe(0)
  expect(short).toBeGreaterThan(0)
  expect(long).toBeGreaterThanOrEqual(750)
})
