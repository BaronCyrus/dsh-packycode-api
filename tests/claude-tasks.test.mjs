import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeTaskNode, nativeTaskChange } from '../src/claude-tasks.js'
import { assembler, HOST_VERSIONS } from './image-conversation-fixture.mjs'

const change = (name, input, output, text = '', list = 'native-session') => nativeTaskChange(name, input, output, text, list, s => s)
const result = (seq, meta, isError = false) => ({ type: 'event', event: { seq, type: 'tool/result', data: {
  meta, message: { role: 'tool', source: { kind: 'tool', callId: `call-${seq}` }, content: [], isError },
} } })

for (const version of HOST_VERSIONS) test(`Claude tasks on DSH ${version} merge by native session and survive reopening the view`, () => {
  const runtime = assembler(version, true, claudeTaskNode)
  runtime.activateTarget('chat')
  const created = change('TaskCreate', { subject: 'Write tests' }, { task: { id: '5', subject: 'Write tests' } })
  const completed = change('TaskUpdate', { taskId: '5', status: 'completed' }, { success: true })
  const events = [
    result(1, created), result(2, completed, true), result(3, completed),
    result(4, change('TaskCreate', {}, undefined, 'Task #5 created successfully: Other work', 'other')),
  ]
  const cards = () => {
    runtime.flush()
    const snapshot = runtime.snapshot('chat')
    return [...snapshot.order].map(key => snapshot.nodes.get(key)).filter(node => node.visibility === 'visible').map(node => node.data.tasks)
  }
  for (const event of events.slice(0, 2)) runtime.append(event)
  assert.equal(cards()[0][0].status, 'pending')
  for (const event of events.slice(2)) runtime.append(event)
  const expected = [[{ id: '5', subject: 'Write tests', status: 'completed' }], [{ id: '5', subject: 'Other work', status: 'pending' }]]
  assert.deepEqual(cards(), expected)
  runtime.replaceWindow(structuredClone(events), false)
  assert.deepEqual(cards(), expected)
  runtime.append(result(5, change('TaskUpdate', { taskId: '5', status: 'deleted' }, { success: true })))
  assert.deepEqual(cards(), expected.slice(1))
})

test('native task snapshots are authoritative and incomplete outputs leave the previous state intact', () => {
  const tasks = [{ id: '1', subject: 'Verify', status: 'in_progress' }]
  assert.deepEqual(change('TaskList', {}, { tasks }).tasks, tasks)
  assert.deepEqual(change('TaskList', {}, { tasks: [] }).tasks, [])
  assert.equal(change('TaskList', {}, { tasks: [{}] }), undefined)
  assert.equal(change('TaskUpdate', { taskId: '1', status: 'completed' }, { success: false }), undefined)
  assert.equal(change('TaskUpdate', { taskId: '1', status: 'completed' }, undefined, 'Updated task #2 status'), undefined)
  assert.deepEqual(change('TodoWrite', { todos: [{ content: 'Verify', status: 'in_progress' }] }, undefined).tasks, tasks)
})
