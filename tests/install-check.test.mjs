import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compareVersions, inspect, render, shadowedHostPackages } from '../scripts/install-check.mjs'

/** Build a throwaway DSH home with one profile manifest and one package inside it. */
async function profileFixture(t, { manifest, packageManifest = { name: 'dsh-packycode-api', version: '1.1.8' }, nested = {}, link = false, install = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'packycode-install-check-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'profiles', 'desktop')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  if (link) {
    // A link: install resolves to a directory outside the profile, where DSH intercepts peers.
    const target = join(home, 'checkout', 'dsh-packycode-api')
    await mkdir(join(target, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify(packageManifest))
    await writeFile(join(target, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '3.18.2' }))
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink(target, join(dir, 'node_modules', 'dsh-packycode-api'), 'dir')
    return { home, dir, target }
  }
  if (!install) return { home, dir }
  const installed = join(dir, 'node_modules', 'dsh-packycode-api')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify(packageManifest))
  for (const [name, version] of Object.entries(nested)) {
    const packageDir = join(installed, 'node_modules', ...name.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version }))
  }
  return { home, dir, installed }
}

const MANAGED = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: { 'dsh-packycode-api': '^1.1.8' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-packycode-api'] } },
}

test('compareVersions orders release numbers and ignores prerelease tags', () => {
  assert.equal(compareVersions('3.18.2', '3.18.4'), -1)
  assert.equal(compareVersions('3.18.4', '3.18.4-rc.1'), 0)
  assert.equal(compareVersions('4.0.0', '3.18.4'), 1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.1.5-rc.2'), 1)
})

test('a registry-style install with no nested dependencies reports nothing', async t => {
  const { home } = await profileFixture(t, { manifest: MANAGED })
  const report = inspect({ home, profile: 'desktop' })
  assert.deepEqual(report.findings, [])
  assert.match(render(report), /no shadowing dependency tree found/)
})

test('a shadowed schemastery below the volatile release is named as the cause', async t => {
  const { home, installed } = await profileFixture(t, {
    manifest: MANAGED,
    nested: { '@deepseek-ai/schemastery': '3.18.2', '@deepseek-ai/dsh-llm': '0.1.5-rc.2', '@earendil-works/pi-ai': '0.85.1' },
  })
  const report = inspect({ home, profile: 'desktop' })
  assert.equal(report.findings.length, 1)
  const [finding] = report.findings
  assert.equal(finding.level, 'error')
  assert.equal(finding.kind, 'shadowed')
  assert.equal(finding.detail, join(installed, 'node_modules'))
  assert.deepEqual(finding.shadowed, [
    { name: '@deepseek-ai/dsh-llm', version: '0.1.5-rc.2' },
    { name: '@deepseek-ai/schemastery', version: '3.18.2' },
    { name: '@earendil-works/pi-ai', version: '0.85.1' },
  ])
  const text = render(report)
  assert.match(text, /schemastery 3\.18\.2, which has no Schema\.volatile\(\)/)
  assert.match(text, /Uninstall dsh-packycode-api on the Plugins page/)
  assert.match(text, /Quit and reopen the desktop app/)
})

test('a shadowing tree at or above the volatile release still reports the shadow', async t => {
  const { home } = await profileFixture(t, { manifest: MANAGED, nested: { '@deepseek-ai/schemastery': '3.18.4' } })
  const report = inspect({ home, profile: 'desktop' })
  assert.equal(report.findings[0].kind, 'shadowed')
  assert.match(render(report), /instead of the DSH installation's own packages/)
})

test('a link: install resolving outside the profile is left alone', async t => {
  const { home } = await profileFixture(t, { manifest: MANAGED, link: true })
  assert.deepEqual(inspect({ home, profile: 'desktop' }).findings, [])
})

test('an installed package missing from the bundle list is reported', async t => {
  const { home } = await profileFixture(t, { manifest: { ...MANAGED, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } } })
  const [finding] = inspect({ home, profile: 'desktop' }).findings
  assert.equal(finding.kind, 'not-selected')
  assert.match(render(inspect({ home, profile: 'desktop' })), /absent from dsh\.profile\.bundles/)
})

test('a search patch pointing at an uninstalled backend is reported', async t => {
  const { home, dir } = await profileFixture(t, { manifest: { ...MANAGED, dependencies: {} }, install: false })
  await writeFile(join(dir, 'cordis.patch.yml'), '# dsh-packycode-api: web search provider\n[]\n')
  const [finding] = inspect({ home, profile: 'desktop' }).findings
  assert.equal(finding.kind, 'dangling-search-patch')
})

test('a nested node_modules without host packages stays a note', async t => {
  const { home } = await profileFixture(t, { manifest: MANAGED, nested: { 'left-pad': '1.0.0' } })
  const [finding] = inspect({ home, profile: 'desktop' }).findings
  assert.equal(finding.level, 'note')
  assert.equal(finding.kind, 'nested-modules')
  assert.equal(shadowedHostPackages(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-packycode-api')).packages.length, 0)
})

test('an unreadable profile manifest is a usage error, not a finding', async t => {
  const home = await mkdtemp(join(tmpdir(), 'packycode-install-check-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  assert.throws(() => inspect({ home, profile: 'desktop' }), /no profile manifest/)
})
