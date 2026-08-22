# Technical Debt Register

This register separates release blockers from compatibility debt and known
runtime limitations. A debt item is not considered closed because a unit test
exists; it needs a real entrypoint and platform evidence where applicable.

| ID | Area | Severity | Current state | Closure evidence |
| --- | --- | --- | --- | --- |
| TD-001 | Windows managed command invocation | Closed in this worktree | `.cmd`/`.bat` commands run through `cmd.exe`; Doctor and repair pass on Windows | Windows Doctor + repair smoke |
| TD-002 | Electron native rebuild scope | Closed in this worktree | Rebuild uses `--only better-sqlite3,node-pty,sharp` | Windows ABI rebuild + Doctor |
| TD-003 | Installer build metadata | Closed in this worktree | `@types/node`, `.ico`, NSIS and MSI inputs are present | NSIS and MSI build |
| TD-004 | Legacy launchers | Compatibility debt | Multiple BAT/VBS entries still bypass managed Doctor | Keep until migration/shortcut policy is formally changed |
| TD-005 | Source-first installer | Release limitation | Missing-source install/download is fail-closed; signed payload publication is not connected | Signed payload, staging, rollback, and clean-machine install |
| TD-006 | Rust audio runtime | Runtime warning | Windows startup can emit a Tokio shutdown panic and audio may degrade | Clean Windows launch with audio runtime and no panic |
| TD-007 | Existing single-instance process | Testability debt | A second managed launch may delegate to an existing VCPChat process | Operation-scoped focus/launch test with an existing instance |
| TD-008 | User configuration migration | Runtime debt | Fresh source launches can warn when `AppData/settings.json` is absent | First-run setup creates a valid settings profile |
| TD-009 | Generated repository files | Hygiene debt | Root contains runtime DB/splash and large user-facing legacy assets | Classify, ignore, relocate, or remove with explicit ownership |
| TD-010 | Release signing | Release limitation | Bundles are unsigned evidence only | Windows signing/Defender and macOS signing/notarization evidence |

## Triage Rules

- `Closed` means the local implementation and its focused tests pass; it does
  not imply all-platform release completion.
- `Release limitation` blocks a production claim but may be acceptable for a
  source-first development build.
- `Compatibility debt` is not removed by deleting a file. It needs a migration
  path and a documented owner.
