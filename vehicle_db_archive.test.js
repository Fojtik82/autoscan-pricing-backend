import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from 'node:zlib';
import {
  compressVehicleDatabase,
  ensureVehicleDatabase,
  ensureVehicleDatabaseSync,
} from "./vehicle_db_archive.js";

test("vehicle database archive round-trips without changing bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vehicle-db-archive-"));
  const dbPath = path.join(directory, "vehicles_ai.db");
  const original = Buffer.from("SQLite test payload\0with binary bytes\xff", "latin1");

  try {
    fs.writeFileSync(dbPath, original);
    const archivePath = await compressVehicleDatabase(dbPath, { partSize: 10 });
    assert.equal(fs.existsSync(archivePath), true);
    const manifest = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    assert.ok(manifest.parts.length > 1);

    fs.rmSync(dbPath);
    const result = ensureVehicleDatabaseSync(dbPath);
    assert.equal(result.prepared, true);
    assert.deepEqual(fs.readFileSync(dbPath), original);

    assert.equal(ensureVehicleDatabaseSync(dbPath).prepared, false);
    fs.rmSync(dbPath);
    await ensureVehicleDatabase(dbPath);
    assert.deepEqual(fs.readFileSync(dbPath), original);
    fs.rmSync(dbPath);
    fs.writeFileSync(path.join(directory, manifest.parts[1].name), 'corrupt');
    await assert.rejects(ensureVehicleDatabase(dbPath), /Corrupt/);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy single gzip remains readable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vehicle-db-legacy-'));
  const dbPath = path.join(directory, 'vehicles_ai.db');
  try {
    fs.writeFileSync(dbPath + '.gz', gzipSync('legacy'));
    await ensureVehicleDatabase(dbPath);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'legacy');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('empty manifest is rejected and a replacement archive is readable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vehicle-db-update-'));
  const dbPath = path.join(directory, 'vehicles_ai.db');
  try {
    fs.writeFileSync(dbPath + '.gz.parts.json', JSON.stringify({ version: 1, parts: [] }));
    await assert.rejects(ensureVehicleDatabase(dbPath), /Invalid database archive manifest/);
    assert.equal(fs.existsSync(dbPath), false);
    fs.rmSync(dbPath + '.gz.parts.json');
    fs.writeFileSync(dbPath, 'first');
    await compressVehicleDatabase(dbPath, {partSize: 10});
    fs.writeFileSync(dbPath, 'second');
    await compressVehicleDatabase(dbPath, {partSize: 10});
    fs.rmSync(dbPath);
    await ensureVehicleDatabase(dbPath);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'second');
    assert.equal(fs.readdirSync(directory).some(name => name.includes('.tmp-')), false);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
