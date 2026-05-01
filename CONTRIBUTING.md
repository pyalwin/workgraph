# Contributing to WorkGraph

**Contributions are very welcome.** WorkGraph is open source under MIT and built to be hacked on.

## How to contribute

1. **Fork** the repo and create a feature branch (`git checkout -b feat/your-feature`).
2. **Build something.** Add a connector, fix a bug, improve the UI, write docs.
3. **Commit** with a clear message (the project follows conventional-ish prefixes like `feat:`, `fix:`, `docs:`, `chore:`).
4. **Open a pull request** against `main`. Describe what changed and why.

## Good first issues

- Adding a new connector — implement the adapter contract in [`src/lib/connectors/types.ts`](src/lib/connectors/types.ts).
- Improving chunking strategies for long documents.
- Adding tests (the project is currently test-light by design — help us change that).
- UI polish in any module.

## Code style

- TypeScript everywhere, strict mode.
- Prefer small, focused functions over deep abstractions.
- Server logic in `src/lib/`, UI in `src/components/` and `src/app/`.
- Run `next lint` before pushing.

## Reporting bugs

Open an [issue](https://github.com/pyalwin/workgraph/issues/new) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (Node/Bun version, OS)
