import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneOf, hasZones } from '../DeskPetmodules/hitAreas.js';

test('hit area names from common models map to head or body', () => {
    assert.equal(zoneOf(['Head']), 'head');
    assert.equal(zoneOf(['HitAreaHead']), 'head');
    assert.equal(zoneOf(['Body', 'Head']), 'head', '身体的框包住了头：算头');
    assert.equal(zoneOf(['HitAreaBody']), 'body');
    assert.equal(zoneOf(['Bust']), 'body');
    assert.equal(zoneOf(['头部']), 'head');
    assert.equal(zoneOf(['Ribbon']), null);
    assert.equal(zoneOf([]), null);
    assert.equal(zoneOf(undefined), null);
});

test('only models that mark the head are trusted; body-only models fall back to the outline', () => {
    assert.equal(hasZones(['HitAreaHead', 'HitAreaBody']), true);
    assert.equal(hasZones(['Body']), false);
    assert.equal(hasZones([]), false);
});
