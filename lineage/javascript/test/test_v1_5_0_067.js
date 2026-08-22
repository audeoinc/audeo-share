const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-067 — スクリプト変数フォールバック（options.script_variables）。
 *
 * BigQuery の multi-statement script（DECLARE aaa; SET aaa='...'; SELECT ... WHERE
 * x = aaa）は、子ステートメント（JOBS に SELECT / CTAS として記録される 1 文）の
 * query に DECLARE / SET を含まない。そのため変数 aaa は修飾なし識別子として現れ、
 * 列と区別がつかず PHYSICAL_COLUMN_NOT_FOUND（ERROR）になっていた（@param / ? と
 * 違い構文マーカーが無い）。
 *
 * 対応: 親スクリプトの宣言変数名を options.script_variables で渡す。物理解決で
 * 「修飾なし」かつ「列として解決できなかった（NOT_FOUND / UNRESOLVED）」参照の名前が
 * この集合にあれば、値（系統なし）として解決する。列優先は維持（列として解決できる
 * なら列、複数ソース実在の AMBIGUOUS もそのまま）。修飾あり table.aaa は対象外。
 */

const metadata = {
  analysis_id: "v1_5_0_067",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-18T00:00:00Z"
};

const cols = [
  { table_name: "d.t", column_name: "dt", field_path: "dt" },
  { table_name: "d.t", column_name: "col", field_path: "col" }
];

function analyze(sql, options) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify(options),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_067: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

const CHILD_SELECT = "SELECT * FROM d.t WHERE dt = aaa";

// 1) script_variables 無し: 従来どおり PHYSICAL_COLUMN_NOT_FOUND(ERROR)。
const baseline = analyze(CHILD_SELECT, { strict_mode: false });
assert(
  errorCodes(baseline).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "baseline (no script_variables) should still error, got " + JSON.stringify(errorCodes(baseline))
);

// 2) script_variables=[aaa]: 変数として扱い、エラーなく COMPLETED。
const withVar = analyze(CHILD_SELECT, { strict_mode: false, script_variables: ["aaa"] });
assert(
  errorCodes(withVar).length === 0,
  "with script_variables=[aaa] should not error, got " + JSON.stringify(errorCodes(withVar))
);
assert(
  withVar.analysis.analysis_status === "COMPLETED",
  "with script_variables=[aaa] should be COMPLETED, got " + withVar.analysis.analysis_status
);

// 3) 大文字小文字を無視して一致（正規化）。
const caseInsensitive = analyze("SELECT * FROM d.t WHERE dt = AAA", {
  strict_mode: false,
  script_variables: ["aaa"]
});
assert(
  errorCodes(caseInsensitive).length === 0,
  "script variable match should be case-insensitive, got " + JSON.stringify(errorCodes(caseInsensitive))
);

// 4) 列優先: 変数名が実在列と同名でも、列として解決できるなら列（変数扱いしない）。
//    'col' は d.t の実在列。script_variables に col があっても列解決が優先され、
//    エラーは出ない（＝列として解決）。
const columnWins = analyze("SELECT col FROM d.t WHERE dt = col", {
  strict_mode: false,
  script_variables: ["col"]
});
assert(
  columnWins.analysis.analysis_status === "COMPLETED" && errorCodes(columnWins).length === 0,
  "a real column must win over a same-named script variable, got " +
    columnWins.analysis.analysis_status + " " + JSON.stringify(errorCodes(columnWins))
);
assert(
  (columnWins.exported_tables.lineage_paths || []).some(
    (p) => String(p.output_column_name).toUpperCase() === "COL"
  ),
  "the real column 'col' should still produce lineage (not be skipped as a variable)"
);

// 5) 誤抑制しない: 変数集合に無い未解決識別子は従来どおり ERROR。
const typo = analyze("SELECT * FROM d.t WHERE dt = zzz", {
  strict_mode: false,
  script_variables: ["aaa"]
});
assert(
  errorCodes(typo).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "an unresolved name that is not a script variable must still error, got " +
    JSON.stringify(errorCodes(typo))
);

// 6) 修飾あり table.aaa は列 / STRUCT フィールド扱い（変数フォールバック対象外）。
const qualified = analyze("SELECT dt FROM d.t AS t WHERE t.dt = t.aaa", {
  strict_mode: false,
  script_variables: ["aaa"]
});
assert(
  errorCodes(qualified).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "a qualified reference must not be treated as a script variable, got " +
    JSON.stringify(errorCodes(qualified))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_067",
  status: "PASS",
  issue: "options.script_variables で親スクリプトの DECLARE/SET 変数を渡し、修飾なしで列解決" +
    "できなかった識別子が変数なら値扱い（系統なし）で COMPLETED。列優先・誤抑制なし・" +
    "修飾ありは対象外。"
}));
