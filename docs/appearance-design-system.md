# VChat Appearance Design System

> Status: Phase 1 and the Phase 4 appearance drawer are implemented; the first shell-layout selector is available.

## Goal

VChat appearance is no longer defined by one `classic/next` switch. The UI mode remains a compatibility boundary while visual choices become independent, persistent settings.

```text
uiMode
  is presented as the Classic/Next home layout choice and still controls runtime compatibility

appearanceProfile
  controls density, radius, typography, font scale, content width and surface material

chatPresentationMode
  controls bubble, panel or immersive message presentation
```

The three settings are intentionally separate. Changing message presentation must not silently change the shell, and changing radius must not mount or tear down Next runtime. Appearance Studio owns the user-facing home-layout choice; `uiMode` remains its compatibility storage field.

New installations and settings files without `uiMode` start in `classic`. A user enters Next only after explicitly selecting and saving it; an existing saved `next` preference remains unchanged.

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

`modules/ui-system/appearance-engine.js` validates values, applies attributes, updates VCPUI density scopes and emits `vcp-appearance-changed`. `styles/appearance.css` maps those attributes to semantic tokens only under `html[data-ui-mode="next"]`; Classic remains owned by the upstream stylesheets.

## Compatibility Presets

When an older settings file has no `appearanceProfile`, the engine derives a complete profile from `uiMode`:

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
- `classic/next` is presented as two home layouts, but it is not removed internally. It still owns Next runtime loading, Web Awesome availability, child-app allowlists and legacy teardown.
- The Appearance layer does not make classic pages VCPUI components.
- Appearance Studio and Global Settings are the two intentional cross-mode VCPUI hosts. Global Settings always uses the Next SettingsShell, independent of the selected home layout, while agent/group settings still follow the home-layout runtime. Their CSS/token exceptions are explicitly allowlisted; the UI-system guard rejects other cross-mode selectors.

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

Visual acceptance must cover classic and next modes, light and dark themes, narrow and wide windows, wallpaper enabled/disabled, and embedded child pages using their upstream Classic presentation.
Global Settings acceptance must additionally verify category switching, search, close/reopen and layout changes while the dialog is open in both home layouts.
