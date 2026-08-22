const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-063 — 相関 UNNEST の配列引数を非修飾で書いたケース。
 *
 *   FROM t AS a, UNNEST(col1) AS b
 *   LEFT JOIN UNNEST(col2) AS c ON TRUE
 *
 * ここで col2 は col1 要素(STRUCT)のフィールド、すなわち実質 b.col2。修飾すれば
 * (UNNEST(b.col2)) エラーは出ないが、非修飾 UNNEST(col2) は誤って
 * PHYSICAL_COLUMN_NOT_FOUND("COL2") になっていた。
 *
 * 原因: 参照 col2 は3番目の UNNEST ソース c の配列引数。候補集合に c 自身が
 * 含まれてしまい、物理段の相関UNNEST解決(「スコープにUNNESTが1つだけなら要素
 * フィールド参照とみなす」規則)が UNNEST候補=2({b,c}) となって発火せず、
 * PHYSICAL_COLUMN_NOT_FOUND に落ちていた。UNNEST の配列式は自分自身の要素を
 * 参照できない(循環)。
 *
 * 修正: 非修飾名の候補探索から、その配列引数を所有する UNNEST ソース自身を
 * 除外する。これにより先行 UNNEST が1つ(b)だけになり、物理段の相関UNNEST解決へ
 * 正しく委譲され、修飾版 UNNEST(b.col2) と同じ非エラー状態(値 c は要素由来で
 * PARTIALLY_RESOLVED の WARNING 止まり)になる。先行 UNNEST が複数あって真に
 * 曖昧な場合は従来どおり解決しない(誤抑制しない)。
 */

const metadata = {
  analysis_id: "v1_5_0_063",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-18T00:00:00Z"
};

// col1 は ARRAY<STRUCT<id INT64, col2 ARRAY<STRING>>> を模した field_path。
const cols = [
  { table_name: "d.t", column_name: "col1", field_path: "col1" },
  { table_name: "d.t", column_name: "col1", field_path: "col1.id" },
  { table_name: "d.t", column_name: "col1", field_path: "col1.col2" },
  { table_name: "d.t", column_name: "colx", field_path: "colx" },
  { table_name: "d.t", column_name: "k",    field_path: "k" }
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
    throw new Error("test_v1_5_0_063: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code + ":" + d.referenced_column_name);
}

// 1) 報告どおり: 非修飾 col2(= b.col2)。誤 PHYSICAL_COLUMN_NOT_FOUND を出さない。
const unqualified = analyze(`
  SELECT a.k, c AS v
  FROM d.t AS a, UNNEST(col1) AS b
  LEFT JOIN UNNEST(col2) AS c ON TRUE
`);
assert(
  errorCodes(unqualified).length === 0,
  "unqualified UNNEST(col2): expected no ERROR, got " + JSON.stringify(errorCodes(unqualified))
);

// 2) 修飾版と同じ結論(エラー無し)であること。
const qualified = analyze(`
  SELECT a.k, c AS v
  FROM d.t AS a, UNNEST(a.col1) AS b
  LEFT JOIN UNNEST(b.col2) AS c ON TRUE
`);
assert(
  errorCodes(qualified).length === 0,
  "qualified UNNEST(b.col2): expected no ERROR, got " + JSON.stringify(errorCodes(qualified))
);

// 3) 誤抑制しないこと: 先行 UNNEST が2つあると非修飾フィールドは真に曖昧なので
//    従来どおり解決されない(PHYSICAL_COLUMN_NOT_FOUND のまま)。
const ambiguous = analyze(`
  SELECT a.k
  FROM d.t AS a, UNNEST(col1) AS b, UNNEST(colx) AS d
  LEFT JOIN UNNEST(col2) AS c ON TRUE
`);
assert(
  errorCodes(ambiguous).some((code) => code.startsWith("PHYSICAL_COLUMN_NOT_FOUND")),
  "two preceding UNNEST: expected PHYSICAL_COLUMN_NOT_FOUND to remain, got " +
    JSON.stringify(errorCodes(ambiguous))
);

// 4) 位置制御: 先行 UNNEST 無しで実在するトップレベル配列列を非修飾 UNNEST する
//    場合は当然エラー無し。
const topLevel = analyze(`
  SELECT a.k FROM d.t AS a LEFT JOIN UNNEST(colx) AS c ON TRUE
`);
assert(
  errorCodes(topLevel).length === 0,
  "top-level UNNEST(colx): expected no ERROR, got " + JSON.stringify(errorCodes(topLevel))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_063",
  status: "PASS",
  issue: "相関 UNNEST の配列引数を非修飾で書いた形 (FROM t, UNNEST(col1) b LEFT JOIN " +
    "UNNEST(col2) c) で、所有 UNNEST 自身を候補から除外し、先行 UNNEST が1つなら " +
    "要素フィールド参照として解決。誤 PHYSICAL_COLUMN_NOT_FOUND を解消しつつ、" +
    "先行 UNNEST が複数で真に曖昧な場合は従来どおりエラーのまま。"
}));
