const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-061 — 物理列メタデータのペイロード縮小の契約テスト（SQLのみの変更に対応）。
 *
 * 03 パイプライン STEP 3 は、対象増加時に JS UDF が "Resource exceeded / UDF out of
 * memory" になり得る。対策として、UDF へ渡す per-object の physical_columns_json から
 * data_type / is_nullable を除去した（エンジンはこれらを内部で伝播するだけで、
 * エクスポート出力には一切含めないため、解析結果に影響しない）。
 *
 * このテストは「エンジンの出力が data_type / is_nullable の有無に依存しない」という
 * 前提を固定する。将来のエンジン変更でこれらに依存し始めた場合に検知できる。
 */

const metadata = {
  analysis_id: "v1_5_0_061",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

function analyze(sql, cols) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false, compact_export: true }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_061: " + message);
  }
}

// 同じ列集合を「data_type/is_nullable あり」と「なし」で用意する。
const withTypes = [
  { table_name: "p.d.t", column_name: "id", field_path: "id", ordinal_position: 1, data_type: "INT64", is_nullable: "NO" },
  { table_name: "p.d.t", column_name: "amt", field_path: "amt", ordinal_position: 2, data_type: "NUMERIC", is_nullable: "YES" },
  { table_name: "p.d.t", column_name: "ev", field_path: "ev.key", ordinal_position: 3, data_type: "ARRAY<STRUCT<key STRING, value STRUCT<string_value STRING>>>", is_nullable: "YES" }
];

const withoutTypes = withTypes.map((column) => ({
  table_name: column.table_name,
  column_name: column.column_name,
  field_path: column.field_path,
  ordinal_position: column.ordinal_position
}));

const sqls = [
  "SELECT id, amt FROM p.d.t",
  "SELECT id AS k, amt * 2 AS doubled FROM p.d.t WHERE amt > 0",
  "SELECT t.id FROM p.d.t AS t"
];

function comparablePaths(result) {
  return (result.exported_tables.lineage_paths || [])
    .map((p) =>
      String(p.output_column_name || "").toUpperCase() + "<-" +
      String(p.physical_table_name || p.table_name || "").toUpperCase() + "." +
      String(p.physical_column_name || p.field_path || "").toUpperCase()
    )
    .sort();
}

for (const sql of sqls) {
  const full = analyze(sql, withTypes);
  const min = analyze(sql, withoutTypes);

  assert(
    full.analysis.analysis_status === min.analysis.analysis_status,
    `status differs for [${sql}]: ${full.analysis.analysis_status} vs ${min.analysis.analysis_status}`
  );

  const fullPaths = comparablePaths(full);
  const minPaths = comparablePaths(min);

  assert(
    JSON.stringify(fullPaths) === JSON.stringify(minPaths),
    `lineage differs for [${sql}]: ${JSON.stringify(fullPaths)} vs ${JSON.stringify(minPaths)}`
  );
}

// 明示的に: data_type / is_nullable はエクスポート出力に現れない。
const exported = analyze("SELECT id, amt FROM p.d.t", withTypes);
const exportedJson = JSON.stringify(exported.exported_tables);
assert(
  !exportedJson.includes("\"data_type\"") && !exportedJson.includes("\"is_nullable\""),
  "data_type / is_nullable must not appear in the exported tables"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_061",
  status: "PASS",
  issue: "エンジンの lineage 出力は data_type / is_nullable の有無に依存せず、" +
    "これらは per-object メタデータから安全に削除できる（UDF メモリ削減）"
}));
