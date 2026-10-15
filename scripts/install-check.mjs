#!/usr/bin/env node
/**
 * Installed-state check for a dsh profile: why a plugin row can be missing
 * from DSH even though the package is installed and listed.
 *
 * A plugin package installed from a registry has no `node_modules` of its own,
 * so the host resolves every peer it imports — `@deepseek-ai/dsh-*`,
 * `@deepseek-ai/schemastery`, `@earendil-works/pi-ai` — out of the running
 * installation. A *local path* install (`file:`, or a bare directory) instead
 * copies the working tree, `node_modules` included, into the profile. That
 * copied tree sits inside the profile directory, which is exactly where DSH's
 * profile resolution looks first, so the plugin silently loads the old copies
 * again: an older `schemastery` has no `Schema.volatile()`, the plugin module
 * throws while it is being imported, the Loader never creates its fiber, and
 * the settings section, the model route, and the RPC channel never appear.
 * The failure reaches only the host log, so this script reconstructs it from
 * the profile on disk.
 *
 * It only reads. Run it from the repository root:
 *
 *   node scripts/install-check.mjs [--profile desktop] [--home ~/.dsh] [--json]
 *
 * Exit codes: 0 when nothing shadows the installation, 1 when something does,
 * 2 for a usage error.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package scopes the host supplies to a profile bundle; a local copy shadows them. */
const HOST_SCOPES = ['@deepseek-ai/', '@earendil-works/']

/** The `Schema.volatile()` release every DSH 0.2 preference write depends on. */
const VOLATILE_SINCE = '3.18.4'

/** The patch-file marker an uninstalled plugin can leave behind. */
const SEARCH_PATCH_MARKER = 'dsh-packycode-api: web search provider'

const USAGE = 'usage: node scripts/install-check.mjs [--profile <name>] [--home <dir>] [--json]'

/** Read the command line; unknown or incomplete arguments are usage errors. */
function parseArgs(argv) {
  const options = { profile: 'desktop', home: process.env.DSH_HOME || join(homedir(), '.dsh'), json: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument !== '--profile' && argument !== '--home') throw new Error(`unknown argument ${JSON.stringify(argument)}\n${USAGE}`)
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value\n${USAGE}`)
    if (argument === '--profile') {
      if (value === '' || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value === 'node_modules') {
        throw new Error(`invalid profile name ${JSON.stringify(value)}`)
      }
      options.profile = value
    } else options.home = resolve(value)
  }
  return options
}

/** Parse a package.json, or throw with the path that could not be read. */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
}

/**
 * Resolve a package the way DSH's own bundle resolution does: probe Node's
 * require paths from the profile manifest, so a `link:` target and a copied
 * directory are both classified by where they really live.
 */
function resolvePackageDir(profileDir, name) {
  let searchPaths
  try {
    searchPaths = createRequire(join(profileDir, 'package.json')).resolve.paths(name) ?? []
  } catch {
    return undefined
  }
  for (const searchPath of searchPaths) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** Whether `child` is `parent` or below it, comparing real paths. */
function isInside(parent, child) {
  const canonicalParent = `${realpathSync(parent)}${sep}`
  const canonicalChild = realpathSync(child)
  return `${canonicalChild}${sep}`.startsWith(canonicalParent)
}

/**
 * The host packages a package's own `node_modules` would shadow. A registry
 * install has no such directory; a copied local tree has the whole closure.
 */
function shadowedHostPackages(packageDir) {
  const nested = join(packageDir, 'node_modules')
  if (!existsSync(nested) || !statSync(nested).isDirectory()) return undefined
  const packages = []
  for (const scope of HOST_SCOPES) {
    const scopeDir = join(nested, scope)
    if (!existsSync(scopeDir) || !statSync(scopeDir).isDirectory()) continue
    for (const entry of readdirSync(scopeDir).sort()) {
      const manifestPath = join(scopeDir, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = readManifest(manifestPath)
        packages.push({ name: `${scope}${entry}`, version: typeof manifest.version === 'string' ? manifest.version : 'unknown' })
      } catch {
        packages.push({ name: `${scope}${entry}`, version: 'unreadable' })
      }
    }
  }
  return { path: nested, packages }
}

/** Compare two dotted numeric versions; build metadata and prereleases are ignored. */
function compareVersions(left, right) {
  const parts = value => String(value).split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/** Whether the plugin's row is selected as a bundle, which is what mounts it. */
function rowSelected(manifest, packageName) {
  return Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(packageName)
}

/** Everything this script reports, as plain data so `--json` is a rename away. */
function inspect(options) {
  const dir = join(options.home, 'profiles', options.profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`no profile manifest at ${manifestPath}`)
  const manifest = readManifest(manifestPath)
  const findings = []
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    const packageDir = resolvePackageDir(dir, name)
    if (packageDir === undefined) {
      findings.push({ level: 'error', kind: 'missing', package: name, detail: `installed as a dependency but not resolvable from ${dir}` })
      continue
    }
    if (!isInside(dir, packageDir)) continue // a link: install resolves outside the profile; DSH intercepts its peers
    const shadowed = shadowedHostPackages(packageDir)
    if (shadowed === undefined) continue
    if (shadowed.packages.length === 0) {
      findings.push({ level: 'note', kind: 'nested-modules', package: name, detail: `${shadowed.path} exists but carries no host package` })
      continue
    }
    findings.push({ level: 'error', kind: 'shadowed', package: name, detail: shadowed.path, shadowed: shadowed.packages })
  }
  const patchPath = join(dir, 'cordis.patch.yml')
  if (existsSync(patchPath) && readFileSync(patchPath, 'utf8').includes(SEARCH_PATCH_MARKER) && resolvePackageDir(dir, 'dsh-packycode-api') === undefined) {
    findings.push({ level: 'error', kind: 'dangling-search-patch', detail: `${patchPath} still points web search at a removed backend` })
  }
  if (resolvePackageDir(dir, 'dsh-packycode-api') !== undefined && !rowSelected(manifest, 'dsh-packycode-api')) {
    findings.push({ level: 'error', kind: 'not-selected', package: 'dsh-packycode-api', detail: 'installed but absent from dsh.profile.bundles, so nothing mounts it' })
  }
  return { home: options.home, profile: options.profile, dir, findings }
}

/** The one sentence that explains the failure this script exists for. */
function shadowSentence(finding) {
  const schemastery = finding.shadowed.find(item => item.name === '@deepseek-ai/schemastery')
  if (schemastery === undefined) {
    return `its imports resolve to these old copies instead of the DSH installation's own packages`
  }
  if (compareVersions(schemastery.version, VOLATILE_SINCE) < 0) {
    return `its imports resolve to @deepseek-ai/schemastery ${schemastery.version}, which has no Schema.volatile(); the plugin module throws while it is imported, so DSH never creates its fiber and Settings shows no PackyCode section`
  }
  return `its imports resolve to @deepseek-ai/schemastery ${schemastery.version} instead of the DSH installation's own packages`
}

