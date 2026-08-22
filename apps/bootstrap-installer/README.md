# VCPChat Bootstrap Installer

This is the standalone Tauri installer, shipped as a portable bootstrapper for VCPChat. It is intentionally
separate from the Electron application and from the legacy `bootstrap/`
Recovery UI.

## Development

From the repository root:

```bash
npm install --prefix apps/bootstrap-installer
npm run installer:dev
```

The Windows release artifact is a single root-level `VCPChat-Setup.exe`; NSIS/MSI
installation is not part of the product surface. The current source-first milestone owns dependency and Rust runtime repair, final deep Doctor,
process-tree cancellation, persistent logs, and operation-scoped ready
handoff. Missing-source installation still fails closed because signed payload
download, publication, and rollback are not connected yet. Do not use this
development build as a production installer.

Generated platform binaries under `modules/services/chatDataService/bin/` and
`audio_engine/bin/` are installer-owned repair output and are ignored by Git
dirty checks. `--include-rust` builds both VCP-CDS and the platform-specific
audio server. After the operation-scoped ready record is verified, handoff
detaches Electron so the Installer can exit without terminating VCPChat.

The upstream Windows `StartVCPchat.exe` protocol is supported as a presentation
layer through `VCP_STARTUP:` progress frames. Those frames never replace the
managed ready record used to decide launch success.

## Licensing

This project is derived from Hermes Agent's MIT-licensed Bootstrap Installer.
See `LICENSE-HERMES` and `THIRD_PARTY_NOTICES.md` before distributing any
build.
