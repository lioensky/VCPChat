'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { resolveAndNormalizePath, unwrapLocalFileUrl } = require('../VCPDistributedServer/shared/fileKit/paths');

test('fileKit.paths unwraps valid local file:// URLs (including VCPChat internalPath style) and rejects remote/query/fragment URLs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-filekit-url-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const trickyFile = path.join(dir, '中文 # 100%.txt');
  const standardUrl = pathToFileURL(trickyFile).href;

  assert.equal(resolveAndNormalizePath(standardUrl), path.resolve(trickyFile));

  // VCPChat fileManager.js constructs `file://${internalFilePath}` directly
  const plainFile = path.join(dir, 'attachment_demo.txt');
  const vcpInternalUrl = `file://${plainFile}`;
  assert.equal(resolveAndNormalizePath(vcpInternalUrl), path.resolve(plainFile));

  // Relative & virtual-root behavior remains intact
  assert.equal(
    resolveAndNormalizePath('sub/a.js', { basePath: dir, relativeRoot: dir, virtualRoot: dir }),
    path.join(dir, 'sub', 'a.js')
  );

  // Reject network shares, query strings, and fragments
  assert.throws(() => unwrapLocalFileUrl('file://remote-server/share/a.txt'), /host, query, or fragment/);
  assert.throws(() => resolveAndNormalizePath(`${standardUrl}?version=1`), /host, query, or fragment/);
  assert.throws(() => resolveAndNormalizePath(`${standardUrl}#section`), /host, query, or fragment/);
});

test('distributed FileOperator consumes file:// URLs across ReadFile, FileInfo, CopyFile, ApplyDiff and unifies lock keys', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-dist-fileop-'));
  const prevAllowed = process.env.ALLOWED_DIRECTORIES;
  process.env.ALLOWED_DIRECTORIES = dir;

  const fileOpPath = require.resolve('../VCPDistributedServer/Plugin/FileOperator/FileOperator');
  delete require.cache[fileOpPath];
  const fileOp = require(fileOpPath);

  t.after(() => {
    if (prevAllowed === undefined) {
      delete process.env.ALLOWED_DIRECTORIES;
    } else {
      process.env.ALLOWED_DIRECTORIES = prevAllowed;
    }
    delete require.cache[fileOpPath];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const imagePath = path.join(dir, '中文 # 100%.jpg');
  const notePath = path.join(dir, 'live_note.md');
  const copiedPath = path.join(dir, 'copied_note.md');
  const jpgBytes = Buffer.from([255, 216, 255, 217]);
  fs.writeFileSync(imagePath, jpgBytes);
  fs.writeFileSync(notePath, 'before-edit\nline2\n', 'utf8');

  const imageUrl = pathToFileURL(imagePath).href;
  const noteUrl = pathToFileURL(notePath).href;
  const copiedUrl = pathToFileURL(copiedPath).href;

  // Same file referenced by native path vs file:// URL must share identical KeyedLockQueue lock key
  assert.equal(
    fileOp.fileLockQueue.normalizeKey(notePath),
    fileOp.fileLockQueue.normalizeKey(noteUrl)
  );

  const readImg = await fileOp.processToolCall({ command: 'ReadFile', filePath: imageUrl });
  assert.ok(JSON.stringify(readImg).includes('data:image/jpeg;base64,' + jpgBytes.toString('base64')));

  const infoRes = await fileOp.processToolCall({ command: 'FileInfo', filePath: imageUrl });
  assert.ok(JSON.stringify(infoRes).includes('中文 # 100%.jpg'));

  await fileOp.processToolCall({ command: 'CopyFile', sourcePath: noteUrl, destinationPath: copiedUrl });
  await fileOp.processToolCall({
    command: 'ApplyDiff',
    filePath: copiedUrl,
    target: 'before-edit',
    replace: 'after-fileurl-edit',
  });
  assert.equal(fs.readFileSync(copiedPath, 'utf8'), 'after-fileurl-edit\nline2\n');

  await assert.rejects(
    () => fileOp.processToolCall({ command: 'ReadFile', filePath: `${noteUrl}#bad` }),
    /host, query, or fragment/
  );
});
