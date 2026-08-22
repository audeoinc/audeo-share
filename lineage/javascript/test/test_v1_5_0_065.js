const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-065 — UNNEST の配列引数は「同じ FROM 節でその UNNEST より前(左)」の
 * ソースと外側スコープだけを参照できる(lateral/相関)。後から JOIN されるソースが
 * 同名列を持っていても、それは配列引数の候補にならない。
 *
 *   WITH cte AS (SELECT col FROM d.c)
 *   SELECT Col
 *   FROM d.t AS t, UNNEST(Col) AS Col
 *   INNER JOIN cte AS t2 ON Col = t2.col
 *
 * UNNEST の別名 Col が配列列 Col と同名で紛らわしいが、UNNEST(Col) の引数 Col は
 * 先行する t の配列列 d.t.Col を指す。従来、候補探索がスコープ内の全ソースを見て
 * いたため、後続 JOIN の CTE(列 col を公開)まで候補に含め、Col が {D.T, CTE} で
 * PHYSICAL_COLUMN_AMBIGUOUS(ERROR)になっていた(COMPLETED_WITH_ERRORS)。
 *
 * 修正: UNNEST 配列引数の候補を、所有 UNNEST の登場順(source_seq)より前のソース
 * (＋外側スコープ)に限定。自分自身と後続ソースは除外する。真に曖昧なケース
 * (先行ソースが2つとも同名列を持つ)は従来どおり AMBIGUOUS のまま。
 */

const metadata = {
  analysis_id: "v1_5_0_065",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-18T00:00:00Z"
};

function analyze(sql, cols) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_065: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function lineage(result) {
  return (result.exported_tables.lineage_paths || [])
    .map((p) =>
      String(p.output_column_name || "").toUpperCase() + "<-" +
      String(p.physical_table_name || "").toUpperCase() + "." +
      String(p.physical_column_name || p.field_path || "").toUpperCase()
    )
    .sort();
}

// 1) 報告ケース: UNNEST(Col) の引数は先行 t の配列列に解決。後続 CTE の col は
//    候補にならない。AMBIGUOUS を出さず、Col <- D.T.COL に解決。
const reported = analyze(
  "WITH cte AS (SELECT col FROM d.c)\n" +
  "SELECT Col\n" +
  "FROM d.t AS t, UNNEST(Col) AS Col\n" +
  "INNER JOIN cte AS t2 ON Col = t2.col",
  [
    { table_name: "d.t", column_name: "Col", field_path: "Col" },
    { table_name: "d.c", column_name: "col", field_path: "col" }
  ]
);
assert(
  !errorCodes(reported).includes("PHYSICAL_COLUMN_AMBIGUOUS"),
  "UNNEST arg must not be ambiguous with a later-joined CTE column, got " +
    JSON.stringify(errorCodes(reported))
);
assert(
  lineage(reported).includes("COL<-D.T.COL"),
  "expected Col to resolve to d.t.Col, got " + JSON.stringify(lineage(reported))
);

// 2) 誤抑制しない: 先行ソースが2つとも同名列を持つと UNNEST 引数は真に曖昧 →
//    従来どおり AMBIGUOUS。
const genuinelyAmbiguous = analyze(
  "SELECT 1 AS n FROM d.a AS a, d.b AS b, UNNEST(x) AS u",
  [
    { table_name: "d.a", column_name: "x", field_path: "x" },
    { table_name: "d.b", column_name: "x", field_path: "x" }
  ]
);
assert(
  errorCodes(genuinelyAmbiguous).includes("PHYSICAL_COLUMN_AMBIGUOUS"),
  "UNNEST arg ambiguous across two PRECEDING sources must still ERROR, got " +
    JSON.stringify(errorCodes(genuinelyAmbiguous))
);

// 3) 回帰ガード: 通常(非 UNNEST)の真の曖昧は従来どおり AMBIGUOUS。
const plainAmbiguous = analyze(
  "SELECT x FROM d.a AS a JOIN d.b AS b ON a.id = b.id",
  [
    { table_name: "d.a", column_name: "x", field_path: "x" },
    { table_name: "d.a", column_name: "id", field_path: "id" },
    { table_name: "d.b", column_name: "x", field_path: "x" },
    { table_name: "d.b", column_name: "id", field_path: "id" }
  ]
);
assert(
  errorCodes(plainAmbiguous).includes("PHYSICAL_COLUMN_AMBIGUOUS"),
  "a genuinely ambiguous plain column must still ERROR, got " +
    JSON.stringify(errorCodes(plainAmbiguous))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_065",
  status: "PASS",
  issue: "UNNEST の配列引数の可視範囲を、同一 FROM 内でその UNNEST より前のソース(＋外側" +
    "スコープ)に限定。後続 JOIN の同名列(CTE の col 等)を候補にせず誤 AMBIGUOUS を解消。" +
    "先行ソースが複数一致する真の曖昧は従来どおりエラー。"
}));
