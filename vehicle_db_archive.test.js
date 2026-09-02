import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compressVehicleDatabase,
  ensureVehicleDatabaseSync,
} from "./vehicle_db_archive.js";

test("vehicle database archive round-trips without changing bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vehicle-db-archive-"));
  const dbPath = path.join(directory, "vehicles_ai.db");
  const original = Buffer.from("SQLite test payload\0with binary bytes\xff", "latin1");

  try {
    fs.writeFileSync(dbPath, original);
    const archivePath = await compressVehicleDatabase(dbPath);
    assert.equal(fs.existsSync(archivePath), true);

    fs.rmSync(dbPath);
    const result = ensureVehicleDatabaseSync(dbPath);
    assert.equal(result.prepared, true);
    assert.deepEqual(fs.readFileSync(dbPath), original);

    assert.equal(ensureVehicleDatabaseSync(dbPath).prepared, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
