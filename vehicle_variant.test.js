import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initVehicleDb } from './price_db.js';
import { normalizePowertrain, matchesEdition, matchesEngine } from './vehicle_variant.js';
const cases = [
  ['Hybrid','hybrid'],['eHybrid','phev'],['PHEV','phev'],['Plug-in hybrid','phev'],
  ['Benzín + elektro','hybrid'],['BA+EL','hybrid'],['Mild hybrid','mhev'],
  ['MHEV','mhev'],['HEV','hev'],['Benzín','benzin'],['Nafta','diesel'],['D','diesel'],
  ['Elektro','elektro'],['Benzín + LPG','lpg'],['CNG','cng'],['unknown',''],
];
for (const [fuel, expected] of cases) test('canonical fuel: '+fuel, () => assert.equal(normalizePowertrain({fuel}),expected));
test('structured motor and title distinguish electrification despite generic petrol label', () => {
  assert.equal(normalizePowertrain({fuel:'Benzin',motor:'1.4 eHybrid'}),'phev');
  assert.equal(normalizePowertrain({fuel:'Benzin',motor:'1.5 eTSI'}),'mhev');
  assert.equal(normalizePowertrain({fuel:'Benzin',title:'Model GTE'}),'phev');
});
test('trim and engine matching use boundaries and known engine size/family', () => {
  assert.equal(matchesEdition('FR','front parking sensors'),false);
  assert.equal(matchesEdition('FR','Tarraco FR 1.4'),true);
  assert.equal(matchesEdition('Monte Carlo','Fabia MonteCarlo'),true);
  assert.equal(matchesEngine('1.4 TSI','1.5 TSI'),false);
  assert.equal(matchesEngine('1.4 TSI','1.4 TDI'),false);
  assert.equal(matchesEngine('1.4 TSI','Tarraco 1.4 TSI eHybrid'),true);
});
function fixture(rows) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'carprice-variants-'));
 const file=path.join(dir,'fixture.db');
 const db=new Database(file);
 db.exec(`CREATE TABLE vehicle_app (
 brand, model, year, mileage, fuel, motor, price, transmission, drive, source_url, source_db,
 title, kw, brand_norm, model_norm, fuel_norm, transmission_norm, drive_norm, motor_norm, trim_norm,
 is_active, market, currency, last_seen_at, last_checked_at, missing_checks)`);
 const now=new Date().toISOString();
 const insert=db.prepare(`INSERT INTO vehicle_app VALUES
 ('Seat','Tarraco',@year,'50000',@fuel,@motor,@price,'automatic','fwd',@url,'sauto',
 @title,@kw,'seat','tarraco',@fuelNorm,'automatic','fwd',@motor,@trim,1,'CZ','CZK',@now,@now,0)`);
 db.transaction(() => { for (let i=0;i<rows.length;i++) insert.run({
   year:'2021',fuel:'Benzin',motor:'1.4 TSI eHybrid',price:'800000',kw:'180',
   title:'Seat Tarraco eHybrid FR',fuelNorm:'benzin',trim:'fr',...rows[i],
   url:'https://www.sauto.cz/osobni/detail/seat/tarraco/'+(210000000+i),now
 }); })();
 db.close();
 const api=initVehicleDb(file);
 return {api, close(){api.close(); const resolved=path.resolve(dir);
   assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
   assert.ok(path.basename(resolved).startsWith('carprice-variants-'));fs.rmSync(resolved,{recursive:true,force:true});}};
}
const input={brand:'Seat',model:'Tarraco',year:2021,fuel:'PHEV',motor:'1.4 TSI',modelDetail:'FR',kw:180};
const petrol={fuel:'Benzin',motor:'1.5 TSI',kw:110,price:'400000',title:'Seat Tarraco Style',trim:'style'};
test('PHEV estimate and comps never include petrol, diesel, HEV, MHEV or unknown', () => {
 const f=fixture([...Array(3).fill({}), ...Array(30).fill(petrol),
 {fuel:'Diesel',motor:'2.0 TDI',title:'Tarraco FR',kw:180}, {fuel:'Hybrid',motor:'',title:'Tarraco FR'},
 {fuel:'HEV',motor:'1.4 TSI',title:'Tarraco HEV FR'}, {fuel:'MHEV',motor:'1.4 TSI',title:'Tarraco FR'}]);
 try {
 const result=f.api.estimatePrice(input);
 assert.equal(result.found,true);assert.equal(result.count,3);assert.equal(result.price_czk,800000);
 assert.equal(result.matching.powertrain,'phev'); assert.equal(result.matching.trim_applied,true);
 const comps=f.api.findComps(input,5000);assert.equal(comps.length,3);
 assert.ok(comps.every(row=>row.powertrain==='phev'&&row.title.includes('FR')));
 } finally {f.close();}
});
test('insufficient PHEV data stays insufficient rather than widening to cheap petrol', () => {
 const f=fixture([{}, {}, ...Array(30).fill(petrol)]);
 try {const r=f.api.estimatePrice(input);assert.equal(r.found,false);assert.equal(r.count,2);
 assert.equal(r.price_czk,null);assert.equal(r.price_estimate_not_found_reason,'insufficient_comparable_vehicles');
 assert.equal(f.api.findComps(input,5000).length,2);
 }finally{f.close();}
});
test('explicit trim, power and engine stay required in every fallback', () => {
 for (const override of [{trim:'style',title:'Tarraco eHybrid Style'},
 {motor:'1.5 TSI eHybrid'}, {kw:110},
 {trim:'',title:'Tarraco eHybrid',motor:'1.4 TSI eHybrid'}]) {
 const f=fixture([{}, {}, ...Array(25).fill(override)]);
 try {assert.equal(f.api.estimatePrice(input).found,false);assert.equal(f.api.findComps(input,5000).length,2);}
 finally{f.close();}
 }
});
test('generic hybrid and mixed unqualified requests do not produce confident prices', () => {
 const f=fixture([{}, {}, {}, ...Array(25).fill(petrol)]);
 try {
 for (const request of [{...input,fuel:'Hybrid',motor:'',modelDetail:''},
 {brand:'Seat',model:'Tarraco',year:2021}]) {
 const r=f.api.estimatePrice(request);assert.equal(r.found,false);
 assert.equal(r.price_estimate_not_found_reason,'powertrain_unconfirmed');
 }
 }finally{f.close();}
});
test('trend uses the same protected powertrain and trim constraints', () => {
 const f=fixture([{}, {}, {}, ...Array(25).fill(petrol)]);
 try {const rows=f.api.findComps({...input,mode:'trend'},5000);
 assert.equal(rows.length,3);assert.ok(rows.every(row=>row.powertrain==='phev'));}
 finally{f.close();}
});
test('petrol comparisons exclude explicit electrified motors even with stale fuel_norm', () => {
 const f=fixture([{}, {}, {}, ...Array(3).fill(petrol)]);
 try {const r=f.api.estimatePrice({brand:'Seat',model:'Tarraco',year:2021,fuel:'Benzin',kw:110});
 assert.equal(r.found,true);assert.equal(r.count,3);assert.equal(r.price_czk,400000);}
 finally{f.close();}
});
test('strict filters run before candidate limits, even after thousands of wrong variants', () => {
 const f=fixture([...Array(5001).fill(petrol), {}, {}, {}]);
 try {const result=f.api.estimatePrice(input);assert.equal(result.found,true);
 assert.equal(result.count,3);assert.equal(result.price_czk,800000);}
 finally{f.close();}
});
