import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createSkDatabase, saveSkRows } from './sk_import.js';
import { parseSkDetail } from './sk_sources.js';

const root = path.dirname(fileURLToPath(import.meta.url));
async function freePort() {
  const socket=net.createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening');
  const port=socket.address().port; await new Promise(resolve=>socket.close(resolve)); return port;
}
test('two independent HTTP backends refuse the other market and keep their own prices',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'carprice-two-backends-'));
  const children=[];
  try {
    const urls={};
    for(const market of ['CZ','SK']) {
      const filename=path.join(directory,market+'.db');
      const db=createSkDatabase(filename);
      for(let i=0;i<3;i++) {
        const id='A'+i;
        const html='<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{advertisement:{
          id,brandValue:'Skoda',carModelValue:'Octavia',yearValue:'2020',categoryValue:'Osobné vozidlá',
          finalPrice:15000+i*1000,title:'Skoda Octavia',mileage:100000}}}})+'</script>';
        saveSkRows(db,[parseSkDetail(html,`https://www.autobazar.eu/detail/skoda/${id}/`)]);
      }
      if(market==='CZ') db.exec("UPDATE vehicle_app SET market='CZ',currency='CZK',price='400000',source_db='sauto',source_url='https://www.sauto.cz/osobni/detail/skoda/octavia/'||rowid");
      db.close();
      const port=await freePort(); urls[market]=`http://127.0.0.1:${port}`;
      const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,
        CARPRICE_MARKET:market,VEHICLES_DB_PATH:filename,SQLITE_PATH:path.join(directory,market+'-cache.db'),
        PORT:String(port),VEHICLE_INGEST_API_KEY:''},stdio:'ignore'});
      children.push(child);
      let ready=false;
      for(let i=0;i<100;i++) {
        try {if((await fetch(urls[market]+'/healthz')).ok){ready=true;break;}}catch{}
        await new Promise(r=>setTimeout(r,100));
      }
      assert.equal(ready,true,market+' backend starts');
    }
    for(const market of ['CZ','SK']) {
      const probe = await fetch(urls[market]+'/');
      assert.equal(probe.status,200);
      const metadata = await probe.json();
      if(market==='SK') {
        assert.equal(metadata.vehicleDbReady,true);
        assert.equal(metadata.vehicleDb,undefined); // No full catalogue count in port probes.
      } else assert.equal(metadata.vehicleDb.count,3);
      const health = await fetch(urls[market]+'/healthz');
      assert.equal(health.status,200);
      assert.equal((await health.json()).vehicleDbReady,true);
      const response=await fetch(urls[market]+'/price/estimate',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({market,brand:'Skoda',model:'Octavia',year:2020})});
      assert.equal(response.status,200);
      const result=await response.json();
      if(market==='SK'){assert.equal(result.price,16000);assert.equal(result.currency,'EUR');assert.equal(result.price_czk,undefined);}
      else assert.equal(result.price_czk,400000);
      const wrong=await fetch(urls[market]+'/comps?market='+(market==='CZ'?'SK':'CZ'));
      assert.equal(wrong.status,409);
      assert.equal((await wrong.json()).error,'wrong_market_backend');
    }
  } finally {
    await Promise.all(children.map(async child=>{
      if(child.exitCode!==null)return;
      const exited=once(child,'exit'); child.kill(); await exited;
    }));
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
