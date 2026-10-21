import assert from 'node:assert/strict'
import test from 'node:test'

import { PackyCodeKeyRing } from '../src/key-ring.js'
import {
  buildSearchRequest,
  createPackyCodeAutoSearchProvider,
  createPackyCodeSearchProvider,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_SEARCH_BACKEND,
  PACKYCODE_AUTO_SEARCH_PROVIDER_ID,
  PACKYCODE_SEARCH_PROVIDER_ID,
  parseMessagesSearchResponse,
  parseResponsesSearchResponse,
  readResponsesStream,
  transientRetryDelay,
  WebError,
} from '../src/search.js'
import { fakeCredentials } from './helpers.mjs'

async function ringWith(...keys) {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  for (const [index, key] of keys.entries()) await ring.add(key, `k${index + 1}`)
  return ring
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/** The block shape `deepseek-flash` answered with through PackyCode's `/v1/messages`. */
const MESSAGES_ANSWER = {
  type: 'message',
  role: 'assistant',
  model: 'deepseek-flash',
  content: [
    { type: 'thinking', thinking: '…', signature: 'sig' },
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'DeepSeek Harness desktop app' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [
        { type: 'web_search_result', title: 'DeepSeek Harness Desktop Preview', url: 'https://eu.36kr.com/en/p/3998199345500040#1', encrypted_content: 'x'.repeat(64), page_age: null },
        { type: 'web_search_result', title: '下载 DeepSeek', url: 'https://www.deepseek.com/download/', encrypted_content: 'y', page_age: 'June 1, 2026' },
        { type: 'web_search_result', title: 'duplicate', url: 'https://www.deepseek.com/download/', encrypted_content: 'z' },
        { type: 'web_search_result', title: 'not http', url: 'javascript:alert(1)' },
      ],
    },
    { type: 'thinking', thinking: '…', signature: 'sig' },
    { type: 'text', text: 'The desktop preview ', citations: [] },
    { type: 'text', text: 'launched.', citations: [{ type: 'web_search_result_location', url: 'https://www.deepseek.com/download/', title: '下载 DeepSeek', cited_text: 'Download the DeepSeek Harness desktop app.' }] },
  ],
  usage: { input_tokens: 8920, output_tokens: 891, server_tool_use: { web_search_requests: 1 } },
}

/** The item shape `gpt-6.1-sol` answered with through PackyCode's `/v1/responses`. */
const RESPONSES_ANSWER = {
  output: [
    { type: 'message', content: [{ type: 'output_text', text: 'I’ll check Node.js’s release announcements.', annotations: [] }] },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'latest Node.js release', sources: [{ type: 'url', url: 'https://nodejs.org/en/blog' }, { type: 'url', url: 'https://github.com/nodejs/node/releases' }] } },
    { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://nodejs.org/en/blog/release/v26.11.1' } },
    {
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'Node.js 26.11.1 (Current), announced October 7, 2026 — https://nodejs.org/en/blog/release/v26.11.1 ([nodejs.org](https://nodejs.org/en/blog/release/v26.11.1))',
        annotations: [{ type: 'url_citation', url: 'https://nodejs.org/en/blog/release/v26.11.1', title: 'Node.js — Node.js 26.11.1 (Current)', start_index: 100, end_index: 160 }],
      }],
    },
  ],
}

test('a Messages answer maps its result blocks to sources and its text to content', () => {
  const result = parseMessagesSearchResponse(MESSAGES_ANSWER)
  assert.deepEqual(result.sources, [
    { url: 'https://eu.36kr.com/en/p/3998199345500040#1', title: 'DeepSeek Harness Desktop Preview' },
    { url: 'https://www.deepseek.com/download/', title: '下载 DeepSeek', snippet: 'Download the DeepSeek Harness desktop app.', publishedAt: 'June 1, 2026' },
  ])
  assert.equal(result.content, 'The desktop preview launched.')
  assert.equal(result.truncated, false)
  // Encrypted page content never reaches the result.
  assert.doesNotMatch(JSON.stringify(result), /encrypted|xxxx/u)
})

