const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-042
 *  1. [LEFT|INNER] JOIN UNNEST(...) without ON/USING. BigQuery allows a
 *     conditionless correlated UNNEST join, but the FromParser only permitted it
 *     when the array expression textually referenced a visible source name, so a
 *     bare/unqualified array column (LEFT JOIN UNNEST(items)) or a CTE-column
 *     array raised "FromParser: LEFT JOIN requires ON or USING condition." Any
 *     non-CROSS join whose right source is UNNEST may now omit the condition;
 *     ordinary joins still require ON/USING.
 *  2. Array literals [ ... ] parse as expressions (e.g. UNNEST([1,2,3])).
 */

const metadata = {
  analysis_id: "v1_5_0_042",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "id", field_path: "id" },
  { table_name: "p.d.t", column_name: "items", field_path: "items" },
  { table_name: "p.d.u", column_name: "id", field_path: "id" }
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
    throw new Error("test_v1_5_0_042: " + message);
  }
}

function assertParses(name, sql) {
  const r = analyze(sql);
  assert(r.analysis.analysis_status !== "PARTIAL_FAILURE",
    `${name}: expected a successful parse, got ${r.analysis.analysis_status} ` +
    (r.analysis.error_detail_json || ""));
  return r;
}

function assertFailsParse(name, sql) {
  const r = analyze(sql);
  assert(r.analysis.analysis_status === "PARTIAL_FAILURE",
    `${name}: expected PARTIAL_FAILURE, got ${r.analysis.analysis_status}`);
}

// Conditionless [LEFT|INNER] JOIN UNNEST in its various shapes.
assertParses("LEFT JOIN UNNEST bare column", "SELECT t.id FROM p.d.t AS t LEFT JOIN UNNEST(items) AS x");
assertParses("INNER JOIN UNNEST bare column", "SELECT t.id FROM p.d.t AS t INNER JOIN UNNEST(items) AS x");
assertParses("LEFT JOIN UNNEST no left alias", "SELECT id FROM p.d.t LEFT JOIN UNNEST(items) AS x");
assertParses("LEFT JOIN UNNEST correlated", "SELECT t.id FROM p.d.t AS t LEFT JOIN UNNEST(t.items) AS x");
assertParses("LEFT JOIN UNNEST array literal", "SELECT id FROM p.d.t LEFT JOIN UNNEST([1,2,3]) AS x");
assertParses("CROSS JOIN UNNEST still fine", "SELECT t.id FROM p.d.t AS t CROSS JOIN UNNEST(items) AS x");

// Array literal parses as a normal expression.
assertParses("SELECT array literal", "SELECT [1,2,3] AS a FROM p.d.t");

// Guard: an ordinary LEFT JOIN with no ON/USING is still an error.
assertFailsParse("regular LEFT JOIN needs ON", "SELECT a.id FROM p.d.t a LEFT JOIN p.d.u b");

console.log(JSON.stringify({
  test: "test_v1_5_0_042",
  status: "PASS",
  issue: "[LEFT|INNER] JOIN UNNEST without ON/USING, and array-literal [...] parsing"
}));
