import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

import { parseReleaseNotes, readReleaseNotes } from '../scripts/release-notes.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
const NOT_ON_DISPATCH = "github.event_name != 'workflow_dispatch'"
const workflow = () => parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'))
const NOTES = '# v1.2.9：修复清空全部 Key 报错\n\n修复说明。\n\n在 DSH 插件管理中更新至 **1.2.9**，然后重新打开 DSH 加载新版。\n'

test('every release notes file names its own version and tells readers to update to it', () => {
  const files = readdirSync(new URL('../docs/releases/', import.meta.url)).filter(name => name.endsWith('.md'))
  assert.ok(files.length > 0)
  for (const name of files) {
    const version = /^v(\d+\.\d+\.\d+)\.md$/u.exec(name)?.[1]
    assert.ok(version, `${name}: notes are named v<version>.md`)
    const { title, body } = readReleaseNotes(version)
    assert.match(title, new RegExp(`^v${version.replaceAll('.', '\\.')}：\\S`, 'u'), name)
    assert.ok(body.includes(`**${version}**`), name)
  }
})

test('the version in package.json has its GitHub Release notes before it can be tagged', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.doesNotThrow(() => readReleaseNotes(version), `write docs/releases/v${version}.md`)
})

test('notes split into the release title and body', () => {
  assert.deepEqual(parseReleaseNotes(NOTES, '1.2.9'), {
    title: 'v1.2.9：修复清空全部 Key 报错',
    body: '修复说明。\n\n在 DSH 插件管理中更新至 **1.2.9**，然后重新打开 DSH 加载新版。\n',
  })
  assert.equal(parseReleaseNotes(NOTES.replaceAll('\n', '\r\n'), '1.2.9').title, 'v1.2.9：修复清空全部 Key 报错')
})

test('malformed or mismatched notes are refused with the reason', () => {
  const cases = [
    [NOTES.replace('# v1.2.9：', '# v1.2.9: '), /must start with "# v1\.2\.9：<title>"/u],
    [NOTES.replace('# v1.2.9：修复清空全部 Key 报错', '# v1.2.9：'), /must start with/u],
    [NOTES.replace('# v1.2.9：', '# v1.2.8：'), /titled v1\.2\.8, not v1\.2\.9/u],
    ['# v1.2.9：标题\n\n   \n', /have no body/u],
    [NOTES.replace('**1.2.9**', '**1.2.8**'), /update to \*\*1\.2\.9\*\*/u],
    ['修复说明。', /must start with/u],
  ]
  for (const [text, reason] of cases) assert.throws(() => parseReleaseNotes(text, '1.2.9'), reason)
  assert.throws(() => parseReleaseNotes(NOTES, 'v1.2.9'), /plain version/u)
  assert.throws(() => readReleaseNotes('0.0.0'), /docs\/releases\/v0\.0\.0\.md is missing/u)
})

test('the script prints the title, writes the body, and exits 1 on missing notes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'packy-release-notes-'))
  try {
    const bodyFile = join(directory, 'body.md')
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const title = execFileSync(process.execPath, [SCRIPT, version, '--body-file', bodyFile], { encoding: 'utf8' })
    const notes = readReleaseNotes(version)
    assert.equal(title, `${notes.title}\n`)
    assert.equal(readFileSync(bodyFile, 'utf8'), notes.body)
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, '0.0.0'], { stdio: 'pipe' }), error => error.status === 1 && /is missing/u.test(String(error.stderr)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the tag checks its notes before npm publishes, then hands the published tarball on', () => {
  const steps = workflow().jobs.publish.steps
  const at = name => steps.findIndex(step => step.name === name)
  const notes = steps[at('Refuse a tag without its GitHub Release notes')]
  assert.ok(notes, 'the publish job refuses a tag without notes')
  assert.equal(notes.if, NOT_ON_DISPATCH)
  assert.match(notes.run, /node scripts\/release-notes\.mjs "\$\{GITHUB_REF_NAME#v\}"/u)
  assert.ok(at('Refuse a tag without its GitHub Release notes') < at('Publish'), 'notes are checked before npm publishes')
  const handOff = steps[at('Hand the published tarball to the release job')]
  assert.ok(at('Publish') < at('Hand the published tarball to the release job'), 'only a published tarball is handed on')
  assert.equal(handOff.if, NOT_ON_DISPATCH)
  assert.equal(handOff.uses, 'actions/upload-artifact@v4')
  assert.equal(handOff.with.path, '.artifacts/dsh-packycode-api-*.tgz')
  // v1.2.10's run published to npm, then found no tarball here: the action
  // skips files under a dot directory such as .artifacts by default.
  assert.equal(handOff.with['include-hidden-files'], true)
  assert.equal(handOff.with['if-no-files-found'], 'error')
})

test('only the release job may write, and it runs no dependency code', () => {
  const { permissions, jobs } = workflow()
  assert.deepEqual(permissions, { 'id-token': 'write', contents: 'read' }, 'the publish job keeps read-only contents')
  assert.equal(jobs.publish.permissions, undefined)
  const release = jobs.release
  assert.equal(release.needs, 'publish')
  assert.equal(release.if, NOT_ON_DISPATCH, 'workflow_dispatch never creates a release')
  assert.deepEqual(release.permissions, { contents: 'write' })
  assert.deepEqual(release.steps.filter(step => step.uses).map(step => step.uses), ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/download-artifact@v4'])
  assert.equal(release.steps[0].with['persist-credentials'], false)
  assert.equal(release.steps[2].with.name, jobs.publish.steps.find(step => step.name === 'Hand the published tarball to the release job').with.name)
  for (const step of release.steps.filter(step => step.run)) {
    assert.doesNotMatch(step.run, /\bpnpm\b|\bnpm (?:install|ci|exec)\b|\bnpx\b/u, `${step.name}: no dependency code runs with a write token`)
  }
  const create = release.steps.find(step => step.name === 'Create the release with the tarball npm published')
  assert.equal(create.env.GH_TOKEN, '${{ github.token }}')
  assert.match(create.run, /artifact="\.artifacts\/dsh-packycode-api-\$\{version:\?\}\.tgz"/u)
  assert.match(create.run, /title="\$\(node scripts\/release-notes\.mjs "\$version" --body-file "\$notes"\)"/u)
  assert.match(create.run, /gh release create "\$GITHUB_REF_NAME" "\$artifact" --verify-tag --title "\$title" --notes-file "\$notes"/u)
  assert.match(create.run, /if gh release view "\$GITHUB_REF_NAME"/u, 'a release made by hand is left unchanged')
})

test('nothing in the workflow switches npm from OIDC to token auth', () => {
  const text = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
  const { jobs } = workflow()
  for (const job of Object.values(jobs)) {
    for (const step of job.steps) {
      assert.equal(step.with?.['registry-url'], undefined, `${step.name ?? step.uses}: setup-node registry-url means token auth`)
      assert.equal(step.env?.NODE_AUTH_TOKEN, undefined)
    }
  }
  assert.doesNotMatch(text, /NODE_AUTH_TOKEN:/u)
})
