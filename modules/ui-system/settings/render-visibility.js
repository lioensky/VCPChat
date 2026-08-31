// Presentation-only projection for render-settings custom typography rows.
export function syncRenderSettingsVisibility(form) {
    if (!form) return;
    [
        ['chatFontPreset', 'chatFontCustomRow'],
        ['chatCodeFontPreset', 'chatCodeFontCustomRow'],
        ['chatDiaryFontPreset', 'chatDiaryFontCustomRow'],
        ['chatToolFontPreset', 'chatToolFontCustomRow'],
    ].forEach(([selectId, rowId]) => {
        const select = form.querySelector(`#${selectId}`);
        const row = form.querySelector(`#${rowId}`);
        if (select && row) row.style.display = select.value === 'custom' ? 'block' : 'none';
    });
    const streamPreset = form.querySelector('#streamAnimationPreset');
    const streamCustomRow = form.querySelector('#streamAnimationCustomRow');
    if (streamPreset && streamCustomRow) streamCustomRow.hidden = streamPreset.value !== 'custom';
    const duration = form.querySelector('#streamAnimationDurationMs');
    const durationOutput = form.querySelector('#streamAnimationDurationValue');
    if (duration && durationOutput) durationOutput.textContent = `${duration.value}ms`;
}
