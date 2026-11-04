import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildExamples, evaluateModel, readSnapshot, trainModel } from './saleability_model.js';

export function runBacktest({ trainStart, trainEnd, testStart, testEnd, provenance = {} }) {
  if (Math.max(...Object.values(trainEnd.checked).map(Date.parse)) >= Math.min(...Object.values(testStart.checked).map(Date.parse))) {
    throw new Error('Training outcomes must precede every holdout feature snapshot');
  }
  const training = buildExamples(trainStart, trainEnd, { issuedAt: provenance.train_start?.date });
  const test = buildExamples(testStart, testEnd, { issuedAt: provenance.test_start?.date });
  const testedModel = trainModel(training, { ...provenance, role: 'historical_test', train_start: trainStart.checked, train_end: trainEnd.checked });
  const report = evaluateModel(testedModel, test, { trainingKeys: new Set(training.examples.map(r => r.key)) });
  // Freeze the algorithm before the test, then refit on the latest completed
  // cohort for a prospective pilot. These are explicitly different models.
  const pilotModel = trainModel(test, { ...provenance, role: 'prospective_pilot', train_start: testStart.checked, train_end: testEnd.checked });
  pilotModel.validation = { temporally_tested_sources: Object.keys(testedModel.sources), production_approved: false, tested_model_version: testedModel.version, historical_brier: report.overall.brier, baseline_brier: report.overall.baseline_brier, beats_baseline: report.overall.brier_improvement > 0 };
  return { model: pilotModel, report: { ...report, method: testedModel.method,
    tested_model_version: testedModel.version, pilot_model_version: pilotModel.version,
    temporally_tested_sources: Object.keys(testedModel.sources),
    not_temporally_tested_sources: ['sauto', 'bazos'].filter(source => !testedModel.sources[source]),
    simulated_train_issue_at: provenance.train_start?.date || trainStart.checked,
    simulated_test_issue_at: provenance.test_start?.date || testStart.checked,
    training_cohort: training.cohort_size, training_resolved: training.examples.length,
    training_censoring: training.censoring, train_start: trainStart.checked, train_end: trainEnd.checked,
    test_start: testStart.checked, test_end: testEnd.checked,
    price_references: 'Only the feature snapshot available at prediction time; never endpoint prices.',
    model_selection: 'Fixed hierarchical empirical rates, minimum 50 labels, prior strength 20. No holdout tuning.',
    limitations: ['Historical coverage is a sample of known ads.', 'Endpoint inactivity is not a confirmed sale.',
      'Predictions concern already advertised cars, not newly posted ads.', 'Vehicle duplicates across portals remain.',
      'One chronological holdout does not establish seasonal stability.'], provenance } };
}

function main() {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1]; };
  const snapshots = {};
  for (const [name, flag] of Object.entries({ trainStart: '--train-start', trainEnd: '--train-end', testStart: '--test-start', testEnd: '--test-end' })) {
    const db = new Database(value(flag), { readonly: true, fileMustExist: true });
    try { snapshots[name] = readSnapshot(db); } finally { db.close(); }
    console.log(JSON.stringify({ loaded: name, known_ads: snapshots[name].records.size, checks: snapshots[name].checked }));
  }
  const index = args.indexOf('--provenance');
  const provenance = index >= 0 ? JSON.parse(fs.readFileSync(args[index + 1], 'utf8')) : {};
  const result = runBacktest({ ...snapshots, provenance });
  const directory = value('--output-dir');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'saleability-model.json'), JSON.stringify(result.model) + '\n');
  fs.writeFileSync(path.join(directory, 'saleability-backtest.json'), JSON.stringify(result.report, null, 2) + '\n');
  console.log(JSON.stringify({ ...result.report, overall: { ...result.report.overall, bins: undefined },
    by_source: Object.fromEntries(Object.entries(result.report.by_source).map(([k, v]) => [k, { ...v, bins: undefined }])),
    unseen_listing_ids: { ...result.report.unseen_listing_ids, bins: undefined } }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
