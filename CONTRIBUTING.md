# Contributing

Thanks for contributing to `@ryancormack/strands-acp`.

## Prerequisites

- Node.js >= 22
- pnpm 10

## Getting started

```bash
pnpm install
pnpm build   # tsc
pnpm test    # vitest run
```

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change. Add or update tests to cover it.
3. Run `pnpm build` and `pnpm test` locally before opening a PR.
4. Open a PR against `main` and fill in the template.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org).
The commit messages that land on `main` drive automated releases, so the prefix
matters:

- `fix:` — a bug fix (bumps the patch version)
- `feat:` — a new feature (bumps the minor version)
- `feat!:` or a `BREAKING CHANGE:` footer — a breaking change (bumps the major version)
- `docs:`, `chore:`, `refactor:`, `test:`, `ci:` — no release on their own

PRs are squash-merged, so the PR title becomes the commit on `main` — write the
PR title as a Conventional Commit.

## Releases

Releases are automated with
[Release Please](https://github.com/googleapis/release-please). You do not tag
or publish by hand:

1. Merging Conventional Commits to `main` makes Release Please open (and keep
   updating) a **Release PR** that bumps the version in `package.json`, updates
   `CHANGELOG.md`, and previews the notes.
2. When the release is ready, merge the Release PR. Release Please then cuts the
   git tag and the GitHub Release.
3. The published GitHub Release triggers `publish.yml`, which publishes to npm
   with provenance.

### Beta / prerelease versions

If the version has a `-beta.N` suffix, `publish.yml` publishes it to the npm
`beta` dist-tag instead of `latest`, so `npm install @ryancormack/strands-acp`
keeps getting the stable line while `npm install @ryancormack/strands-acp@beta`
gets the prerelease.

### Re-publishing a release

If a publish run fails, fix the cause on `main` and run the **Publish to NPM**
workflow manually (Actions tab, or `gh workflow run publish.yml -f tag=v0.1.0`)
with the existing release tag.

### Future: a v2 line on its own branch

When work on a new major version starts, it can be tracked on a dedicated branch
(e.g. `v2`) with its own Release Please config set to `"prerelease": true`,
cutting `2.0.0-beta.N` releases independently while `main` keeps shipping the
1.x line. The current setup tracks only the stable line on `main`; the v2 branch
flow is documented here for when that time comes but is not wired yet.

## What happens on your PR

Every PR runs the same checks, and all of them must pass before it can merge:

- **CI** builds with `tsc` and runs the test suite on Node 22 and 24.
- **CodeQL** scans the code for security issues.
- **Dependency review** flags any vulnerable or license-problematic dependency changes.

`main` is protected: a PR needs one approving review and an up-to-date branch
with all checks green. The maintainer is requested automatically. If your PR is
your first contribution, a maintainer approves the workflow runs before they
start.

## Reporting bugs and requesting features

Open an issue describing the problem or the proposal. For a bug, include the
Strands and ACP SDK versions and a minimal reproduction if you can.
