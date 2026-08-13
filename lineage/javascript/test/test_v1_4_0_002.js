const assert = require('assert');
const { LineageEngine, BigQueryExporter } = require('../dist/lineage_udf_bundle.js');

/*
 * Parser Diagnosticsの回帰テスト。
 * 意図的に不正なJOIN構文を与え、失敗位置が分析結果とExporterへ
 * 保持されることを確認する。
 */
const sqlText = `
SELECT t.id
FROM sample.table_a AS t unexpected_alias (
  t.id
)
`;

const engineResult = new LineageEngine({ strictMode: false }).analyze(sqlText);
assert.strictEqual(engineResult.analysis_status, 'PARTIAL_FAILURE');
assert.strictEqual(engineResult.failed_stage, 'QUERY_PARSER');
assert.strictEqual(engineResult.diagnostics.length, 1);

const diagnostic = engineResult.diagnostics[0];
assert.strictEqual(diagnostic.parser_stage, 'FromParser');
assert.strictEqual(diagnostic.token, 'unexpected_alias');
assert.ok(Number.isInteger(diagnostic.token_seq));
assert.ok(Number.isInteger(diagnostic.line_no));
assert.ok(Number.isInteger(diagnostic.column_no));
assert.ok(Array.isArray(diagnostic.context_tokens));
assert.ok(diagnostic.context_tokens.some((item) => item.is_error_token));

const exported = new BigQueryExporter({
  analysis_id: 'diagnostic-test',
  view_project: 'project_id',
  view_dataset: 'dataset',
  view_name: 'v_diagnostic_test',
  analyzed_at: '2026-07-19T00:00:00Z'
}).export(engineResult);

const detail = JSON.parse(exported.analyses[0].error_detail_json);
assert.strictEqual(detail.parser_stage, 'FromParser');
assert.strictEqual(detail.token, 'unexpected_alias');

console.log('test_v1_4_0_002: PASS');
