const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-064 — 非修飾列が「実在ソースには無いが、メタデータ未収集(=消えた/未収集)
 * のソースが候補にある」場合に、ERROR ではなく WARNING に落とす。
 *
 * JOBS から採取した SQL は、一時/短命テーブル(実行後に消える)を参照することがある。
 *   SELECT col1 FROM ghost_ds.ghost_table AS a JOIN real_ds.real_t AS b ON a.id = b.id
 * ここで ghost_table は既に存在せず列が1つも収集されない。従来、非修飾 col1 は
 * present な real_t に無いため PHYSICAL_COLUMN_NOT_FOUND(ERROR)になり、オブジェクトが
 * COMPLETED_WITH_ERRORS -> 非 publishable -> registry FAILED、毎回リトライされていた。
 *
 * 修飾ありの参照(a.col1)は既に、ソースにメタデータが無ければ
 * PHYSICAL_METADATA_NOT_FOUND(WARNING)として扱われる(#resolveAgainstPhysicalSource /
 * #hasMetadataForSource)。本修正は非修飾の複数候補経路(#disambiguateAcrossSources)でも
 * 同じ扱いに揃える: どの present ソースにも列が無く、候補に「メタデータ未収集の物理
 * ソース」があれば、その列はそのソース由来かもしれないので PHYSICAL_COLUMN_NOT_FOUND
 * ではなく PHYSICAL_METADATA_NOT_FOUND(WARNING)にする。
 *
 * 「消えた(publish)」か「未収集=カバレッジ不足(FAILED)」かの最終判定は 03 パイプライン側が
 * INFORMATION_SCHEMA.TABLES で行う(batch_object_source_flags)。エンジンは WARNING に
 * するところまで。誤抑制しない: 全ソースが present(メタあり)なら従来どおり ERROR のまま。
 */

const metadata = {
  analysis_id: "v1_5_0_064",
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
    throw new Error("test_v1_5_0_064: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

const presentCols = [
  { table_name: "real_ds.real_t", column_name: "k", field_path: "k" },
  { table_name: "real_ds.real_t", column_name: "id", field_path: "id" }
];

// 1) 報告ケース: 非修飾 col1、ghost_table は未収集、real_t は present だが col1 無し。
//    WARNING(PHYSICAL_METADATA_NOT_FOUND)へ落ち、ERROR は出ない。
const missing = analyze(
  "SELECT col1, k FROM ghost_ds.ghost_table AS a " +
  "JOIN real_ds.real_t AS b ON a.id = b.id",
  presentCols
);
assert(
  !errorCodes(missing).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "unqualified col with an absent source must not raise PHYSICAL_COLUMN_NOT_FOUND, got " +
    JSON.stringify(errorCodes(missing))
);
assert(
  (missing.exported_tables.diagnostics || []).some(
    (d) => d.severity === "WARNING" && d.code === "PHYSICAL_METADATA_NOT_FOUND"
  ),
  "expected a PHYSICAL_METADATA_NOT_FOUND warning for the absent source"
);

// 2) 修飾版はこれまでどおり WARNING(回帰ガード)。
const qualified = analyze(
  "SELECT a.col1 FROM ghost_ds.ghost_table AS a",
  []
);
assert(
  errorCodes(qualified).length === 0,
  "qualified col from an absent table must not error, got " +
    JSON.stringify(errorCodes(qualified))
);

// 3) 誤抑制しない: 全ソースが present(メタあり)なら、存在しない列は ERROR のまま。
const typo = analyze(
  "SELECT typo_col FROM real_ds.real_t AS b",
  presentCols
);
assert(
  errorCodes(typo).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "a genuine missing column on a present table must still ERROR, got " +
    JSON.stringify(errorCodes(typo))
);

// 4) 誤抑制しない: present な2ソースのどちらにも無い非修飾列も ERROR のまま
//    (absent ソースが無いため)。
const twoPresent = analyze(
  "SELECT nope FROM real_ds.a AS a JOIN real_ds.b AS b ON a.id = b.id",
  [
    { table_name: "real_ds.a", column_name: "id", field_path: "id" },
    { table_name: "real_ds.b", column_name: "id", field_path: "id" }
  ]
);
assert(
  twoPresent.exported_tables.diagnostics
    .filter((d) => d.severity === "ERROR")
    .some((d) => d.code === "PHYSICAL_COLUMN_NOT_FOUND" || d.code === "PHYSICAL_COLUMN_AMBIGUOUS"),
  "not-found column across two present sources must still surface an ERROR, got " +
    JSON.stringify(errorCodes(twoPresent))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_064",
  status: "PASS",
  issue: "非修飾列が present ソースに無く、候補にメタデータ未収集の物理ソースがある場合、" +
    "PHYSICAL_COLUMN_NOT_FOUND(ERROR)ではなく PHYSICAL_METADATA_NOT_FOUND(WARNING)にする" +
    "(消えた一時/短命テーブル参照を FAILED にしない)。全ソース present の真の欠落は ERROR のまま。"
}));
