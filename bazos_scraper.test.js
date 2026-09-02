import assert from "node:assert/strict";
import test from "node:test";
import {
  bazosCategoryPageUrl,
  createBazosTaxonomy,
  parseBazosDetail,
  parseBazosListingPage,
  parseBazosSitemapDetail,
  parseBazosSitemapIndex,
  parseBazosSiteTotal,
} from "./bazos_scraper.js";

const category = { host: "auto.bazos.cz", slug: "renault", group: "auto", brand: "Renault" };

test("Bazos listing pages expose canonical IDs, dates and totals", () => {
  const html = `
    <div class="inzeratynadpis">Zobrazeno 1-20 inzerátů z 1 234</div>
    <div class="inzeraty inzeratyflex"><h2 class=nadpis>
      <a href="/inzerat/223315917/renault-megane.php">Renault Megane</a></h2>
      <span class=velikost10> - [2.9. 2026]</span></div>`;
  const result = parseBazosListingPage(html, category);
  assert.equal(result.total, 1234);
  assert.equal(result.listings[0].key, "auto.bazos.cz:223315917");
  assert.equal(result.listings[0].postedDate, "2026-09-02");
  assert.equal(bazosCategoryPageUrl(category, 40), "https://auto.bazos.cz/renault/40/");
});

test("Bazos sitemap parsers keep only detail files and listing URLs", () => {
  const index = `<sitemapindex><sitemap><loc>https://auto.bazos.cz/sitemapdetail.php?sitepage=0&amp;x=1</loc></sitemap><sitemap><loc>https://auto.bazos.cz/sitemapcategory.php</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseBazosSitemapIndex(index, "auto.bazos.cz"), [
    "https://auto.bazos.cz/sitemapdetail.php?sitepage=0&x=1",
  ]);
  const detail = `<urlset><url><loc>https://auto.bazos.cz/inzerat/223315917/renault-megane.php</loc><lastmod>2026-09-02T10:00:00+02:00</lastmod></url></urlset>`;
  assert.equal(parseBazosSitemapDetail(detail, "auto.bazos.cz")[0].key, "auto.bazos.cz:223315917");
  assert.equal(parseBazosSiteTotal("Inzeráty Auto celkem: <b>410 191</b>", "Auto"), 410191);
});

test("Bazos detail parser maps a useful vehicle row", () => {
  const taxonomy = createBazosTaxonomy([
    { brand: "Renault", model: "Megane" },
    { brand: "BMW", model: "R 1250 GS" },
  ]);
  const candidate = {
    key: "auto.bazos.cz:223315917",
    url: "https://auto.bazos.cz/inzerat/223315917/renault-megane.php",
    title: "Renault Megane II combi 1.6 16V",
    category,
  };
  const html = `
    <link rel="canonical" href="${candidate.url}">
    <h1 class=nadpisdetail>Renault Megane II combi 1.6 16V</h1>
    <div class=popisdetail>Rok výroby 2008.<br>Benzínový motor 1.6 16V 82kW.<br>Najeto 198 000 km.<br>VIN: VF1BM0J0H28178622</div>
    <table><tr><td>Cena:</td><td><br><b><span translate="no">31 000 Kč</span></b></td></tr></table>`;
  const row = parseBazosDetail(html, candidate, taxonomy, "2026-09-02T10:00:00.000Z");
  assert.equal(row.brand, "Renault");
  assert.equal(row.model, "Megane");
  assert.equal(row.year, "2008");
  assert.equal(row.mileage, "198000");
  assert.equal(row.price, "31000");
  assert.equal(row.kw, "82");
  assert.equal(row.vin, "VF1BM0J0H28178622");
  assert.equal(row.body, "Kombi");
  assert.equal(row.source_db, "bazos_auto_daily_cloud");
});

test("Bazos detail parser rejects parts and does not take a brand from description", () => {
  const taxonomy = createBazosTaxonomy([
    { brand: "Mitsubishi", model: "Outlander" },
    { brand: "Rewaco", model: "RF1" },
  ]);
  const motoCategory = { host: "motorky.bazos.cz", slug: "trikolky", group: "motorky", brand: null };
  const candidate = {
    key: "motorky.bazos.cz:223000001",
    url: "https://motorky.bazos.cz/inzerat/223000001/rewaco-rf1.php",
    title: "Rewaco RF1",
    category: motoCategory,
  };
  const vehicleHtml = `<link rel="canonical" href="${candidate.url}"><h1 class=nadpisdetail>Rewaco RF1</h1><div class=popisdetail>Motor Mitsubishi, rok 2019.</div><tr><td>Cena:</td><td><span>669 000 Kč</span></td></tr>`;
  assert.equal(parseBazosDetail(vehicleHtml, candidate, taxonomy).brand, "Rewaco");

  const partCandidate = {
    ...candidate,
    key: "motorky.bazos.cz:223000002",
    url: "https://motorky.bazos.cz/inzerat/223000002/motor-rotax.php",
  };
  const partHtml = `<link rel="canonical" href="${partCandidate.url}"><h1 class=nadpisdetail>Motor Rotax 1503</h1><div class=popisdetail>Rok 2019.</div><tr><td>Cena:</td><td><span>70 000 Kč</span></td></tr>`;
  assert.equal(parseBazosDetail(partHtml, partCandidate, taxonomy), null);
});
