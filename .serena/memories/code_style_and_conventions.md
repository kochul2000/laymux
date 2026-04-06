# Code Style & Conventions

## TypeScript/React (Frontend)
- **Prettier**: semi=true, singleQuote=false, trailingComma=all, printWidth=100, tabWidth=2
- **ESLint**: typescript-eslint recommended + react-hooks + react-refresh
- **Unused vars**: `_` prefix allowed (argsIgnorePattern/varsIgnorePattern)
- **Styling**: Tailwind CSS utilities (layout) + CSS variables (theme values) hybrid
- **CSS variables**: All common values in `index.css` `:root`. No hardcoded magic numbers.
- **No `color-mix()`**: Breaks html2canvas screenshots. Use predefined CSS vars like `var(--accent-50)`.
- **Hover**: Use CSS hover classes (`.hover-bg`), not `onMouseEnter/Leave` style manipulation.
- **Shared components**: `components/ui/` — extract when 3+ places repeat same pattern.
- **State management**: Zustand stores in `stores/` directory.

## Rust (Backend)
- **Edition**: 2021
- **Format**: rustfmt (edition = "2021" in rustfmt.toml)
- **Error handling**: `AppError` enum, no `unwrap()` in production code. Use `?` or `unwrap_or_default()`.
- **Locks**: `MutexExt::lock_or_err()`, follow documented lock ordering in `state.rs`.
- **Constants**: All magic strings in `constants.rs`. Events, env vars, timeouts, buffer sizes.
- **Serde**: `#[serde(rename_all = "camelCase")]` for frontend exchange types.
- **Logging**: `tracing` macros, not `eprintln!()`.
- **Process execution**: `crate::process::headless_command()`, not `std::process::Command::new()`.
- **Tauri commands**: Thin entry points → core logic in `&AppState`-accepting internal functions.
- **Module structure**: File >500 lines → consider splitting. `mod.rs` = `pub use` hub only.
- **Naming**: snake_case (modules/fns), PascalCase (structs/enums), SCREAMING_SNAKE_CASE (constants).

## General
- TDD approach for all development.
- OSC processing is Rust-only (no OSC parsing in frontend).
- CWD is centrally managed in `terminalStore`, never spawn background shells for CWD info.
