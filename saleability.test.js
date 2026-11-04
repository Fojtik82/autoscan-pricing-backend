import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { buildExamples, DAY_MS, features, liveCohort, outcomeAt, predict, priceReferences,
  readSnapshot, scorePredictions, trainModel } from './saleability_model.js';
import { runBacktest } from './saleability_backtest.js';
import { pilotStatus, updateSaleabilityPilot } from './saleability_pilot.js';
import { registerSaleabilityApi } from './saleability_api.js';

const date = (s) => new Date(s).toISOString();
const initial = date('2026-11-04T08:00:00Z');
const record = (source, i, checked = initial) => ({ source,
  key: source === 'sauto' ? `sauto:${200000000+i}` : `bazos:auto.bazos.cz:${200000000+i}`,
  ...features({ brand: 'Škoda', model: 'Octavia', year: 2020, mileage: 150000, fuel: 'nafta', motor: '2.0 TDI',
    transmission: 'DSG', drive: 'fwd', engine_ccm: 1968, price: 300000 }),
  active: true, missing: 0, checked, seen: checked });
function snapshot(checked = initial) {
  const records = new Map();
  for (const source of ['sauto','bazos']) for (let i=0; i<100; i++) { const r=record(source,i,checked); records.set(r.key,r); }
  return { records, checked: { sauto: checked, bazos: checked }, duplicates: 0 };
}
function model() {
  const examples = [...snapshot().records.values()].map((r,i) => ({ ...r, outcome: i%2 }));
  return trainModel({ examples, references: priceReferences(examples) }, {
    train_end: { sauto: '2026-11-01T08:00:00Z', bazos: '2026-11-01T08:00:00Z' }, role: 'test' });
}

test('pending absences, stale evidence, future outcomes and late checks cannot become negative sales labels', () => {
  const r=record('sauto',1), due=initial;
  assert.equal(outcomeAt({...r,missing:1},initial,due).value,null);
  assert.equal(outcomeAt({...r,active:false,missing:2},initial,due).value,null);
  assert.equal(outcomeAt({...r,active:false,missing:3},initial,due).value,1);
  assert.equal(outcomeAt(r,initial,due).value,0);
  assert.equal(outcomeAt(r,date('2026-11-03T08:00:00Z'),due).state,'not_due');
  assert.equal(outcomeAt(r,date('2026-11-07T08:00:00Z'),due).state,'censored_late_check');
  assert.equal(outcomeAt({...r,checked:null},initial,due).value,null);
});

test('source identity deduplicates URLs, excludes motorcycles and rejects conflicting baseline features', () => {
  const db=new Database(':memory:');
  try {
    db.exec('CREATE TABLE vehicle_app(source_url TEXT,is_active INTEGER,missing_checks INTEGER,last_seen_at TEXT,last_checked_at TEXT,brand TEXT,model TEXT,year INTEGER)');
    const insert=db.prepare('INSERT INTO vehicle_app VALUES (?,1,0,?,?,?, ?,2020)');
    insert.run('https://www.sauto.cz/osobni/detail/skoda/octavia/200000001',initial,initial,'skoda','octavia');
    insert.run('https://sauto.cz/osobni/detail/skoda/octavia/200000001?x=1',initial,initial,'skoda','octavia');
    insert.run('https://motorky.bazos.cz/inzerat/200000001/x.php',initial,initial,'honda','cb');
    assert.equal(liveCohort(readSnapshot(db)).length,1);
    insert.run('https://sauto.cz/osobni/detail/skoda/octavia/200000001?x=2',initial,initial,'skoda','fabia');
    assert.equal(liveCohort(readSnapshot(db)).length,0);
  } finally { db.close(); }
});

test('uncertain powertrains and missing variants fall back with explicit scope, and unknown models are withheld', () => {
  const m=model(), r=record('sauto',1);
  assert.equal(predict(m,r,priceReferences([...snapshot().records.values()])).match_level,'variant_price');
  assert.equal(predict(m,{...r,...features({brand:'skoda',model:'octavia',fuel:'plug-in hybrid',year:2020})}).match_level,'model');
  assert.equal(predict(m,{...r,model:'unknown'}).available,false);
  assert.equal(predict(m,r).experimental,true);
  assert.equal(predict(m,r).population,'already_advertised');
});

test('Brier score and calibration have independently known values', () => {
  const rows=Array.from({length:10},(_,i)=>({probability:0.2,baseline:0.5,actual:i<2?1:0}));
  const score=scorePredictions(rows);
  assert.ok(Math.abs(score.brier-0.16)<1e-12);
  assert.ok(Math.abs(score.baseline_brier-0.25)<1e-12);
  assert.ok(score.calibration_error<1e-12);
});

test('chronological benchmark cannot use future outcome prices or an overlapping training window', () => {
  const a=snapshot(date('2026-07-01T08:00:00Z')), b=snapshot(date('2026-07-31T08:00:00Z'));
  const c=snapshot(date('2026-08-02T08:00:00Z')), d=snapshot(date('2026-09-01T08:00:00Z'));
  for (const [i,r] of [...b.records.values()].entries()) if(i%2) {r.active=false;r.missing=3;}
  for (const [i,r] of [...d.records.values()].entries()) if(i%3===0) {r.active=false;r.missing=3;}
  const first=runBacktest({trainStart:a,trainEnd:b,testStart:c,testEnd:d});
  for(const r of d.records.values()) r.price=19000000;
  const second=runBacktest({trainStart:a,trainEnd:b,testStart:c,testEnd:d});
  assert.deepEqual(first.report.overall,second.report.overall);
  assert.equal(first.model.version,second.model.version);
  assert.throws(()=>runBacktest({trainStart:a,trainEnd:c,testStart:b,testEnd:d}),/precede/);
  assert.equal(first.report.production_approved,false);
});

