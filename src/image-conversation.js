/** Project this plugin's durable image results into chat without duplicating context. */
export const IMAGE_CHAT_KIND = 'packycode-image-output'
const IMAGE_TOOLS = new Set(['packycode_image_generate', 'claude_code'])
const hasImage = content => Array.isArray(content) && content.some(part => part.type === 'image' && part.attachment)

function successfulImages(event) {
  if (event?.type === 'tool/result' && event.data?.meta?.kind === 'packycode-image') {
    return (event.data.message?.content ?? []).filter(block => block.type === 'tool-result' && !block.isError
      && hasImage(block.content)).map(block => ({ ...block, meta: event.data.meta }))
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
  // A view projection of real assistant image blocks, never a logged fake
  // tool invocation. Replay/ownership uses the durable assistant reference.
  return (event.data.message.content ?? []).flatMap((block, index) => block.type === 'image' && block.attachment
    ? [{ type: 'tool-result', toolCallId: `packycode-cli-image-${event.seq}-${index}`, content: [block] }] : [])
}

export const imageConversationNode = {
  kind: IMAGE_CHAT_KIND,
  target: 'chat',
  match(event) {
    return event.type === 'turn/end' || successfulImages(event).length > 0
      ? { id: String(event.data.turn), role: 'update' } : null
  },
  start: () => undefined,
  update: context => context.state,
  buildViewNode(context) {
    const finished = context.matches.find(match => match.event.type === 'turn/end')
    if (finished === undefined) return null
    const results = context.matches.filter(match => successfulImages(match.event).length > 0)
    if (results.length === 0) return null
    const blocks = [...new Map(results.flatMap(({ event }) => successfulImages(event)
      .map(block => [block.toolCallId, { ...block, kind: 'tool-result' }]))).values()]
    const answerSeq = finished.location.turn?.steps?.at(-1)?.data.get('assistant-step')?.finalNode?.seq
    const lastImageSeq = Math.max(...results.map(match => match.event.seq))
    return {
      key: context.key, id: context.id, kind: IMAGE_CHAT_KIND, target: 'chat',
      // DSH 0.2 groups custom Turn/Step nodes as process content, even when
      // anchored after the answer. This Session-level gallery stays in the
      // main flow; its durable evidence/turn and numeric placement are retained.
      location: { kind: 'session' }, visibility: 'visible',
      anchorSeq: answerSeq > lastImageSeq ? answerSeq + 0.025 : finished.event.seq - 0.025,
      data: { turn: finished.event.data.turn, blocks },
    }
  },
}
