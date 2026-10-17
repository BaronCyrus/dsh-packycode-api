# Repository agent guide

This file governs the entire `dsh-packycode-api` repository.

## Repository identity

- Canonical repository: `https://github.com/BaronCyrus/dsh-packycode-api`
- npm package: `dsh-packycode-api`
- DSH plugin row: `packycode-api`
- Model group display name: `PackyCode`
- LLM provider route key: `packycode`

## Project boundaries

- This is a permanent DSH profile plugin, not a temporary dynamic Cordis Plugin.
- Host code belongs in `src/index.js` and its sibling modules; browser UI belongs in `src/client.jsx` and is built through the client wrapper in `tsdown.config.mjs`.
- The route is self-contained: the plugin builds its own pi-ai provider, catalog, key ring, and balance reader. It must never require the user to edit `cordis.patch.yml` or `llm-pi-ai` provider YAML.
- Never introduce a silent fallback to another provider, another credential source, or an ambient `PACKY_CODE_API_KEY`. Only keys the user added through this plugin may authenticate a request.
- Claude requests on keys in the `cc` group go through the official Claude Code CLI (`src/claude-cli-*.js`, `src/claude-mcp-bridge.js`); every other key uses HTTP. The CLI is only a transport: it must keep all of its own tools disabled, receive DSH's tools through the MCP bridge, and leave execution, permissions and plan mode to DSH. Never let it read the user's Claude settings, login or ambient keys, and never fall back between the CLI and HTTP routes on a failure. Changing the CLI's flags, environment or the continuation logic requires `node scripts/claude-check.mjs --transport cli` with a `cc` key.
- The catalog declares protocols and effort levels from vendor documentation. Changing a model's `api`, `baseUrl`, or `thinkingLevelMap` requires a note in `CHANGELOG.md` and a live check.
- The in-plugin update installs under the profile's own pnpm release-age policy. Never pass `--config.minimumReleaseAge` or edit `minimumReleaseAgeExclude` from the plugin. Bypassing the policy leaves a lockfile entry pnpm later rejects, and pnpm then refuses every plugin install in that profile until the version is 24 hours old. pnpm records an exact version it accepts early itself; a version it holds back is reported as pending.

## Security requirements

- Never print, log, commit, return to the browser, or include in diagnostics any API key. `scripts/live-check.mjs` may read the stored key but must only ever print its masked tail.
- Credentials and balance requests stay host-side. Browser RPC returns only the projections in `src/rpc.js`.
- Balance requests stay bounded by a timeout and configured with `redirect: 'error'`.
- Preserve unrelated DSH plugins, profiles, sessions, settings, and credentials.
- Do not start, stop, or restart DSH without explicit user permission.

## Source and generated files

- Edit `src/`; never hand-edit generated `lib/index.js` or `lib/client.js`.
- `lib/` is tracked and must be regenerated with `pnpm run build` after source changes.
- `.artifacts/` and `node_modules/` are ignored and must never be committed.
- `docs/releases/v<version>.md` holds each version's GitHub Release notes. It is tracked and not packaged.
- Add or update tests under `tests/` for behavior changes.

## Required validation

```sh
pnpm install
pnpm run check
```

`pnpm run check` must run every test, rebuild both bundles, and produce the versioned tarball in `.artifacts/`.

Live gateway behavior is verified with `node scripts/live-check.mjs` after a build. It consumes a small amount of quota; run it when a change touches the catalog, the provider composition, or the failure classification. Do not claim runtime success from a passing build alone.

## Release authorization

`npm publish`, Git tags, GitHub Releases, and version publication are externally visible and partially irreversible. Execute them only when the user explicitly asks to publish or release and confirms the target version. A request to modify, test, or commit alone is not release authorization.

Never reuse, move, delete, or overwrite a published npm version or Git tag. If a published version needs a correction, create a new patch version.

## Release cadence

Tags publish straight to npm's `latest` again, since 2026-10-17 after 1.3.4 (checklist step 7). Read this before iterating on new versions:

- `latest` is what the in-plugin update button and DSH's Plugins page install. From 1.3.3 on, the button keeps pnpm's 24-hour release-age policy, and pnpm records an exact version it accepts early itself. Update buttons up to 1.3.2 still bypass the policy: updating with one of them to a version younger than 24 hours leaves the profile refusing every plugin install, including the next update, until that version is 24 hours old. Both READMEs tell those users to install the exact version on the Plugins page instead.
- Keep at least 24 hours between releases while users remain on 1.3.2 or earlier. A profile blocked that way refuses even the fixed button's next update, and pnpm still relinks `node_modules` ahead of `package.json` and the lockfile (pnpm 11.28.5, 2026-10-17). Before tagging, check the previous release's publish time with `npm view dsh-packycode-api time --json --prefer-online`. Drop this rule only when the maintainer says most users run 1.3.3 or later.
- 1.3.3 and 1.3.4 were published to `next` before this change. Until `latest` names 1.3.4 or newer, the hourly `promote` job (`scripts/promote-release.mjs`) moves `latest` to each once it is 25 hours old, and `mark-latest` marks its GitHub Release Latest. Never move `latest` by hand. Once `latest` is 1.3.4 or newer, remove the schedule, the `promote` input, both jobs, the script and its tests.
- A broken release reaches `latest` at once: deprecate it on npm and publish a fixed patch version.

