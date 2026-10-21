import { foldVariant } from './vehicle_variant.js';
import { marketSourceId } from './source_identity.js';

// Opt-in only. The default price API remains strictly filtered for existing apps.
export const ANNOTATED_SPECS_POLICY = 'annotated_missing_specs_v1';
const empty = value => !foldVariant(value) || /^(neuvedeno|nezname|unknown|unspecified|n a)$/.test(foldVariant(value));

function canonical(kind, value) {
  const text = foldVariant(value);
  if (empty(value)) return '';
  const groups = kind === 'transmission' ? {
    manual: ['manual', 'manualni', 'manualna', 'man', 'manual transmission'],
    automatic: ['automat', 'automaticka', 'automatic', 'auto', 'dsg', 's tronic', 'tiptronic', 'cvt'],
    semi: ['poloautomaticka', 'poloautomat', 'semi automatic', 'semiautomatic'],
  } : {
    front: ['predni', 'fwd', 'front wheel', 'front wheel drive'],
    rear: ['zadni', 'rwd', 'rear wheel', 'rear wheel drive'],
    awd: ['4x4', '4 x 4', 'awd', '4wd', '4motion', 'quattro'],
    two_wheel: ['4x2', '4 x 2', '2wd'],
  };
  return Object.keys(groups).find(key => groups[key].includes(text)) || '?';
}

function titleSignals(kind, title) {
  const text = foldVariant(title);
  const patterns = kind === 'transmission' ? {
    manual: /\b(manual|manualni)\b/,
    automatic: /\b(automat|automaticka|automatic|dsg|s tronic|tiptronic|cvt)\b/,
    semi: /\b(poloautomaticka|poloautomat|semi automatic|semiautomatic)\b/,
  } : {
    front: /\b(predni pohon|pohon prednich kol|fwd|front wheel drive)\b/,
    rear: /\b(zadni pohon|pohon zadnich kol|rwd|rear wheel drive)\b/,
    awd: /\b(4x4|4 x 4|4wd|awd|4motion|quattro)\b/,
    two_wheel: /\b(4x2|4 x 2|2wd)\b/,
  };
  // Negated equipment is not affirmative evidence for a drivetrain/gearbox.
  const affirmative = text.replace(/\b(?:bez|neni|not|no)\s+(?:4x4|4 x 4|awd|4motion|quattro|dsg|automat(?:icka)?)\b/g, '');
  return Object.keys(patterns).filter(key => patterns[key].test(affirmative));
}

export function assessSpec(kind, requested, raw, normalized, title = '') {
  if (!requested) return { include: true, unknown: false };
  const wanted = canonical(kind, requested);
  if (!wanted || wanted === '?') return { include: false, unknown: false };
  const structured = [canonical(kind, raw), canonical(kind, normalized)];
  const evidence = new Set([...structured.filter(value => value && value !== '?'), ...titleSignals(kind, title)]);
  // Explicit conflicting evidence never becomes a partially confirmed match.
  if (evidence.size > 1) {
    // "2WD" and "front" (or "rear") are compatible, but 2WD and AWD are not.
    if (kind === 'drive' && evidence.has('two_wheel') && evidence.size === 2 && !evidence.has('awd')) evidence.delete('two_wheel');
    else return { include: false, unknown: false };
  }
  const observed = [...evidence][0];
  if (observed === 'two_wheel' && ['front', 'rear'].includes(wanted)) return { include: true, unknown: true };
  if (observed) return { include: observed === wanted, unknown: false };
  // An unrecognized nonempty specification is not permission to ignore it.
  if (structured.includes('?')) return { include: false, unknown: false };
  return { include: true, unknown: true };
}

export function unknownSpecs(vehicle, request) {
  return ['transmission', 'drive'].filter(kind => assessSpec(kind, request[kind + 'Norm'],
    vehicle[kind], vehicle['_' + kind + '_norm'], vehicle.title).unknown);
}

export function summarizePartialSpecs(vehicles, request) {
  const summary = { policy: ANNOTATED_SPECS_POLICY, partial_count: 0,
    transmission_unknown: 0, drive_unknown: 0, by_source: {} };
  for (const vehicle of vehicles) {
    const source = marketSourceId(vehicle.url, vehicle.source_db);
    const item = summary.by_source[source] ||= { count: 0, partial_count: 0, transmission_unknown: 0, drive_unknown: 0 };
    item.count++;
    const unknown = unknownSpecs(vehicle, request);
    if (unknown.length) { summary.partial_count++; item.partial_count++; }
    for (const kind of unknown) { summary[kind + '_unknown']++; item[kind + '_unknown']++; }
  }
  return summary;
}
