import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initVehicleDb } from './price_db.js';
import { ANNOTATED_SPECS_POLICY, assessSpec } from './comparison_policy.js';

test('missing specs may be included but known opposites and conflicting evidence cannot', () => {
  for (const kind of ['drive', 'transmission']) {
    const wanted = kind === 'drive' ? 'Přední' : 'Manuál';
    assert.deepEqual(assessSpec(kind, wanted, '', '', ''), { include: true, unknown: true });
    assert.equal(assessSpec(kind, wanted, kind === 'drive' ? '4x4' : 'Automatická', '', '').include, false);
    assert.equal(assessSpec(kind, wanted, '', '', kind === 'drive' ? 'Fabia 4Motion' : 'Fabia DSG').include, false);
    assert.equal(assessSpec(kind, wanted, 'unrecognized nonempty value', '', '').include, false);
  }
  assert.deepEqual(assessSpec('drive', 'Přední', '4x2', '', ''), { include: true, unknown: true });
  assert.equal(assessSpec('drive', '4x4', '4x2', '', '').include, false);
  assert.equal(assessSpec('transmission', 'Automat', 'Poloautomatická', '', '').include, false);
  assert.equal(assessSpec('drive', 'Přední', 'Přední', 'rwd', '').include, false);
  assert.deepEqual(assessSpec('transmission', 'Manuál', 'Manuální', 'manual', 'Fabia'), { include: true, unknown: false });
});

const input = { brand: 'Skoda', model: 'Fabia', year: 2006, mileage: 136134, kw: 55, motor: '1.4 16V',
  fuel: 'benzin', transmission: 'Manuál', drive: 'Přední' };
const annotated = { ...input, comparison_policy: ANNOTATED_SPECS_POLICY };
function fixture(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-partial-specs-'));
  const file = path.join(dir, 'fixture.db'), db = new Database(file);
  const columns = ['brand','model','year','mileage','fuel','motor','price','transmission','drive','source_url','source_db',
    'title','kw','brand_norm','model_norm','fuel_norm','transmission_norm','drive_norm','motor_norm','trim_norm',
    'is_active','last_seen_at','last_checked_at','missing_checks'];
  db.exec('CREATE TABLE vehicle_app (' + columns.join(',') + ')');
  const insert = db.prepare('INSERT INTO vehicle_app VALUES (' + columns.map(key => '@' + key).join(',') + ')');
  const now = new Date().toISOString();
  rows.forEach((patch, index) => insert.run({
    brand:'Skoda',model:'Fabia',year:'2006',mileage:'136134',fuel:'Benzin',motor:'1.4 16V',price:'60000',
    transmission:'Manuální',drive:'Přední',source_db:'sauto',source_url:'https://www.sauto.cz/osobni/detail/skoda/fabia/' + (210000000 + index),
    title:'Skoda Fabia 1.4 16V',kw:'55',brand_norm:'skoda',model_norm:'fabia',fuel_norm:'benzin',transmission_norm:'manual',
    drive_norm:'predni',motor_norm:'1 4 16v',trim_norm:'',is_active:1,last_seen_at:now,last_checked_at:now,missing_checks:0,...patch,
  }));
  db.close();
  const api = initVehicleDb(file);
  return { api, close() { api.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('carprice-partial-specs-')); fs.rmSync(dir, { recursive:true, force:true }); } };
}
const bazos = index => ({source_db:'bazos',source_url:`https://auto.bazos.cz/inzerat/${190000000 + index}/skoda-fabia.php`,drive:'',drive_norm:''});
const niche = (source, index) => ({source_db:source,source_url:`https://www.${source}.cz/${100000 + index}-skoda-fabia`});

test('all four sources participate when eligible, with exact uncertainty counts; default behavior stays strict', () => {
  const f = fixture([
    {price:'50000'},{price:'60000'},{price:'70000'},
    {...bazos(1),price:'55000'},
    {...bazos(2),price:'45000',transmission:'',transmission_norm:''},
    {...niche('sportovnivozy',1),price:'75000'},
    {...niche('rajveteranu',1),price:'65000',transmission:'',transmission_norm:''},
    {...bazos(3),price:'5000000',transmission:'Automat',transmission_norm:'automat'},
    {...bazos(4),price:'5000000',transmission:'',transmission_norm:'',title:'Skoda Fabia 1.4 16V DSG'},
    {...bazos(5),price:'5000000',title:'Skoda Fabia 1.4 16V 4x4'},
    {...bazos(6),price:'5000000',motor:'2.0 TDI',fuel:'Nafta',fuel_norm:'diesel',title:'Skoda Fabia 2.0 TDI'},
    {...bazos(7),price:'5000000',kw:'180'},
    {...bazos(8),price:'5000000',year:'2016'},
    {...niche('sportovnivozy',2),price:'5000000',last_seen_at:'2020-01-01T00:00:00Z',last_checked_at:'2020-01-01T00:00:00Z'},
    {...niche('rajveteranu',2),price:'5000000',is_active:0},
    {...bazos(9),source_db:'caroffice-dealer-prodano',price:'5000000'},
  ]);
  try {
    const strict = f.api.estimatePrice(input);
    assert.equal(strict.count,4); assert.equal(strict.partial_specs,undefined); assert.equal(strict.matching.comparison_policy,undefined);
    assert.equal(f.api.estimatePrice({...input,comparison_policy:'unknown'}).count,strict.count);
    const result = f.api.estimatePrice(annotated);
    assert.equal(result.count,7); assert.equal(result.price_czk,60000);
    assert.deepEqual(result.source_counts,{sauto:3,bazos:2,sportovnivozy:1,rajveteranu:1,other:0});
    assert.equal(result.comparison_policy,ANNOTATED_SPECS_POLICY);
    assert.equal(result.partial_specs.partial_count,3);
    assert.equal(result.partial_specs.drive_unknown,2);
    assert.equal(result.partial_specs.transmission_unknown,2);
    assert.equal(result.partial_specs.by_source.bazos.drive_unknown,2);
    assert.equal(result.matching.drive_fully_confirmed,false);
    assert.equal(result.matching.transmission_fully_confirmed,false);
    const comps = f.api.findComps(annotated,5000);
    assert.equal(comps.length,result.count); assert.ok(comps.every(row=>row.price_czk<100000));
    assert.equal(comps.filter(row=>row.comparison_unknown.includes('drive')).length,2);
    assert.equal(comps.filter(row=>row.comparison_unknown.includes('transmission')).length,2);
  } finally { f.close(); }
});

test('partially specified ads cannot bypass minimum comparables, powertrain, engine, power or niche freshness', () => {
  const f = fixture([{...bazos(1)},{...bazos(2)},
    {...niche('rajveteranu',3),last_seen_at:'2020-01-01T00:00:00Z',last_checked_at:'2020-01-01T00:00:00Z'}]);
  try {
    const result=f.api.estimatePrice(annotated); assert.equal(result.count,2); assert.equal(result.found,false);
    assert.equal(result.price_estimate_not_found_reason,'insufficient_comparable_vehicles');
    assert.equal(result.partial_specs.drive_unknown,2);
    assert.equal(f.api.estimatePrice({...annotated,fuel:'PHEV'}).count,0);
    assert.equal(f.api.estimatePrice({...annotated,motor:'2.0 TDI'}).count,0);
    assert.equal(f.api.estimatePrice({...annotated,kw:180}).count,0);
  } finally {f.close();}
});
