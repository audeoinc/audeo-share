const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-068 — FROM 位置のテーブル値関数（EXTERNAL_QUERY など）を不透明ソースとして解析。
 *
 * 症状: JOBS の SQL に `FROM EXTERNAL_QUERY('conn', '''SELECT ...''') AS a` のような
 * フェデレーテッドクエリが含まれると、"Source discovery did not complete" /
 * FromParser「JOIN を期待したが "(" が見つかった」で失敗していた。FROM のソース候補が
 * 通常テーブル / UNNEST / サブクエリしかなく、名前の直後に "(" が来る関数呼び出し形を
 * 解釈できなかったため（`EXTERNAL_QUERY` をテーブル名として読み、続く "(" で JOIN 解析へ
 * 落ちる）。
 *
 * 対応: FROM 位置で名前の直後に "(" が来る場合はテーブル値関数(TVF)呼び出しとみなし、
 * 括弧内部は解析せず対応する ")" まで読み飛ばして不透明ソース(TABLE_FUNCTION)として
 * 扱う。TABLE_FUNCTION は CTE / サブクエリと同じ派生ソース系で、物理列を持たない
 * （列参照は解決されるが系統も診断も生まない）。EXTERNAL_QUERY の出力は外部 DB 由来で
 * BigQuery 物理列にマップできないため、これは安全（過剰にも過少にも系統を作らない）。
 * `AS a` の有無どちらも対応。
 */

const metadata = {
  analysis_id: "v1_5_0_068",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-19T00:00:00Z"
};

const cols = [
  { table_name: "d.t", column_name: "id", field_path: "id" },
  { table_name: "d.t", column_name: "col", field_path: "col" }
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
    throw new Error("test_v1_5_0_068: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function lineageOutputs(result) {
  return (result.exported_tables.lineage_paths || [])
    .map((p) => String(p.output_column_name).toUpperCase());
}

// 1) EXTERNAL_QUERY AS a + 修飾参照 a.ext_col。パース成功・エラーなし・COMPLETED。
//    a は外部ソースなので ext_col には物理系統が付かない。
const qualified = analyze(
  "SELECT a.ext_col FROM EXTERNAL_QUERY('my_conn', 'SELECT ext_col FROM remote_table') AS a"
);
assert(
  qualified.analysis.analysis_status === "COMPLETED",
  "EXTERNAL_QUERY AS a should parse and be COMPLETED, got " +
    qualified.analysis.analysis_status
);
assert(
  errorCodes(qualified).length === 0,
  "EXTERNAL_QUERY AS a should not error, got " + JSON.stringify(errorCodes(qualified))
);

// 2) 別名なし EXTERNAL_QUERY（単一ソース）＋修飾なし参照。エラーなし・COMPLETED。
const noAlias = analyze(
  "SELECT ext_col FROM EXTERNAL_QUERY('my_conn', 'SELECT ext_col FROM remote_table')"
);
assert(
  noAlias.analysis.analysis_status === "COMPLETED" && errorCodes(noAlias).length === 0,
  "EXTERNAL_QUERY without alias should parse cleanly, got " +
    noAlias.analysis.analysis_status + " " + JSON.stringify(errorCodes(noAlias))
);

// 3) 実テーブルと CROSS JOIN。実テーブルの列は物理系統が残り、外部ソース列はエラー無し。
const joined = analyze(
  "SELECT t.col, a.ext_col " +
  "FROM d.t AS t " +
  "CROSS JOIN EXTERNAL_QUERY('my_conn', 'SELECT ext_col FROM remote_table') AS a"
);
assert(
  joined.analysis.analysis_status === "COMPLETED",
  "join with EXTERNAL_QUERY should be COMPLETED, got " + joined.analysis.analysis_status
);
assert(
  errorCodes(joined).length === 0,
  "join with EXTERNAL_QUERY should not error, got " + JSON.stringify(errorCodes(joined))
);
assert(
  lineageOutputs(joined).includes("COL"),
  "the real table column 'col' must still produce lineage in a join with EXTERNAL_QUERY"
);

// 4) dataset 修飾の TVF 呼び出し（dataset.my_tvf(x)）も同様に不透明ソースとして解析。
const dottedTvf = analyze(
  "SELECT f.v FROM d.my_tvf('x') AS f"
);
assert(
  dottedTvf.analysis.analysis_status === "COMPLETED" && errorCodes(dottedTvf).length === 0,
  "a dotted TVF call should parse cleanly, got " +
    dottedTvf.analysis.analysis_status + " " + JSON.stringify(errorCodes(dottedTvf))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_068",
  status: "PASS",
  issue: "FROM 位置の EXTERNAL_QUERY / TVF 呼び出し（name(...) 形）を不透明ソース" +
    "(TABLE_FUNCTION)として解析。パース成功・列参照は解決するが系統/診断なし。" +
    "別名有無・実テーブルとの JOIN・dataset 修飾いずれも対応。"
}));
