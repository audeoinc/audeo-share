const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-071 — ExpressionParser の構文エラーに「位置(line:column, token_seq)＋周辺
 * トークン片」を付与する。
 *
 * 生成 SQL(DAG のジョブ SQL 等)が未対応構文でパース不能になると、03 は例外メッセージを
 * そのまま診断に載せる。従来は "ExpressionParser: expected \")\", but found \"AS\"." の
 * ように「どこで」失敗したかが分からず、巨大な 1 行 SQL から該当箇所を特定できなかった。
 * #expect のメッセージに `at line L column C (token_seq N) near: <周辺トークン>` を付け、
 * 診断だけで場所と文脈が分かるようにする。挙動(解析結果)は不変で、失敗時の文言のみ拡張。
 */

const metadata = {
  analysis_id: "v1_5_0_071",
  view_project: "proj",
  view_dataset: "ds",
  view_name: "out",
  analyzed_at: "2026-08-18T00:00:00Z"
};

const cols = [
  { table_name: "ds.t", column_name: "a", field_path: "a" },
  { table_name: "ds.t", column_name: "b", field_path: "b" }
];

function analyze(sql) {
  /*
   * Default options (like 03's source-discovery pass, which omits strict_mode):
   * a structural parse failure throws, and the thrown message is what 03 records
   * as the diagnostic -- exactly the message this test asserts is now locatable.
   */
  return bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    "{}",
    JSON.stringify(metadata)
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_071: " + message);
  }
}

// A parse failure inside an expression must now carry a locatable message.
let message = null;
try {
  analyze("SELECT a FROM ds.t\nWHERE a IN (b AS x)");
  assert(false, "expected a parse failure for 'IN (b AS x)'");
} catch (e) {
  message = e.message;
}

assert(/expected ".*", but found "AS"/.test(message),
  "message should still name the expected/found tokens, got: " + message);
assert(/at line \d+ column \d+ \(token_seq \d+\)/.test(message),
  "message must include line/column/token_seq, got: " + message);
assert(/near: .*AS/.test(message),
  "message must include a surrounding-token snippet, got: " + message);

// A valid expression must still analyze without error (no false positives).
const ok = JSON.parse(analyze("SELECT a, b FROM ds.t"));
assert((ok.exported_tables.diagnostics || [])
  .filter((d) => d.severity === "ERROR").length === 0,
  "valid SQL must not raise ERROR diagnostics");

console.log("test_v1_5_0_071: PASS");