test('a Messages answer without a search block is an error, not prose scraping', () => {
  assert.throws(
    () => parseMessagesSearchResponse({ content: [{ type: 'text', text: 'see https://example.com' }] }),
    error => error instanceof WebError && error.code === 'WEB_PROVIDER_ERROR' && /did not run a web search/u.test(error.message),
  )
  assert.throws(
    () => parseMessagesSearchResponse({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] }),
    /max_uses_exceeded/u,
  )
})

test('a Responses answer lists cited sources first, then the URLs its search actions saw', () => {
  const result = parseResponsesSearchResponse(RESPONSES_ANSWER)
  assert.deepEqual(result.sources.map(source => source.url), [
    'https://nodejs.org/en/blog/release/v26.11.1',
    'https://nodejs.org/en/blog',
    'https://github.com/nodejs/node/releases',
  ])
  assert.equal(result.sources[0].title, 'Node.js — Node.js 26.11.1 (Current)')
  // A URL without a title is labelled with its host.
  assert.equal(result.sources[1].title, 'nodejs.org')
  // The final message is the answer; the preamble is not.
  assert.match(result.content, /^Node\.js 26\.11\.1 \(Current\)/u)
  assert.throws(() => parseResponsesSearchResponse({ output: [RESPONSES_ANSWER.output[3]] }), /did not run a web search/u)
})

test('a Responses body with no output at all says the result was lost, not that no search ran', () => {
  // What the Codex channel answers a non-streaming request with.
  assert.throws(
    () => parseResponsesSearchResponse({ status: 'completed', output: [], tool_usage: { web_search: { num_requests: 1 } } }),
    error => error instanceof WebError && error.code === 'WEB_PROVIDER_ERROR'
      && /no output items \(status completed\); the gateway did not pass the search result on/u.test(error.message),
  )
})

/** Serialize events the way the gateway streams them. */
const sse = events => events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join('')

/** The event order a live `gpt-6.1-sol` search streamed, with the empty final output it ended on. */
function searchEvents(output = RESPONSES_ANSWER.output, finalOutput = []) {
  const response = { id: 'resp_search', object: 'response', status: 'in_progress', instructions: 'x'.repeat(2000), output: [] }
  const events = [{ type: 'response.created', response }, { type: 'response.in_progress', response }]
  output.forEach((item, index) => {
    events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' } })
    if (item.type === 'message') events.push({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: item.content[0].text })
    if (item.type === 'web_search_call') events.push({ type: 'response.web_search_call.completed', output_index: index, item_id: 'ws' })
    events.push({ type: 'response.output_item.done', output_index: index, item })
  })
  events.push({ type: 'response.metadata', metadata: {} })
  events.push({ type: 'response.completed', response: { ...response, status: 'completed', output: finalOutput, usage: { input_tokens: 17590, output_tokens: 221 } } })
  return events
}

/** A capacity refusal the way the Codex channel relays it inside a 200 stream. */
function capacityEvents(message = 'Temporary capacity limit. Please try again in 2s.') {
  const response = { id: 'resp_busy', object: 'response', status: 'in_progress', output: [] }
  const error = { type: 'service_unavailable_error', code: 'rate_limit_exceeded', message, param: null }
  return [
    { type: 'response.created', response },
    { type: 'response.in_progress', response },
    { type: 'response.metadata', metadata: {} },
    { type: 'error', error: { ...error, headers: { 'x-retry-metadata': 'NO_MORE_RETRY' } } },
    { type: 'response.failed', response: { ...response, status: 'failed', error } },
  ]
}

