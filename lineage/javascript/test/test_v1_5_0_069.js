const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-069 — カラム利用箇所インデックス(column_usages のエクスポート)。
 *
 * 目的: あるテーブル/ビューのカラムの要件変更時に影響を確認するため、「どの
 * table/view のどの行で、どういう使われ方(SELECT/WHERE/JOIN/GROUP BY/...)で参照
 * されているか」を出せるようにする。エンジンは全カラム参照(値フローの SELECT だけ
 * でなく WHERE/JOIN/GROUP BY 等も)を物理解決済みで保持しており、clause_type と
 * トークン範囲を持つ。exporter がそれを平坦化し、解決済み物理列ごとに1行の
 * column_usages を出す。各行は usage_type(=clause) / reference_name / 解決済み
 * source 物理列(physical_table_name.physical_column_name, field_path) /
 * line_number / column_number / line_text(参照トークンのある1行) を持つ。
 *
 * 03 STEP 3 がこれを t_lineage_column_usage に publish する(この回帰は engine の
 * 出力契約のみを検証)。
 */

const metadata = {
  analysis_id: "v1_5_0_069",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-19T00:00:00Z"
};

const cols = [
  { table_name: "d.t", column_name: "id", field_path: "id" },
  { table_name: "d.t", column_name: "col", field_path: "col" },
  { table_name: "d.t", column_name: "flag", field_path: "flag" },
  { table_name: "d.u", column_name: "id", field_path: "id" },
  { table_name: "d.u", column_name: "amount", field_path: "amount" }
];

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false, compact_export: true }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_069: " + message);
  }
}

function usages(result) {
  return result.exported_tables.column_usages || [];
}

// A usage row matcher: by source column + clause.
function find(rows, table, column, clause) {
  return rows.find((u) =>
    String(u.physical_table_name).toUpperCase() === table &&
    String(u.physical_column_name).toUpperCase() === column &&
    u.usage_type === clause
  );
}

// 1) 複数句(SELECT / WHERE / GROUP BY / JOIN)で使われるカラムを、句ごとに
//    行番号・行テキストつきで拾えること。
const sql1 =
  "SELECT t.col AS c, u.amount AS a\n" +      // line 1
  "FROM d.t AS t\n" +                          // line 2
  "JOIN d.u AS u ON u.id = t.id\n" +           // line 3
  "WHERE t.flag = 1\n" +                       // line 4
  "GROUP BY t.col, u.amount";                  // line 5
const r1 = analyze(sql1);
assert(
  r1.analysis.analysis_status === "COMPLETED",
  "sql1 should be COMPLETED, got " + r1.analysis.analysis_status
);
const rows1 = usages(r1);

const selectCol = find(rows1, "D.T", "COL", "SELECT");
assert(selectCol, "SELECT usage of d.t.col must be present");
assert(selectCol.line_number === 1, "d.t.col SELECT should be on line 1, got " + selectCol.line_number);
assert(
  selectCol.line_text === "SELECT t.col AS c, u.amount AS a",
  "d.t.col SELECT line_text mismatch: " + JSON.stringify(selectCol.line_text)
);

const whereFlag = find(rows1, "D.T", "FLAG", "WHERE");
assert(whereFlag, "WHERE usage of d.t.flag must be present (non-lineage usage captured)");
assert(whereFlag.line_number === 4, "d.t.flag WHERE should be on line 4, got " + whereFlag.line_number);
assert(
  whereFlag.line_text === "WHERE t.flag = 1",
  "d.t.flag WHERE line_text mismatch: " + JSON.stringify(whereFlag.line_text)
);

const joinId = find(rows1, "D.T", "ID", "JOIN_ON");
assert(joinId, "JOIN_ON usage of d.t.id must be present");
assert(joinId.line_number === 3, "d.t.id JOIN_ON should be on line 3, got " + joinId.line_number);

const groupCol = find(rows1, "D.T", "COL", "GROUP_BY");
assert(groupCol, "GROUP_BY usage of d.t.col must be present");
assert(groupCol.line_number === 5, "d.t.col GROUP_BY should be on line 5, got " + groupCol.line_number);

// reference_name + resolution_status も付いていること。
assert(
  String(selectCol.reference_name).toUpperCase() === "T.COL" &&
  selectCol.physical_resolution_status === "PHYSICAL_RESOLVED",
  "usage rows should carry reference_name and resolution_status"
);

// 2) 派生列(外部/CTE 等、物理列に解決できない参照)は column_usages に出さない。
//    ここでは EXTERNAL_QUERY の列を SELECT しても物理 usage は生まれないこと。
const sql2 =
  "SELECT a.ext_col\n" +
  "FROM EXTERNAL_QUERY('c', 'SELECT ext_col FROM r') AS a";
const r2 = analyze(sql2);
assert(
  r2.analysis.analysis_status === "COMPLETED",
  "sql2 should be COMPLETED, got " + r2.analysis.analysis_status
);
assert(
  usages(r2).length === 0,
  "external-source column must NOT produce a physical usage row, got " + JSON.stringify(usages(r2))
);

// 3) 同一カラムが同一句で複数回でも、各参照が1行として出る(位置で区別)。
const sql3 = "SELECT t.col FROM d.t AS t WHERE t.col > 0 AND t.col < 100";
const r3 = analyze(sql3);
const whereColUsages = usages(r3).filter((u) =>
  String(u.physical_column_name).toUpperCase() === "COL" && u.usage_type === "WHERE"
);
assert(
  whereColUsages.length === 2,
  "two WHERE references of d.t.col should yield two usage rows, got " + whereColUsages.length
);

console.log(JSON.stringify({
  test: "test_v1_5_0_069",
  status: "PASS",
  issue: "column_usages を新規エクスポート。全句(SELECT/WHERE/JOIN/GROUP BY 等)の解決済み" +
    "物理カラム参照を、usage_type・reference_name・source 物理列・line_number・line_text 付きで" +
    "1参照=1行で出力。派生/未解決参照は除外。t_lineage_column_usage 用の素材。"
}));
