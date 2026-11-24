import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';

export function vehicleDatabaseArchivePath(dbPath) { return `${dbPath}.gz`; }
const manifestPath = dbPath => `${vehicleDatabaseArchivePath(dbPath)}.parts.json`;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const PART_SIZE = 80 * 1024 * 1024;

function readManifest(dbPath) {
  const file = manifestPath(dbPath);
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 1000) throw new Error('Invalid database archive manifest');
  for (const [index, part] of manifest.parts.entries()) {
    const expected = path.basename(vehicleDatabaseArchivePath(dbPath)) + '.part' + String(index).padStart(3, '0') + '-' + part.sha256;
    if (part.name !== expected || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > PART_SIZE || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error('Invalid database archive part');
  }
  return manifest;
}

function readPart(dbPath, part) {
  const data = fs.readFileSync(path.join(path.dirname(dbPath), part.name));
  if (data.length !== part.size || sha256(data) !== part.sha256) throw new Error(`Corrupt database archive part: ${part.name}`);
  return data;
}

async function* partsStream(dbPath, manifest) {
  for (const part of manifest.parts) yield readPart(dbPath, part);
}

export async function ensureVehicleDatabase(dbPath) {
  if (fs.existsSync(dbPath)) return { prepared: false, path: dbPath };
  const manifest = readManifest(dbPath);
  const archivePath = vehicleDatabaseArchivePath(dbPath);
  if (!manifest && !fs.existsSync(archivePath)) throw new Error(`Vehicle database and archive are missing: ${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporaryPath = `${dbPath}.tmp-${process.pid}`;
  const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
  const closed = new Promise(resolve => output.once('close', resolve));
  try {
    await pipeline(manifest ? Readable.from(partsStream(dbPath, manifest)) : fs.createReadStream(archivePath), createGunzip(), output);
    fs.renameSync(temporaryPath, dbPath);
  } catch (error) { await closed; fs.rmSync(temporaryPath, { force: true }); throw error; }
  return { prepared: true, path: dbPath, archivePath: manifest ? manifestPath(dbPath) : archivePath };
}

export function ensureVehicleDatabaseSync(dbPath) {
  if (fs.existsSync(dbPath)) return { prepared: false, path: dbPath };
  const manifest = readManifest(dbPath);
  const archivePath = vehicleDatabaseArchivePath(dbPath);
  if (!manifest && !fs.existsSync(archivePath)) throw new Error(`Vehicle database and archive are missing: ${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporaryPath = `${dbPath}.tmp-${process.pid}`;
  try {
    const compressed = manifest ? Buffer.concat(manifest.parts.map(part => readPart(dbPath, part))) : fs.readFileSync(archivePath);
    fs.writeFileSync(temporaryPath, gunzipSync(compressed), { flag: 'wx' });
    fs.renameSync(temporaryPath, dbPath);
  } catch (error) { fs.rmSync(temporaryPath, { force: true }); throw error; }
  return { prepared: true, path: dbPath, archivePath: manifest ? manifestPath(dbPath) : archivePath };
}

export async function compressVehicleDatabase(dbPath, options = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`Vehicle database is missing: ${dbPath}`);
  const size = options.partSize ?? PART_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > PART_SIZE) throw new Error('Invalid archive part size');
  const archivePath = vehicleDatabaseArchivePath(dbPath);
  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  const manifestTemp = `${manifestPath(dbPath)}.tmp-${process.pid}`;
  const temporaryParts = [];
  try {
    await pipeline(fs.createReadStream(dbPath), createGzip({ level: 9 }), fs.createWriteStream(temporaryPath, { flags: 'wx' }));
    const source = fs.openSync(temporaryPath, 'r');
    const parts = [];
    try {
      const total = fs.fstatSync(source).size;
      for (let offset = 0; offset < total; offset += size) {
        const data = Buffer.allocUnsafe(Math.min(size, total - offset));
        if (fs.readSync(source, data, 0, data.length, offset) !== data.length) throw new Error('Failed reading compressed archive');
        const hash = sha256(data);
        const name = path.basename(archivePath) + '.part' + String(parts.length).padStart(3, '0') + '-' + hash;
        const finalPath = path.join(path.dirname(dbPath), name);
        const tmp = `${finalPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, data, { flag: 'wx' });
        temporaryParts.push({ tmp, finalPath });
        parts.push({ name, size: data.length, sha256: hash });
      }
    } finally { fs.closeSync(source); }
    const oldManifest = readManifest(dbPath);
    for (const part of temporaryParts) {
      if (fs.existsSync(part.finalPath)) {
        if (!fs.readFileSync(part.finalPath).equals(fs.readFileSync(part.tmp))) throw new Error('Existing archive part does not match its hash');
        fs.rmSync(part.tmp);
      } else fs.renameSync(part.tmp, part.finalPath);
    }
    fs.writeFileSync(manifestTemp, JSON.stringify({ version: 1, parts }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(manifestTemp, manifestPath(dbPath));
    for (const part of oldManifest?.parts || []) if (!parts.some(item => item.name === part.name)) fs.rmSync(path.join(path.dirname(dbPath), part.name), { force: true });
    fs.rmSync(archivePath, { force: true });
    return manifestPath(dbPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fs.rmSync(manifestTemp, { force: true });
    for (const part of temporaryParts) fs.rmSync(part.tmp, { force: true });
  }
}
