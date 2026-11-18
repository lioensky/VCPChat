import assert from 'node:assert/strict';
import test from 'node:test';
import { metricChart, sliceViewport } from '../modules/warpedFieldAtlas/renderer/metric-slice.mjs';

const range = [0.35, 0.65];
const geometry = { kappa: 2, phi0: 1.5, alpha: 0.15 };

test('zero cubic term agrees with the analytic logarithmic chart', () => {
    const c = metricChart({ ...geometry, alpha: 0 }, range);
    for (let i = 0; i <= 100; i++) {
        const r = range[0] + i / 100 * (range[1] - range[0]);
        const expected = Math.log((1.5 + r) / (1.5 + range[0])) / 2;
        assert.ok(Math.abs(c.at(r) - expected) < 1e-8);
    }
});

test('radial and angular metric unit steps have equal local screen scale', () => {
    const c = metricChart(geometry, range);
    const v = sliceViewport(c, 20, 40, { left: 50, right: 800, top: 20, bottom: 500 });
    const r = 0.5, dr = 0.0001;
    const dtheta = dr / (2 * (1.5 + r + 0.15 * r ** 3));
    const dx = v.X(30 + dtheta * 180 / Math.PI) - v.X(30);
    const dy = v.Y(r) - v.Y(r + dr);
    assert.ok(Math.abs(dx / dy - 1) < 0.001);
    assert.ok(Math.abs(v.Y(range[1]) - v.top) < 1e-8);
});

test('unsupported snapshots do not silently fall back to a constant curvature model', () => {
    for (const g of [null, {}, { ...geometry, kappa: 0 }, { ...geometry, alpha: NaN }])
        assert.equal(metricChart(g, range), null);
    assert.equal(metricChart(geometry, [1, 1]), null);
});