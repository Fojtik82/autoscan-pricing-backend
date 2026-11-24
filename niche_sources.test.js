import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNicheDetail, validateNicheDetailCoverage } from './niche_sources.js';

const listing = { source: 'rajveteranu', url: 'https://www.rajveteranu.cz/72463-aero-662-1934' };
const fields = [
  ['Značka', 'Aero'], ['Model', '662'], ['Rok výroby', '1934'],
  ['Datum vložení', '1.1.2026'],
].map(([key, value]) => `<tr><td>${key}:</td><td>&nbsp;</td><td>${value}</td></tr>`).join('');

test('a detail archived between index and fetch is a gone listing', () => {
  const page = `<a href="archiv">archivní inzeráty</a><table>${fields}
    <tr><td class='vm tr ital '>Datum&nbsp;archivace:</td>
    <td>&nbsp;&nbsp;&nbsp;</td><td>24.11.2026</td></tr></table>`;
  assert.deepEqual(parseNicheDetail(page, listing), { status: 'gone' });
});

test('normal archive navigation does not hide an active listing', () => {
  const page = `<a href="archiv">archivní inzeráty</a><table>${fields}</table>`;
  assert.equal(parseNicheDetail(page, listing).status, 'parsed');
});

test('a single unrecognized detail stays unverified, not a false deletion', () => {
  assert.deepEqual(parseNicheDetail('<h1>Inzerát</h1>', listing), { status: 'unsupported' });
});

test('isolated unsupported detail is safe, but broken source coverage is rejected', () => {
  const parsed = Array.from({ length: 100 }, () => ({ status: 'parsed' }));
  assert.doesNotThrow(() => validateNicheDetailCoverage(listing, [...parsed, { status: 'unsupported' }]));
  assert.throws(() => validateNicheDetailCoverage(listing, [
    ...parsed, ...Array.from({ length: 4 }, () => ({ status: 'unsupported' })),
  ]), /unusable detail coverage/);
  assert.throws(() => validateNicheDetailCoverage(listing, [{ status: 'gone' }]), /unusable detail coverage/);
});
