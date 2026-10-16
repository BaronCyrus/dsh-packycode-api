/** Project this plugin's durable image results into chat without duplicating context. */
export const IMAGE_CHAT_KIND = 'packycode-image-output'
// Legacy claude_code records remain readable; no CLI tool is registered or run.
const IMAGE_TOOLS = new Set(['packycode_image_generate', 'claude_code'])
const hasImage = content => Array.isArray(content) && content.some(part => part.type === 'image' && part.attachment)

function successfulImages(event) {
  if (event?.type === 'tool/result' && event.data?.meta?.kind === 'packycode-image') {
    const message = event.data.message
    const toolCallId = message?.source?.callId
    if (message?.source?.kind !== 'tool' || typeof toolCallId !== 'string' || toolCallId === ''
      || message.isError === true || !hasImage(message.content)) return []
    // DSH persists a ToolMessage with image/text parts directly in content.
    // The tool-result wrapper belongs to the view/SDK, not the stored event.
    return [{ type: 'tool-result', toolCallId, content: message.content, isError: false, meta: event.data.meta }]
  }
  // PTC logs the settled child output under its own event, without the root
  // tool's presentationMeta. The tool-detail panel already reads this record.
  if (event?.type === 'tool/ptc-dispatch' && IMAGE_TOOLS.has(event.data?.name)
    && event.data.isError === false && typeof event.data.subCallId === 'string' && hasImage(event.data.content)) {
    return [{ type: 'tool-result', toolCallId: event.data.subCallId, content: event.data.content, meta: { kind: 'packycode-image' } }]
  }
  const source = event?.data?.message?.source
  if (event?.type !== 'assistant/message' || source?.kind !== 'model' || source.provider !== 'packycode'
    || !/^claude-/u.test(source.model ?? '')) return []
  // Older CLI-backed sessions saved assistant image blocks. Keep their view
  // projection and stable IDs readable, never create a logged fake
  // tool invocation. Replay/ownership uses the durable assistant reference.
  return (event.data.message.content ?? []).flatMap((block, index) => block.type === 'image' && block.attachment
    ? [{ type: 'tool-result', toolCallId: `packycode-cli-image-${event.seq}-${index}`, content: [block] }] : [])
}

export const imageConversationNode = {
  kind: IMAGE_CHAT_KIND,
  target: 'chat',
  match(event) {
    const images = successfulImages(event)
    if (images.length === 0) return null
    // Tool output records do not carry data.turn. Keep each call's evidence
    // together; the engine supplies its Turn/Step Location at materialization.
    const id = event.type === 'assistant/message' ? `cli:${event.seq}`
      : event.data?.subCallId ?? event.data?.message?.source?.callId ?? images[0].toolCallId ?? `event:${event.seq}`
    return { id: String(id), role: 'update' }
  },
  start: () => ({}),
  update: context => context.state ?? {},
  buildViewNode(context) {
    const results = context.matches.filter(match => successfulImages(match.event).length > 0)
    if (results.length === 0) return null
    const location = results.find(match => match.location?.kind === 'turn' || match.location?.kind === 'step')?.location
    const turn = location?.turn
    // Show paid successes immediately. History can acquire its opening/closing
    // boundaries later; refining Location must never withdraw an existing card.
    const finished = turn?.end
    const blocks = [...new Map(results.flatMap(({ event }) => successfulImages(event)
      .map(block => [block.toolCallId, { ...block, kind: 'tool-result' }]))).values()]
    const answerSeq = turn?.steps?.at(-1)?.data.get('assistant-step')?.finalNode?.seq
    const lastImageSeq = Math.max(...results.map(match => match.event.seq))
    return {
      key: context.key, id: context.id, kind: IMAGE_CHAT_KIND, target: 'chat',
      // DSH 0.2 groups custom Turn/Step nodes as process content, even when
      // anchored after the answer. This Session-level gallery stays in the
      // main flow; its durable evidence/turn and numeric placement are retained.
      location: { kind: 'session' }, visibility: 'visible',
      anchorSeq: answerSeq > lastImageSeq ? answerSeq + 0.025 : finished === undefined ? lastImageSeq + 0.025 : finished.seq - 0.025,
      data: { ...(turn === undefined ? {} : { turn: turn.turn }), blocks },
    }
  },
}
