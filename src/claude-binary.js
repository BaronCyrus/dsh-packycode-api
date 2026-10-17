/**
 * Finding and starting the official Claude Code CLI.
 *
 * Keys in PackyCode's `cc` group are served only to the official client, so
 * their Claude requests are sent by the real CLI binary on this device. These
 * helpers locate it the way the user's shell would and turn an npm launcher
 * into something `spawn` can start without a shell.
 *
 * @module dsh-packycode-api/claude-binary
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { nvmBinDirs, pathFor, searchPath } from './locate.js'

/** The npm package the official CLI ships as. */
export const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code'

/** Isolated CLI home; the plugin owns the endpoint and key it runs with. */
export const DEFAULT_CLAUDE_CONFIG_DIR = join(homedir(), '.dsh', 'packycode-claude-cli')

/** What a request reports when no CLI could be started at all. */
export const CLAUDE_MISSING_MESSAGE = '本机没有可用的 Claude Code CLI，而当前 Key 的 Claude 分组只接受官方 CLI 发出的请求。'
  + '请在 设置 → PackyCode → Claude Code CLI 安装，或在终端运行 npm install -g @anthropic-ai/claude-code，然后重发。'
  + ' / Claude Code CLI is not installed on this device, and this key\'s Claude group only serves the official CLI. Install it under Settings → PackyCode, or run: npm install -g @anthropic-ai/claude-code'

/** The CLI's file names on PATH: the native installer ships an `.exe`, npm a `.cmd` launcher. */
export const claudeFileNames = platform => (platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'])

/**
 * Where the official installer, npm, and the common Node managers put the CLI,
 * in the order they are tried. PATH is searched after these.
 * @param options - platform, home directory, environment, and a directory reader.
 * @returns absolute candidate paths.
 */
export function claudeBinaryCandidates({ platform = process.platform, home = homedir(), env = process.env, readdir } = {}) {
  const path = pathFor(platform)
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      ...(env.NVM_SYMLINK ? [path.join(env.NVM_SYMLINK, 'claude.cmd')] : []),
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'claude.cmd'),
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    ...nvmBinDirs({ home, env, platform, readdir }).map(directory => path.join(directory, 'claude')),
  ]
}

/**
 * Locate an installed Claude Code CLI.
 * @param options - a configured path (wins when it exists), plus platform,
 *   home, environment, and file-system seams.
 * @returns an absolute path, or undefined when none is installed.
 */
export function locateClaudeBinary({ explicit, platform = process.platform, home = homedir(), env = process.env, exists = existsSync, readdir } = {}) {
  const configured = typeof explicit === 'string' ? explicit.trim() : ''
  if (configured !== '') {
    if (pathFor(platform).isAbsolute(configured)) return exists(configured) ? configured : undefined
    const names = platform === 'win32' && !/\.[a-z]+$/iu.test(configured) ? [`${configured}.exe`, `${configured}.cmd`] : [configured]
    return searchPath(names, { platform, env, exists })
  }
  for (const candidate of claudeBinaryCandidates({ platform, home, env, readdir })) {
    if (exists(candidate)) return candidate
  }
  return searchPath(claudeFileNames(platform), { platform, env, exists })
}

/** The program an npm `.cmd` launcher runs, relative to the launcher's own directory. */
const SHIM_TARGET = /"%(?:~dp0|dp0%)\\([^"%]+?\.(?:c?js|mjs|exe))"/giu

/**
 * Turn a located CLI into something `spawn` can start without a shell.
 *
 * On Windows npm installs `claude.cmd`, and Node refuses to start a `.cmd`
 * without `shell: true` — which would hand arguments to `cmd.exe` to parse.
 * The launcher only forwards to a program beside it, so that program is
 * started directly instead: `node <cli.js>` or the packaged `.exe`.
 * @param binary - the located CLI.
 * @param options - platform and file-system seams.
 * @returns the command and the arguments that precede the CLI's own.
 */
export function resolveSpawnCommand(binary, { platform = process.platform, exists = existsSync, readFile = file => readFileSync(file, 'utf8') } = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(binary)) return { command: binary, args: [] }
  const path = pathFor(platform)
  const directory = path.dirname(binary)
  let relative
  try {
    relative = [...readFile(binary).matchAll(SHIM_TARGET)]
      .map(match => match[1])
      .find(target => !/^node\.exe$/iu.test(target))
  } catch {
    // Unreadable launcher; fall back to npm's standard layout below.
  }
  const target = relative === undefined
    ? path.join(directory, 'node_modules', ...CLAUDE_NPM_PACKAGE.split('/'), 'cli.js')
    : path.join(directory, relative)
  if (!exists(target)) {
    throw new Error(`Claude Code CLI launcher ${binary} points at a missing program; reinstall it with npm install -g ${CLAUDE_NPM_PACKAGE}`)
  }
  if (/\.exe$/iu.test(target)) return { command: target, args: [] }
  const bundledNode = path.join(directory, 'node.exe')
  return { command: exists(bundledNode) ? bundledNode : 'node', args: [target] }
}
