import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReader } from './niche_sources.js';
import { SK_SOURCES, parseSkDetail } from './sk_sources.js';
import { createSkDatabase, saveSkRows } from './sk_import.js';
import { compressVehicleDatabase } from './vehicle_db_archive.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const examples = [
  'https://auto.bazos.sk/inzerat/196481497/2023-volkswagen-golf-variant-viii-15-etsi-life-odpocet-dph.php',
  'https://www.autobazar.eu/detail/audi-q3-tdi-quatro-40800-km/Aeym4VE7zc2/',
  'https://www.autovia.sk/detail/308-allure-12-pt-130k-eat8/Am35_Tc-rqO/',
];
const rows = [];
for (let i=0;i<SK_SOURCES.length;i++) {
  const source = SK_SOURCES[i];
  const read = await makeReader(source);
  const detail = await read(examples[i]);
  const row = parseSkDetail(detail.html,detail.url,[{brand:'Volkswagen',model:'Golf'}]);
  if (!row) throw Error('Live parser failed: '+source.id);
  rows.push(row);
  console.log(JSON.stringify({source:source.id,brand:row.brand,model:row.model,year:row.year,price:row.price,currency:row.currency}));
}
const db = createSkDatabase(path.join(root,'data','vehicles_sk.db'));
saveSkRows(db,rows); db.close();
await compressVehicleDatabase(path.join(root,'data','vehicles_sk.db'));
fs.writeFileSync(path.join(root,'data','sk-live-verification.json'),JSON.stringify({
  checked_at:new Date().toISOString(),sources:rows.map(r=>r.source_db),rows:rows.length,
  coverage:'three_live_examples_only_not_a_full_import'},null,2));
