'use strict';
// Drive the real lifecycle with virtual time and a fake parser transport.
// No test-time timeout override or lifecycle internals exported by production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('idle parser retires only its own generation with no pending RPC', async () => {
    const ttl = 300000, timers = new Set(), children = [];
    let now = 0;
    function later(fn, ms) {
        const h = { fn, ms, due: now + ms, unref() { this.unreferenced = true; } };
        timers.add(h);
        return h;
    }
    function advance(ms) {
        now += ms;
        for (const h of [...timers].sort((a,b) => a.due-b.due)) {
            if (h.due <= now && timers.delete(h)) h.fn();
        }
    }
    function spawn() {
        const c = new EventEmitter();
        Object.assign(c, {exitCode:null, killed:false, ref(){}, unref(){},
            kill(){ this.killed = true; }, stdout:{}, stderr:{},
            requests:[], stdin:{write(s){ c.requests.push(JSON.parse(s)); }}});
        children.push(c);
        return c;
    }
    const mocks = {
        'node:os': {platform: () => 'win32'},
        'node:fs': {existsSync: () => true},
        'node:child_process': {spawn},
        'node:readline': {createInterface() {
            const c = children.at(-1);
            c.reader = new EventEmitter(); c.reader.close = () => {};
            return c.reader;
        }}
    };
    const mod = {exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'commandSecurityCheck.js'),'utf8'), {
        module:mod, require:id=>Object.hasOwn(mocks,id)?mocks[id]:require(id),
        process:{env:{}}, Buffer, setTimeout:later, clearTimeout:h=>timers.delete(h)
    });
    const api = mod.exports, parse = text => api.parsePowerShellAstAsync(text);
    function reply(c) {
        const req = c.requests.shift();
        c.reader.emit('line',JSON.stringify({jsonrpc:'2.0',id:req.id,result:{errors:[],commands:[]}}));
    }
    const idle = () => [...timers].find(h => h.ms === ttl);
    try {
        const first = parse('one'), a = children[0]; reply(a); await first;
        const stale = idle(); assert.ok(stale?.unreferenced);
        advance(ttl-1); assert.equal(a.killed,false);
        const second = parse('two'), third = parse('three');
        reply(a); await second;
        advance(1); stale.fn(); // cancelled callback delivered with one RPC pending
        assert.equal(a.killed,false); assert.equal(idle(),undefined);
        reply(a); await third;
        stale.fn(); // old timer, same owner, now empty
        assert.equal(a.killed,false);
        advance(ttl-1); assert.equal(a.killed,false);
        const retiredTimer = idle();
        advance(1); assert.equal(a.killed,true);
        await parse('one'); assert.equal(children.length,1); // cache survived retirement
        const wake = parse('four'), b = children[1]; reply(b); await wake;
        retiredTimer.fn(); a.emit('exit',0);
        assert.equal(b.killed,false); assert.ok(idle());
        api.shutdownAstDaemon();
        assert.equal(b.killed,true); assert.equal(timers.size,0);
    } finally { api.shutdownAstDaemon(); }
});
