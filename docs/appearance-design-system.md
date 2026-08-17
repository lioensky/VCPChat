# VChat Appearance Design System

> Status: current appearance schema reference. Main-window layout selection has retired; current architecture and remaining compatibility work are tracked in [`next-ui-current-state.md`](./next-ui-current-state.md).

## Goal

VChat appearance is defined by independent, persistent visual choices. Historical `uiMode` values remain readable for settings compatibility but no longer select two main-window presentations.

```text
uiMode
  is a legacy compatibility field; it is not a live appearance control

appearanceProfile
  controls density, radius, typography, font scale, content width and surface material

chatPresentationMode
  controls bubble, panel or immersive message presentation
```

The active settings are intentionally separate. Changing message presentation must not silently change the shell, and changing radius must not mount or tear down a second runtime. Appearance Studio owns visual preview/commit/rollback; it does not own main-window layout selection.

## Current Schema

```js
appearanceProfile: {
  density: 'compact' | 'comfortable' | 'relaxed',
  radius: 'square' | 'small' | 'medium' | 'round',
  typography: 'system' | 'humanist' | 'serif',
  fontScale: 'small' | 'normal' | 'large',
  contentWidth: 'full' | 'centered',
  surface: 'solid' | 'translucent'
}
```

The authoritative copy lives in `settings.json`. Local storage is only an early-paint cache, following the same rule as `uiMode`; it never becomes the settings authority.

The renderer projects the profile onto the document:

```text
data-vcp-density
data-vcp-radius
data-vcp-typography
data-vcp-font-scale
data-vcp-content-width
data-vcp-surface
```

`modules/ui-system/appearance-engine.js` validates values, applies attributes, updates VCPUI density scopes and emits `vcp-appearance-changed`. `styles/appearance.css` maps those attributes to semantic tokens in the canonical main presentation. Remaining `data-ui-mode="next"` selectors are compatibility selectors, not evidence of a second main-window runtime.

## Compatibility Presets

When an older settings file has no `appearanceProfile`, the engine may derive a complete migration profile from the historical `uiMode` value:

| Compatibility mode | Density | Radius | Typography | Width | Surface |
| --- | --- | --- | --- | --- | --- |
| classic | comfortable | small | system | full | translucent |
| next | comfortable | medium | humanist | full | translucent |

These are migration defaults, not permanent coupled modes. Once saved, every field is independent.

## Design Tokens

- Color remains owned by the existing theme engine.
- Spacing uses the existing 4px token grid; density changes semantic control and panel spacing.
- Radius changes semantic radius tokens, not scattered component pixels.
- Typography changes the UI family and font scale; chat, code, diary and tool content keep their specialized font settings.
- Surface selects blur/translucency policy without changing the wallpaper or theme.
- Motion keeps the existing 160ms and 260ms tokens and respects reduced motion.

## Boundaries

- No main chat state, Agent Runtime or ToolBox behavior is changed.
- Appearance does not control main-window runtime ownership or business child-page policy.
- The Appearance layer does not make upstream child pages VCPUI components.
- Appearance Studio and Global Settings are canonical main-window Surfaces. Agent/group settings retain their existing business DOM and may be locally enhanced without becoming a second presentation.

## Delivery Roadmap

### Phase 1: Appearance profile foundation

- Persistent schema and validation.
- Boot cache and document attribute engine.
- Radius, density, typography, font scale, content width and surface controls.
- Contract test and UI-system gate integration.

### Phase 2: Token coverage

- Replace high-impact hard-coded radius, spacing and font sizes with semantic bridge tokens.
- Cover main chat, settings, notifications and embedded active surfaces.
- Publish a coverage report; do not claim a setting is global before the surface consumes its token.

### Phase 3: Shell decomposition

The first step exposes the existing compatibility shells as a transactional home-layout selector:

```js
uiMode: 'classic' | 'next'
```

The drawer stays mounted while previewing either layout, Cancel restores the opening mode, and Apply persists through `settings.json`. Continue decomposing it into orthogonal shell settings only after the remaining lifecycle work is complete:

```js
shell: 'inset' | 'edge'
navigation: 'top-tabs' | 'classic-titlebar'
```

At that point `uiMode` becomes an internal compatibility profile rather than a user-facing visual mode. Next runtime mounting and classic fallback must remain fail-closed.

### Phase 4: Quick appearance drawer

- The shared `AppearanceStudio` drawer is available from the main chat account menu and global settings.
- The same drawer can open from Global Settings in Classic layout, so users can switch back without a separate version toggle.
- Both account menus retain a direct light/dark toggle for the high-frequency theme switch; the full studio remains the entry for multi-setting changes.
- It provides system presets plus independent theme, profile and chat-presentation overrides.
- Preview is transactional: cancel restores the opening snapshot and save writes through Main.
- Theme Store and the complete settings dialog remain separate authorities reached from the drawer.
- Global Settings mounts SettingsShell only in Next. Classic keeps the upstream modal DOM, controls and navigation behavior.
- Global Settings exposes a dedicated “界面与外观” category for appearance profile, typography and chat presentation; the former standalone UI-version switch is now a hidden compatibility field synchronized by the drawer.
- The category presents a live appearance summary and opens Appearance Studio with the current form draft; applying in the studio synchronizes the legacy form controls and their visual proxies.
- Support import/export only after schema versioning exists.

### Phase 5: Deprecation audit

- Audit every `data-ui-mode` selector and runtime branch.
- Remove `uiMode` only if no remaining branch controls behavior or availability.
- Keep migration support for older settings files.

## Verification

```powershell
npm run test:appearance-engine
npm run check:ui-system
```

Visual acceptance must cover light and dark themes, narrow and wide windows, wallpaper enabled/disabled, and embedded child pages using their upstream presentation.
Global Settings acceptance must additionally verify category switching, search, close/reopen, preview, commit and rollback in the canonical main layout.
