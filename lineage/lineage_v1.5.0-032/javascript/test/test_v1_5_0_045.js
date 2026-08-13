const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-045 — WITH RECURSIVE self-reference is not a false cycle.
 *
 * A recursive CTE's recursive term legitimately references the CTE itself
 * (`... UNION ALL SELECT a.itm_cd FROM cte_rec a JOIN ...`). The resolver's
 * cycle guard flagged this re-entry as CYCLE_DETECTED, surfacing a false
 * PARTIALLY_RESOLVED ("Unresolved: a.itm_cd @scope N [cycle detected]"). Re-entry
 * into a recursive CTE's own scope is now terminated benignly
 * (NO_COLUMN_DEPENDENCY) — the base term supplies the lineage and the recursive
 * term adds no new physical source. Non-recursive re-entry still yields
 * CYCLE_DETECTED.
 */

const metadata = {
  analysis_id: "v1_5_0_045",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = ["ITM_CD", "TYPE", "PARENT"].map((c) => ({
  table_name: "p.d.base", column_name: c, field_path: c
}));

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
    throw new Error("test_v1_5_0_045: " + message);
  }
}

function noCycle(name, result) {
  for (const l of (result.exported_tables.output_lineages || [])) {
    assert(l.lineage_status !== "CYCLE_DETECTED",
      `${name}: output ${l.output_column_name} is CYCLE_DETECTED`);
    for (const d of (l.dependencies || [])) {
      assert(d.dependency_status !== "CYCLE_DETECTED",
        `${name}: dependency ${d.source_reference_name} is CYCLE_DETECTED`);
    }
  }
}

function deps(result, out) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name && String(p.output_column_name).toUpperCase() === out)
    .map((p) => String(p.physical_column_name).toUpperCase()))];
}

// The reported shape: recursive CTE that self-joins to another CTE.
const sql =
  "WITH RECURSIVE\n" +
  "cte_c AS (SELECT itm_cd, type FROM p.d.base WHERE type IN ('aaa','bbb')),\n" +
  "cte_rec AS (\n" +
  "  SELECT itm_cd, type FROM cte_c\n" +
  "  UNION ALL\n" +
  "  SELECT a.itm_cd, a.type FROM cte_rec a\n" +
  "  INNER JOIN cte_c b ON a.itm_cd = b.itm_cd AND a.type = b.type\n" +
  ")\n" +
  "SELECT itm_cd, type FROM cte_rec";

let r = analyze(sql);
assert(r.analysis.analysis_status === "COMPLETED",
  "recursive CTE should be COMPLETED, got " + r.analysis.analysis_status);
noCycle("recursive self-join", r);
assert(deps(r, "ITM_CD").includes("ITM_CD"),
  "itm_cd should trace to base.itm_cd, got " + JSON.stringify(deps(r, "ITM_CD")));

// Hierarchical parent-walk recursion.
r = analyze(
  "WITH RECURSIVE r AS (\n" +
  "  SELECT itm_cd, type, parent FROM p.d.base WHERE parent IS NULL\n" +
  "  UNION ALL\n" +
  "  SELECT b.itm_cd, b.type, b.parent FROM p.d.base b INNER JOIN r ON b.parent = r.itm_cd\n" +
  ") SELECT itm_cd, type FROM r"
);
assert(r.analysis.analysis_status === "COMPLETED", "hierarchical recursion should be COMPLETED");
noCycle("hierarchical recursion", r);
assert(deps(r, "ITM_CD").includes("ITM_CD"), "hierarchical itm_cd should resolve");

console.log(JSON.stringify({
  test: "test_v1_5_0_045",
  status: "PASS",
  issue: "WITH RECURSIVE self-reference resolves via the base term (no false CYCLE_DETECTED)"
}));
