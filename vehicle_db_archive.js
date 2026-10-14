import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip, gunzipSync } from "node:zlib";
import { Readable } from 'node:stream';

function archiveParts(archivePath) {
  const manifestPath=archivePath+'.parts.json';
  if(!fs.existsSync(manifestPath))return null;
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const base=path.basename(archivePath);
  if(manifest.version!==1||!Array.isArray(manifest.parts)||!manifest.parts.length||manifest.parts.length>10000||
      manifest.parts.some((name,index)=>name!==base+'.part-'+String(index+1).padStart(4,'0')))
    throw Error('Invalid database archive part manifest');
  return manifest.parts.map(name=>path.join(path.dirname(archivePath),name));
}

export function vehicleDatabaseArchivePath(dbPath) {
  return `${dbPath}.gz`;
}

// Keep only stream-sized chunks in memory, even as the database grows.
export async function ensureVehicleDatabase(dbPath) {
  if (fs.existsSync(dbPath)) return { prepared: false, path: dbPath };
  const archivePath = vehicleDatabaseArchivePath(dbPath);
  const parts=archiveParts(archivePath);
  if (!parts && !fs.existsSync(archivePath)) {
    throw new Error(`Vehicle database and archive are missing: ${dbPath}`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporaryPath = `${dbPath}.tmp-${process.pid}`;
  try {
    await pipeline(
      parts ? Readable.from((async function*(){for(const part of parts)for await(const chunk of fs.createReadStream(part))yield chunk;})()) : fs.createReadStream(archivePath),
      createGunzip(),
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
    );
    fs.renameSync(temporaryPath, dbPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { prepared: true, path: dbPath, archivePath };
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

export async function compressVehicleDatabase(dbPath, {splitBytes=0} = {}) {
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

  if(splitBytes>0&&fs.statSync(archivePath).size>splitBytes){
    const oldParts=archiveParts(archivePath)??[];
    const size=fs.statSync(archivePath).size,parts=[];
    for(let start=0,index=1;start<size;start+=splitBytes,index++){
      const part=archivePath+'.part-'+String(index).padStart(4,'0');
      await pipeline(fs.createReadStream(archivePath,{start,end:Math.min(start+splitBytes,size)-1}),fs.createWriteStream(part));
      parts.push(part);
    }
    fs.writeFileSync(archivePath+'.parts.json',JSON.stringify({version:1,parts:parts.map(p=>path.basename(p))})+'\n');
    fs.rmSync(archivePath);
    for(const old of oldParts)if(!parts.includes(old))fs.rmSync(old,{force:true});
    return archivePath+'.parts.json';
  }
  if(fs.existsSync(archivePath+'.parts.json')){
    for(const part of archiveParts(archivePath))fs.rmSync(part,{force:true});
    fs.rmSync(archivePath+'.parts.json');
  }
  return archivePath;
}
