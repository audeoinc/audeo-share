const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-060 — CREATE ... AS (SELECT ...) の括弧付き本体を解析できない不具合の修正。
 *
 * 症状: `CREATE OR REPLACE TEMP TABLE t AS (SELECT ...)` で QueryParser が
 * 「トップレベルの SELECT Clause が見つかりません」を出す。括弧なしの
 * `CREATE ... AS SELECT ...` は通っていた。
 *
 * 原因: ClauseParser は深さ0の SELECT を探すが、`AS (SELECT ...)` では SELECT が
 * 括弧内（深さ1）に入る。既存の `#stripWrappingParentheses` は「先頭が '('」の
 * 場合しか外側括弧を剥がさないため、前置き（CREATE ... AS）の後ろに来る
 * 括弧付きクエリには対応していなかった。
 *
 * 修正: `#stripStatementBodyParentheses` を追加。深さ0の 'AS' の直後が深さ0の '(' で、
 * その対応 ')' が末尾（末尾 ';' は無視）に一致し、内側が SELECT/WITH で始まる場合に、
 * 括弧内のクエリだけを取り出して再解析する。対象テーブル名は解析メタデータ側で
 * 与えられるため、CREATE ... AS の前置きは lineage に寄与しない。
 */

const metadata = {
  analysis_id: "v1_5_0_060",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "a", field_path: "a" },
  { table_name: "p.d.t", column_name: "b", field_path: "b" }
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
    throw new Error("test_v1_5_0_060: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function pathPairs(result) {
  return (result.exported_tables.lineage_paths || []).map((p) =>
    String(p.output_column_name || "").toUpperCase() + "<-" +
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
    JSON.stringify(errorCodes(result)) + " " +
    (JSON.parse(result.analysis.error_detail_json || "{}").message || "")
  );
  return result;
}

// 報告ケース: CREATE OR REPLACE TEMP TABLE t AS (SELECT ...)。
const reported = clean(
  "CTAS TEMP paren",
  "CREATE OR REPLACE TEMP TABLE t AS (SELECT a, b FROM p.d.t)"
);
assert(
  pathPairs(reported).includes("A<-P.D.T.A") &&
  pathPairs(reported).includes("B<-P.D.T.B"),
  "CTAS paren lineage expected, got " + JSON.stringify(pathPairs(reported))
);

// バリエーション。
clean("CTAS paren + ;", "CREATE OR REPLACE TEMP TABLE t AS (SELECT a FROM p.d.t);");
clean("CTAS TABLE paren", "CREATE OR REPLACE TABLE p.d.x AS (SELECT a FROM p.d.t)");
clean("CREATE VIEW paren", "CREATE VIEW p.d.v AS (SELECT a FROM p.d.t)");
clean(
  "CTAS paren WITH",
  "CREATE OR REPLACE TABLE p.d.x AS " +
  "(WITH c AS (SELECT a FROM p.d.t) SELECT a FROM c)"
);

// 回帰: 括弧なし CTAS / 素の SELECT / 全体括弧 / CTE / 列別名 AS / スカラーサブクエリ AS。
clean("CTAS bare", "CREATE OR REPLACE TEMP TABLE t AS SELECT a, b FROM p.d.t");
clean("plain select", "SELECT a, b FROM p.d.t");
clean("whole wrapped", "(SELECT a FROM p.d.t)");
clean("CTE", "WITH c AS (SELECT a FROM p.d.t) SELECT a FROM c");
const colAlias = clean("column alias AS", "SELECT a AS x FROM p.d.t");
assert(
  pathPairs(colAlias).includes("X<-P.D.T.A"),
  "column alias must still resolve, got " + JSON.stringify(pathPairs(colAlias))
);
clean("scalar subquery AS", "SELECT (SELECT MAX(b) FROM p.d.t) AS x FROM p.d.t");

console.log(JSON.stringify({
  test: "test_v1_5_0_060",
  status: "PASS",
  issue: "CREATE ... AS (SELECT ...) の括弧付き本体を解析でき、" +
    "『トップレベルの SELECT が見つからない』を出さない"
}));
