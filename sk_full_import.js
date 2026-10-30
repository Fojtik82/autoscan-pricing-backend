import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeReader} from './niche_sources.js';
import {SK_SOURCES,parseSkListing,parseSkDetail,sitemapLocations,skDetailGone,bazosSkCategorySlugs} from './sk_sources.js';
import {parseBazosListingPage} from './bazos_scraper.js';
import {createSkDatabase,saveSkRows,relevantSitemap,reconcileSkMissing} from './sk_import.js';
import {ensureVehicleDatabase,compressVehicleDatabase} from './vehicle_db_archive.js';

export function ensureCrawlSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sk_crawl_sources (
    source TEXT PRIMARY KEY, generation TEXT NOT NULL, phase TEXT NOT NULL,
    sitemap_queue TEXT NOT NULL, visited_sitemaps TEXT NOT NULL,
    index_complete INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, completed_at TEXT,
    last_error TEXT, last_progress_at TEXT, retry_at TEXT);
    CREATE TABLE IF NOT EXISTS sk_crawl_queue (
    source TEXT NOT NULL, id TEXT NOT NULL, url TEXT NOT NULL, generation TEXT NOT NULL,
    modified_at TEXT, state TEXT NOT NULL DEFAULT 'pending', checked_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, last_error TEXT,
    PRIMARY KEY(source,id));
    CREATE INDEX IF NOT EXISTS sk_crawl_pending ON sk_crawl_queue(source,generation,state,retry_at);
    CREATE TABLE IF NOT EXISTS sk_price_history (
    source TEXT NOT NULL, id TEXT NOT NULL, checked_at TEXT NOT NULL, price TEXT NOT NULL,
    currency TEXT NOT NULL CHECK(currency='EUR'), PRIMARY KEY(source,id,checked_at));`);
  const columns = db.prepare('PRAGMA table_info(sk_crawl_sources)').all().map(column => column.name);
  if (!columns.includes('retry_at')) db.exec('ALTER TABLE sk_crawl_sources ADD COLUMN retry_at TEXT');
}

const BAZOS_REQUEST_DELAY_MS = 2500;
const BAZOS_429_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const isBazos = source => source.id === 'bazos_sk' || source.id === 'bazos_moto_sk';
const isRateLimited = error => /HTTP 429/.test(error.message);

function blockSource(db, source, error, now) {
  const retryAt = isBazos(source) && isRateLimited(error)
    ? new Date(Date.parse(now) + BAZOS_429_COOLDOWN_MS).toISOString()
    : null;
  db.prepare("UPDATE sk_crawl_sources SET phase='blocked',last_error=?,retry_at=? WHERE source=?")
    .run(error.message, retryAt, source.id);
}

function startSource(db, source, now) {
  const generation = now;
  db.prepare(`INSERT OR REPLACE INTO sk_crawl_sources
    (source,generation,phase,sitemap_queue,visited_sitemaps,started_at)
    VALUES (?,?,'index',?,'[]',?)`).run(source.id,generation,
      JSON.stringify(source.indexMode==='categories'?bazosSkCategorySlugs(source).map(slug=>'https://'+source.host+'/'+slug+'/'):['https://'+source.host+source.sitemap]),now);
  return db.prepare('SELECT * FROM sk_crawl_sources WHERE source=?').get(source.id);
}

export function recordCrawlItems(db, source, generation, items) {
  const put = db.prepare(`INSERT INTO sk_crawl_queue (source,id,url,generation,modified_at)
    VALUES (@source,@id,@url,@generation,@modified_at)
    ON CONFLICT(source,id) DO UPDATE SET url=excluded.url,generation=excluded.generation,
      state=CASE WHEN sk_crawl_queue.generation<>excluded.generation THEN 'pending' ELSE sk_crawl_queue.state END,
      attempts=CASE WHEN sk_crawl_queue.generation<>excluded.generation THEN 0 ELSE sk_crawl_queue.attempts END,
      retry_at=CASE WHEN sk_crawl_queue.generation<>excluded.generation THEN NULL ELSE sk_crawl_queue.retry_at END,
      modified_at=excluded.modified_at`);
  let count=0;
  db.transaction(()=>{
    for(const item of items) {
      if(item?.source!==source.id)continue;
      put.run({...item,source:source.id,generation,modified_at:item.modified_at??null});count++;
    }
  })();
  return count;
}

export function recordCrawlPage(db,source,generation,html) {
  const items=[];
  for(const block of html.matchAll(/<url>\s*([\s\S]*?)<\/url>/gi)){
    const urls=sitemapLocations('<urlset><url>'+block[1]+'</url></urlset>');
    const item=parseSkListing(urls[0]);if(item)items.push({...item,modified_at:/<lastmod>([^<]+)<\/lastmod>/i.exec(block[1])?.[1]??null});
  }
  return recordCrawlItems(db,source,generation,items);
}

export function bazosSkIndexPage(html,url,source) {
  const czHost=source.id==='bazos_moto_sk'?'motorky.bazos.cz':'auto.bazos.cz';
  const slug=new URL(url).pathname.split('/').filter(Boolean)[0];
  const adapted=html.replaceAll(source.host,czHost).replaceAll('Zobrazených','Zobrazeno');
  if(!/nadpiskategorie/i.test(html))throw Error('Unexpected Bazos category page');
  const parsed=parseBazosListingPage(adapted,{host:czHost,slug,group:source.id==='bazos_moto_sk'?'motorky':'auto'});
  const rawTotal=/Zobrazen[ýy]ch\s+[\d\s-]+\s+inzer[áa]tov\s+z\s+([\d\s]+)/i.exec(html)?.[1];
  if(!rawTotal)throw Error('Bazos category coverage cannot be verified');
  return {total:rawTotal?Number(rawTotal.replace(/\s/g,'')):parsed.total,
    items:parsed.listings.map(item=>parseSkListing(item.url.replace(czHost,source.host)))};
}

export function crawlStatus(db) {
  const sources=db.prepare('SELECT * FROM sk_crawl_sources ORDER BY source').all().map(s=>{
    const counts=Object.fromEntries(db.prepare(`SELECT state,COUNT(*) count FROM sk_crawl_queue
      WHERE source=? AND generation=? GROUP BY state`).all(s.source,s.generation).map(r=>[r.state,r.count]));
    const records=db.prepare(`SELECT vehicle_type,COUNT(*) count FROM vehicle_app
      WHERE source_db=? AND is_active=1 GROUP BY vehicle_type`).all(s.source);
    return {source:s.source,phase:s.phase,index_complete:Boolean(s.index_complete),
      sitemaps_remaining:JSON.parse(s.sitemap_queue).length,discovered:Object.values(counts).reduce((a,b)=>a+b,0),
      counts,records,last_error:s.last_error,retry_at:s.retry_at,
      started_at:s.started_at,completed_at:s.completed_at};
  });
  return {market:'SK',currency:'EUR',updated_at:new Date().toISOString(),
    complete:sources.length===SK_SOURCES.length&&sources.every(s=>s.phase==='complete'),
    blocked:sources.some(s=>s.phase==='blocked'),sources};
}

export async function runFullSkImport(db,{sources=SK_SOURCES,readerFactory=makeReader,
  deadline=Date.now()+210*60000,maxDetails=Infinity,refreshCompleted=false,
  concurrency=2,onCheckpoint=()=>{},now=()=>new Date().toISOString()}={}) {
  ensureCrawlSchema(db);
  // Each host has its own paced reader. Requests overlap but robots delay applies
  // to every start on that host, across both detail workers.
  await Promise.all(sources.map(async source=>{
    let state=db.prepare('SELECT * FROM sk_crawl_sources WHERE source=?').get(source.id);
    if(!state||state.phase==='complete'&&refreshCompleted)state=startSource(db,source,now());
    if(state.phase==='complete')return;
    let read;
    try { read=await readerFactory({...source,maxResponseBytes:32*1024*1024,
      requestDelayMs:isBazos(source) ? BAZOS_REQUEST_DELAY_MS : 600}); }
    catch(e){blockSource(db,source,e,now());return;}
    if(state.phase==='blocked') {
      if(state.retry_at && state.retry_at>now()) return;
      db.prepare("UPDATE sk_crawl_sources SET phase=?,last_error=NULL,retry_at=NULL WHERE source=?")
        .run(state.index_complete?'details':'index',source.id);
      state=db.prepare('SELECT * FROM sk_crawl_sources WHERE source=?').get(source.id);
    }
    const queue=JSON.parse(state.sitemap_queue),visited=new Set(JSON.parse(state.visited_sitemaps));
    while(queue.length&&Date.now()<deadline) {
      const url=queue[0]; if(visited.has(url)){queue.shift();continue;}
      try {
        const page=await read(url); if(page.status!==200)throw Error('Sitemap HTTP '+page.status);
        if(source.indexMode==='categories'&&!new URL(url).pathname.includes('sitemap')){
          const category=bazosSkIndexPage(page.html,url,source);
          recordCrawlItems(db,source,state.generation,category.items);
          const pieces=new URL(url).pathname.split('/').filter(Boolean);
          if(pieces.length===1){
            for(let offset=20;offset<Math.min(category.total,20000);offset+=20){
              const next='https://'+source.host+'/'+pieces[0]+'/'+offset+'/';
              if(!visited.has(next)&&!queue.includes(next))queue.push(next);
            }
            // If the portal's paging window truncates a category, inspect its
            // complete sitemap as fallback; never claim the first 20,000 are all.
            if(category.total>20000){const fallback='https://'+source.host+source.sitemap;if(!visited.has(fallback)&&!queue.includes(fallback))queue.push(fallback);}
          }
        } else if(/<sitemapindex\b/i.test(page.html)){
          const urls=sitemapLocations(page.html);
          for(const loc of urls){const u=new URL(loc);if(u.protocol==='https:'&&u.host===source.host&&relevantSitemap(source,loc)&&!visited.has(loc)&&!queue.includes(loc))queue.push(loc);}
        } else {sitemapLocations(page.html);recordCrawlPage(db,source,state.generation,page.html);}
        visited.add(url);queue.shift();
        db.prepare('UPDATE sk_crawl_sources SET sitemap_queue=?,visited_sitemaps=?,last_progress_at=?,last_error=NULL WHERE source=?')
          .run(JSON.stringify(queue),JSON.stringify([...visited]),now(),source.id);
        onCheckpoint();
        if(visited.size%10===0)console.log('SK_FULL_INDEX_PROGRESS '+JSON.stringify({source:source.id,sitemaps:visited.size,remaining:queue.length}));
      }catch(e){blockSource(db,source,e,now());return;}
    }
    if(queue.length)return;
    const indexCount=db.prepare('SELECT COUNT(*) n FROM sk_crawl_queue WHERE source=? AND generation=?').get(source.id,state.generation).n;
    if(!indexCount){db.prepare("UPDATE sk_crawl_sources SET phase='blocked',last_error='Empty vehicle index',retry_at=NULL WHERE source=?").run(source.id);return;}
    db.prepare("UPDATE sk_crawl_sources SET phase='details',index_complete=1 WHERE source=?").run(source.id);
    const items=db.prepare(`SELECT * FROM sk_crawl_queue WHERE source=? AND generation=?
      AND state IN ('pending','error') AND (retry_at IS NULL OR retry_at<=?)
      ORDER BY attempts,id LIMIT ?`).all(source.id,state.generation,now(),Number.isFinite(maxDetails)?maxDetails:2147483647);
    const taxonomy=db.prepare('SELECT DISTINCT brand,model FROM vehicle_app').all();
    let cursor=0,consecutiveErrors=0,blocked=false,processed=0;
    const mark=db.prepare('UPDATE sk_crawl_queue SET state=?,checked_at=?,attempts=attempts+1,retry_at=?,last_error=? WHERE source=? AND id=?');
    await Promise.all(Array.from({length:Math.max(1,Math.min(2,concurrency))},async()=>{
      while(cursor<items.length&&Date.now()<deadline&&!blocked){
        const item=items[cursor++];const checked=now();
        try {
          const detail=await read(item.url);
          if([404,410].includes(detail.status)||skDetailGone(detail.html)){
            db.prepare('UPDATE vehicle_app SET is_active=0,last_checked_at=?,inactive_at=? WHERE source_db=? AND source_id=?').run(checked,checked,source.id,item.id);
            mark.run('gone',checked,null,null,source.id,item.id);
          }else{
            const row=parseSkDetail(detail.html,item.url,taxonomy,checked);
            if(row){
              db.transaction(()=>{saveSkRows(db,[row]);if(row.price)db.prepare('INSERT OR IGNORE INTO sk_price_history VALUES (?,?,?,?,?)').run(source.id,item.id,checked,row.price,'EUR');})();
            }
            mark.run(row?'done':'rejected',checked,null,null,source.id,item.id);
          }
          consecutiveErrors=0;processed++;onCheckpoint();
          if(processed%250===0)console.log('SK_FULL_PROGRESS '+JSON.stringify({source:source.id,processed,total:indexCount}));
        }catch(e){
          consecutiveErrors++;
          const retry=new Date(Date.now()+Math.min(6*3600000,60000*2**Math.min(item.attempts,8))).toISOString();
          mark.run('error',checked,retry,e.message,source.id,item.id);
          if(item.attempts>=4||consecutiveErrors>=5||/robots disallows|access challenge|HTTP (401|403|429)/.test(e.message)){
            blocked=true;blockSource(db,source,e,checked);
          }
        }
      }
    }));
    if(blocked)return;
    const pending=db.prepare("SELECT COUNT(*) n FROM sk_crawl_queue WHERE source=? AND generation=? AND state IN ('pending','error')").get(source.id,state.generation).n;
    if(!pending){
      const live=new Set(db.prepare('SELECT id FROM sk_crawl_queue WHERE source=? AND generation=?').all(source.id,state.generation).map(r=>r.id));
      reconcileSkMissing(db,source.id,live,{complete:true,now:now()});
      db.prepare('INSERT OR REPLACE INTO sk_source_runs VALUES (?,?,?,?,?,?)').run(source.id,now(),indexCount,1,processed,0);
      db.prepare("UPDATE sk_crawl_sources SET phase='complete',completed_at=?,last_error=NULL WHERE source=?").run(now(),source.id);
    }
  }));
  return crawlStatus(db);
}

async function main(){
  if(process.env.CARPRICE_MARKET!=='SK')throw Error('Full SK import requires CARPRICE_MARKET=SK');
  const filename=path.resolve(process.env.SK_VEHICLES_DB_PATH??'./data/vehicles_sk.db');
  if(fs.existsSync(filename+'.gz')||fs.existsSync(filename+'.gz.parts.json'))await ensureVehicleDatabase(filename);
  const db=createSkDatabase(filename);ensureCrawlSchema(db);
  const minutes=Number(process.env.SK_RUN_MINUTES??210);
  if(!Number.isFinite(minutes)||minutes<=0||minutes>240)throw Error('SK_RUN_MINUTES must be in (0,240]');
  let status;
  try {
    status=await runFullSkImport(db,{deadline:Date.now()+minutes*60000,
      maxDetails:process.env.SK_BATCH_DETAILS?Number(process.env.SK_BATCH_DETAILS):Infinity,
      refreshCompleted:process.env.SK_REFRESH_COMPLETED==='1'&&crawlStatus(db).complete});
  }finally{db.close();await compressVehicleDatabase(filename,{splitBytes:48*1024*1024});}
  const statusFile=path.join(path.dirname(filename),'sk-import-status.json');
  fs.writeFileSync(statusFile,JSON.stringify(status,null,2)+'\n');
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`complete=${status.complete}\nblocked=${status.blocked}\n`);
  console.log('SK_FULL_STATUS '+JSON.stringify(status));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e);process.exitCode=1;});
