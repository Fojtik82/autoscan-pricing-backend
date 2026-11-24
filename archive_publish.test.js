import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushArchiveWithRetry } from './archive_publish.js';

function git(cwd, ...args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(String(error.stderr || error.message)); }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-publish-'));
  const remote = path.join(root, 'remote.git');
  const writer = path.join(root, 'writer');
  const importer = path.join(root, 'importer');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, writer);
  git(writer, 'config', 'user.name', 'Test'); git(writer, 'config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(writer, 'data'));
  fs.writeFileSync(path.join(writer, 'data', 'vehicles_ai.db.gz'), 'old database');
  fs.writeFileSync(path.join(writer, 'code.js'), 'old code');
  git(writer, 'add', '.'); git(writer, 'commit', '-m', 'base'); git(writer, 'push', 'origin', 'HEAD:main');
  git(root, 'clone', remote, importer);
  git(importer, 'config', 'user.name', 'Test'); git(importer, 'config', 'user.email', 'test@example.invalid');
  const base = git(importer, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(importer, 'data', 'vehicles_ai.db.gz'), 'new database');
  git(importer, 'add', '.'); git(importer, 'commit', '-m', 'import');
  return { root, remote, writer, importer, base, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const run = (command, args, opts) => ({ stdout: git(opts.cwd, ...args), stderr: '' });

test('publishes on top of concurrent documentation changes without replacing them', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.writer, 'README.md'), 'new documentation');
    git(f.writer, 'add', '.'); git(f.writer, 'commit', '-m', 'docs'); git(f.writer, 'push', 'origin', 'HEAD:main');
    const result = pushArchiveWithRetry(f.importer, 'main', f.base, run);
    assert.equal(result.pushed, true);
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:README.md'), 'new documentation');
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:data/vehicles_ai.db.gz'), 'new database');
  } finally { f.clean(); }
});

test('preserves an import when production code changes during collection', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.writer, 'code.js'), 'potentially new schema');
    git(f.writer, 'add', '.'); git(f.writer, 'commit', '-m', 'code change'); git(f.writer, 'push', 'origin', 'HEAD:main');
    assert.throws(() => pushArchiveWithRetry(f.importer, 'main', f.base, run), /Production code or database schema changed/);
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:data/vehicles_ai.db.gz'), 'old database');
    assert.equal(git(f.importer, 'show', 'HEAD:data/vehicles_ai.db.gz'), 'new database');
  } finally { f.clean(); }
});

test('never overwrites a concurrent database publication', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.writer, 'data', 'vehicles_ai.db.gz'), 'other database');
    git(f.writer, 'add', '.'); git(f.writer, 'commit', '-m', 'other import'); git(f.writer, 'push', 'origin', 'HEAD:main');
    assert.throws(() => pushArchiveWithRetry(f.importer, 'main', f.base, run), /refusing to overwrite/);
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:data/vehicles_ai.db.gz'), 'other database');
    assert.equal(git(f.importer, 'show', 'HEAD:data/vehicles_ai.db.gz'), 'new database');
  } finally { f.clean(); }
});

test('retries a non-fast-forward race without force', () => {
  const f = fixture();
  try {
    let first = true;
    const racingRun = (command, args, opts) => {
      if (args[0] === 'push' && first) {
        first = false;
        fs.writeFileSync(path.join(f.writer, 'README.md'), 'racing documentation');
        git(f.writer, 'add', '.'); git(f.writer, 'commit', '-m', 'race'); git(f.writer, 'push', 'origin', 'HEAD:main');
      }
      return run(command, args, opts);
    };
    const result = pushArchiveWithRetry(f.importer, 'main', f.base, racingRun);
    assert.equal(result.pushed, true);
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:README.md'), 'racing documentation');
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:data/vehicles_ai.db.gz'), 'new database');
  } finally { f.clean(); }
});

test('recognizes a successful push when its acknowledgement was lost', () => {
  const f = fixture();
  try {
    let first = true;
    const uncertainRun = (command, args, opts) => {
      if (args[0] === 'push' && first) {
        first = false;
        run(command, args, opts);
        throw new Error('[rejected] connection lost after remote update');
      }
      return run(command, args, opts);
    };
    const result = pushArchiveWithRetry(f.importer, 'main', f.base, uncertainRun);
    assert.equal(result.reason, 'already_published');
    assert.equal(git(f.writer, '--git-dir', f.remote, 'show', 'main:data/vehicles_ai.db.gz'), 'new database');
  } finally { f.clean(); }
});
