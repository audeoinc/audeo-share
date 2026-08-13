const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { LineageEngine } = require('../../dist/lineage_udf_bundle.js');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSql(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizePhysicalColumns(rows) {
  return rows.map((row, index) => ({
    project_id: row.project_id,
    dataset_id: row.dataset_id,
    table_name: row.table_name,
    column_name: row.column_name,
    field_path: row.field_path || row.column_name,
    ordinal_position: row.ordinal_position || index + 1
  }));
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function loadCase(baseDir, caseName) {
  const sqlPath = path.join(baseDir, 'fixtures', `${caseName}.sql`);
  const expectedPath = path.join(baseDir, 'expected', `${caseName}.json`);
  const expected = readJson(expectedPath);
  return {
    caseName,
    sql: readSql(sqlPath),
    physicalColumns: normalizePhysicalColumns(expected.physical_columns || [])
  };
}

function analyzeCase(testCase) {
  const engine = new LineageEngine({
    physicalColumns: testCase.physicalColumns,
    strictMode: false
  });
  const result = engine.analyze(testCase.sql);
  assert.notStrictEqual(result.analysis_status, 'FAILED', `${testCase.caseName}: analysis failed.`);
  return result;
}

function measureCase(testCase, warmupIterations, measuredIterations) {
  for (let index = 0; index < warmupIterations; index += 1) {
    analyzeCase(testCase);
  }

  const values = [];
  let maxHeapDeltaBytes = 0;
  for (let index = 0; index < measuredIterations; index += 1) {
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    analyzeCase(testCase);
    const elapsedMs = performance.now() - startedAt;
    const heapAfter = process.memoryUsage().heapUsed;
    values.push(elapsedMs);
    maxHeapDeltaBytes = Math.max(maxHeapDeltaBytes, Math.max(0, heapAfter - heapBefore));
  }

  values.sort((left, right) => left - right);
  const medianMs = percentile(values, 0.5);
  const p95Ms = percentile(values, 0.95);
  return {
    case_name: testCase.caseName,
    iterations: measuredIterations,
    median_ms: round(medianMs),
    p95_ms: round(p95Ms),
    stability_ratio: round(p95Ms / Math.max(medianMs, 1)),
    max_heap_delta_mb: round(maxHeapDeltaBytes / (1024 * 1024))
  };
}

function measureFullSuite(baseDir, caseNames, iterations) {
  const cases = caseNames.map((caseName) => loadCase(baseDir, caseName));
  for (const testCase of cases) analyzeCase(testCase);

  const startedAt = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const testCase of cases) analyzeCase(testCase);
  }
  const elapsedMs = performance.now() - startedAt;
  const analyses = cases.length * iterations;
  return {
    cases: cases.length,
    iterations,
    analyses,
    total_ms: round(elapsedMs),
    average_ms_per_analysis: round(elapsedMs / analyses),
    analyses_per_second: round((analyses * 1000) / elapsedMs)
  };
}

function runPerformanceRegression(baseDir, contract) {
  const expectedDir = path.join(baseDir, 'expected');
  const allCaseNames = fs.readdirSync(expectedDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();

  const workloadResults = contract.workloads.map((workload) => {
    const result = measureCase(
      loadCase(baseDir, workload.case_name),
      contract.warmup_iterations,
      contract.measured_iterations
    );
    assert.ok(
      result.median_ms <= workload.max_median_ms,
      `${workload.case_name}: median ${result.median_ms}ms exceeds ${workload.max_median_ms}ms.`
    );
    assert.ok(
      result.p95_ms <= workload.max_p95_ms,
      `${workload.case_name}: p95 ${result.p95_ms}ms exceeds ${workload.max_p95_ms}ms.`
    );
    assert.ok(
      result.stability_ratio <= contract.max_stability_ratio,
      `${workload.case_name}: stability ratio ${result.stability_ratio} exceeds ${contract.max_stability_ratio}.`
    );
    assert.ok(
      result.max_heap_delta_mb <= contract.max_heap_delta_mb,
      `${workload.case_name}: heap delta ${result.max_heap_delta_mb}MB exceeds ${contract.max_heap_delta_mb}MB.`
    );
    return result;
  });

  const suite = measureFullSuite(baseDir, allCaseNames, contract.full_suite_iterations);
  assert.ok(
    suite.average_ms_per_analysis <= contract.max_suite_average_ms,
    `Full suite average ${suite.average_ms_per_analysis}ms exceeds ${contract.max_suite_average_ms}ms.`
  );
  assert.ok(
    suite.analyses_per_second >= contract.min_suite_analyses_per_second,
    `Full suite throughput ${suite.analyses_per_second}/s is below ${contract.min_suite_analyses_per_second}/s.`
  );

  return {
    contract_version: contract.contract_version,
    timing_method: 'performance.now',
    workloads: workloadResults,
    full_suite: suite,
    limits: {
      max_stability_ratio: contract.max_stability_ratio,
      max_heap_delta_mb: contract.max_heap_delta_mb,
      max_suite_average_ms: contract.max_suite_average_ms,
      min_suite_analyses_per_second: contract.min_suite_analyses_per_second
    }
  };
}

module.exports = { runPerformanceRegression };
