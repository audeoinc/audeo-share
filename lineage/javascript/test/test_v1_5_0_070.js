const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-070 — FROM のサブクエリが WITH / セット演算で始まる形を許可する。
 *
 * FromParser の #parseSubquerySource は「括弧内サブクエリの先頭 token が SELECT」で
 * ないと SyntaxError を投げていた。しかし内側は QueryParser へ委譲して解析しており、
 * QueryParser は WITH(CTE) もセット演算(UNION/INTERSECT/EXCEPT)も扱える。そのため
 * DAG の生成 SQL に多い次の形が「parenthesized FROM source must begin with SELECT」で
 * 落ちていた:
 *
 *   FROM (
 *     WITH xxx AS (...) SELECT ... FROM xxx
 *     INTERSECT DISTINCT
 *     (WITH zzz AS (...) SELECT ... FROM zzz)
 *   ) AS t
 *
 * 先頭 token 判定を SELECT / WITH / '(' の3種(=クエリの開始)に緩め、QueryParser に
 * 委譲する。パースが通り、両ブランチ(ds.a / ds.b)の物理列まで解決されること、
 * ERROR 診断が出ないことを確認する。
 */

const metadata = {
  analysis_id: "v1_5_0_070",
  view_project: "proj",
  view_dataset: "ds",
  view_name: "out",
  analyzed_at: "2026-08-18T00:00:00Z"
};

const cols = [
  { table_name: "ds.a", column_name: "id", field_path: "id" },
  { table_name: "ds.b", column_name: "id", field_path: "id" }
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
    throw new Error("test_v1_5_0_070: " + message);
  }
}

function physicalPaths(result) {
  return (result.exported_tables.lineage_paths || [])
    .map((p) => p.physical_table_name + "." + p.physical_column_name)
    .sort();
}

function errorCount(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR").length;
}

// 1) 報告ケース: WITH .. INTERSECT DISTINCT (WITH ..) を FROM サブクエリに入れる。
const reported = analyze(
  "SELECT t.id FROM (" +
  "  WITH xxx AS (SELECT id FROM ds.a) SELECT id FROM xxx" +
  "  INTERSECT DISTINCT" +
  "  (WITH zzz AS (SELECT id FROM ds.b) SELECT id FROM zzz)" +
  ") AS t"
);
assert(
  physicalPaths(reported).join(",") === "DS.A.ID,DS.B.ID",
  "both INTERSECT branches must resolve to their physical columns, got " +
    JSON.stringify(physicalPaths(reported))
);
assert(errorCount(reported) === 0,
  "no ERROR diagnostics expected, got " + errorCount(reported));

// 2) WITH で始まる素の FROM サブクエリ(セット演算なし)も許可される。
const withOnly = analyze(
  "SELECT t.id FROM (WITH xxx AS (SELECT id FROM ds.a) SELECT id FROM xxx) AS t"
);
assert(
  physicalPaths(withOnly).join(",") === "DS.A.ID",
  "WITH-only FROM subquery must resolve, got " + JSON.stringify(physicalPaths(withOnly))
);
assert(errorCount(withOnly) === 0, "WITH-only: no ERROR expected");

// 3) 括弧付きブランチで始まるセット演算 ((SELECT) UNION ALL (SELECT)) も許可される。
const parenFirst = analyze(
  "SELECT t.id FROM ((SELECT id FROM ds.a) UNION ALL (SELECT id FROM ds.b)) AS t"
);
assert(
  physicalPaths(parenFirst).join(",") === "DS.A.ID,DS.B.ID",
  "parenthesized-branch set operation must resolve, got " +
    JSON.stringify(physicalPaths(parenFirst))
);
assert(errorCount(parenFirst) === 0, "paren-first: no ERROR expected");

// 4) サブクエリでない裸のテーブル参照は従来どおり(サブクエリ経路に来ない)。
const plain = analyze("SELECT a.id FROM ds.a AS a");
assert(errorCount(plain) === 0, "plain table ref must still resolve without error");

console.log("test_v1_5_0_070: PASS");
