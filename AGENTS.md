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

6. Confirm the package has a GitHub Actions trusted publisher before pushing the tag: repository `BaronCyrus/dsh-packycode-api`, workflow filename `publish.yml`, environment empty, with **Allow npm dist-tag** enabled so the promote job can move `latest`. Never request that a token, password, or one-time code be pasted into chat.

7. Create the annotated tag and push it. That push publishes to npm's `next` dist-tag with GitHub OIDC. The workflow's `release` job then creates the GitHub Release from `docs/releases/v<version>.md`, attaches the tarball npm published, and leaves it without the Latest mark. `latest` moves later: the hourly `promote` job runs `scripts/promote-release.mjs`, which moves `latest` to the `next` version once that version is 25 hours old, and `mark-latest` then marks its GitHub Release Latest. pnpm refuses versions younger than 24 hours, and the update buttons already installed (up to 1.3.2) bypass that refusal, so `latest` must never name a younger version; never move it by hand earlier. `release` and `mark-latest` are the only jobs with `contents: write`, and neither runs dependency code. Do not run `npm publish` locally for a release. A local publish cannot attach provenance. Do not set `NODE_AUTH_TOKEN` or a setup-node `registry-url` in the publish workflow; npm treats either as token auth and skips OIDC.

   ```sh
   git tag -a v<version> -m "dsh-packycode-api v<version>"
   git push origin v<version>
   ```

   `workflow_dispatch` on the same workflow prints the OIDC identity npm will match and does not publish. With `promote` checked, it runs the promote job instead, which still waits out the 25 hours.

8. Confirm that both jobs of the tag's publish run succeeded. Then check that npm's `next` serves the version (`npm view dsh-packycode-api dist-tags --prefer-online`; without `--prefer-online` a cached 404 can linger) and that `gh release view v<version>` shows the notes and the `dsh-packycode-api-<version>.tgz` asset. On an OIDC `package not found` error, fix the trusted publisher and re-run the same workflow. Do not move the tag. If the tagged tree itself must change, publish a new patch version.

   The release reaches the update button only when `latest` moves. About 25–26 hours after publishing, confirm that a scheduled `promote` run moved `latest` and that `gh release list --json tagName,isLatest` marks the version Latest. If the promote job fails on the dist-tag, enable **Allow npm dist-tag** on the trusted publisher and run the workflow with `promote`. If no run happened, check that the scheduled workflow is enabled (GitHub disables schedules in a repository without activity for 60 days).

   If npm published but the release job failed, re-run only that failed job. If the Release must be made by hand, attach the tarball npm serves, not a local `.artifacts` build: CI packs its own, so the local bytes differ. Fetch it with `npm pack dsh-packycode-api@<version>`, and compare its SHA-512 with the registry's `dist.integrity`. Then run `gh release create v<version> <tarball> --verify-tag --title "<the notes' title>" --notes-file <the notes' body>`. The release job leaves an existing Release unchanged.
