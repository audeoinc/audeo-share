const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-044 — self-join derived-scope resolution hardening.
 *
 * When a CTE is self-joined (table_a AS x LEFT JOIN table_a AS y), a qualified
 * reference (y.col) must resolve to the aliased source's own query scope. If the
 * derived-scope resolution ever points back at the referencing scope itself, that
 * is impossible for a non-recursive query and previously produced a false
 * CYCLE_DETECTED. The resolver now (1) discards a derived scope equal to the
 * referencing scope, and (2) picks the derived source by the reference qualifier
 * (falling back to the sole / single-child-scope derived source).
 */

const metadata = {
  analysis_id: "v1_5_0_044",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.phys", column_name: "k", field_path: "k" },
  { table_name: "p.d.phys", column_name: "col_a", field_path: "col_a" }
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
    throw new Error("test_v1_5_0_044: " + message);
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

// Multi-level CTE, self-joined with x/y aliases, x.col + y.col AS pre_col,
// consumed by a downstream aggregating CTE (the reported shape).
const sql =
  "WITH cte_base AS (SELECT k, col_a FROM p.d.phys),\n" +
  "table_a AS (SELECT k, col_a FROM cte_base),\n" +
  "inter AS (\n" +
  "  SELECT x.k, x.col_a AS col_a, y.col_a AS col_b\n" +
  "  FROM table_a AS x LEFT JOIN table_a AS y ON x.k = y.k\n" +
  "),\n" +
  "erroring AS (SELECT k, MAX(col_a) AS col_a, MAX(col_b) AS col_b FROM inter GROUP BY k)\n" +
  "SELECT col_a, col_b FROM erroring";

const r = analyze(sql);
noCycle("self-join multi-level", r);
assert(deps(r, "COL_A").includes("COL_A"), "col_a should trace to phys.col_a, got " + JSON.stringify(deps(r, "COL_A")));
assert(deps(r, "COL_B").includes("COL_A"), "col_b (y.col_a) should trace to phys.col_a, got " + JSON.stringify(deps(r, "COL_B")));

// Plain self-join qualified references resolve to the right side.
const r2 = analyze("WITH t AS (SELECT k, col_a FROM p.d.phys) SELECT x.col_a, y.col_a AS pre FROM t AS x LEFT JOIN t AS y ON x.k = y.k");
noCycle("plain self-join", r2);
assert(deps(r2, "COL_A").includes("COL_A") && deps(r2, "PRE").includes("COL_A"),
  "both self-join sides resolve to phys.col_a");

console.log(JSON.stringify({
  test: "test_v1_5_0_044",
  status: "PASS",
  issue: "Self-join qualified derived-scope resolution (no false CYCLE_DETECTED)"
}));
