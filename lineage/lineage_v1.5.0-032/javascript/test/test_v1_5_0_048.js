const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-048 — mixed qualified/unqualified columns across a `SELECT *` CTE join.
 *
 * A CTE whose body is `SELECT * FROM <physical_table>` exposes an UNKNOWN set of
 * columns at the name-resolution stage (the wildcard pulls in physical columns
 * that are only known once metadata is applied). The ColumnResolver previously
 * treated such a CTE as exposing ZERO columns (empty set), which made it invisible
 * as a candidate source. The consequences, when the CTE was the FROM side of a
 * LEFT JOIN against another (physical) source:
 *   - an unqualified column that belongs to the CTE was bound to the JOIN side and
 *     reported PHYSICAL_COLUMN_NOT_FOUND (no rescue, because a wrong single
 *     candidate had already been chosen); and
 *   - even a qualified reference into the CTE (`x.col`) was reported
 *     UNRESOLVED_COLUMN.
 *
 * Fix: a wildcard over a source whose columns are unknown (physical table, UNNEST,
 * or an unknown child scope) propagates "unknown" (null) instead of collapsing to
 * an empty set, so the CTE stays a candidate and the physical resolver
 * disambiguates using real metadata.
 */

const cols = [
  { table_name: "p.d.t1", column_name: "cola", field_path: "cola" },
  { table_name: "p.d.t1", column_name: "keyid", field_path: "keyid" },
  { table_name: "p.d.t2", column_name: "colb", field_path: "colb" },
  { table_name: "p.d.t2", column_name: "keyid", field_path: "keyid" }
];

const metadata = {
  analysis_id: "v1_5_0_048",
  view_project: "p",
  view_dataset: "d",
  view_name: "v",
  analyzed_at: "2026-01-01T00:00:00Z"
};

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
    throw new Error("test_v1_5_0_048: " + message);
  }
}

function pathFor(result, outputName) {
  return (result.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name &&
      String(p.output_column_name).toUpperCase() === outputName)
    .map((p) => `${p.physical_table_name}.${p.physical_column_name}`.toUpperCase())
    .sort();
}

// Case 1: FROM = CTE (SELECT * from physical), LEFT JOIN = physical table.
// `cola` (unqualified) belongs to the FROM-side CTE; must NOT be bound to the
// JOIN side, and `x.keyid` (qualified into the CTE) must resolve.
const r1 = analyze(
  `WITH a AS (SELECT * FROM \`p.d.t1\`)
   SELECT x.keyid AS k, cola, y.colb AS cb
   FROM a AS x
   LEFT JOIN \`p.d.t2\` AS y ON x.keyid = y.keyid`);

assert(r1.analysis.analysis_status === "COMPLETED",
  `case1 should COMPLETE without errors (got ${r1.analysis.analysis_status})`);
assert(JSON.stringify(pathFor(r1, "COLA")) === JSON.stringify(["P.D.T1.COLA"]),
  `case1 unqualified cola must trace to FROM-side t1 (got ${JSON.stringify(pathFor(r1, "COLA"))})`);
assert(JSON.stringify(pathFor(r1, "K")) === JSON.stringify(["P.D.T1.KEYID"]),
  `case1 x.keyid must resolve to CTE t1 (got ${JSON.stringify(pathFor(r1, "K"))})`);
assert(JSON.stringify(pathFor(r1, "CB")) === JSON.stringify(["P.D.T2.COLB"]),
  `case1 y.colb must resolve to JOIN t2 (got ${JSON.stringify(pathFor(r1, "CB"))})`);

// Case 2: mirror — FROM = physical, LEFT JOIN = CTE (SELECT * from physical).
// unqualified `colb` belongs to the JOIN-side CTE.
const r2 = analyze(
  `WITH b AS (SELECT * FROM \`p.d.t2\`)
   SELECT y.keyid AS k, x.cola AS ca, colb
   FROM \`p.d.t1\` AS x
   LEFT JOIN b AS y ON x.keyid = y.keyid`);

assert(r2.analysis.analysis_status === "COMPLETED",
  `case2 should COMPLETE without errors (got ${r2.analysis.analysis_status})`);
assert(JSON.stringify(pathFor(r2, "COLB")) === JSON.stringify(["P.D.T2.COLB"]),
  `case2 unqualified colb must trace to JOIN-side CTE t2 (got ${JSON.stringify(pathFor(r2, "COLB"))})`);
assert(JSON.stringify(pathFor(r2, "CA")) === JSON.stringify(["P.D.T1.COLA"]),
  `case2 x.cola must resolve to FROM t1 (got ${JSON.stringify(pathFor(r2, "CA"))})`);

// Case 3: multi-level — FROM CTE is `SELECT *` over another CTE with an EXPLICIT
// column list. The explicit inner list keeps exposed columns KNOWN, so an
// unqualified column absent from it stays correctly attributed to the physical side.
const r3 = analyze(
  `WITH inner_cte AS (SELECT keyid FROM \`p.d.t1\`),
        a AS (SELECT * FROM inner_cte)
   SELECT x.keyid AS k, y.colb AS cb
   FROM a AS x
   LEFT JOIN \`p.d.t2\` AS y ON x.keyid = y.keyid`);

assert(r3.analysis.analysis_status === "COMPLETED",
  `case3 should COMPLETE (got ${r3.analysis.analysis_status})`);
assert(JSON.stringify(pathFor(r3, "K")) === JSON.stringify(["P.D.T1.KEYID"]),
  `case3 x.keyid must resolve through the explicit inner CTE to t1 (got ${JSON.stringify(pathFor(r3, "K"))})`);

console.log("test_v1_5_0_048: PASS");