/** A 200 event-stream answer, delivered in chunks of `size` bytes. */
function streamAnswer(body, { size = Infinity } = {}) {
  const bytes = new TextEncoder().encode(body)
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

test('a streamed answer rebuilds its output from the items the stream completed', async () => {
  const body = await readResponsesStream(streamAnswer(sse(searchEvents())))
  assert.equal(body.status, 'completed')
  assert.deepEqual(body.output, RESPONSES_ANSWER.output)
  assert.deepEqual(parseResponsesSearchResponse(body), parseResponsesSearchResponse(RESPONSES_ANSWER))
})

test('the stream reader survives CRLF and chunks that split lines, line endings and characters', async () => {
  const output = [...RESPONSES_ANSWER.output.slice(0, 3), {
    type: 'message',
    content: [{ type: 'output_text', text: 'Node.js 26.11.1 — 发布于十月', annotations: [{ type: 'url_citation', url: 'https://nodejs.org/zh-cn/', title: 'Node.js 中文网' }] }],
  }]
  const wire = sse(searchEvents(output)).replace(/\n/gu, '\r\n')
  for (const size of [1, 2, 7, 64]) {
    const body = await readResponsesStream(streamAnswer(wire, { size }))
    assert.deepEqual(body.output, output, `chunks of ${size} bytes`)
  }
  // Bare CR line endings, and a last event without its blank line.
  const bare = sse(searchEvents(output)).replace(/\n/gu, '\r').replace(/\r\r$/u, '')
  assert.deepEqual((await readResponsesStream(streamAnswer(bare, { size: 5 }))).output, output)
})

test('the stream reader keeps the final event\'s own output, orders items by index, and skips noise', async () => {
  const [preamble, search, open, answer] = RESPONSES_ANSWER.output
  const own = await readResponsesStream(streamAnswer(sse(searchEvents([preamble, search], [search, answer]))))
  assert.deepEqual(own.output, [search, answer])

  const shuffled = [
    { type: 'response.created', response: { status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 2, item: open },
    { type: 'response.output_item.done', output_index: 0, item: search },
    { type: 'response.output_item.done', output_index: 1, item: answer },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]
  const wire = `: keep-alive\n\ndata: not json\n\n${sse(shuffled)}data: [DONE]\n\n`
  assert.deepEqual((await readResponsesStream(streamAnswer(wire))).output, [search, answer, open])
})

test('the stream reader turns a relayed failure into the body error and needs a final event', async () => {
  const failed = await readResponsesStream(streamAnswer(sse(capacityEvents())))
  assert.equal(failed.error.code, 'rate_limit_exceeded')
  assert.match(failed.error.message, /Temporary capacity limit/u)
  // Only response.failed, as some channels send it.
  const only = await readResponsesStream(streamAnswer(sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }])))
  assert.deepEqual(only.error, { code: 'server_error', message: 'boom' })

  const cut = searchEvents().slice(0, -1)
  await assert.rejects(readResponsesStream(streamAnswer(sse(cut))), error => error instanceof WebError && /ended before the response completed/u.test(error.message))
})

