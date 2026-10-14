import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {compressVehicleDatabase,ensureVehicleDatabase} from './vehicle_db_archive.js';
test('large SK archives split into bounded Git files and restore with identical bytes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sk-archive-')),filename=path.join(dir,'vehicles_sk.db');
  try{
    const bytes=randomBytes(16384);fs.writeFileSync(filename,bytes);
    const manifest=await compressVehicleDatabase(filename,{splitBytes:3000});
    const {parts}=JSON.parse(fs.readFileSync(manifest,'utf8'));assert.ok(parts.length>1);
    assert.ok(parts.every(p=>fs.statSync(path.join(dir,p)).size<=3000));
    fs.unlinkSync(filename);await ensureVehicleDatabase(filename);
    assert.deepEqual(fs.readFileSync(filename),bytes);
    await compressVehicleDatabase(filename);
    assert.equal(fs.existsSync(manifest),false);assert.ok(parts.every(p=>!fs.existsSync(path.join(dir,p))));
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