test('a source lacking an early complete index is excluded from historical validation, not invented', () => {
  const a=snapshot(date('2026-07-01T08:00:00Z')), b=snapshot(date('2026-07-31T08:00:00Z'));
  delete a.checked.sauto;
  const data=buildExamples(a,b);
  assert.equal(data.examples.length,100);
  assert.ok(data.examples.every(r=>r.source==='bazos'));
});

test('pilot freezes predictions on retries, waits for maturity and censors unresolved absences', () => {
  const db=new Database(':memory:');
  try {
    const m=model(), start=snapshot();
    assert.equal(updateSaleabilityPilot(db,m,{now:new Date(initial),snapshot:start}).issued,200);
    const original=db.prepare('SELECT listing_key,probability,features_json,due_at FROM saleability_forecasts ORDER BY listing_key').all();
    for(const r of start.records.values()) r.price=1000;
    assert.equal(updateSaleabilityPilot(db,m,{now:new Date(initial),snapshot:start}).issued,0);
    assert.deepEqual(db.prepare('SELECT listing_key,probability,features_json,due_at FROM saleability_forecasts ORDER BY listing_key').all(),original);
    const due=date('2026-12-04T08:00:00Z'), end=snapshot(due);
    const values=[...end.records.values()];
    values[0].missing=2;
    for(let i=1;i<50;i++){values[i].active=false;values[i].missing=3;}
    updateSaleabilityPilot(db,m,{now:new Date(Date.parse(due)-DAY_MS),snapshot:end});
    assert.equal(pilotStatus(db).overall.n,0);
    const result=updateSaleabilityPilot(db,m,{now:new Date(due),snapshot:end});
    assert.equal(result.resolved,199);assert.equal(result.censored,1);
    assert.equal(pilotStatus(db).forecast_count,200);
    assert.equal(pilotStatus(db).overall.n,199);
    assert.equal(pilotStatus(db).production_ready,false);
    assert.deepEqual(db.prepare('SELECT listing_key,probability,features_json,due_at FROM saleability_forecasts ORDER BY listing_key').all(),original);
  } finally { db.close(); }
});

test('pilot needs complete fresh indexes, cannot change the frozen model, and never starts before training ends', () => {
  const db=new Database(':memory:');
  try {
    const m=model();
    assert.equal(updateSaleabilityPilot(db,m,{now:new Date(initial),snapshot:snapshot(),completeSources:['bazos']}).enabled,false);
    updateSaleabilityPilot(db,m,{now:new Date(initial),snapshot:snapshot()});
    assert.equal(updateSaleabilityPilot(db,{...m,version:'different'},{now:new Date(initial),snapshot:snapshot()}).reason,'pilot_model_frozen');
    assert.equal(pilotStatus(db).forecast_count,200);
  } finally { db.close(); }
  const second=new Database(':memory:');
  try {assert.throws(()=>updateSaleabilityPilot(second,model(),{now:new Date('2026-10-01T08:00:00Z'),snapshot:snapshot(date('2026-10-01T08:00:00Z'))}),/training|fresh/);}
  finally {second.close();}
});

test('experimental HTTP API exposes status and scoped references without raw listing IDs', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'saleability-http-'));
  const file=path.join(directory,'test.db');
  const db=new Database(file);
  const now=new Date(), checked=now.toISOString(), snap=snapshot(checked), m=model();
  m.provenance.train_end={sauto:new Date(now.getTime()-DAY_MS).toISOString(),bazos:new Date(now.getTime()-DAY_MS).toISOString()};
  db.exec(`CREATE TABLE vehicle_app(source_url TEXT,brand_norm TEXT,model_norm TEXT,year INTEGER,mileage INTEGER,fuel TEXT,
    transmission TEXT,drive TEXT,engine_ccm INTEGER,price INTEGER,is_active INTEGER,missing_checks INTEGER,last_seen_at TEXT,last_checked_at TEXT)`);
  const insert=db.prepare('INSERT INTO vehicle_app VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?,?)');
  for(const r of snap.records.values()) {
    const id=r.key.split(':').at(-1);
    const url=r.source==='sauto'?`https://sauto.cz/osobni/detail/skoda/octavia/${id}`:`https://auto.bazos.cz/inzerat/${id}/auto.php`;
    insert.run(url,'skoda','octavia',2020,150000,'nafta','DSG','fwd',1968,300000,checked,checked);
  }
  updateSaleabilityPilot(db,m,{now,snapshot:snap});db.close();
  const app=express();app.use(express.json());registerSaleabilityApi(app,file);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const status=await (await fetch(base+'/market/saleability/status')).json();
    assert.equal(status.forecast_count,200);
    const response=await fetch(base+'/market/saleability',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brand:'Škoda',model:'Octavia',year:2020,mileage_km:150000,fuel:'nafta',transmission:'DSG',engine_ccm:1968,asking_price_czk:300000})});
    const result=await response.json();assert.equal(response.status,200);assert.equal(result.found,true);
    assert.equal(result.production_ready,false);assert.equal(result.sources.length,2);
    assert.equal(JSON.stringify(result).includes('200000001'),false);
    assert.equal((await fetch(base+'/market/saleability',{method:'POST',headers:{'content-type':'application/json'},body:'{"brand":"skoda","model":"octavia","year":-1}'})).status,400);
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
});