test('only an upstream hiccup is resent, after the pause it names', () => {
  assert.equal(transientRetryDelay({ type: 'service_unavailable_error', code: 'rate_limit_exceeded', message: 'Temporary capacity limit. Please try again in 2s.' }), 2000)
  assert.equal(transientRetryDelay({ code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.898s.' }), 1898)
  assert.equal(transientRetryDelay({ code: 'rate_limit_exceeded', message: 'Please try again in 28ms.' }), 28)
  assert.equal(transientRetryDelay({ type: 'server_error', code: 'server_error', message: 'An error occurred while processing your request.' }), DEFAULT_RETRY_DELAY_MS)
  assert.equal(transientRetryDelay({ code: 'server_error', message: 'boom' }, 5), 5)
  // A pause longer than the search budget allows is reported instead.
  assert.equal(transientRetryDelay({ code: 'rate_limit_exceeded', message: 'Please try again in 30s.' }), undefined)
  // Request, quota and key failures are not resent.
  assert.equal(transientRetryDelay({ type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid tool_choice' }), undefined)
  assert.equal(transientRetryDelay({ code: 'rate_limit_exceeded', message: '该令牌额度已用尽' }), undefined)
  assert.equal(transientRetryDelay({ type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' }), undefined)
  assert.equal(transientRetryDelay(undefined), undefined)
})

test('a GPT search streams and returns the items the stream completed', async () => {
  const ring = await ringWith('sk-first-key-0001')
  const calls = []
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return streamAnswer(sse(searchEvents()), { size: 97 })
    },
  })
  const result = await provider.search({ query: 'latest Node.js release' })
  assert.deepEqual(result, parseResponsesSearchResponse(RESPONSES_ANSWER))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gw.example/v1/responses')
  assert.equal(calls[0].init.headers.accept, 'text/event-stream')
  assert.equal(JSON.parse(calls[0].init.body).stream, true)
  assert.equal(calls[0].init.redirect, 'error')
})

test('a GPT search always sends a prompt cache key, which the Codex group requires', async () => {
  const ring = await ringWith('sk-first-key-0001')
  const keys = []
  let session
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    resolveSessionId: () => session,
    fetchImpl: async (_url, init) => {
      keys.push(JSON.parse(init.body).prompt_cache_key)
      return streamAnswer(sse(searchEvents()))
    },
  })
  await provider.search({ query: 'q' })
  session = ''
  await provider.search({ query: 'q' })
  session = 'session-1'
  await provider.search({ query: 'q' })
  await provider.search({ query: 'q', sessionId: 'mcp-session' })
  // Without a session, one id per provider, the way the model route falls back.
  assert.match(keys[0], /^packycode-api-search-[0-9a-f-]{36}$/u)
  assert.equal(keys[1], keys[0])
  assert.deepEqual(keys.slice(2), ['session-1', 'mcp-session'])
})

test('a capacity refusal inside the stream is resent on the same key, which is never blamed', async () => {
  const ring = await ringWith('sk-first-key-0001', 'sk-second-key-0002')
  const failures = []
  const used = []
  const started = Date.now()
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    onKeyFailure: kind => failures.push(kind),
    fetchImpl: async (_url, init) => {
      used.push(init.headers.authorization)
      return streamAnswer(sse(used.length === 1 ? capacityEvents('Temporary capacity limit. Please try again in 30ms.') : searchEvents()))
    },
  })
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources.length, 3)
  assert.deepEqual(used, ['Bearer sk-first-key-0001', 'Bearer sk-first-key-0001'])
  assert.ok(Date.now() - started >= 25, 'waited the advised pause')
  assert.deepEqual(failures, [])
})

test('a capacity refusal that persists is reported after three attempts with what to do', async () => {
  const ring = await ringWith('sk-first-key-0001', 'sk-second-key-0002')
  const failures = []
  let calls = 0
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    retryDelayMs: 1,
    onKeyFailure: kind => failures.push(kind),
    fetchImpl: async () => {
      calls += 1
      // No pause named: the configured one applies.
      return streamAnswer(sse([{ type: 'error', error: { type: 'server_error', code: 'server_error', message: 'An error occurred while processing your request.' } }]))
    },
  })
  await assert.rejects(provider.search({ query: 'q' }), error => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /gpt-6\.1-sol stayed unavailable upstream after 3 attempts \(server_error: An error occurred/u)
    assert.match(error.message, /switch the search backend to "deepseek"/u)
    return true
  })
  assert.equal(calls, 3)
  assert.deepEqual(failures, [])
  assert.equal((await ring.list()).keys.every(key => !key.disabled), true)
})

