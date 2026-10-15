/** Project this plugin's durable image results into chat without duplicating context. */
export const IMAGE_CHAT_KIND = 'packycode-image-output'

const successfulImages = event => event?.type === 'tool/result' && event.data?.meta?.kind === 'packycode-image'
  ? (event.data.message?.content ?? []).filter(block => block.type === 'tool-result' && !block.isError
    && block.content?.some(part => part.type === 'image' && part.attachment))
  : []

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
    const blocks = results.flatMap(({ event }) => successfulImages(event).map(block => ({ ...block, kind: 'tool-result', meta: event.data.meta })))
    const answerSeq = finished.location.turn?.steps?.at(-1)?.data.get('assistant-step')?.finalNode?.seq
    const lastImageSeq = Math.max(...results.map(match => match.event.seq))
    return {
      key: context.key, id: context.id, kind: IMAGE_CHAT_KIND, target: 'chat',
      location: finished.location, visibility: 'visible',
      anchorSeq: answerSeq > lastImageSeq ? answerSeq + 0.025 : finished.event.seq - 0.025,
      data: { blocks },
    }
  },
}
