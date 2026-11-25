// Isothermal chart for ds² = dr² + φ(r)² dθ².
// Plot unwrapped θ against u = ∫dr/φ(r); the same scale on both axes
// gives ds² = φ(r)²(du² + dθ²). This is not a constant-curvature disk.
export function metricChart(geometry, range) {
    if (!geometry || !Array.isArray(range)) return null;
    const { kappa, phi0, alpha } = geometry;
    const [lo, hi] = range;
    if (![kappa, phi0, alpha, lo, hi].every(Number.isFinite) ||
        kappa <= 0 || phi0 <= 0 || alpha < 0 || lo < 0 || hi <= lo) return null;
    const n = 512, step = (hi - lo) / n;
    const inv = r => 1 / (kappa * (phi0 + r + alpha * r ** 3));
    const u = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) {
        const r = lo + j * step;
        u[j + 1] = u[j] + step / 6 * (inv(r) + 4 * inv(r + step / 2) + inv(r + step));
    }
    if (!(u[n] > 0 && Number.isFinite(u[n]))) return null;
    return { span: u[n], at(r) {
        if (!Number.isFinite(r) || r < lo || r > hi) return NaN;
        const x = (r - lo) / step, j = Math.min(n - 1, Math.floor(x));
        return u[j] + (x - j) * (u[j + 1] - u[j]);
    } };
}

// An affine viewport in chart coordinates. Unused vertical space is intentional:
// stretching the radial axis independently would destroy local angle fidelity.
export function sliceViewport(chart, from, to, box) {
    const rad = Math.PI / 180;
    const scale = Math.min((box.right - box.left) / ((to - from) * rad),
        (box.bottom - box.top) / chart.span);
    const width = (to - from) * rad * scale, height = chart.span * scale;
    const left = (box.left + box.right - width) / 2;
    const bottom = (box.top + box.bottom + height) / 2;
    return { left, right: left + width, top: bottom - height, bottom,
        X: theta => left + (theta - from) * rad * scale,
        Y: radius => bottom - chart.at(radius) * scale };
}