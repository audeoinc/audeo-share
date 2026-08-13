const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LineageEngine } = require('../../dist/lineage_udf_bundle.js');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSql(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function physicalDependencies(lineage) {
  const values = (lineage.dependencies || [])
    .filter((dependency) => dependency.physical_table_name && dependency.physical_column_name)
    .map((dependency) => `${dependency.physical_table_name}.${dependency.physical_column_name}`);
  return [...new Set(values)].sort();
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

function findLineage(result, outputName, scopeId) {
  const candidates = result.tables.output_lineages.filter((item) => {
    if (item.output_column_name !== outputName) return false;
    if (scopeId === undefined || scopeId === null) return true;
    return item.output_scope_id === scopeId;
  });
  if (scopeId !== undefined && scopeId !== null) return candidates[0];
  return candidates.find((item) => physicalDependencies(item).length > 0) || candidates[0];
}

function runGoldenCase(caseName, baseDir) {
  const fixturePath = path.join(baseDir, 'fixtures', `${caseName}.sql`);
  const expectedPath = path.join(baseDir, 'expected', `${caseName}.json`);
  const sql = readSql(fixturePath);
  const expected = readJson(expectedPath);
  assert.ok(expected.purpose, `${caseName}: purpose is required.`);
  assert.ok(Array.isArray(expected.coverage) && expected.coverage.length > 0, `${caseName}: coverage is required.`);

  const result = new LineageEngine({
    physicalColumns: normalizePhysicalColumns(expected.physical_columns || []),
    strictMode: false
  }).analyze(sql);

  assert.strictEqual(result.analysis_status, expected.analysis_status || 'COMPLETED', `${caseName}: analysis_status`);
  assert.strictEqual(result.warning_count || 0, expected.warning_count || 0, `${caseName}: warning_count`);
  assert.strictEqual(result.error_count || 0, expected.error_count || 0, `${caseName}: error_count`);

  let verifiedOutputs = 0;
  for (const output of expected.outputs || []) {
    const lineage = findLineage(result, output.name, output.scope_id);
    assert.ok(lineage, `${caseName}.${output.name}: output lineage was not found.`);
    assert.strictEqual(lineage.lineage_status, output.status || 'RESOLVED', `${caseName}.${output.name}: lineage status`);
    if (output.expression_text !== undefined) {
      assert.strictEqual(
        lineage.expression_text,
        output.expression_text,
        `${caseName}.${output.name}: expression_text`
      );
    }
    assert.deepStrictEqual(
      physicalDependencies(lineage),
      [...output.dependencies].sort(),
      `${caseName}.${output.name}: physical dependencies differ.`
    );
    verifiedOutputs += 1;
  }

  for (const outputName of expected.absent_outputs || []) {
    const lineage = findLineage(result, outputName, expected.absent_scope_id);
    assert.ok(!lineage, `${caseName}.${outputName}: output must be absent.`);
  }

  return {
    case_name: caseName,
    verified_outputs: verifiedOutputs,
    purpose: expected.purpose,
    coverage: expected.coverage
  };
}

function runGoldenSuite(baseDir) {
  const expectedDir = path.join(baseDir, 'expected');
  const caseNames = fs.readdirSync(expectedDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
  return caseNames.map((caseName) => runGoldenCase(caseName, baseDir));
}

module.exports = { runGoldenCase, runGoldenSuite, physicalDependencies };