/** Render the report for a terminal. */
function render(report) {
  const lines = [`profile: ${report.dir}`]
  const errors = report.findings.filter(finding => finding.level === 'error')
  for (const finding of report.findings) {
    if (finding.kind === 'shadowed') {
      lines.push(`  [${finding.level}] ${finding.package} carries its own node_modules`)
      lines.push(`         ${finding.detail}`)
      lines.push(`         ${shadowSentence(finding)}`)
      lines.push(`         host packages found there: ${finding.shadowed.map(item => `${item.name}@${item.version}`).join(', ')}`)
    } else if (finding.package !== undefined) {
      lines.push(`  [${finding.level}] ${finding.package}: ${finding.detail}`)
    } else {
      lines.push(`  [${finding.level}] ${finding.detail}`)
    }
  }
  if (errors.length === 0) {
    lines.push('  no shadowing dependency tree found; an absent PackyCode section has another cause')
    return `${lines.join('\n')}\n`
  }
  lines.push('')
  lines.push('Recovery for a shadowing tree (DSH itself reports this only in the host log):')
  lines.push('  1. Uninstall dsh-packycode-api on the Plugins page, then install it again.')
  lines.push('     Uninstall runs `pnpm remove`, which deletes the package directory; installing')
  lines.push('     over an existing one only rewrites its files and leaves the old tree in place.')
  lines.push('  2. Quit and reopen the desktop app. Reloading the page does not reload the Host.')
  lines.push('  Or delete the directory printed above and restart DSH.')
  return `${lines.join('\n')}\n`
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
    return
  }
  let report
  try {
    report = inspect(options)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
    return
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : render(report))
  process.exitCode = report.findings.some(finding => finding.level === 'error') ? 1 : 0
}

/** Whether this file was started as the program rather than imported by a test. */
function invokedDirectly() {
  const argument = process.argv[1]
  if (argument === undefined) return false
  try {
    return realpathSync(argument) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) await main()

export { compareVersions, inspect, render, shadowedHostPackages }
