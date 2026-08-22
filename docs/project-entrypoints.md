# VCPChat Project Entry Points

This document is the source of truth for how the repository is started, repaired,
tested, and packaged. Older scripts remain available for compatibility, but they
are not all release entry points.

## Recommended Paths

| Audience | Entry point | Purpose | Release status |
| --- | --- | --- | --- |
| End user, source checkout | `launchers/VCPChat-Launcher.vbs` (Windows), `launchers/VCPChat-Launcher.command` (macOS), `launchers/VCPChat-Launcher.sh` (Linux) | Open the graphical setup/recovery flow for the current checkout | Supported source launcher |
| End user, portable bootstrap | `npm run installer:portable` → root `VCPChat-Setup.exe` | Double-click from the project root; it checks/prepares the VCPChat source and starts the app | Supported Windows delivery; no system installation |
| Developer | `npm run vcpchat` | Diagnose, optionally repair with explicit consent, then launch | Supported CLI |
| Developer, direct debugging | `npm start` | Run Electron directly and keep the existing debugging behavior | Compatibility/debug only |
| CI/package validation | `npm run check:release-surface` | Validate required entrypoints, manifests, locks, and artifact naming | Required gate |

## Artifact Ownership

- `apps/bootstrap-installer/` owns the standalone Tauri Setup application. Windows
  delivery is the root-level portable `VCPChat-Setup.exe`; no NSIS/MSI installer
  is part of the release surface.
- `main.js`, `renderer.js`, and the root Electron package own the desktop app.
- `scripts/vcpchat.mjs` owns the consent-aware managed CLI state machine.
- `scripts/vcpchat-dev-launcher.mjs` owns the lower-level managed Electron handoff.
- `bootstrap/` owns the legacy Recovery UI. It is retained for development and
  recovery compatibility, not presented as the production installer.
- `start.bat`, `启动Vchat.vbs`, `启动全部.vbs`, `start-desktop.vbs`, and
  `start-rag-observer.vbs` remain compatibility/debug entries. They must not be
  used as release evidence.

## Build Outputs

| Output | Command | Location | Verification |
| --- | --- | --- | --- |
| Tauri portable bootstrap | `npm run installer:portable` | `VCPChat-Setup.exe` at repository root | `npm run check:release-surface` |
| Electron unpacked package | `npm run pack` | `dist/` | `npm run test:packed-install` |
| Offline Web Awesome closure | `npm run pack:check` | `vendor/webawesome-runtime/` | `npm run pack:check` |

Build directories, `node_modules`, user data, logs, runtime databases, and local
state are not release inputs and must not be committed as product evidence.

## Windows Test Order

1. Run `launchers/VCPChat-Launcher.vbs` from a clean source checkout.
2. Click the setup flow's prepare action and wait for Doctor, dependency repair,
   native rebuild, and final Doctor.
3. Verify the setup window exits only after operation-scoped `renderer-ready`.
4. Verify the root-level `VCPChat-Setup.exe` launches without an installation step.
5. Record remaining warnings separately from blocking failures.

## Compatibility Policy

The legacy direct launchers are intentionally not deleted in this milestone.
They are kept so existing developer workflows and desktop shortcuts do not break.
New documentation and release evidence must point to the managed launcher or the
standalone Setup artifact instead.
