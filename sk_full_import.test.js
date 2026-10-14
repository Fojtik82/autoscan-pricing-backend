import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSkDatabase,saveSkRows} from './sk_import.js';
import {runFullSkImport,ensureCrawlSchema} from './sk_full_import.js';
import {parseSkDetail,parseSkListing} from './sk_sources.js';
import {initVehicleDb} from './price_db.js';

const source={id:'autobazar_eu',host:'www.autobazar.eu',sitemap:'/root.xml'};
const url=id=>'https://www.autobazar.eu/detail/honda-cb/'+id+'/';
const ad=(id,extra={})=>({id,brandValue:'Honda',carModelValue:'CB 1100',categoryValue:'Motocykle',yearValue:'2020',
  finalPrice:9000,title:'Honda CB 1100',carEquipmentValue:'ABS, Tempomat, ABS',otherEquipment:'Originálne kufre',description:'Servisná história',...extra});
const page=a=>'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{advertisement:a}}})+'</script>';
const sitemap=ids=>'<urlset>'+ids.map(id=>'<url><loc>'+url(id)+'</loc><lastmod>2026-10-14</lastmod></url>').join('')+'</urlset>';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sk-full-'));const db=createSkDatabase(path.join(dir,'vehicles_sk.db'));db.testReaders=[];t.after(()=>{for(const r of db.testReaders)r.close();db.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return db;}

