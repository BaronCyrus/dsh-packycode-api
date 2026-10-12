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
- Add or update tests under `tests/` for behavior changes.

## Required validation

```sh
pnpm install
pnpm run check
```

`pnpm run check` must run every test, rebuild both bundles, and produce the versioned tarball in `.artifacts/`.

Live gateway behavior is verified with `node scripts/live-check.mjs` after a build. It consumes a small amount of quota; run it when a change touches the catalog, the provider composition, or the failure classification. Do not claim runtime success from a passing build alone.

## Release authorization

`npm publish`, Git tags, GitHub Releases, and version publication are externally visible and partially irreversible. Execute them only when the user explicitly asks and confirms the version. Never reuse or move a published version or tag; publish a new patch version instead.
