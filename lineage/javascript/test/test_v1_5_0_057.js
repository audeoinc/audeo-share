const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-057 — USING列がFROM/左側ソースに存在しないケースの解決。
 *
 * v1.5.0-056 は JOIN ... USING(col) の結合キーを、候補が複数でも先頭
 * (FROM/左側)ソースへ確定解決するようにした。しかし USING列は結合先の
 * いずれかにあればよく、FROM側の物理表が必ず持つとは限らない。
 *
 * 症状:
 *   WITH aaa AS (...cola...), bbb AS (...cola...)
 *   SELECT cola FROM tablea INNER JOIN aaa USING(id) INNER JOIN bbb USING(cola)
 * で、tablea(物理・列不明)が候補先頭になり、そこへ cola を解決 → tablea に
 * cola が無く PHYSICAL_COLUMN_NOT_FOUND。cola は CTE aaa/bbb 側の列。
 *
 * 修正: 候補の中で列を公開していると分かっているソース(CTE/派生。
 * #getColumnStatus === "RESOLVED")を優先し、確定できない(全て物理で
 * スキーマ未連携)場合のみ先頭へフォールバックする。
 */

const metadata = {
  analysis_id: "v1_5_0_057",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.tablea", column_name: "id", field_path: "id" },
  { table_name: "p.d.src", column_name: "id", field_path: "id" },
  { table_name: "p.d.src", column_name: "cola", field_path: "cola" }
];

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_057: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

// 報告ケース: cola は CTE aaa/bbb にあり、FROM の物理表 tablea には無い。
const reported = analyze(
  "WITH aaa AS (SELECT id, cola FROM p.d.src), " +
  "bbb AS (SELECT id, cola FROM p.d.src) " +
  "SELECT cola FROM p.d.tablea " +
  "INNER JOIN aaa USING(id) INNER JOIN bbb USING(cola)"
);
assert(
  errorCodes(reported).length === 0,
  "reported case must be clean, got " + JSON.stringify(errorCodes(reported))
);

// cola は物理ソース p.d.src.cola へ辿れる(CTE経由)。
const paths = (reported.exported_tables.lineage_paths || []).map((p) => ({
  table: String(p.physical_table_name || p.table_name || "").toUpperCase(),
  column: String(p.physical_column_name || p.field_path || "").toUpperCase()
}));
assert(
  paths.some((p) => p.table === "P.D.SRC" && p.column === "COLA"),
  "cola must trace to p.d.src.cola, got " + JSON.stringify(paths)
);

// FROM 物理表側に USING列がある通常ケースも従来どおり解決できる。
noErrorCase(
  "FROM has the USING key",
  "WITH bbb AS (SELECT id FROM p.d.src) " +
  "SELECT id FROM p.d.tablea INNER JOIN bbb USING(id)"
);

function noErrorCase(name, sql) {
  const result = analyze(sql);
  assert(
    errorCodes(result).length === 0,
    `${name}: expected clean parse, got ${JSON.stringify(errorCodes(result))}`
  );
}

console.log(JSON.stringify({
  test: "test_v1_5_0_057",
  status: "PASS",
  issue: "USING列がFROM/左側(物理)ソースに無く結合先のCTEにある場合でも、" +
    "列を公開する候補へ解決し PHYSICAL_COLUMN_NOT_FOUND を出さない"
}));
