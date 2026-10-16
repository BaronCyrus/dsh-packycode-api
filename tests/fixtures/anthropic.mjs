/** Anthropic SSE fixture parsed by the real SDK; no provider methods are mocked. */
export function anthropicStream(model, block = { type: 'text', text: 'ok' }) {
  const tool = block.type === 'tool_use'
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
  const events = [
    ['message_start', { message }],
    ['content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', {}],
  ]
  return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
