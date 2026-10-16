/** Observe terminal Anthropic SSE frames without rewriting any response bytes. */
export function createClaudeTerminalDetector() {
  const decoder = new TextDecoder()
  let line = '', event = '', data = '', overflow = false, dataOverflow = false, skipLf = false
  const consume = () => {
    if (overflow) { overflow = false; dataOverflow = true; line = ''; return }
    const value = line
    line = ''
    if (value === '') {
      let terminal
      if (event === 'error') terminal = 'error'
      else if (event === 'message_stop' && !dataOverflow) {
        try { if (JSON.parse(data).type === 'message_stop') terminal = 'message_stop' } catch { /* Let the provider report malformed frames. */ }
      }
      event = ''; data = ''; dataOverflow = false
      return terminal
    }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /u, '')
    if (field === 'event') event = content
    else if (field === 'data' && !dataOverflow) {
      if (data.length + content.length > 4096) { data = ''; dataOverflow = true }
      else data += `${data ? '\n' : ''}${content}`
    }
  }
  return chunk => {
    for (const character of decoder.decode(chunk, { stream: true })) {
      if (character === '\n' && skipLf) { skipLf = false; continue }
      skipLf = character === '\r'
      if (character === '\n' || character === '\r') {
        const terminal = consume()
        if (terminal) return terminal
      } else if (!overflow) {
        if (line.length >= 65536) { line = ''; overflow = true }
        else line += character
      }
    }
  }
}

/**
 * message_stop completes the Messages protocol; transport EOF may arrive late.
 * Forward the terminal frame, then close and cancel the upstream reader. Error
 * frames remain visible to the provider. This never retries an accepted stream.
 */
export function finishClaudeStream(response, signal) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response
  const reader = response.body.getReader()
  const terminal = createClaudeTerminalDetector()
  let finished = false, abort, pendingCr = false
  const dispose = (cancel, reason) => {
    signal?.removeEventListener('abort', abort)
    const release = () => { try { reader.releaseLock() } catch { /* A pending read is settling after cancellation. */ } }
    if (cancel) void reader.cancel(reason).catch(() => {}).finally(release)
    else release()
  }
  const body = new ReadableStream({
    start(controller) {
      abort = () => {
        if (finished) return
        finished = true
        controller.error(signal.reason ?? new DOMException('Request aborted', 'AbortError'))
        dispose(true, signal.reason)
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    },
    async pull(controller) {
      if (finished) return
      try {
        for (;;) {
          const item = await reader.read()
          if (finished) return
          if (item.done) {
            if (pendingCr) controller.enqueue(Uint8Array.of(13))
            finished = true; controller.close(); dispose(false)
            return
          }
          const end = terminal(item.value)
          // The provider's line parser treats a trailing CR as a full delimiter.
          // Keep a split CRLF in one chunk without changing a single wire byte.
          let chunk = item.value
          if (pendingCr) { const joined = new Uint8Array(chunk.length + 1); joined[0] = 13; joined.set(chunk, 1); chunk = joined }
          pendingCr = !end && chunk.at(-1) === 13
          if (pendingCr) chunk = chunk.subarray(0, -1)
          if (chunk.length) controller.enqueue(chunk)
          if (end) { finished = true; controller.close(); dispose(true) }
          if (chunk.length || finished) return
        }
      } catch (error) {
        if (!finished) { finished = true; controller.error(error); dispose(true, error) }
      }
    },
    cancel(reason) { finished = true; dispose(true, reason) },
  })
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  Object.defineProperty(wrapped, 'url', { value: response.url })
  return wrapped
}
