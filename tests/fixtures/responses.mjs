/** OpenAI Responses SSE fixture parsed by pi-ai's real OpenAI SDK path; no provider methods are mocked. */

/** A completed assistant message item. */
export const messageItem = (text, id = 'msg_fixture') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })

/**
 * A reasoning item as PackyCode returns it for DeepSeek: the text in
 * `reasoning_text` content, no summary, and a reference in `encrypted_content`.
 */
export const reasoningItem = (text, id = 'rs_fixture') => ({ type: 'reasoning', id, status: 'completed', summary: [], content: [{ type: 'reasoning_text', text }], encrypted_content: 'resp_fixture-0' })

/** A completed function call item. */
export const functionCallItem = (name, args, callId = 'call_fixture') => ({ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' })

/**
 * Stream `output` the way the gateway does: each item added, its deltas, and
 * its final form, then `response.completed`.
 */
export function responsesStream(output = [messageItem('ok')]) {
  const events = [{ type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } }]
  output.forEach((item, index) => {
    if (item.type === 'reasoning') {
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', content: [] } })
      for (const part of item.content) events.push({ type: 'response.reasoning_text.delta', output_index: index, content_index: 0, item_id: item.id, delta: part.text })
    } else if (item.type === 'message') {
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', content: [] } })
      events.push({ type: 'response.content_part.added', output_index: index, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } })
      events.push({ type: 'response.output_text.delta', output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text })
    } else if (item.type === 'function_call') {
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', arguments: '' } })
      events.push({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: item.arguments })
      events.push({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments })
    }
    events.push({ type: 'response.output_item.done', output_index: index, item })
  })
  events.push({ type: 'response.completed', response: { id: 'resp_fixture', object: 'response', status: 'completed', output, usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } })
  return new Response(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
