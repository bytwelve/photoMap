# Contributing

[简体中文](CONTRIBUTING.md) · **English**

Thanks for your interest in PhotoMap. This is a privacy-first, offline Windows desktop application, and every contribution has to preserve that premise: **no network requests, telemetry or cloud dependencies; scanning and annotation never write into the source media folder; rename and recycle-bin operations must be triggered explicitly by the user.**

The Chinese documents are canonical. Where a translation and the Chinese text disagree, the Chinese text prevails; translations may lag behind by a release. Documents that have no English version yet are marked below.

## Development environment

Required versions, dependency installation and how to run the app are in the [development guide](docs/DEVELOPMENT.md#环境) (Chinese).

## Before you submit

Run at least the following for every change:

```powershell
npm run check
```

This runs strict type checking, ESLint (including the four-layer boundary rules), the knip unused-code check, the full Vitest suite, the complete license-input check and the document link check.

Changes touching any of the following should additionally run the full gate `pwsh -NoProfile -File .\scripts\verify-local.ps1 -Gate all` on the exact toolchain:

- Windows packaging, the Squirrel installer, portable mode
- File system operations (rename, recycle bin, scan, path policy)
- Custom protocols (`photomap-media:` / `photomap-asset:`)
- Data location, settings storage, SQLite schema
- Privacy boundaries (EXIF / GPS handling, diagnostic log contents)

## Code conventions

- TypeScript strict mode. The main / preload / renderer / shared boundaries are described in the [development guide](./docs/DEVELOPMENT.md) (Chinese) and enforced by `npm run lint`, not by review alone.
- All communication between the renderer and the main process must go through the typed contracts in `src/shared/contracts.ts` and the validation in `src/shared/schemas.ts`.
- New features need tests: pure logic in `tests/unit/`, anything touching SQLite or the file system in `tests/integration/`.
- Never write full paths, tag contents, raw EXIF or coordinates into diagnostic logs, error messages or test snapshots.
- Prefix commit messages with `feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:`. Chinese or English are both fine.

## Pull requests

1. Fork and branch from the repository's default branch. New repositories use `main`; CI also accepts copies that still use `master`.
2. Keep each pull request focused on a single purpose; separate refactoring from features.
3. In the description, say what changed, why, how you verified it, and whether it affects the privacy or file-safety boundaries.
4. Wait for maintainer review once CI's static checks, dependency audit and packaged launch acceptance have passed.

## Reporting problems

- Use the issue templates for bugs and feature requests.
- **Do not report security problems publicly.** Follow [`SECURITY.md`](./SECURITY.md) for private reporting.
- Do not attach real personal photos, screenshots containing location information, or full local paths to issues.

## Documentation and assets

- When you change file locations, commands or headings, update the README, the user guide and the affected links, then run `npm run docs:check` to verify local links and section anchors. Keep the README's concept illustration and its real screenshots clearly distinguished.
- Regenerate screenshots with the repository's synthetic photos; the procedure is in the [development guide](./docs/DEVELOPMENT.md#文档与截图) (Chinese). Register new assets in [ASSETS.md](./ASSETS.md) with their source, license and any generation record, and state honestly where a record is missing.
- Changing the map data version requires verifying the upstream terms, updating the manifest and the administrative-region catalog, and running the full map regression. Do not simply relax the hash check, and do not commit GeoJSON you downloaded yourself.
- When you change a Chinese document that has an `.en.md` counterpart, update the translation in the same pull request where you can. If you cannot, say so in the description so it can be picked up separately — a stale translation is worse than an openly missing one.

## License

By contributing you agree to license your contribution under this project's [MIT License](./LICENSE).
