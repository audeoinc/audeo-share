const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-056 — JOIN ... USING(col) の結合キー列が PHYSICAL_COLUMN_AMBIGUOUS に
 * なる誤検知の修正。
 *
 * 症状: すべてCTEを2回 INNER JOIN し、USING で結合、カラム修飾なしのSQLで
 *   `SELECT id FROM c1 INNER JOIN c2 USING(id) INNER JOIN c3 USING(id)`
 * の `id` が「複数ソースに存在する曖昧な列」と判定され ERROR になっていた。
 *
 * 原因: パーサは USING 列を join.using_columns に記録していたが、リゾルバが
 * それを使っていなかった。SourceResolver は USING 情報を scope に残さず、
 * ColumnResolver は候補ソースが2つ以上あれば無条件で AMBIGUOUS を返していた。
 *
 * 修正: SourceResolver が scope.join_using_columns に USING 列名を記録し、
 * ColumnResolver は修飾なし参照がその USING 列名なら、登録順で先頭(FROM/左側)
 * のソースへ確定解決する（USING は結合キーを1論理列へ統合するため曖昧ではない）。
 *
 * ON 結合（USING でない）で同名列が両ソースにある場合は、従来どおり曖昧として
 * ERROR にする回帰も併せて確認する。
 */

const metadata = {
  analysis_id: "v1_5_0_056",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.base", column_name: "id", field_path: "id" },
  { table_name: "p.d.base", column_name: "amt", field_path: "amt" },
  { table_name: "p.d.dim", column_name: "id", field_path: "id" },
  { table_name: "p.d.dim", column_name: "label", field_path: "label" }
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
    throw new Error("test_v1_5_0_056: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function noError(name, sql) {
  const result = analyze(sql);
  const codes = errorCodes(result);
  assert(
    result.analysis.analysis_status !== "PARTIAL_FAILURE" && codes.length === 0,
    `${name}: expected clean parse, got ${result.analysis.analysis_status} ` +
    JSON.stringify(codes)
  );
  return result;
}

// 単一 INNER JOIN USING、すべて CTE、修飾なし。
noError(
  "single USING",
  "WITH c1 AS (SELECT id, amt FROM p.d.base), " +
  "c2 AS (SELECT id, label FROM p.d.dim) " +
  "SELECT id, amt, label FROM c1 INNER JOIN c2 USING(id)"
);

// 二重 INNER JOIN USING、すべて CTE、修飾なし（報告されたケース）。
noError(
  "double USING (reported case)",
  "WITH c1 AS (SELECT id, amt FROM p.d.base), " +
  "c2 AS (SELECT id, label FROM p.d.dim), " +
  "c3 AS (SELECT id FROM p.d.base) " +
  "SELECT id FROM c1 INNER JOIN c2 USING(id) INNER JOIN c3 USING(id)"
);

// 複数列の USING も曖昧にならない。
noError(
  "multi-column USING",
  "WITH c1 AS (SELECT id, amt FROM p.d.base), " +
  "c2 AS (SELECT id, amt FROM p.d.base) " +
  "SELECT id, amt FROM c1 INNER JOIN c2 USING(id, amt)"
);

// LEFT JOIN USING でも同様。
noError(
  "LEFT JOIN USING",
  "WITH c1 AS (SELECT id, amt FROM p.d.base), " +
  "c2 AS (SELECT id, label FROM p.d.dim) " +
  "SELECT id FROM c1 LEFT JOIN c2 USING(id)"
);

// 回帰: ON 結合（USING でない）で両ソースに同名列があり修飾なし参照は、
// 従来どおり曖昧として ERROR にする。
const onJoin = analyze(
  "WITH c1 AS (SELECT id FROM p.d.base), " +
  "c2 AS (SELECT id FROM p.d.dim) " +
  "SELECT id FROM c1 INNER JOIN c2 ON c1.id > c2.id"
);
assert(
  errorCodes(onJoin).includes("PHYSICAL_COLUMN_AMBIGUOUS"),
  "ON join with duplicate unqualified column must remain ambiguous, got " +
  JSON.stringify(errorCodes(onJoin))
);

// USING で解決しても、USING 列以外の修飾なし列は正しく個別ソースへ解決される。
noError(
  "USING plus non-key columns",
  "WITH c1 AS (SELECT id, amt FROM p.d.base), " +
  "c2 AS (SELECT id, label FROM p.d.dim) " +
  "SELECT id, amt, label FROM c1 INNER JOIN c2 USING(id)"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_056",
  status: "PASS",
  issue: "JOIN ... USING(col) の結合キー列を修飾なし参照しても " +
    "PHYSICAL_COLUMN_AMBIGUOUS にならず、先頭ソースへ確定解決する"
}));
