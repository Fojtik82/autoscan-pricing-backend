import { makeReader } from './niche_sources.js';
import { SK_SOURCES, parseSkListing, parseSkDetail } from './sk_sources.js';
import { createSkDatabase, saveSkRows } from './sk_import.js';
import { compressVehicleDatabase } from './vehicle_db_archive.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A bounded first population from public category pages. This is deliberately
// partial discovery and never performs a missing-advertisement reconciliation.
const root=path.dirname(fileURLToPath(import.meta.url));
const filename=path.join(root,'data','vehicles_sk.db');
const db=createSkDatabase(filename);
const summaries=[];
try {
  for(const source of SK_SOURCES){
    const summary={source:source.id,parsed:0,rejected:0,errors:0,coverage:'category_pages_partial'};
    const read=await makeReader(source);
    const candidates=new Map();
    const seeds=source.id==='bazos_sk'
      ? ['/skoda/','/skoda/20/','/volkswagen/','/audi/','/bmw/','/ford/']
      : ['/vysledky/osobne-vozidla/','/vysledky/osobne-vozidla/?page=2','/vysledky/osobne-vozidla/?page=3'];
    for(const seed of seeds){
      const page=await read('https://'+source.host+seed);
      for(const match of page.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){
        const item=parseSkListing(new URL(match[1].replaceAll('&amp;','&'),'https://'+source.host).href);
        if(item?.source===source.id)candidates.set(item.id,item);
      }
    }
    console.log('SK_BOOTSTRAP_DISCOVERED '+source.id+' '+candidates.size);
    for(const item of [...candidates.values()].slice(0,150)){
      try{
        const detail=await read(item.url);
        const row=parseSkDetail(detail.html,item.url);
        if(row){saveSkRows(db,[row]);summary.parsed++;}
        else summary.rejected++;
      }catch(e){summary.errors++;summary.last_error=e.message;}
    }
    summaries.push(summary);console.log('SK_BOOTSTRAP '+JSON.stringify(summary));
  }
} finally {db.close();await compressVehicleDatabase(filename);}
fs.writeFileSync(path.join(root,'data','sk-bootstrap.json'),JSON.stringify({checked_at:new Date().toISOString(),summaries},null,2));
if(summaries.length!==3 || summaries.some(s=>s.parsed===0))process.exitCode=1;
