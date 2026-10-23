// Codex atlas rows. Direction 0 is up; clockwise, in screen coordinates.
export const SPRITE_ROWS = Object.freeze({ idle: [0, 6], right: [1, 8], left: [2, 8], waving: [3, 4], jumping: [4, 5], failed: [5, 8], waiting: [6, 6], running: [7, 6], review: [8, 6] });
export const CELL = Object.freeze({ width: 192, height: 208, columns: 8 });

export function lookCell(x, y, version) {
    if (version !== 2 || !Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 0.25) return null;
    const angle = (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
    const index = Math.round(angle / (Math.PI / 8)) % 16;
    return { row: 9 + Math.floor(index / 8), column: index % 8 };
}

export function spriteState({ frame = {}, approval = false, held = false, velocity = 0, walk = '', action = '', sleeping = false } = {}) {
    if (held) return Math.abs(velocity) > 15 ? (velocity > 0 ? 'right' : 'left') : 'idle';
    if (approval) return 'waiting';
    if (frame.state === 'error') return 'failed';
    if (['thinking', 'tool', 'talk', 'speaking'].includes(frame.state)) return 'running';
    if (walk === 'left' || walk === 'right') return walk;
    if (SPRITE_ROWS[action]) return action;
    if (sleeping) return 'idle';
    return 'idle';
}

export function animationCell(state, elapsedMs, fps = 8) {
    const [row, frames] = SPRITE_ROWS[state] || SPRITE_ROWS.idle;
    return { row, column: Math.floor(Math.max(0, elapsedMs) * fps / 1000) % frames };
}