test('any other failure inside the stream is reported at once, without a status', async () => {
  const ring = await ringWith('sk-secret-key-123456')
  let calls = 0
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    fetchImpl: async () => {
      calls += 1
      return streamAnswer(sse([{ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad input for sk-secret-key-123456' } }]))
    },
  })
  await assert.rejects(provider.search({ query: 'q' }), error => {
    assert.equal(error.message, 'PackyCode search failed upstream: invalid_value: bad input for …3456')
    return true
  })
  assert.equal(calls, 1)
})

test('a search cancelled during the pause before a resend stops there', async () => {
  const ring = await ringWith('sk-first-key-0001')
  const controller = new AbortController()
  let calls = 0
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    fetchImpl: async () => {
      calls += 1
      setTimeout(() => controller.abort(), 10)
      return streamAnswer(sse(capacityEvents('Temporary capacity limit. Please try again in 2s.')))
    },
  })
  const started = Date.now()
  await assert.rejects(provider.search({ query: 'q' }, controller.signal), error => error.code === 'WEB_ABORTED')
  assert.ok(Date.now() - started < 1000, 'did not sit out the pause')
  assert.equal(calls, 1)
})

test('a search cancelled while its stream is arriving stops reading', async () => {
  const ring = await ringWith('sk-first-key-0001')
  const controller = new AbortController()
  let cancelled = false
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    fetchImpl: async () => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(sse(searchEvents()).slice(0, 300)))
        setTimeout(() => controller.abort(), 10)
      },
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  await assert.rejects(provider.search({ query: 'q' }, controller.signal), error => error.code === 'WEB_ABORTED')
  assert.equal(cancelled, true)
})

test('each backend builds its own protocol request against the configured host', () => {
  const deepseek = buildSearchRequest('deepseek', { apiHost: 'https://gw.example', query: 'q', sessionId: 's1' })
  assert.equal(deepseek.url, 'https://gw.example/v1/messages')
  assert.deepEqual(deepseek.headers('sk-1'), { 'x-api-key': 'sk-1', 'anthropic-version': '2023-06-01' })
  assert.equal(deepseek.body.model, 'deepseek-flash')
  assert.deepEqual(deepseek.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
  assert.match(deepseek.body.messages[0].content, /^Perform a web search for the query: q/u)

  const gpt = buildSearchRequest('gpt', { apiHost: 'https://gw.example', query: 'q', sessionId: 's1' })
  assert.equal(gpt.url, 'https://gw.example/v1/responses')
  assert.deepEqual(gpt.headers('sk-1'), { authorization: 'Bearer sk-1' })
  assert.equal(gpt.body.model, 'gpt-6.1-sol')
  assert.deepEqual(gpt.body.tools, [{ type: 'web_search' }])
  assert.equal(gpt.body.tool_choice, 'required')
  assert.equal(gpt.body.store, false)
  // The Codex channel's non-streaming answer carries an empty output.
  assert.equal(gpt.body.stream, true)
  assert.equal(deepseek.body.stream, undefined)
  assert.equal(gpt.body.prompt_cache_key, 's1')
  // The Codex group refuses a bare string input on some channels.
  assert.ok(Array.isArray(gpt.body.input))

  assert.equal(DEFAULT_SEARCH_BACKEND, 'deepseek')
  assert.throws(() => buildSearchRequest('bing', { apiHost: 'https://gw.example', query: 'q' }), /not supported/u)
})

test('a search authenticates with the active ring key only and refuses redirects', async () => {
  const ring = await ringWith('sk-first-key-0001', 'sk-second-key-0002')
  const calls = []
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return json(200, MESSAGES_ANSWER)
    },
  })
  assert.equal(provider.id, PACKYCODE_SEARCH_PROVIDER_ID)
  assert.equal(provider.available(), true)
  const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
  assert.equal(result.sources.length, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gw.example/v1/messages')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-first-key-0001')
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test('the backend preference is read per search', async () => {
  const ring = await ringWith('sk-first-key-0001')
  let backend = 'deepseek'
  const urls = []
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => backend,
    fetchImpl: async url => {
      urls.push(url)
      return json(200, url.endsWith('/responses') ? RESPONSES_ANSWER : MESSAGES_ANSWER)
    },
  })
  await provider.search({ query: 'a' })
  backend = 'gpt'
  await provider.search({ query: 'b' })
  backend = 'unknown'
  await provider.search({ query: 'c' })
  assert.deepEqual(urls, ['https://gw.example/v1/messages', 'https://gw.example/v1/responses', 'https://gw.example/v1/messages'])
})

