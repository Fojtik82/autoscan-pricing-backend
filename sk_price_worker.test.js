import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSkDatabase, saveSkRows } from './sk_import.js';
import { initVehicleDb } from './price_db.js';
import { initSkPriceClient } from './sk_price_client.js';

async function fixture(t, options) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'carprice-sk-worker-'));
  const filename=path.join(directory,'sk.db');
  const db=createSkDatabase(filename);
  const now=new Date().toISOString();
  saveSkRows(db,[10000,15000,20000].map((price,i)=>({
    source_db:'autobazar_eu',source_id:'Worker'+i,
    source_url:'https://www.autobazar.eu/detail/skoda-kamiq/Worker'+i+'/',
    market:'SK',currency:'EUR',brand:'Skoda',model:'Kamiq',year:'2021',
    price:String(price),brand_norm:'skoda',model_norm:'kamiq',title:'Skoda Kamiq',
    motor_norm:'',trim_norm:'',kw:'81',drive:'Predni',drive_norm:'predni',
    last_seen_at:now,last_checked_at:now,is_active:1,missing_checks:0,
  })));
  const client=await initSkPriceClient(filename,options);
  t.after(async()=>{if(db.inTransaction)db.exec('ROLLBACK');await client.close();db.close();
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {db,client,filename};
}

test('SK worker preserves prices, currency, comparable offers and query failures',async t=>{
  const {client,filename}=await fixture(t);
  const direct=initVehicleDb(filename,{market:'SK'});
  try {
    const input={brand:'Skoda',model:'Kamiq',year:2021};
    assert.equal(client.ready,true);
    assert.deepEqual(await client.estimatePrice(input),direct.estimatePrice(input));
    assert.deepEqual(await client.findComps(input,5000),direct.findComps(input,5000));
    await assert.rejects(client.estimatePrice(null));
    assert.equal((await client.health()).count,3);
    assert.equal(client.ready,true);
  }finally{direct.close();}
});

test('a waiting SQLite query cannot block the main thread or health checks',async t=>{
  const {db,client}=await fixture(t);
  await client.health();
  db.exec('BEGIN EXCLUSIVE');
  let settled=false;
  const pending=client.health().finally(()=>{settled=true;});
  pending.catch(()=>{});
  try {
    await delay(30);
    assert.equal(settled,false);
    assert.equal(client.ready,true);
    db.exec('COMMIT');
    assert.equal((await pending).count,3);
  }finally{if(db.inTransaction)db.exec('ROLLBACK');}
});

test('worker query deadline is bounded and later queries can recover',async t=>{
  const {db,client}=await fixture(t,{timeoutMs:40});
  db.exec('BEGIN EXCLUSIVE');
  try {
    await assert.rejects(client.health(),error=>error.code==='price_query_timeout');
  }finally{db.exec('COMMIT');}
  assert.equal((await client.health()).count,3);
});
