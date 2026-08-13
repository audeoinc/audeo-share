const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-039
 *
 *  1. GROUP BY ALL — `ALL` was mis-read as a column (PHYSICAL_COLUMN_NOT_FOUND).
 *     It is now recognised as the "group by all non-aggregated columns" form
 *     and produces no grouping column reference.
 *  2. Wildcard tables + pseudo-columns — `FROM \`proj.ds.events_*\`` now resolves
 *     its columns from the collected shard schemas, and `_TABLE_SUFFIX` (and the
 *     other pseudo-columns) no longer raise PHYSICAL_COLUMN_NOT_FOUND.
 *  3. UNNEST value lineage — `UNNEST(item_id) AS item_id` (and `UNNEST(t.items)
 *     AS x`) now traces the element value back to the array column instead of
 *     UNNEST_DEFERRED.
 */

const metadata = {
  analysis_id: "v1_5_0_039",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
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
    throw new Error("test_v1_5_0_039: " + message);
  }
}

function noError(name, result) {
  const errors = (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR");
  assert(
    result.analysis.analysis_status !== "PARTIAL_FAILURE" && errors.length === 0,
    `${name}: expected no error, got ${result.analysis.analysis_status} ` +
    JSON.stringify(errors.map((d) => d.code))
  );
}

function deps(result, outputName) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) =>
      String(p.output_column_name).toUpperCase() === outputName && p.physical_table_name)
    .map((p) => `${p.physical_table_name}.${p.physical_column_name}`))];
}

// 1. GROUP BY ALL
const groupCols = ["CAT", "AMT"].map((c) => ({ table_name: "P.D.T", column_name: c, field_path: c }));
const groupResult = analyze("SELECT cat, SUM(amt) AS s FROM P.D.T GROUP BY ALL", groupCols);
noError("GROUP BY ALL", groupResult);
assert(
  deps(groupResult, "CAT").includes("P.D.T.CAT"),
  "GROUP BY ALL: cat must still resolve, got " + JSON.stringify(deps(groupResult, "CAT"))
);

// 2. Wildcard table + _TABLE_SUFFIX
const shardCols = ["ID", "CAT"].map((c) => ({ table_name: "P.D.EVENTS_20200101", column_name: c, field_path: c }));
const wildcardResult = analyze(
  "SELECT id FROM `P.D.events_*` WHERE _TABLE_SUFFIX BETWEEN '20200101' AND '20200131'",
  shardCols
);
noError("wildcard + _TABLE_SUFFIX", wildcardResult);
assert(
  deps(wildcardResult, "ID").includes("P.D.EVENTS_20200101.ID"),
  "wildcard table: id must resolve to a shard column, got " + JSON.stringify(deps(wildcardResult, "ID"))
);

// _TABLE_SUFFIX must never be reported as a missing column even against a known table.
const suffixResult = analyze(
  "SELECT id FROM P.D.EVENTS_20200101 WHERE _TABLE_SUFFIX = '20200101'",
  shardCols
);
const suffixBogus = (suffixResult.exported_tables.diagnostics || []).find((d) =>
  d.code === "PHYSICAL_COLUMN_NOT_FOUND" &&
  String(d.message || "").toUpperCase().includes("_TABLE_SUFFIX")
);
assert(!suffixBogus, "_TABLE_SUFFIX must not be flagged as a missing column");

// 3. UNNEST value lineage
const unnestCols = ["ID", "ITEM_ID"].map((c) => ({ table_name: "P.D.T", column_name: c, field_path: c }));
const unnestResult = analyze("SELECT item_id FROM P.D.T, UNNEST(item_id) AS item_id", unnestCols);
noError("UNNEST value", unnestResult);
assert(
  deps(unnestResult, "ITEM_ID").includes("P.D.T.ITEM_ID"),
  "UNNEST(item_id) AS item_id: value must trace to P.D.T.ITEM_ID, got " +
  JSON.stringify(deps(unnestResult, "ITEM_ID"))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_039",
  status: "PASS",
  issue: "GROUP BY ALL, wildcard tables + _TABLE_SUFFIX pseudo-column, and UNNEST value-to-array lineage"
}));
