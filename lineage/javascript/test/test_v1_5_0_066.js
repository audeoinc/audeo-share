const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-066 — 位置パラメータ '?'（positional query parameter）を認識する。
 *
 * DAG / クライアントが実行するパラメータ化クエリの SQL テキスト（JOBS.query に
 * そのまま入る）には、名前付き @param と名前なしの位置パラメータ '?' が現れる。
 * 名前付き @name はレキサが PARAMETER Token として処理し正常だったが、'?' は
 * 未知文字として解析失敗（PARTIAL_FAILURE）になり、「未解決」と「パラメータ」の
 * 区別がつかなかった。
 *
 * 修正: レキサが '?' を @name と同じ PARAMETER Token として読み取る。'?' は値
 * (不透明・系統なし)なので、WHERE / IN / LIMIT / SELECT のどこにあってもリネージに
 * 影響せず、解析は COMPLETED になる。名前付き @param の挙動は不変。
 */

const metadata = {
  analysis_id: "v1_5_0_066",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-18T00:00:00Z"
};

const cols = [
  { table_name: "d.t", column_name: "col", field_path: "col" },
  { table_name: "d.t", column_name: "d", field_path: "d" }
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
    throw new Error("test_v1_5_0_066: " + message);
  }
}

function status(result) {
  return result.analysis.analysis_status;
}

function lineage(result) {
  return (result.exported_tables.lineage_paths || [])
    .map((p) =>
      String(p.output_column_name || "").toUpperCase() + "<-" +
      String(p.physical_column_name || p.field_path || "").toUpperCase()
    )
    .sort();
}

// 位置パラメータ '?' を含む各種の形が COMPLETED になり、リネージは正しく COL<-COL。
const positional = [
  "SELECT col FROM d.t WHERE d = ?",
  "SELECT col FROM d.t WHERE d IN (?, ?, ?)",
  "SELECT col FROM d.t LIMIT ?",
  "SELECT ? AS x, col FROM d.t",
  "SELECT col FROM d.t WHERE d BETWEEN ? AND ?"
];

for (const sql of positional) {
  const result = analyze(sql);
  assert(
    status(result) === "COMPLETED",
    `positional '?' should complete for [${sql}], got ${status(result)}`
  );
  assert(
    lineage(result).includes("COL<-COL"),
    `lineage should be COL<-COL for [${sql}], got ${JSON.stringify(lineage(result))}`
  );
}

// 名前付き @param と '?' の混在も COMPLETED。
const mixed = analyze("SELECT col FROM d.t WHERE d = ? AND col > @thr");
assert(status(mixed) === "COMPLETED", "mixed '?' and @param should complete, got " + status(mixed));

// 回帰ガード: 名前付き @param のみの従来ケースも引き続き COMPLETED。
const named = analyze("SELECT col FROM d.t WHERE d = @p");
assert(status(named) === "COMPLETED", "named @param should still complete, got " + status(named));

console.log(JSON.stringify({
  test: "test_v1_5_0_066",
  status: "PASS",
  issue: "位置パラメータ '?' をレキサが PARAMETER Token として認識。名前なしパラメータが" +
    "PARTIAL_FAILURE になって『未解決かパラメータか区別できない』問題を解消。値なので" +
    "系統に影響せず COMPLETED、名前付き @param は不変。"
}));
