import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";

export function vehicleDatabaseArchivePath(dbPath) {
  return `${dbPath}.gz`;
}

export function ensureVehicleDatabaseSync(dbPath) {
  if (fs.existsSync(dbPath)) {
    return { prepared: false, path: dbPath };
  }

  const archivePath = vehicleDatabaseArchivePath(dbPath);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Vehicle database and archive are missing: ${dbPath}`);
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporaryPath = `${dbPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, gunzipSync(fs.readFileSync(archivePath)), { flag: "wx" });
    fs.renameSync(temporaryPath, dbPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  return { prepared: true, path: dbPath, archivePath };
}

export async function compressVehicleDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Vehicle database is missing: ${dbPath}`);
  }

  const archivePath = vehicleDatabaseArchivePath(dbPath);
  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  try {
    await pipeline(
      fs.createReadStream(dbPath),
      createGzip({ level: 9 }),
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
    );
    if (process.platform === "win32") fs.rmSync(archivePath, { force: true });
    fs.renameSync(temporaryPath, archivePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  return archivePath;
}
