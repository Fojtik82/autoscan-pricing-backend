import test from 'node:test';
import assert from 'node:assert/strict';
import {createVehicleProvider, registerVehicleProvider} from './vehicle_provider.js';
import express from 'express';
const vin='TMBJG7NE0J0123456';
const env={DATAOVOZIDLECH_API_KEY:'private-dov-key',VINDECODER_API_KEY:'private-vin-key',VINDECODER_API_SECRET:'private-vin-secret'};
function setup(t, options={}) { const p=createVehicleProvider({env,...options});t.after(()=>p.close());return p; }
test('DOV uses fixed provider, private headers, caches and filters response',async t=>{
 let calls=0;
 const p=setup(t,{fetchImpl:async(url,options)=>{calls++;assert.equal(new URL(url).hostname,'api.dataovozidlech.cz');assert.equal(options.headers.API_KEY,env.DATAOVOZIDLECH_API_KEY);assert.equal(options.redirect,'error');return Response.json({Status:1,Data:{TovarniZnacka:'Skoda',Owner:'private owner',MotorTyp:env.DATAOVOZIDLECH_API_KEY}});}});
 const [a,b]=await Promise.all([p.lookup('dov',vin),p.lookup('dov',vin)]);
 assert.deepEqual(a,{Status:1,Data:{TovarniZnacka:'Skoda',MotorTyp:''}});assert.deepEqual(a,b);
 await p.lookup('dov',vin);assert.equal(calls,1);
});
test('VINDecoder checksum stays on server and only vehicle fields return',async t=>{
 const p=setup(t,{fetchImpl:async(url)=>{assert.match(url,/^https:\/\/api\.vindecoder\.eu\/3\.2\/private-vin-key\/[a-f0-9]{10}\/decode\//);return Response.json({secret:env.VINDECODER_API_SECRET,decode:[{label:'Make',value:'Skoda'},{label:'API_KEY',value:env.VINDECODER_API_KEY}]});}});
 assert.deepEqual(await p.lookup('vindecoder',vin),{decode:[{label:'Make',value:'Skoda'}]});
});
test('invalid requests and missing credentials never contact upstream',async t=>{
 let calls=0;const p=setup(t,{env:{},fetchImpl:()=>{calls++;}});
 await assert.rejects(p.lookup('dov','../../secret'),{status:400});
 await assert.rejects(p.lookup('arbitrary',vin),{status:400});
 await assert.rejects(p.lookup('dov',vin),{status:503});assert.equal(calls,0);
});
test('upstream errors never leak URLs, keys or response bodies',async t=>{
 const p=setup(t,{fetchImpl:async()=>{throw new Error('request failed '+env.VINDECODER_API_SECRET);}});
 await assert.rejects(p.lookup('vindecoder',vin),e=>e.status===502&&!e.message.includes(env.VINDECODER_API_SECRET));
});
test('upstream size limit and malformed JSON fail safely',async t=>{
 const p=setup(t,{fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))});
 await assert.rejects(p.lookup('dov',vin),{status:502});
});
test('minute and daily budgets bound uncached paid requests',async t=>{
 let now=Date.parse('2026-09-22T00:00:00Z'),calls=0;
 const p=setup(t,{now:()=>now,fetchImpl:async()=>{calls++;return Response.json({decode:[]});}});
 const makeVin=i=>'TMBJG7NE0J'+String(i).padStart(7,'0');
 for(let i=0;i<20;i++)await p.lookup('vindecoder',makeVin(i));
 await assert.rejects(p.lookup('vindecoder',makeVin(20)),{status:429});assert.equal(calls,20);
 for(let i=20;i<100;i++){now+=60001;await p.lookup('vindecoder',makeVin(i));}
 now+=60001;await assert.rejects(p.lookup('vindecoder',makeVin(100)),{code:'vehicle_provider_daily_limit'});assert.equal(calls,100);
});
test('HTTP integration rejects malformed VIN and returns generic provider failures', async t=>{
 const p=setup(t,{env:{}}),app=express();registerVehicleProvider(app,p);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const invalid=await fetch(base+'/vehicle-data/dov/invalid');assert.equal(invalid.status,400);
 const unavailable=await fetch(base+'/vehicle-data/dov/'+vin);assert.equal(unavailable.status,503);
 assert.deepEqual(await unavailable.json(),{error:'vehicle_provider_not_configured'});
 assert.equal(unavailable.headers.get('cache-control'),'no-store');
});
