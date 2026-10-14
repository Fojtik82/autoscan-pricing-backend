import fs from 'node:fs';
import { makeReader } from './niche_sources.js';
import { SK_SOURCES } from './sk_sources.js';
import { discoverSkListings } from './sk_import.js';
const sources=[];
for(const source of SK_SOURCES){
  console.log('Checking sitemap discovery: '+source.id);
  const read=await makeReader({...source,maxResponseBytes:32*1024*1024});
  const result=await discoverSkListings(source,read);
  const summary={source:source.id,listings:result.listings.size,complete:result.complete};
  sources.push(summary);console.log(JSON.stringify(summary));
}
fs.writeFileSync('data/sk-sitemap-verification.json',JSON.stringify({checked_at:new Date().toISOString(),sources},null,2));
if(sources.some(s=>!s.complete))process.exitCode=1;
