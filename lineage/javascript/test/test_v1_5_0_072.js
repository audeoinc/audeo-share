const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-072 — 無型 STRUCT コンストラクタのフィールド別名 STRUCT(expr AS name, ...)
 * を式パーサで正しく消費する。
 *
 * 従来、関数呼び出しの引数ループは `AS <field>` を消費せず、STRUCT(a AS x) は
 * SELECT 句(項目単位の復旧が効く場所)でだけ通り、FROM の UNNEST や WHERE のように
 * 復旧の効かない構造的位置では「ExpressionParser: expected ")", but found "AS"」で
 * ハードエラーになっていた。DAG 生成 SQL に多い
 *   CROSS JOIN UNNEST(IF(ARRAY_LENGTH(aaa)>0, aaa,
 *     [STRUCT(CAST(NULL AS STRING) AS id, CAST(NULL AS TIMESTAMP) AS start_dtime)]))
 * が 03 の探索パス(strict 既定=throw)で落ちていた。
 *
 * 修正: STRUCT 呼び出しに限り、各引数の後の任意の `AS <name>` を消費して捨てる
 * (別名はフィールドラベルで列参照ではない)。値式の lineage は従来どおり保持する。
 * 他関数は対象外にして他所の構文エラーを覆い隠さない。
 *
 * 既定オプション("{}")で解析する = 03 の source-discovery パスと同じく、構文エラーが
 * throw される(項目復旧に頼らない)モードで検証する。
 */

const metadata = {
  analysis_id: "v1_5_0_072",
  view_project: "proj",
  view_dataset: "ds",
  view_name: "out",
  analyzed_at: "2026-08-18T00:00:00Z"
};

const cols = [
  { table_name: "ds.a", column_name: "aaa", field_path: "aaa" },
  { table_name: "ds.a", column_name: "k", field_path: "k" }
];

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    "{}",
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_072: " + message);
  }
}

function errorCount(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR").length;
}

function physicalPaths(result) {
  return (result.exported_tables.lineage_paths || [])
    .map((p) => p.physical_table_name + "." + p.physical_column_name)
    .sort();
}

// 1) 報告ケース: CROSS JOIN UNNEST(IF(.., [STRUCT(cast(null AS t) AS f, ...)])) が
//    throw せずに解析できる。
const reported = analyze(
  "SELECT t.id FROM ds.a CROSS JOIN UNNEST(IF(ARRAY_LENGTH(aaa) > 0, aaa, " +
  "[STRUCT(CAST(NULL AS STRING) AS id, CAST(NULL AS STRING) AS cd, " +
  "CAST(NULL AS TIMESTAMP) AS start_dtime)])) AS t"
);
assert(errorCount(reported) === 0,
  "reported UNNEST(IF(..,[STRUCT(..AS..)])) must parse with no ERROR");

// 2) WHERE(復旧の効かない位置)の STRUCT フィールド別名でも通り、値式の列は解決される。
const whereStruct = analyze("SELECT k FROM ds.a WHERE STRUCT(k AS x) IS NOT NULL");
assert(errorCount(whereStruct) === 0, "WHERE STRUCT(k AS x) must parse");
assert(physicalPaths(whereStruct).includes("DS.A.K"),
  "the STRUCT field value column must still resolve, got " +
    JSON.stringify(physicalPaths(whereStruct)));

// 3) UNNEST の STRUCT フィールド値が列参照なら lineage を保持する。
const unnestValue = analyze(
  "SELECT t.v FROM ds.a CROSS JOIN UNNEST([STRUCT(k AS v)]) AS t"
);
assert(errorCount(unnestValue) === 0, "UNNEST([STRUCT(k AS v)]) must parse");

// 4) 別名なしの STRUCT は従来どおり全列を解決する(回帰なし)。
const noAlias = analyze("SELECT STRUCT(k, aaa) AS s FROM ds.a");
assert(errorCount(noAlias) === 0, "STRUCT(k, aaa) must parse");
assert(physicalPaths(noAlias).join(",") === "DS.A.AAA,DS.A.K",
  "STRUCT without aliases must resolve every field, got " +
    JSON.stringify(physicalPaths(noAlias)));

console.log("test_v1_5_0_072: PASS");
