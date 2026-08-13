const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-059 — INTERVAL の値が算術式のとき日付単位を取りこぼす不具合の修正。
 *
 * 症状: `DATE_ADD(d, INTERVAL n * 2 DAY)` のように INTERVAL の値部が算術式だと、
 * ExpressionParser が「expected ) but found day」を出す（素の SELECT 項目では
 * INTERVAL が列参照へ誤解決し PHYSICAL_COLUMN_NOT_FOUND）。
 *
 * 原因: `#parseIntervalExpression` が値部を単項精度（#parseUnaryExpression）でしか
 * 解析せず、`*` / `/` / `+` / `-` の後ろに続く日付単位を消費できなかった。値を
 * 消費しきる前に単位が残り、関数引数の閉じ `)` 検査で衝突していた。
 *
 * 修正: 値部を加減算精度（#parseAdditiveExpression）で解析する。日付単位（DAY 等）は
 * 裸のキーワードで演算子ではないため、加減算解析は必ず単位の手前で停止し過剰消費
 * しない。値部に含まれる列（例: n）の依存も lineage に保持される。
 */

const metadata = {
  analysis_id: "v1_5_0_059",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "d", field_path: "d" },
  { table_name: "p.d.t", column_name: "n", field_path: "n" }
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
    throw new Error("test_v1_5_0_059: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function tablesColumns(result) {
  return (result.exported_tables.lineage_paths || []).map((p) =>
    String(p.physical_table_name || p.table_name || "").toUpperCase() + "." +
    String(p.physical_column_name || p.field_path || "").toUpperCase()
  );
}

function clean(name, sql) {
  const result = analyze(sql);
  assert(
    result.analysis.analysis_status !== "PARTIAL_FAILURE" &&
    errorCodes(result).length === 0,
    `${name}: expected clean parse, got ${result.analysis.analysis_status} ` +
    JSON.stringify(errorCodes(result))
  );
  return result;
}

// 算術式の値（報告ケース）。関数引数内で "expected ) but found day" だった。
clean("DATE_ADD n*2", "SELECT DATE_ADD(d, INTERVAL n * 2 DAY) AS x FROM p.d.t");
clean("DATE_ADD n+1", "SELECT DATE_ADD(d, INTERVAL n + 1 DAY) AS x FROM p.d.t");
clean("DATE_SUB 2*1", "SELECT DATE_SUB(d, INTERVAL 2 * 1 MONTH) AS x FROM p.d.t");

// 素の SELECT 項目・日付演算でも算術式の値が通る。
clean("bare interval n*2", "SELECT INTERVAL n * 2 DAY AS x FROM p.d.t");
clean("date + interval n*2", "SELECT d + INTERVAL n * 2 DAY AS x FROM p.d.t");

// 値部の列（n）が依存として保持される。
const withCol = clean(
  "interval value column lineage",
  "SELECT DATE_ADD(d, INTERVAL n + 1 DAY) AS x FROM p.d.t"
);
assert(
  tablesColumns(withCol).includes("P.D.T.N"),
  "interval value column n must be captured, got " +
  JSON.stringify(tablesColumns(withCol))
);

// 回帰: リテラル値・列値・負値・TO 句・単位のみ。
clean("literal value", "SELECT DATE_ADD(d, INTERVAL 2 DAY) AS x FROM p.d.t");
clean("column value", "SELECT DATE_ADD(d, INTERVAL n DAY) AS x FROM p.d.t");
clean("negative value", "SELECT DATE_ADD(d, INTERVAL -2 DAY) AS x FROM p.d.t");
clean("TO clause", "SELECT d + INTERVAL '1 2:3:4' DAY TO SECOND AS x FROM p.d.t");

console.log(JSON.stringify({
  test: "test_v1_5_0_059",
  status: "PASS",
  issue: "INTERVAL の値が算術式（n * 2 等）でも日付単位を消費でき、" +
    "expected ) but found <part> / INTERVAL 列誤解決を起こさない"
}));
