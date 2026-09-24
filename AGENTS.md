# Contributor notes

- Run `pnpm lint`, `pnpm build`, and `pnpm test` before finishing changes. `pnpm format` applies formatting.
- TypeScript 7 builds the project. TypeScript 6 is installed under the `typescript` name for typescript-eslint's compiler API.
- Tests should use fixtures and must not connect to a real Actual server or TypeSafe account. The repository's `.env` may contain live credentials.
- Keep the `README.md` focused on end-user documentation. Keep it concise, useful, skimmable.
- `AGENTS.md` should contain essential contributor knowledge that cannot be easily inferred.
- Keep future plans and to-dos in `TODO.md`.
