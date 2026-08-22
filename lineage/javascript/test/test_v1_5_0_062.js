const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-062 — HAVING EXISTS の中で UNNEST が2つ以上ある相関サブクエリで、
 * UNNEST の配列引数が外側 SELECT の集約エイリアスを指すケース。
 *
 *   SELECT t.grp, ARRAY_AGG(t.col) AS arr
 *   FROM d.t AS t
 *   GROUP BY ALL
 *   HAVING EXISTS (
 *     SELECT 1 FROM UNNEST(arr) AS a
 *     INNER JOIN UNNEST(['zzz','yyy']) AS b ON a = b
 *   )
 *
 * `arr` は外側の `ARRAY_AGG(t.col) AS arr` への相関参照。従来、非修飾の配列引数
 * `arr` の解決はローカル Scope の候補（列集合不明の UNNEST ソース a, b）を総当りで
 * 拾い、UNNEST が1つなら誤ってそのソースへ、2つ以上なら AMBIGUOUS になり
 * PhysicalColumnResolver 段で PHYSICAL_COLUMN_NOT_FOUND（"ARR" が候補物理テーブルに
 * 無い）を誤検出していた。
 *
 * 修正: UNNEST の配列引数（clause_type = FROM_UNNEST / JOIN_UNNEST）で、ローカルに
 * 既知列を公開する確定一致が無い場合に限り、祖先 Scope の一意な出力エイリアスへ
 * SELECT_ALIAS_RESOLVED として解決する。物理列探索は行わない（集約式側の Lineage が
 * 既に依存列を保持している）。単一 UNNEST や、ローカルに実列がある場合の解決は不変。
 */

const metadata = {
  analysis_id: "v1_5_0_062",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-18T00:00:00Z"
};

const cols = [
  { table_name: "d.t", column_name: "grp", field_path: "grp" },
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
    throw new Error("test_v1_5_0_062: " + message);
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
      String(p.physical_column_name || p.field_path || "").toUpperCase()
    )
    .sort();
}

// 期待するリネージ（EXISTS は出力列を持たないため、どの形でも同一）。
const EXPECTED = ["ARR<-COL", "GRP<-GRP"];

// 1) 報告どおりの INNER JOIN 形（外側集約エイリアス arr + リテラル配列）。
const innerJoin = analyze(`
  SELECT t.grp, ARRAY_AGG(t.col) AS arr
  FROM d.t AS t
  GROUP BY ALL
  HAVING EXISTS (
    SELECT 1 FROM UNNEST(arr) AS a
    INNER JOIN UNNEST(['zzz', 'yyy']) AS b ON a = b
  )
`);
assert(
  !errorCodes(innerJoin).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "INNER JOIN UNNEST: correlated array alias must not raise PHYSICAL_COLUMN_NOT_FOUND, got " +
    JSON.stringify(errorCodes(innerJoin))
);
assert(
  JSON.stringify(lineage(innerJoin)) === JSON.stringify(EXPECTED),
  "INNER JOIN UNNEST: lineage mismatch, got " + JSON.stringify(lineage(innerJoin))
);

// 2) カンマ結合で UNNEST が2つ（両方とも外側エイリアス参照）。
const commaTwo = analyze(`
  SELECT t.grp, ARRAY_AGG(t.col) AS arr, ARRAY_AGG(t.grp) AS garr
  FROM d.t AS t
  GROUP BY ALL
  HAVING EXISTS (
    SELECT 1 FROM UNNEST(arr) AS a, UNNEST(garr) AS g
    WHERE a > 0 AND g IS NOT NULL
  )
`);
assert(
  !errorCodes(commaTwo).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "comma UNNEST x2: must not raise PHYSICAL_COLUMN_NOT_FOUND, got " +
    JSON.stringify(errorCodes(commaTwo))
);

// 3) 単一 UNNEST（回帰ガード: 元から通っていた形が壊れていないこと）。
const single = analyze(`
  SELECT t.grp, ARRAY_AGG(t.col) AS arr
  FROM d.t AS t
  GROUP BY ALL
  HAVING EXISTS (SELECT 1 FROM UNNEST(arr) AS a WHERE a > 0)
`);
assert(
  !errorCodes(single).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "single UNNEST: must not raise PHYSICAL_COLUMN_NOT_FOUND, got " +
    JSON.stringify(errorCodes(single))
);
assert(
  JSON.stringify(lineage(single)) === JSON.stringify(EXPECTED),
  "single UNNEST: lineage mismatch, got " + JSON.stringify(lineage(single))
);

// 4) ガード: UNNEST の配列引数がローカルの実列を指す場合は、外側エイリアスへ
//    倒さず従来どおりローカル解決される（内側スコープ勝ち）。物理列 col は
//    スカラだが、UNNEST(col) の col はローカル t.col へ解決され、外側に同名
//    エイリアスは無いため相関フォールバックは作動しない。ここでは単に
//    PHYSICAL_COLUMN_NOT_FOUND を出さないことを確認する。
const localCol = analyze(`
  SELECT t.grp, ARRAY_AGG(t.col) AS arr
  FROM d.t AS t
  GROUP BY ALL
  HAVING EXISTS (SELECT 1 FROM UNNEST([t.grp]) AS a WHERE a IS NOT NULL)
`);
assert(
  !errorCodes(localCol).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "local-column UNNEST arg: unexpected PHYSICAL_COLUMN_NOT_FOUND, got " +
    JSON.stringify(errorCodes(localCol))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_062",
  status: "PASS",
  issue: "HAVING EXISTS 内で UNNEST が2つ以上（INNER JOIN / カンマ）ある相関サブクエリで、" +
    "外側集約エイリアスを指す UNNEST 配列引数が PHYSICAL_COLUMN_NOT_FOUND を誤検出しない。" +
    "祖先 Scope の一意な出力エイリアスへ SELECT_ALIAS_RESOLVED として解決する。"
}));
