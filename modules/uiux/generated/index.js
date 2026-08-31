export { createUiScope, createUiScopeFromGlobal } from './runtime/scope.js';
export { createDomRenderer } from './runtime/dom-renderer.js';
export { mountThemePresenter, themeUiDefinition, } from './providers/theme.js';
export { createSettingsUiService, settingsUiDefinition } from './adapters/settings.js';
export { mountField } from './primitives/field.js';
export { mountButton } from './primitives/button.js';
export { mountSelect } from './primitives/select.js';
export { mountInput } from './primitives/input.js';
export { mountMenu } from './primitives/menu.js';
export { AGENT_PRESET_SEAT_DEFAULT_HINT, AGENT_PRESET_SEAT_NO_DESCRIPTION, mountAgentPresetSeat } from './primitives/agent-preset-seat.js';
export { AGENT_PRESET_ROW_DEFAULT_DESCRIPTION, AGENT_PRESET_ROW_DEFAULT_TITLE, AGENT_PRESET_ROW_LOADING_LABEL, AGENT_PRESET_ROW_USER_TRUST_LABEL, mountAgentPresetRow } from './primitives/agent-preset-row.js';
export { mountLanguageRow } from './primitives/language-row.js';
export { mountFontSizeRow } from './primitives/font-size-row.js';
export { mountAgentModelPicker } from './primitives/agent-model-picker.js';
export { mountModal } from './primitives/modal.js';
export { mountTooltip } from './primitives/tooltip.js';
export { mountHoverCard } from './primitives/hover-card.js';
export { mountDisclosureRow, mountDisclosureRowController } from './primitives/disclosure-row.js';
export { mountStateDot } from './primitives/state-dot.js';
export { mountToast, TOAST_FADE_MS, TOAST_HOLD_MS } from './primitives/toast.js';
export { mountRiskConfirmation } from './primitives/risk-confirmation.js';
export { mountSemanticIcon } from './primitives/semantic-icon.js';
export { mountChoice } from './primitives/choice.js';
export { mountRange } from './primitives/range.js';
export { mountNumericStepperRow } from './primitives/numeric-stepper-row.js';
export { mountToggle } from './primitives/toggle.js';
export { mountColorPair } from './primitives/color-pair.js';
export { mountOnboardingSurface } from './primitives/onboarding-surface.js';
/** Candidate-only frozen-domain diff fixture; no VCP tool/chat consumer. */
export { mountDiffBlock } from './primitives/diff-block.js';
/** Candidate-only Harness command-popup contract; not a stable VCP business API. */
export { createPopupSelectController, filterOptions, mountPopupSelectView } from './primitives/popup-select.js';
/** Candidate-only in-app directory browser; its filesystem capabilities are injected by the caller. */
export { mountDirectoryBrowser } from './primitives/directory-browser.js';
export { mountPrimitiveLab } from './lab/primitive-lab.js';
