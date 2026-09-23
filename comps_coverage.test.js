import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initVehicleDb } from './price_db.js';

test('comps exposes more than 30, both sources, and independent model-year sample', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carprice-comps-'));
  const file = path.join(dir, 'fixture.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE vehicle_app (
    brand, model, year, mileage, fuel, motor, price, transmission, drive,
    source_url, source_db, title, kw, brand_norm, model_norm, fuel_norm,
    transmission_norm, drive_norm, motor_norm, trim_norm, is_active)`);
  const insert = db.prepare(`INSERT INTO vehicle_app VALUES (
    'Skoda','Fabia',?,'100000','Benzin','','195000','','',?,?,
    'Skoda Fabia','66','skoda','fabia','benzin','','','','',?)`);
  for (let i=0;i<120;i++) insert.run('2016',
    i<96 ? `https://www.sauto.cz/osobni/detail/skoda/fabia/${210000000+i}`
      : `https://auto.bazos.cz/inzerat/${210000000+i}/skoda-fabia.php`,
    i<96?'sauto':'bazos',1);
  for (const year of [2012,2013,2019,2020]) insert.run(String(year),
    `https://www.sauto.cz/osobni/detail/skoda/fabia/${220000000+year}`,'sauto',1);
  insert.run('2016','https://auto.bazos.cz/inzerat/299999999/removed.php','bazos',0);
  db.close();
  const api=initVehicleDb(file);
  try {
    const input={brand:'Skoda',model:'Fabia',year:2016,fuel:'benzin'};
    const before=api.estimatePrice(input);
    const all=api.findComps(input,5000);
    assert.equal(all.length,120);
    assert.equal(all.filter(v=>v.source==='bazos').length,24);
    assert.equal(api.findComps(input,30).filter(v=>v.source==='bazos').length,15);
    assert.ok(all.every(v=>v.kw===66));
    const chart=api.findComps({...input,mode:'trend'},5000);
    assert.deepEqual([...new Set(chart.map(v=>v.year))].sort(),[2012,2013,2016,2019,2020]);
    assert.deepEqual(api.estimatePrice(input),before);
    assert.equal(api.findComps(input,NaN).length,12);
    assert.equal(api.findComps({...input,mode:'trend',brand:''},5000).length,0);
  } finally { api.close(); }
});
