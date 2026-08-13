const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-036 — unqualified column resolution across a JOIN of derived sources.
 *
 * The ColumnResolver has no physical schema and cannot see the columns a
 * derived source (CTE/subquery) exposes through a `*` cascade. So in a scope
 * with a JOIN (multiple sources), an unqualified column that lives only in a
 * derived source was left UNRESOLVED_COLUMN with zero candidates, and it never
 * reached disambiguation. In a wildcard UNION downstream this surfaced as a
 * PARTIALLY_RESOLVED column at the SET_OPERATION scope.
 *
 * PhysicalColumnResolver now does a late disambiguation using the derived
 * column lists it can compute: if exactly one source in the reference's scope
 * (physical or derived) exposes the column, it resolves to that source; if more
 * than one, it stays ambiguous (never silently guesses); if none, unresolved.
 *
 * The SQL below mirrors the reported field case: a CTE with unqualified columns
 * over a `cte JOIN (subquery)`, feeding a `SELECT * ... UNION ALL SELECT * ...`.
 */

const metadata = {
  analysis_id: "v1_5_0_036",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const src = ["CREATE_DATE", "FLG_A", "FLG_B", "FLG_Q", "FLG_O", "FLG_YYY", "TYPE", "STS", "AID", "ID", "UH", "MID", "FLG_AA"]
  .map((c) => ({ table_name: "P.D.SRC_TBL", column_name: c, field_path: c }));

const t2 = ["ID", "AID"].map((c) => ({ table_name: "P.D.T2", column_name: c, field_path: c }));

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
    throw new Error("test_v1_5_0_036: " + message);
  }
}

function physicalDeps(result, outputName) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) =>
      String(p.output_column_name).toUpperCase() === outputName &&
      p.physical_table_name)
    .map((p) => `${p.physical_table_name}.${p.physical_column_name}`))];
}

const sql =
  "WITH cnt_all AS (SELECT * EXCEPT(create_date) FROM P.D.SRC_TBL),\n" +
  "cnt_xx_fil AS (\n" +
  "  SELECT * EXCEPT(flg_a, flg_b) FROM cnt_all\n" +
  "  WHERE type IN ('tt','ff') AND sts = 'NG' AND flg_a = 1\n" +
  "),\n" +
  "cnt_yy AS (SELECT * FROM cnt_all WHERE type = 'rr' AND sts = 'OK'),\n" +
  "cnt_yy_act_id AS (SELECT id FROM cnt_yy WHERE flg_q = 1 AND flg_o = 1),\n" +
  "cnt_yy_id AS (\n" +
  "  SELECT cnt.* FROM cnt_yy AS cnt\n" +
  "  INNER JOIN cnt_yy_act_id act_id ON cnt.id = act_id.id\n" +
  "),\n" +
  "cnt_yy_fil AS (SELECT * FROM cnt_yy_id WHERE flg_yyy = 1),\n" +
  "cnt_yy_fil_abc AS (\n" +
  "  SELECT aid, c.id, uh, mid, flg_aa\n" +
  "  FROM cnt_yy_fil c\n" +
  "  LEFT JOIN (SELECT DISTINCT id FROM cnt_xx_fil) f ON c.id = f.id\n" +
  "),\n" +
  "cnt_pp_fil AS (\n" +
  "  SELECT * FROM cnt_xx_fil\n" +
  "  UNION ALL\n" +
  "  SELECT * FROM cnt_yy_fil_abc\n" +
  ")\n" +
  "SELECT * FROM cnt_pp_fil";

const result = analyze(sql, src);
assert(
  result.analysis.analysis_status === "COMPLETED",
  "expected COMPLETED, got " + result.analysis.analysis_status +
  " codes=" + JSON.stringify((result.exported_tables.diagnostics || []).map((d) => d.code))
);

const partial = (result.exported_tables.diagnostics || [])
  .filter((d) => d.code === "LINEAGE_PARTIALLY_RESOLVED");
assert(partial.length === 0, "no partial resolution expected, got " + partial.length);

// The unqualified columns from the JOIN branch must trace to the correct source.
for (const col of ["AID", "UH", "MID", "FLG_AA"]) {
  assert(
    physicalDeps(result, col).includes(`P.D.SRC_TBL.${col}`),
    `${col} must resolve to P.D.SRC_TBL.${col}, got ` + JSON.stringify(physicalDeps(result, col))
  );
}

// Guard: a genuinely ambiguous unqualified column (present in BOTH join sources)
// must NOT be silently resolved to one source.
const ambSql =
  "WITH a AS (SELECT * FROM P.D.SRC_TBL)\n" +
  ", b AS (SELECT * FROM P.D.T2)\n" +
  "SELECT aid FROM a c JOIN b g ON c.id = g.id";
const amb = analyze(ambSql, src.concat(t2));
assert(
  physicalDeps(amb, "AID").length === 0,
  "ambiguous AID must not be silently resolved, got " + JSON.stringify(physicalDeps(amb, "AID"))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_036",
  status: "PASS",
  issue: "Unqualified column in a JOIN of derived sources now resolves to the correct source (was PARTIALLY_RESOLVED at the UNION)"
}));
