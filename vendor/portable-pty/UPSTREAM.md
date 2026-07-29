# Upstream provenance

This directory is a minimal in-repository fork of `portable-pty` 0.8.1 from
the WezTerm repository.

- Upstream repository: <https://github.com/wezterm/wezterm>
- Upstream commit: `4afedd626dadd15d9c2929bab0e2063b54f61393`
- Path in upstream: `pty/`
- crates.io package: `portable-pty-0.8.1.crate`
- crates.io SHA-256: `806ee80c2a03dbe1a9fb9534f8d19e4c0546b790cde8fd1fea9d6390644cb0be`

The checked-in `Cargo.toml` is Cargo's crates.io-normalized manifest so the
fork does not acquire WezTerm workspace sibling dependencies. `Cargo.toml.orig`
is retained byte-for-byte for provenance. The normalized product manifest
removes the upstream example-only `smol` and `futures` development dependencies
because examples are not vendored or distributed; this packaging-only change
prevents unrelated lockfile churn. It also adds the `winapi` features needed
by the Windows interruptible-reader seam and declares the legacy no-op
`cargo-clippy` feature already referenced by upstream source so current Cargo
check-cfg validation does not warn.

Laymux changes are limited to the generation-aware interruptible reader/event
seam, its Windows ConPTY and Unix PTY implementations, and their tests. Spawn,
resize, writer, child, pseudo-console, and side-loading behavior are unchanged.
Exact output provenance is explicitly outside this fork and tracked by laymux
issue #643.

The native seam is enabled only on the product's supported Windows and Linux
targets. Other Unix targets retain the upstream reader and return unsupported
for the new optional seam; this avoids pretending that Linux `pipe2` semantics
were audited on BSD/macOS.

## Maintenance and upstream exit

The laymux maintainers own this fork. Before each laymux release that changes
PTY behavior, and whenever WezTerm publishes a `portable-pty` release, security
advisory, or Windows ConPTY/I/O correctness fix, they compare upstream changes
from this pinned commit and either update the fork with recorded provenance or
document why the change does not apply. In particular, changes around
`ReadFile`, `CancelSynchronousIo`, thread-handle access, pseudo-console teardown,
Unix `poll`, and wake descriptor ownership are security/correctness review
triggers rather than routine dependency bumps.

The path fork is removed when upstream offers an equivalent generation-scoped,
interruptible reader API with the Windows two-stage cancel acknowledgement and
Linux wake-descriptor ownership required by ADR-0089. The upstream proposal and
fork-removal workstream is tracked in
[laymux #657](https://github.com/kochul2000/laymux/issues/657). Exact output
provenance remains outside this fork's contract and is separately tracked in
[laymux #643](https://github.com/kochul2000/laymux/issues/643).
