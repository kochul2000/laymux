# Task Completion Checklist

When completing a task, ensure the following:

1. **Tests**: Run relevant tests (TDD is mandatory)
   - `cd ui && npx vitest run` (frontend unit)
   - `cd src-tauri && cargo test` (Rust unit)
   - Add e2e tests for new features involving compile errors from new fields

2. **Lint & Format**:
   - `cd ui && npx eslint . && npx prettier --check .`
   - `cd src-tauri && cargo fmt --check && cargo clippy`

3. **Build check**: `cd ui && tsc && vite build` (frontend compiles)

4. **UI changes**: Use `/screenshot` skill to verify visual result

5. **Architecture sync**: If changes diverge from ARCHITECTURE.md, discuss with user and update it

6. **Automation API**: When adding features, consider API extension and autonomous verification loop
