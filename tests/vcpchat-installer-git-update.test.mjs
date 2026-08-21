import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

function configure(cwd) {
  git(cwd, 'config', 'user.name', 'VCPChat Installer Test')
  git(cwd, 'config', 'user.email', 'installer-test@vcpchat.invalid')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-update-'))
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  const local = path.join(root, 'local')
  git(root, 'init', '--bare', remote)
  git(root, 'init', '-b', 'main', seed)
  configure(seed)
  fs.writeFileSync(path.join(seed, 'shared.txt'), 'base\n')
  fs.writeFileSync(path.join(seed, 'upstream.txt'), 'base\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'base')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'main')
  git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'clone', remote, local)
  configure(local)
  return { root, seed, local }
}

function pushUpstream(seed, file, contents) {
  fs.writeFileSync(path.join(seed, file), contents)
  git(seed, 'add', file)
  git(seed, 'commit', '-m', `update ${file}`)
  git(seed, 'push')
}

function namedStash(local) {
  git(local, 'stash', 'push', '--include-untracked', '--message', 'vcpchat-installer/test-transaction')
  return git(local, 'rev-parse', 'refs/stash')
}

function exactStashRef(local, oid) {
  const match = git(local, 'stash', 'list', '--format=%H%x09%gd')
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([candidate]) => candidate === oid)
  return match?.[1]
}

function restoreAndDrop(local, oid) {
  git(local, 'stash', 'apply', '--index', oid)
  const reference = exactStashRef(local, oid)
  assert.ok(reference, `stash ${oid} must retain an exact reflog reference until restore succeeds`)
  git(local, 'stash', 'drop', reference)
}

test('dirty update restores tracked and untracked work, then drops only its recorded stash', (t) => {
  const { root, seed, local } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(local, 'shared.txt'), 'local work\n')
  fs.writeFileSync(path.join(local, 'untracked.txt'), 'private draft\n')
  pushUpstream(seed, 'upstream.txt', 'upstream update\n')

  const oid = namedStash(local)
  git(local, 'fetch', '--prune')
  git(local, 'merge', '--ff-only', '@{upstream}')
  restoreAndDrop(local, oid)

  assert.equal(readText(path.join(local, 'shared.txt')), 'local work\n')
  assert.equal(readText(path.join(local, 'untracked.txt')), 'private draft\n')
  assert.equal(readText(path.join(local, 'upstream.txt')), 'upstream update\n')
  assert.equal(exactStashRef(local, oid), undefined)
})

test('stash restore conflict leaves updated HEAD clean and preserves the recorded stash OID', (t) => {
  const { root, seed, local } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(local, 'shared.txt'), 'local work\n')
  fs.writeFileSync(path.join(local, 'untracked.txt'), 'private draft\n')
  pushUpstream(seed, 'shared.txt', 'upstream work\n')

  const oid = namedStash(local)
  git(local, 'fetch', '--prune')
  git(local, 'merge', '--ff-only', '@{upstream}')
  assert.throws(() => git(local, 'stash', 'apply', '--index', oid))
  const updatedHead = git(local, 'rev-parse', 'HEAD')
  git(local, 'reset', '--hard', updatedHead)
  git(local, 'clean', '-fd')

  assert.equal(git(local, 'status', '--porcelain'), '')
  assert.ok(exactStashRef(local, oid))
  assert.equal(readText(path.join(local, 'shared.txt')), 'upstream work\n')
  assert.equal(fs.existsSync(path.join(local, 'untracked.txt')), false)
})

test('post-update validation failure rolls HEAD back before restoring local work', (t) => {
  const { root, seed, local } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const originalHead = git(local, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(local, 'shared.txt'), 'local work\n')
  fs.writeFileSync(path.join(local, 'untracked.txt'), 'private draft\n')
  pushUpstream(seed, 'upstream.txt', 'upstream update\n')

  const oid = namedStash(local)
  git(local, 'fetch', '--prune')
  git(local, 'merge', '--ff-only', '@{upstream}')
  fs.writeFileSync(path.join(local, 'installer-artifact.txt'), 'unexpected output\n')
  git(local, 'reset', '--hard', originalHead)
  git(local, 'clean', '-fd')
  restoreAndDrop(local, oid)

  assert.equal(git(local, 'rev-parse', 'HEAD'), originalHead)
  assert.equal(readText(path.join(local, 'shared.txt')), 'local work\n')
  assert.equal(readText(path.join(local, 'untracked.txt')), 'private draft\n')
  assert.equal(fs.existsSync(path.join(local, 'installer-artifact.txt')), false)
  assert.equal(exactStashRef(local, oid), undefined)
})