test('an exhausted key moves aside through the shared sink and the next key answers', async () => {
  const ring = await ringWith('sk-first-key-0001', 'sk-second-key-0002')
  const failures = []
  const used = []
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    onKeyFailure: (kind, message, key, id) => {
      failures.push({ kind, key, id })
      void ring.disable(id, kind)
    },
    fetchImpl: async (_url, init) => {
      used.push(init.headers['x-api-key'])
      return init.headers['x-api-key'] === 'sk-first-key-0001'
        ? json(403, { error: { message: '该令牌额度已用尽', type: 'packy_api_error' } })
        : json(200, MESSAGES_ANSWER)
    },
  })
  const result = await provider.search({ query: 'q' })
  assert.equal(result.sources.length, 2)
  assert.deepEqual(used, ['sk-first-key-0001', 'sk-second-key-0002'])
  assert.equal(failures.length, 1)
  assert.equal(failures[0].kind, 'quota')
  assert.equal(failures[0].key, 'sk-first-key-0001')
  assert.equal(typeof failures[0].id, 'string')
})

test('a key whose group does not cover the search model is skipped but never disabled', async () => {
  const ring = await ringWith('sk-first-key-0001', 'sk-second-key-0002')
  const failures = []
  let calls = 0
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    backend: () => 'gpt',
    onKeyFailure: kind => failures.push(kind),
    fetchImpl: async () => {
      calls += 1
      return json(400, { error: { code: 'model_not_found', message: '当前令牌未覆盖供应商 "OpenAI"（模型=gpt-6.1-sol，已选分组=[codex]）', type: 'packy_api_error' } })
    },
  })
  await assert.rejects(provider.search({ query: 'q' }), error => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /no stored API key's group covers gpt-6\.1-sol/u)
    assert.match(error.message, /Switch the search backend to "deepseek"/u)
    return true
  })
  assert.equal(calls, 2)
  assert.deepEqual(failures, [])
  assert.equal((await ring.list()).keys.every(key => !key.disabled), true)
})

test('a client-policy refusal is explained and blames no key', async () => {
  const ring = await ringWith('sk-first-key-0001')
  const failures = []
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    onKeyFailure: kind => failures.push(kind),
    fetchImpl: async () => json(403, { error: { message: '请使用标准 codex 客户端' } }),
  })
  await assert.rejects(provider.search({ query: 'q' }), /拒绝了这个客户端/u)
  assert.deepEqual(failures, [])
})

test('other failures name the status and never echo the key', async () => {
  const ring = await ringWith('sk-secret-key-123456')
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    fetchImpl: async () => json(500, { error: { message: 'upstream exploded for sk-secret-key-123456' } }),
  })
  await assert.rejects(provider.search({ query: 'q' }), error => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /HTTP 500/u)
    assert.doesNotMatch(error.message, /sk-secret-key-123456/u)
    assert.match(error.message, /…3456/u)
    return true
  })
})

test('no stored key, an empty query, and a cancelled search fail with their own codes', async () => {
  const empty = createPackyCodeSearchProvider({
    ring: await ringWith(),
    hosts: () => ({ apiHost: 'https://gw.example' }),
    fetchImpl: async () => assert.fail('no request without a key'),
  })
  await assert.rejects(empty.search({ query: 'q' }), error => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING' && /Settings → PackyCode/u.test(error.message))
  await assert.rejects(empty.search({ query: '  ' }), /non-empty query/u)

  const ring = await ringWith('sk-first-key-0001')
  let started
  const fetching = new Promise(resolve => { started = resolve })
  const slow = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    // Like fetch: an already-aborted signal rejects at once, a later abort rejects then.
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (init.signal.aborted) return abort()
      init.signal.addEventListener('abort', abort)
      started()
    }),
  })
  const controller = new AbortController()
  const pending = slow.search({ query: 'q' }, controller.signal)
  await fetching
  controller.abort()
  await assert.rejects(pending, error => error.code === 'WEB_ABORTED')
  // Cancelled while the key was still being resolved: no request goes out.
  const early = new AbortController()
  const beforeFetch = slow.search({ query: 'q' }, early.signal)
  early.abort()
  await assert.rejects(beforeFetch, error => error.code === 'WEB_ABORTED')
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(slow.search({ query: 'q' }, aborted.signal), error => error.code === 'WEB_ABORTED')
})