test('full crawl persists its queue and resumes beyond the previous batch without refetching completed details',async t=>{
  const db=fixture(t);const requested=[];
  const readerFactory=async()=>async u=>{requested.push(u);return {status:200,html:u.endsWith('root.xml')?sitemap(['A1','A2','A3']):page(ad(parseSkListing(u).id))};};
  let status=await runFullSkImport(db,{sources:[source],readerFactory,maxDetails:1});
  assert.equal(status.sources[0].counts.done,1);assert.equal(status.sources[0].counts.pending,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vehicle_app').get().n,1);
  status=await runFullSkImport(db,{sources:[source],readerFactory});
  assert.equal(status.sources[0].phase,'complete');assert.equal(status.sources[0].counts.done,3);
  assert.equal(requested.filter(u=>u.endsWith('root.xml')).length,1);
  assert.equal(requested.filter(u=>u===url('A1')).length,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sk_price_history').get().n,3);
});

test('access failure checkpoints work and cannot declare a source complete or deactivate saved vehicles',async t=>{
  const db=fixture(t);saveSkRows(db,[parseSkDetail(page(ad('Old')),url('Old'))]);
  const status=await runFullSkImport(db,{sources:[source],readerFactory:async()=>async u=>{
    if(u.endsWith('root.xml'))return {status:200,html:sitemap(['A1'])};throw Error('HTTP 429');}});
  assert.equal(status.sources[0].phase,'blocked');assert.equal(status.sources[0].counts.error,1);
  assert.equal(status.complete,false);assert.equal(db.prepare('SELECT is_active FROM vehicle_app').get().is_active,1);
});

test('portal equipment, original description and all three vehicle categories survive SQLite and comps',t=>{
  const db=fixture(t);
  const a=ad('A1');const row=parseSkDetail(page(a),url('A1'));
  assert.deepEqual(JSON.parse(row.equipment_json),['ABS','Tempomat']);
  assert.equal(row.other_equipment,'Originálne kufre');assert.equal(row.vehicle_type,'motorcycle');
  assert.equal(parseSkDetail(page(ad('A2',{categoryValue:'Úžitkové vozidlá do 3,5t'})),url('A2')).vehicle_type,'commercial');
  assert.equal(parseSkDetail(page(ad('A3',{categoryValue:'Osobné vozidlá'})),url('A3')).vehicle_type,'passenger');
  saveSkRows(db,[row]);
  const pricing=initVehicleDb(db.name,{market:'SK'});db.testReaders.push(pricing);
  const [comp]=pricing.findComps({brand:'Honda',model:'CB 1100',year:2020});
  assert.equal(comp.currency,'EUR');assert.equal(comp.equipment,'ABS, Tempomat, ABS');
  assert.equal(comp.other_equipment,'Originálne kufre');assert.equal(comp.vehicle_type,'motorcycle');
});

test('Autovia Flight advertisement takes priority over abbreviated JSON-LD and retains equipment',()=>{
  const a=ad('A1');
  const flight='1:'+JSON.stringify({advertisement:a})+'\n';
  const html='<script type="application/ld+json">'+JSON.stringify({'@type':'ItemPage',mainEntity:{'@type':'Car',url:url('A1'),offers:{price:9000,priceCurrency:'EUR',availability:'https://schema.org/InStock'},brand:{name:'Honda'},model:'CB 1100',vehicleModelDate:'2020'}})+'</script>'+
    '<script>self.__next_f.push('+JSON.stringify([1,flight])+')</script>';
  const row=parseSkDetail(html,url('A1'));assert.equal(row.vehicle_type,'motorcycle');assert.ok(row.equipment.includes('Tempomat'));
});

test('unpriced vehicle listings are retained without becoming zero-euro price observations',t=>{
  const db=fixture(t);const row=parseSkDetail(page(ad('A1',{finalPrice:0})),url('A1'));
  assert.equal(row.price,null);assert.equal(row.listing_status,'unpriced');saveSkRows(db,[row]);
  const pricing=initVehicleDb(db.name,{market:'SK'});db.testReaders.push(pricing);
  assert.equal(pricing.findComps({brand:'Honda',model:'CB 1100',year:2020}).length,0);
});

test('Bazos motorcycle host is strict; whole Dual Motor cars are accepted and parts are rejected',()=>{
  const bazos=(host,title,slug='ostatni',price='23 790 €')=>`<link rel="canonical" href="https://${host}/inzerat/123/car.php"><a href="https://${host}/${slug}/">Kategória</a><h1 class="nadpisdetail">${title}</h1><div class="popisdetail">R.v. 2020, najazdené 100000 km, vyhrievané sedadlá</div><table><tr><td>Cena:</td><td><span>${price}</span></td></tr></table>`;
  let row=parseSkDetail(bazos('auto.bazos.sk','Tesla Model 3 Dual Motor'),'https://auto.bazos.sk/inzerat/123/car.php');
  assert.equal(row.model,'Model 3');assert.equal(row.price,'23790');assert.ok(row.description.includes('vyhrievané'));
  assert.equal(parseSkDetail(bazos('auto.bazos.sk','Motor Tesla Model 3'),'https://auto.bazos.sk/inzerat/123/car.php'),null);
  row=parseSkDetail(bazos('motocykle.bazos.sk','Honda CB 1100','cestovne','Dohodou'),'https://motocykle.bazos.sk/inzerat/123/car.php');
  assert.equal(row.vehicle_type,'motorcycle');assert.equal(row.price,null);
  assert.equal(parseSkListing('https://motocykle.bazos.sk.evil/inzerat/123/car.php'),null);
});

test('Bazos discovery visits every vehicle category page and excludes parts categories',async t=>{
  const db=fixture(t),requested=[];
  const bazos={id:'bazos_sk',host:'auto.bazos.sk',sitemap:'/sitemap.php',indexMode:'categories'};
  await runFullSkImport(db,{sources:[bazos],maxDetails:0,readerFactory:async()=>async u=>{
    requested.push(u);const second=u.endsWith('/alfa/20/');
    return {status:200,html:`<h1 class="nadpiskategorie">Auto</h1>Zobrazených ${second?'21-21':'1-20'} inzerátov z ${u.endsWith('/alfa/')?21:1}<div class="inzeraty inzeratyflex"><h2 class="nadpis"><a href="https://auto.bazos.sk/inzerat/${second?101:100}/car.php">Alfa Romeo</a></h2></div>`};}});
  assert.ok(requested.includes('https://auto.bazos.sk/alfa/20/'));
  assert.ok(requested.includes('https://auto.bazos.sk/dodavka/'));
  assert.equal(requested.some(u=>u.includes('nahradnidily')),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sk_crawl_queue').get().n,2);
});
