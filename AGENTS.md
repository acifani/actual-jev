# Contributor notes

- Run `pnpm format`, `pnpm lint`, `pnpm build`, and `pnpm test` before finishing the work the codebase. Not needed on documentation changes.
- TypeScript 7 builds the project. TypeScript 6 is installed under the `typescript` name for typescript-eslint's compiler API.
- Tests should use fixtures and must not connect to a real Actual server or TypeSafe account. The repository's `.env` may contain live credentials.
- Keep the `README.md` focused on current end-user behavior and actions. Keep it concise, useful, skimmable. Remove sentences that do not help readers understand or decide what to do.
- `AGENTS.md` should contain essential contributor knowledge that cannot be easily inferred.
- Keep future plans and to-dos in `TODO.md`.
- Actual API documentation: https://actualbudget.org/docs/api/reference
