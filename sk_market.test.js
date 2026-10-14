import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSkListing, parseSkDetail, sitemapLocations } from './sk_sources.js';
import { createSkDatabase, saveSkRows, reconcileSkMissing, discoverSkListings, updateSkSources } from './sk_import.js';
import { initVehicleDb } from './price_db.js';
import { requestedMarket } from './market_routing.js';
import { robotsPolicy } from './niche_sources.js';

const url = id => `https://www.autobazar.eu/detail/skoda-octavia/${id}/`;
const page = (id, price = 15000) => `<html lang="sk"><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{statusCode:200,advertisement:{id,
  brandValue:'Skoda',carModelValue:'Octavia',yearValue:'2020',finalPrice:price,
  categoryValue:'Osobné vozidlá',mileage:100000,fuelValue:'Diesel',title:'Skoda Octavia'}}}})}</script></html>`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'carprice-sk-'));
  const filename = path.join(dir,'sk.db');
  const db = createSkDatabase(filename);
  const readers = [];
  t.after(() => { for (const r of readers) r.close(); db.close(); fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}); });
  return { db, filename, readers };
}
test('strict market and listing identities reject foreign and malicious hosts', () => {
  assert.equal(requestedMarket({}), 'CZ');
  assert.equal(requestedMarket({market:'sk'}), 'SK');
  assert.throws(() => requestedMarket({market:'DE'}));
  for (const input of ['https://auto.bazos.cz/inzerat/1/car.php', 'https://www.autovia.sk.evil/detail/car/Aa/',
    'https://user:pass@www.autobazar.eu/detail/car/Aa/', 'https://www.autovia.sk/vysledky/']) assert.equal(parseSkListing(input),null);
});
test('robots matches the crawler product token, not another bot with a similar name',()=>{
  const policy=robotsPolicy('User-agent: *\nDisallow: /private\nUser-agent: pricebot\nDisallow: /');
  assert.equal(policy.allows(new URL('https://auto.bazos.sk/inzerat/1/car.php')),true);
  assert.equal(policy.allows(new URL('https://auto.bazos.sk/private')),false);
  assert.equal(robotsPolicy('User-agent: CarPriceBot\nDisallow: /').allows(new URL('https://auto.bazos.sk/')),false);
});
test('embedded portal data validates identity and full purchase price', () => {
  const row = parseSkDetail(page('Aa', 14990),url('Aa'));
  assert.equal(row.price,'14990'); assert.equal(row.currency,'EUR');
  assert.equal(parseSkDetail(page('Bb'),url('Aa')),null);
  assert.equal(parseSkDetail(page('Aa',0),url('Aa')).price,null);
  assert.equal(parseSkDetail(page('Aa').replace('"finalPrice":15000','"priceCurrency":"CZK","finalPrice":15000'),url('Aa')),null);
});
test('SK estimates use EUR, exclude stale/CZ rows and deduplicate shared vehicles', t => {
  const {db,filename,readers} = fixture(t);
  const now = new Date().toISOString();
  const rows = [10000,15000,20000].map((p,i)=>parseSkDetail(page('A'+i,p),url('A'+i),[],now));
  saveSkRows(db, rows);
  const mirror = {...rows[1],source_db:'autovia',source_url:'https://www.autovia.sk/detail/skoda-octavia/A1/'};
  saveSkRows(db,[mirror]);
  const stale = {...rows[0],source_id:'Old',source_url:url('Old'),price:'1000000',
    last_seen_at:'2020-01-01T00:00:00Z',last_checked_at:'2020-01-01T00:00:00Z'};
  saveSkRows(db,[stale]);
  db.prepare("INSERT INTO vehicle_app (brand,model,year,price,market,currency,source_url,brand_norm,model_norm) VALUES ('Skoda','Octavia','2020','300000','CZ','CZK','https://www.sauto.cz/car','skoda','octavia')").run();
  const sk = initVehicleDb(filename,{market:'SK'}); readers.push(sk);
  const input = {brand:'Skoda',model:'Octavia',year:2020};
  const estimate = sk.estimatePrice(input);
  assert.equal(estimate.price,15000); assert.equal(estimate.currency,'EUR'); assert.equal(estimate.count,3);
  assert.equal(estimate.price_czk,undefined); assert.equal(sk.findComps(input,100).length,3);
  const cz = initVehicleDb(filename); readers.push(cz);
  assert.equal(cz.findComps(input,100).every(r=>r.url.includes('sauto.cz')),true);
});
test('incomplete discovery and network failures do not remove saved listings', async t => {
  const {db} = fixture(t);
  saveSkRows(db,[parseSkDetail(page('Aa'),url('Aa'))]);
  assert.equal(reconcileSkMissing(db,'autobazar_eu',new Set(['Bb']),{complete:false,now:new Date().toISOString()}),0);
  const summary = await updateSkSources(db,{sources:[{id:'autobazar_eu',host:'www.autobazar.eu'}],readerFactory:async()=>{throw Error('HTTP 429');}});
  assert.equal(summary[0].ok,false);
  assert.equal(db.prepare('SELECT is_active FROM vehicle_app').get().is_active,1);
});
test('missing records require three complete source checks', t => {
  const {db} = fixture(t); saveSkRows(db,[parseSkDetail(page('Aa'),url('Aa'))]);
  for(let i=0;i<3;i++) reconcileSkMissing(db,'autobazar_eu',new Set(['Bb']),{complete:true,now:new Date().toISOString()});
  assert.equal(db.prepare('SELECT is_active FROM vehicle_app').get().is_active,0);
});
test('sitemap parser ignores image and alternate-language URLs and caps incomplete scans',async()=>{
  assert.deepEqual(sitemapLocations(`<urlset><url><loc>${url('Aa')}</loc><image:image><image:loc>https://cdn/image</image:loc></image:image></url></urlset>`),[url('Aa')]);
  assert.throws(()=>sitemapLocations('<urlset><url>'));
  const result=await discoverSkListings({id:'autobazar_eu',host:'www.autobazar.eu',sitemap:'/root'},async()=>({status:200,html:'<sitemapindex><sitemap><loc>https://www.autobazar.eu/sitemap/sitemap-listings-osobne-vozidla-sk.xml</loc></sitemap></sitemapindex>'}),{maxSitemaps:1});
  assert.equal(result.complete,false);
});
