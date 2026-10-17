import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parse } from 'yaml'

import { compareVersions, decidePromotion, PROMOTE_AFTER_MS } from '../scripts/promote-release.mjs'

const HOUR = 3_600_000
const PUBLISHED = Date.parse('2026-10-17T05:00:00.000Z')
const registry = (distTags, published = PUBLISHED) => ({ distTags, time: { '1.3.3': new Date(published).toISOString() } })

test('latest waits past pnpm\'s 24-hour release-age window, with an hour to spare', () => {
  assert.equal(PROMOTE_AFTER_MS, 25 * HOUR)
  const tags = { latest: '1.3.2', next: '1.3.3' }
  assert.match(decidePromotion(registry(tags), PUBLISHED + 24 * HOUR).skip, /1\.3\.3 is 24\.0h old; it may become latest after 2026-10-18T06:00:00\.000Z/u)
  assert.deepEqual(decidePromotion(registry(tags), PUBLISHED + 25 * HOUR), { version: '1.3.3' })
})

test('only a newer next version is promoted', () => {
  const later = PUBLISHED + 30 * HOUR
  assert.deepEqual(decidePromotion(registry({ latest: '1.3.2' }), later), { skip: 'no next tag' })
  assert.match(decidePromotion(registry({ latest: '1.3.3', next: '1.3.3' }), later).skip, /not newer/u)
  assert.match(decidePromotion(registry({ latest: '1.4.0', next: '1.3.3' }), later).skip, /not newer/u)
  assert.match(decidePromotion(registry({ latest: '1.3.2', next: '1.3.3-rc.1' }), later).skip, /not a plain version/u)
  assert.match(decidePromotion({ distTags: { latest: '1.3.2', next: '1.3.3' }, time: {} }, later).skip, /has a publish time/u)
})

test('releases faster than the window still reach latest, one matured version at a time', () => {
  const T = PUBLISHED
  const time = {
    created: new Date(T - 100 * HOUR).toISOString(),
    '1.3.2': new Date(T - 50 * HOUR).toISOString(),
    '1.3.3': new Date(T).toISOString(),
    '1.3.4': new Date(T + 10 * HOUR).toISOString(),
    '1.3.5': new Date(T + 20 * HOUR).toISOString(),
    '1.3.6-rc.1': new Date(T - 40 * HOUR).toISOString(),
  }
  const registry = latest => ({ distTags: { latest, next: '1.3.5' }, time, versions: Object.keys(time).filter(key => key !== 'created') })
  // `next` keeps moving, yet each release is promoted once it alone has aged 25 hours.
  assert.match(decidePromotion(registry('1.3.2'), T + 24 * HOUR).skip, /^1\.3\.3 is 24\.0h old/u)
  assert.deepEqual(decidePromotion(registry('1.3.2'), T + 26 * HOUR), { version: '1.3.3' })
  assert.deepEqual(decidePromotion(registry('1.3.3'), T + 36 * HOUR), { version: '1.3.4' })
  // The newest matured version wins when the job was down for a while.
  assert.deepEqual(decidePromotion(registry('1.3.2'), T + 46 * HOUR), { version: '1.3.5' })
  // A deprecated release is held back; a newer good one goes when it matures.
  const held = { ...registry('1.3.3'), deprecated: ['1.3.4'] }
  assert.match(decidePromotion(held, T + 36 * HOUR).skip, /^1\.3\.5 is 16\.0h old/u)
  assert.deepEqual(decidePromotion(held, T + 46 * HOUR), { version: '1.3.5' })
  // A version npm no longer serves is never promoted.
  assert.match(decidePromotion({ ...registry('1.3.2'), versions: ['1.3.2'] }, T + 46 * HOUR).skip, /no undeprecated version/u)
})

test('versions order numerically, not as text', () => {
  assert.equal(compareVersions('1.3.10', '1.3.9'), 1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('1.3.2', '1.3.3'), -1)
  assert.equal(compareVersions('1.3', '1.3.3'), undefined)
})

test('a tag publishes to next, and only the promote job ever moves latest', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'))
  const steps = job => workflow.jobs[job].steps.map(step => step.run ?? '').join('\n')
  assert.match(steps('publish'), /npm publish "\$\{artifact:\?\}" --access public --tag next/u)
  assert.doesNotMatch(steps('publish'), /dist-tag/u)
  assert.match(steps('release'), /gh release create .*--latest=false/u)
  assert.equal(workflow.jobs.release.if, "github.event_name == 'push'")

  // Hourly, or by hand with `promote`; never on a tag push.
  assert.ok(workflow.on.schedule.length > 0)
  assert.equal(workflow.on.workflow_dispatch.inputs.promote.type, 'boolean')
  assert.match(workflow.jobs.promote.if, /schedule/u)
  assert.doesNotMatch(workflow.jobs.promote.if, /push/u)
  assert.doesNotMatch(workflow.jobs.publish.if, /schedule/u)

  // The promote job moves one tag through the script and runs no dependency code.
  assert.match(steps('promote'), /node scripts\/promote-release\.mjs/u)
  assert.match(steps('promote'), /unset NODE_AUTH_TOKEN/u)
  assert.doesNotMatch(steps('promote'), /pnpm install|npm ci|npm install(?! -g npm@)/u)
  assert.equal(workflow.jobs.promote.permissions, undefined, 'it keeps the workflow\'s id-token write and read-only contents')
  assert.equal(JSON.stringify(workflow.jobs.promote).includes('registry-url'), false)

  // Only the job that marks the GitHub Release may write to the repository.
  assert.deepEqual(workflow.jobs['mark-latest'].permissions, { contents: 'write' })
  assert.equal(workflow.jobs['mark-latest'].needs, 'promote')
  assert.match(steps('mark-latest'), /gh release edit "v\$\{VERSION:\?\}" --latest/u)
  assert.deepEqual(workflow.permissions, { 'id-token': 'write', contents: 'read' })
})
