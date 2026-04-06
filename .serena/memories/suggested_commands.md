# Suggested Commands

## Development
```bash
# Frontend dev server
cd ui && npm run dev

# Tauri dev (full app with hot reload)
cargo tauri dev

# Tauri build (release)
cargo tauri build
```

## Testing
```bash
# Frontend unit tests
cd ui && npx vitest run

# Frontend unit tests (watch mode)
cd ui && npx vitest

# Frontend e2e tests (Playwright)
cd ui && npx playwright test

# Rust unit tests
cd src-tauri && cargo test

# Rust specific test
cd src-tauri && cargo test <test_name>
```

## Linting & Formatting
```bash
# Frontend lint
cd ui && npx eslint .

# Frontend lint fix
cd ui && npx eslint . --fix

# Frontend format check
cd ui && npx prettier --check .

# Frontend format
cd ui && npx prettier --write .

# Rust format
rustfmt src-tauri/src/**/*.rs
# or
cd src-tauri && cargo fmt

# Rust clippy
cd src-tauri && cargo clippy
```

## Pre-commit (lint-staged)
- `ui/**/*.{ts,tsx}` → prettier + eslint --fix
- `ui/**/*.{json,css,md}` → prettier
- `**/*.rs` → rustfmt

## Dev Instance Management
```bash
# Kill dev instance safely (NEVER manually grep PIDs)
bash scripts/kill-dev.sh
```

## Utility Commands (Windows/bash)
```bash
git status / git log / git diff
ls / cat / head / tail
grep -r "pattern" path/
```
