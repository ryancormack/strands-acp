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
