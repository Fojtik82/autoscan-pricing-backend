// Canonical powertrains are deliberately conservative: generic hybrid is not PHEV.
export function foldVariant(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
const has = (text, pattern) => pattern.test(text);
export function normalizePowertrain({ fuel = '', motor = '', model = '', title = '', powertrain = '' } = {}) {
  const text = foldVariant([powertrain, fuel, motor, model, title].join(' '));
  if (has(text, /\b(phev|plug ?in|e ?hybrid|gte|tfsi e)\b/)) return 'phev';
  if (has(text, /\b(mhev|mild ?hybrid|e ?tsi)\b/)) return 'mhev';
  if (has(text, /\b(hev|full ?hybrid|self charging|e power)\b/)) return 'hev';
  const raw = foldVariant(fuel);
  const petrol = has(raw, /\b(benzin|benzina|benzine|petrol|gasoline|ba|b)\b/);
  const diesel = has(raw, /\b(nafta|diesel|nm|d)\b/);
  const electric = has(raw, /\b(elektro|elektrina|electric|elektricky|el|bev|ev)\b/);
  if (has(text, /\bhybrid\b/) || electric && (petrol || diesel)) return 'hybrid';
  if (has(raw, /\blpg\b/)) return 'lpg';
  if (has(raw, /\bcng\b/)) return 'cng';
  if (diesel || has(foldVariant(motor), /\b(tdi|hdi|dci|crdi)\b/)) return 'diesel';
  if (petrol || has(foldVariant(motor), /\b(tsi|tfsi|mpi|ecoboost)\b/)) return 'benzin';
  if (electric) return 'elektro';
  return '';
}
export function matchesEdition(requested, description) {
  const wanted = foldVariant(requested);
  if (!wanted) return false;
  const escaped = wanted.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  return new RegExp('(^| )' + escaped + '( |$)').test(foldVariant(description));
}
export function matchesEngine(requested, description) {
  if (!String(requested || '').trim()) return true;
  const wanted = foldVariant(requested);
  const text = foldVariant(description);
  const size = wanted.match(/\b([0-8]) ([0-9])\b/);
  const family = wanted.match(/\b(tsi|tfsi|tdi|hdi|dci|crdi|mpi|ecoboost|tce|vvt)\b/);
  if (size && !new RegExp('(^| )' + size[1] + ' ' + size[2] + '( |$)').test(text)) return false;
  if (family && !new RegExp('(^| )' + family[1] + '( |$)').test(text)) return false;
  // Unknown engine codes require explicit evidence; do not invent a match.
  return size || family ? true : matchesEdition(wanted, text);
}