## Release checklist

1. Synchronize and confirm a clean base:

   ```sh
   git fetch origin --tags --prune
   git status --short --branch
   git log --oneline HEAD..origin/main
   ```

   Fast-forward clean remote changes before editing. Never discard remote changes.

2. Confirm the requested SemVer is unused:

   ```sh
   npm view dsh-packycode-api@<version> version --json
   git ls-remote --exit-code --tags origin refs/tags/v<version>
   ```

   For an unused npm version, `npm view` normally returns `E404`. An existing npm version or Git tag requires choosing a new version.

3. Update all release metadata together: `package.json` version, `CHANGELOG.md`, any version pinned in `README.md` / `README.en.md`, and the GitHub Release notes in `docs/releases/v<version>.md`. The notes are in Chinese, like every earlier release:
   - The first line is `# v<version>：<短标题>`, which becomes the release title.
   - Then a one-sentence summary and bullets with bold labels.
   - Then a `验证：…` paragraph.
   - They close with `在 DSH 插件管理中更新至 **<version>**，然后重新打开 DSH 加载新版。`

   `node scripts/release-notes.mjs <version>` checks the file, and `pnpm run check` fails while the current `package.json` version has no valid notes.

4. Validate and inspect the exact release artifact:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run check
   npm publish .artifacts/dsh-packycode-api-<version>.tgz --access public --dry-run --json
   ```

5. Commit the release and push `main` without force. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) must already be on the commit that will be tagged. Do not push the tag in this step.

6. Confirm the package has a GitHub Actions trusted publisher before pushing the tag: repository `BaronCyrus/dsh-packycode-api`, workflow filename `publish.yml`, environment empty. Keep **Allow npm dist-tag** enabled while the promote job remains (Release cadence). Never request that a token, password, or one-time code be pasted into chat.

7. Create the annotated tag and push it, once the previous release is at least 24 hours old while that rule applies (Release cadence). That push publishes to npm's `latest` with GitHub OIDC. The workflow's `release` job then creates the GitHub Release from `docs/releases/v<version>.md`, attaches the tarball npm published, and marks it Latest. `release` and `mark-latest` are the only jobs with `contents: write`, and neither runs dependency code. Do not run `npm publish` locally for a release. A local publish cannot attach provenance. Do not set `NODE_AUTH_TOKEN` or a setup-node `registry-url` in the publish workflow; npm treats either as token auth and skips OIDC.

   ```sh
   git tag -a v<version> -m "dsh-packycode-api v<version>"
   git push origin v<version>
   ```

   `workflow_dispatch` on the same workflow prints the OIDC identity npm will match and does not publish. With `promote` checked, it runs the promote job instead, which still waits out the 25 hours.

8. Confirm that both jobs of the tag's publish run succeeded. Then check that npm's `latest` serves the version (`npm view dsh-packycode-api dist-tags --prefer-online`; without `--prefer-online` a cached 404 can linger, and for a few minutes after a publish the tarball URL itself can answer a CDN-cached 404, so check it with a `?t=<now>` query) and that `gh release view v<version>` shows the notes and the `dsh-packycode-api-<version>.tgz` asset, with `gh release list --json tagName,isLatest` marking it Latest. On an OIDC `package not found` error, fix the trusted publisher and re-run the same workflow. Do not move the tag. If the tagged tree itself must change, publish a new patch version.

   While the promote job still finishes 1.3.3 and 1.3.4 (Release cadence), confirm that scheduled `promote` runs moved `latest` to them and marked their Releases Latest. If the promote job fails on the dist-tag, enable **Allow npm dist-tag** on the trusted publisher and run the workflow with `promote`. If no run happened, check that the scheduled workflow is enabled (GitHub disables schedules in a repository without activity for 60 days).

   If npm published but the release job failed, re-run only that failed job. If the Release must be made by hand, attach the tarball npm serves, not a local `.artifacts` build: CI packs its own, so the local bytes differ. Fetch it with `npm pack dsh-packycode-api@<version>`, and compare its SHA-512 with the registry's `dist.integrity`. Then run `gh release create v<version> <tarball> --verify-tag --title "<the notes' title>" --notes-file <the notes' body>`. The release job leaves an existing Release unchanged.
