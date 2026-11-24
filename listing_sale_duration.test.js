import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { listingSaleDuration } from './listing_sale_duration.js';

const now = new Date('2026-11-24T12:00:00Z');
const url = (source, id) => source === 'sauto'
  ? `https://www.sauto.cz/osobni/detail/skoda/octavia/${id}` : `https://auto.bazos.cz/inzerat/${id}/octavia.php`;
const options = { now, minSupport: 1 };
function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE vehicle_app(source_url TEXT,source_db TEXT,market TEXT,currency TEXT,brand TEXT,brand_norm TEXT,
    model TEXT,model_norm TEXT,year TEXT,mileage TEXT,fuel TEXT,motor TEXT,title TEXT,transmission TEXT,drive TEXT,
    engine_l TEXT,kw TEXT,is_active INTEGER,missing_checks INTEGER,first_seen_at TEXT,first_seen_is_observed INTEGER,
    last_seen_at TEXT,last_checked_at TEXT,missing_since TEXT,inactive_at TEXT,published_at TEXT)`);
  return db;
}
function add(db, id, extra = {}) {
  const row = { source_url: url('sauto', id), brand: 'Škoda',brand_norm:'skoda',model:'Octavia',model_norm:'octavia',
    year:'2020',mileage:'120000',fuel:'Benzín',motor:'1.5 TSI',title:'Škoda Octavia 1.5 TSI',transmission:'manuální',
    drive:'Přední',engine_l:'1.5',kw:'110',is_active:0,missing_checks:3,first_seen_at:'2026-09-01T00:00:00Z',
    first_seen_is_observed:1,last_seen_at:'2026-09-10T00:00:00Z',last_checked_at:'2026-09-13T00:00:00Z',
    missing_since:'2026-09-11T00:00:00Z',inactive_at:'2026-09-13T00:00:00Z',...extra };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO vehicle_app (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
}
const query = { brand:'Škoda',model:'Octavia',year:2020,fuel:'Benzín' };

test('combines Sauto/Bazos means, medians, distribution and source counts, ending at first absence', () => {
  const db=database(); try {
    add(db,1);add(db,2,{source_url:url('bazos',2),missing_since:'2026-09-21T00:00:00Z',last_seen_at:'2026-09-20T00:00:00Z'});
    const result=listingSaleDuration(db,query,options);
    assert.equal(result.found,true);assert.equal(result.average_days,15);assert.equal(result.median_days,15);
    assert.equal(result.p25_days,12.5);assert.equal(result.p75_days,17.5);assert.equal(result.sample_size,2);
    assert.equal(result.by_source.sauto.average_days,10);assert.equal(result.by_source.bazos.average_days,20);
    assert.equal(result.date_basis.missing_since,2);assert.equal(result.assumption,'withdrawn_listing_is_sold');
  } finally {db.close();}
});

test('deduplicates query URLs and uses earliest known start; latest active duplicate cancels sold outcome',()=>{
  const db=database();try {
    add(db,1,{first_seen_at:'2026-09-03T00:00:00Z'});add(db,1,{source_url:url('sauto',1)+'?foo=1'});
    add(db,2);add(db,2,{is_active:1,missing_checks:0,missing_since:null,inactive_at:null,last_checked_at:'2026-11-23T00:00:00Z'});
    const result=listingSaleDuration(db,query,options);
    assert.equal(result.sample_size,1);assert.equal(result.average_days,10);assert.equal(result.active_count,1);assert.equal(result.sold_count,1);
  }finally{db.close();}
});

test('reads complete-index first observations, includes legacy starts, and prefers publication dates',()=>{
  const db=database();try {
    db.exec('CREATE TABLE listing_first_seen(listing_key TEXT PRIMARY KEY,first_seen_at TEXT,first_seen_is_observed INTEGER)');
    add(db,1,{first_seen_at:'2026-09-05T00:00:00Z'});
    db.prepare('INSERT INTO listing_first_seen VALUES (?,?,?)').run('sauto:1','2026-08-22T00:00:00Z',0);
    add(db,2,{published_at:'2026-08-12T00:00:00Z'});
    const result=listingSaleDuration(db,query,options);
    assert.equal(result.average_days,25);assert.equal(result.date_basis.published,1);assert.equal(result.date_basis.legacy_first_observed,1);
    assert.equal(result.period.first_seen_from,'2026-08-12T00:00:00.000Z');
  }finally{db.close();}
});

test('excludes missing, reversed and future dates, absent live evidence never manufactures a start',()=>{
  const db=database();try {
    add(db,1,{first_seen_at:null});add(db,2,{first_seen_at:'2026-10-01T00:00:00Z'});
    add(db,3,{missing_since:'2027-01-01T00:00:00Z',inactive_at:null});
    add(db,4,{missing_since:null,inactive_at:'2026-09-13T00:00:00Z'});
    const result=listingSaleDuration(db,query,options);
    assert.equal(result.sample_size,1);assert.equal(result.average_days,12);assert.equal(result.excluded_missing_dates,3);
    assert.equal(result.date_basis.inactive_at,1);
  }finally{db.close();}
});

test('excludes SK, motorcycles, Sauto utility and Bazos parts; exact model prevents Grand Scenic contamination',()=>{
  const db=database();try {
    add(db,1);add(db,2,{source_url:'https://auto.bazos.sk/inzerat/2/octavia.php'});
    add(db,3,{source_url:'https://motorky.bazos.cz/inzerat/3/octavia.php'});
    add(db,4,{source_url:'https://www.sauto.cz/uzitkova/detail/skoda/octavia/4'});
    add(db,5,{source_url:url('bazos',5),title:'Náhradní díly Škoda Octavia'});
    add(db,6,{market:'SK'});add(db,7,{model:'Grand Octavia',model_norm:'grand octavia'});
    assert.equal(listingSaleDuration(db,query,options).sample_size,1);
  }finally{db.close();}
});

test('uses most specific supported cohort and explicitly broadens to model when needed',()=>{
  const db=database();try {
    for(let id=1;id<=5;id++)add(db,id);
    add(db,6,{year:'2005',missing_since:'2026-10-01T00:00:00Z',last_seen_at:'2026-09-30T00:00:00Z'});
    const strict=listingSaleDuration(db,{...query,engine_l:1.5,mileage_km:120000,transmission:'manuální'},{now});
    assert.equal(strict.match_level,'variant');assert.equal(strict.sample_size,5);assert.equal(strict.filters.engine_l,1.5);
    const broad=listingSaleDuration(db,{...query,year:1980},{now});
    assert.equal(broad.match_level,'model');assert.equal(broad.sample_size,6);assert.equal(broad.average_days,13.3);
    const insufficient=listingSaleDuration(db,{brand:'Škoda',model:'Fabia'},{now});
    assert.equal(insufficient.found,false);assert.equal(insufficient.average_days,null);assert.equal(insufficient.sample_size,0);
  }finally{db.close();}
});

test('normalizes BMW series aliases without substring matches',()=>{
  const db=database();try {
    add(db,1,{brand:'BMW',brand_norm:'bmw',model:'Řada 3',model_norm:'rada 3'});
    add(db,2,{brand:'BMW',brand_norm:'bmw',model:'Řada 5',model_norm:'rada 5'});
    add(db,3,{brand:'BMW',brand_norm:'bmw',model:'320d',model_norm:'320d'});
    add(db,4,{brand:'BMW',brand_norm:'bmw',model:'M3',model_norm:'m3'});
    add(db,5,{brand:'BMW',brand_norm:'bmw',model:'3 GT',model_norm:'3 gt'});
    assert.equal(listingSaleDuration(db,{brand:'BMW',model:'3 series'},options).sample_size,2);
    assert.equal(listingSaleDuration(db,{brand:'BMW',model:'320d'},options).sample_size,1);
  }finally{db.close();}
});

test('source filter selects only the requested portal and rejects unknown sources',()=>{
  const db=database();try {
    add(db,1);add(db,2,{source_url:url('bazos',2)});
    const result=listingSaleDuration(db,{...query,source:'bazos'},options);
    assert.equal(result.sample_size,1);assert.equal(result.by_source.sauto.sample_size,0);
    assert.throws(()=>listingSaleDuration(db,{...query,source:'other'},options),/invalid_source/);
  }finally{db.close();}
});

test('publication later than a recorded live observation is rejected in favor of first observation',()=>{
  const db=database();try {
    add(db,1,{published_at:'2026-09-05T00:00:00Z'});
    const result=listingSaleDuration(db,query,options);
    assert.equal(result.average_days,10);assert.equal(result.date_basis.published,0);assert.equal(result.date_basis.first_observed,1);
  }finally{db.close();}
});

test('recognizes historic Megane Scenic aliases while preserving Grand Scenic isolation',()=>{
  const db=database();try {
    add(db,1,{brand:'Renault',brand_norm:'renault',model:'Megane Scenic',model_norm:'megane scenic',title:'Renault Megane Scenic'});
    add(db,2,{brand:'Renault',brand_norm:'renault',model:'Scenic',model_norm:'scenic',title:'Renault Grand Scenic'});
    assert.equal(listingSaleDuration(db,{brand:'Renault',model:'Scenic'},options).sample_size,1);
    assert.equal(listingSaleDuration(db,{brand:'Renault',model:'Grand Scenic'},options).sample_size,1);
  }finally{db.close();}
});

test('rejects invalid query values',()=>{
  const db=database();try {
    assert.throws(()=>listingSaleDuration(db,{},options),/brand_model_required/);
    assert.throws(()=>listingSaleDuration(db,{...query,year:'2020'},options),/invalid_year/);
  }finally{db.close();}
});

test('match labels describe only filters actually requested and applied',()=>{
  const db=database();try {
    add(db,1);
    assert.equal(listingSaleDuration(db,{brand:'Škoda',model:'Octavia'},options).match_level,'model');
    assert.equal(listingSaleDuration(db,{brand:'Škoda',model:'Octavia',year:2020},options).match_level,'year');
    assert.equal(listingSaleDuration(db,{brand:'Škoda',model:'Octavia',fuel:'Benzín'},options).match_level,'fuel');
    assert.equal(listingSaleDuration(db,query,options).match_level,'year_fuel');
    assert.equal(listingSaleDuration(db,{brand:'Škoda',model:'Octavia'},options).filters.year,null);
  }finally{db.close();}
});

test('year lookup reads the narrow window first and broadens only after insufficient completed samples',()=>{
  const db=database();try {
    add(db,1);add(db,2,{year:'2017'});add(db,3,{year:'2000'});
    const selected=[];
    const nearby=listingSaleDuration(db,query,{now,minSupport:1,onStage:event=>{if(event.stage==='selected')selected.push(event);}});
    assert.equal(nearby.sample_size,1);assert.deepEqual(selected.map(event=>event.year_window),[2]);assert.equal(selected[0].count,1);
    selected.length=0;
    const wider=listingSaleDuration(db,query,{now,minSupport:2,onStage:event=>{if(event.stage==='selected')selected.push(event);}});
    assert.equal(wider.match_level,'year');assert.equal(wider.sample_size,2);assert.deepEqual(selected.map(event=>event.year_window),[2,4]);
    selected.length=0;
    const whole=listingSaleDuration(db,query,{now,minSupport:3,onStage:event=>{if(event.stage==='selected')selected.push(event);}});
    assert.equal(whole.match_level,'model');assert.equal(whole.sample_size,3);assert.deepEqual(selected.map(event=>event.year_window),[2,4,null]);
  }finally{db.close();}
});

test('indexed year bounds support INTEGER-affinity imports as well as TEXT years',()=>{
  const db=new Database(':memory:');try {
    db.exec(`CREATE TABLE vehicle_app(source_url TEXT,brand TEXT,model TEXT,year INTEGER,is_active INTEGER,
      first_seen_at TEXT,missing_since TEXT,last_checked_at TEXT)`);
    db.prepare('INSERT INTO vehicle_app VALUES (?,?,?,?,?,?,?,?)').run(url('sauto',1),'Škoda','Octavia',2020,0,
      '2026-09-01T00:00:00Z','2026-09-11T00:00:00Z','2026-09-13T00:00:00Z');
    assert.equal(listingSaleDuration(db,{brand:'Škoda',model:'Octavia',year:2020},options).average_days,10);
  }finally{db.close();}
});
