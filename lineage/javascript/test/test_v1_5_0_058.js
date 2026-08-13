const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-058 — UNNEST(array) WITH OFFSET AS offset の別名が予約語 OFFSET の
 * ときに出力列名が解決できない不具合の修正。
 *
 * 症状: `SELECT offset FROM t, UNNEST(arr) AS e WITH OFFSET AS offset` で、
 * SELECT の `offset` が KEYWORD として字句解析され、SelectParser の暗黙出力名
 * 導出（#deriveColumnAlias）が IDENTIFIER/BACKTICK のみ受理していたため、
 * 出力列が UNNAMED → OUTPUT_COLUMN_NAME_UNRESOLVED（WARNING）になっていた。
 * 別名が `pos` 等の通常識別子なら問題は出なかった。
 *
 * 原因: ExpressionParser は非予約 KEYWORD を識別子として解決する（OFFSET も
 * 列参照になる）のに、SelectParser の出力名導出だけが KEYWORD を弾いていた。
 *
 * 修正: SelectParser に #isColumnNameToken を追加し、ExpressionParser と同じ
 * 予約語基準で「列名になり得る KEYWORD」を出力名として導出する。NULL/TRUE/FALSE
 * などの真の予約語は従来どおり無名のまま。
 */

const metadata = {
  analysis_id: "v1_5_0_058",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "arr", field_path: "arr" },
  { table_name: "p.d.t", column_name: "id", field_path: "id" }
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
    throw new Error("test_v1_5_0_058: " + message);
  }
}

function outputNames(result) {
  return (result.exported_tables.output_columns || [])
    .map((column) => column.output_column_name);
}

function diagCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .map((diagnostic) => diagnostic.severity + ":" + diagnostic.code);
}

// 報告ケース: WITH OFFSET AS offset の別名が予約語 OFFSET。
const reported = analyze(
  "SELECT id, offset FROM p.d.t, UNNEST(arr) AS e WITH OFFSET AS offset"
);
assert(
  diagCodes(reported).length === 0,
  "reported case must be clean, got " + JSON.stringify(diagCodes(reported))
);
assert(
  outputNames(reported).includes("OFFSET"),
  "offset must resolve as an output column name, got " +
  JSON.stringify(outputNames(reported))
);

// UNNEST を主 FROM に置いた相関なしケース。
const primary = analyze(
  "SELECT offset FROM UNNEST([1, 2, 3]) AS e WITH OFFSET AS offset"
);
assert(
  diagCodes(primary).length === 0,
  "UNNEST primary case must be clean, got " + JSON.stringify(diagCodes(primary))
);
assert(
  outputNames(primary).includes("OFFSET"),
  "offset output name expected, got " + JSON.stringify(outputNames(primary))
);

// 値と offset を同時に選択。
const both = analyze(
  "SELECT e, offset FROM p.d.t, UNNEST(arr) AS e WITH OFFSET AS offset"
);
assert(
  diagCodes(both).length === 0,
  "value + offset case must be clean, got " + JSON.stringify(diagCodes(both))
);

// 通常の識別子別名（回帰）。
const pos = analyze(
  "SELECT id, pos FROM p.d.t, UNNEST(arr) AS e WITH OFFSET AS pos"
);
assert(
  diagCodes(pos).length === 0 && outputNames(pos).includes("POS"),
  "identifier offset alias must still work, got " +
  JSON.stringify(diagCodes(pos)) + " " + JSON.stringify(outputNames(pos))
);

// 回帰: NULL リテラルは暗黙の出力名を持たず、無名のままにする。
const nullItem = analyze("SELECT NULL, id FROM p.d.t");
assert(
  diagCodes(nullItem).some((code) => code.includes("OUTPUT_COLUMN_NAME_UNRESOLVED")),
  "a bare NULL must remain unnamed, got " + JSON.stringify(diagCodes(nullItem))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_058",
  status: "PASS",
  issue: "UNNEST(array) WITH OFFSET AS offset の別名が予約語 OFFSET でも " +
    "出力列名を導出でき、OUTPUT_COLUMN_NAME_UNRESOLVED を出さない"
}));