test('a request that never answers is bounded by the search timeout', async t => {
  // AbortSignal.timeout does not keep the event loop alive, and this fake
  // fetch holds nothing open; in a host process something always does. Node
  // 22's runner would otherwise see an idle loop and cancel the file.
  const keepAlive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepAlive))
  const ring = await ringWith('sk-first-key-0001')
  const provider = createPackyCodeSearchProvider({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
      if (init.signal.aborted) return abort()
      init.signal.addEventListener('abort', abort)
    }),
  })
  await assert.rejects(provider.search({ query: 'q' }), error => error.code === 'WEB_PROVIDER_ERROR' && /no answer within/u.test(error.message))
})

function stubProvider(id, answer) {
  const seen = []
  return {
    id,
    seen,
    available: () => true,
    async search(request) {
      seen.push(request.query)
      return typeof answer === 'function' ? answer(request) : answer
    },
  }
}

test('auto search serves PackyCode sessions itself and hands every other request to the fallback', async () => {
  const packycode = stubProvider(PACKYCODE_SEARCH_PROVIDER_ID, { sources: [{ url: 'https://p.example' }], truncated: false })
  const fallback = stubProvider('kimi-subscription', { sources: [{ url: 'https://k.example' }], truncated: false })
  let modelProvider = 'packycode'
  const auto = createPackyCodeAutoSearchProvider({
    packycode,
    resolveModelProvider: () => modelProvider,
    resolveProvider: id => (id === fallback.id ? fallback : undefined),
    resolveFallbackId: () => 'kimi-subscription',
  })
  assert.equal(auto.id, PACKYCODE_AUTO_SEARCH_PROVIDER_ID)
  assert.equal((await auto.search({ query: 'one' })).sources[0].url, 'https://p.example')
  modelProvider = 'anthropic'
  assert.equal((await auto.search({ query: 'two' })).sources[0].url, 'https://k.example')
  assert.deepEqual(packycode.seen, ['one'])
  assert.deepEqual(fallback.seen, ['two'])
})

test('auto search never falls back to itself, and a router that loops back reaches DSH search', async () => {
  const packycode = stubProvider(PACKYCODE_SEARCH_PROVIDER_ID, { sources: [], truncated: false })
  const dsh = stubProvider('deepseek-official', { sources: [{ url: 'https://d.example' }], truncated: false })
  const providers = new Map([[dsh.id, dsh]])
  let auto
  // A foreign router whose own fallback is the web row's base — this plugin.
  const router = stubProvider('kimi-subscription-auto', request => auto.search(request))
  providers.set(router.id, router)
  let fallbackId = PACKYCODE_AUTO_SEARCH_PROVIDER_ID
  auto = createPackyCodeAutoSearchProvider({
    packycode,
    resolveModelProvider: () => 'anthropic',
    resolveProvider: id => providers.get(id),
    resolveFallbackId: () => fallbackId,
  })
  assert.equal((await auto.search({ query: 'self' })).sources[0].url, 'https://d.example')
  fallbackId = 'kimi-subscription-auto'
  assert.equal((await auto.search({ query: 'loop' })).sources[0].url, 'https://d.example')
  assert.deepEqual(router.seen, ['loop'])
  assert.deepEqual(dsh.seen, ['self', 'loop'])

  fallbackId = 'missing-provider'
  await assert.rejects(auto.search({ query: 'x' }), error => error.code === 'WEB_PROVIDER_UNAVAILABLE' && /missing-provider/u.test(error.message))
})
