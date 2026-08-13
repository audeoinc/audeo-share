const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * CAST / SAFE_CAST support across every clause.
 *
 * Before this fix the ExpressionParser did not implement the `expr AS type`
 * form, so CAST/SAFE_CAST only survived inside a top-level SELECT item (via the
 * raw-expression fallback) and failed with
 *   ExpressionParser: expected ")", but found "AS".
 * in WHERE, JOIN ON, GROUP BY, HAVING, ORDER BY, and (through the window
 * sub-expression paren miscount) QUALIFY.
 */

const physicalColumns = [
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "CUST_KEY", field_path: "CUST_KEY" },
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "AMOUNT", field_path: "AMOUNT" },
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "TS", field_path: "TS" },
  { table_name: "PROJECT.DATASET.CUSTOMERS", column_name: "ID", field_path: "ID" },
  { table_name: "PROJECT.DATASET.CUSTOMERS", column_name: "NAME", field_path: "NAME" }
];

const metadata = {
  analysis_id: "v1_5_0_032",
  view_project: "PROJECT",
  view_dataset: "DATASET",
  view_name: "TEST_VIEW",
  analyzed_at: "2026-07-31T00:00:00Z"
};

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(physicalColumns),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assertCompleted(name, sql) {
  const result = analyze(sql);
  if (result.analysis.analysis_status !== "COMPLETED") {
    throw new Error(
      `${name}: expected COMPLETED but found ${result.analysis.analysis_status}: ` +
      JSON.stringify(result.exported_tables.diagnostics)
    );
  }
  return result;
}

function dependenciesOf(result, outputName) {
  const outputs = (result.exported_tables.output_lineages || []);
  const target = outputs.find((row) => row.output_column_name === outputName);
  if (!target) {
    throw new Error(`Output "${outputName}" was not found.`);
  }
  return (result.exported_tables.lineage_paths || [])
    .filter((row) =>
      row.output_column_id === target.output_column_id &&
      row.output_scope_id === target.output_scope_id &&
      row.physical_table_name
    )
    .map((row) => `${row.physical_table_name}.${row.physical_column_name}`)
    .sort();
}

function assertDeps(name, result, outputName, expected) {
  const actual = [...new Set(dependenciesOf(result, outputName))];
  const want = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(`${name}: deps for ${outputName} = ${JSON.stringify(actual)} expected ${JSON.stringify(want)}`);
  }
}

// The originally reported failure: SAFE_CAST inside a LEFT JOIN ON clause.
const joinResult = assertCompleted("SAFE_CAST in LEFT JOIN ON", `
SELECT o.amount AS amount, c.name AS cust_name
FROM project.dataset.orders o
LEFT JOIN project.dataset.customers c
  ON SAFE_CAST(o.cust_key AS INT64) = c.id
`);
assertDeps("JOIN ON", joinResult, "AMOUNT", ["PROJECT.DATASET.ORDERS.AMOUNT"]);
assertDeps("JOIN ON", joinResult, "CUST_NAME", ["PROJECT.DATASET.CUSTOMERS.NAME"]);

// CAST/SAFE_CAST in every other clause.
assertCompleted("CAST in WHERE",
  "SELECT amount FROM project.dataset.orders WHERE CAST(ts AS INT64) > 0");
assertCompleted("SAFE_CAST in WHERE",
  "SELECT amount FROM project.dataset.orders WHERE SAFE_CAST(ts AS INT64) > 0");
assertCompleted("SAFE_CAST in GROUP BY",
  "SELECT SAFE_CAST(ts AS INT64) AS g, COUNT(*) c FROM project.dataset.orders GROUP BY SAFE_CAST(ts AS INT64)");
assertCompleted("SAFE_CAST in HAVING",
  "SELECT cust_key FROM project.dataset.orders GROUP BY cust_key HAVING SAFE_CAST(MAX(ts) AS INT64) > 0");
assertCompleted("SAFE_CAST in ORDER BY",
  "SELECT amount FROM project.dataset.orders ORDER BY SAFE_CAST(ts AS INT64)");
assertCompleted("SAFE_CAST in QUALIFY window ORDER BY",
  "SELECT amount FROM project.dataset.orders QUALIFY ROW_NUMBER() OVER (ORDER BY SAFE_CAST(ts AS INT64)) = 1");
assertCompleted("SAFE_CAST in QUALIFY window PARTITION BY",
  "SELECT amount FROM project.dataset.orders QUALIFY ROW_NUMBER() OVER (PARTITION BY SAFE_CAST(ts AS INT64) ORDER BY amount) = 1");

// A plain function call inside a window clause (the general parseWindowSubExpression fix).
assertCompleted("function call in window ORDER BY",
  "SELECT amount FROM project.dataset.orders QUALIFY ROW_NUMBER() OVER (ORDER BY UPPER(ts)) = 1");

// Type-spec forms that must not become spurious column references.
const paramResult = assertCompleted("parameterized + bracketed types in SELECT", `
SELECT
  CAST(amount AS NUMERIC(10, 2)) AS a2,
  SAFE_CAST(cust_key AS INT64) AS k,
  CAST(SPLIT(ts, ',') AS ARRAY<INT64>) AS arr
FROM project.dataset.orders
`);
assertDeps("parameterized", paramResult, "A2", ["PROJECT.DATASET.ORDERS.AMOUNT"]);
assertDeps("parameterized", paramResult, "K", ["PROJECT.DATASET.ORDERS.CUST_KEY"]);
assertDeps("parameterized", paramResult, "ARR", ["PROJECT.DATASET.ORDERS.TS"]);

// The type keyword itself must never be reported as a missing physical column.
for (const sql of [
  "SELECT amount FROM project.dataset.orders WHERE CAST(ts AS INT64) > 0",
  "SELECT CAST(amount AS STRING) AS s FROM project.dataset.orders"
]) {
  const r = analyze(sql);
  const bogus = (r.exported_tables.diagnostics || []).find((row) =>
    row.code === "PHYSICAL_COLUMN_NOT_FOUND" &&
    ["INT64", "STRING", "NUMERIC", "FLOAT64"].includes(String(row.message || "").match(/"([^"]+)"/)?.[1])
  );
  if (bogus) {
    throw new Error(`Type keyword was treated as a physical column: ${JSON.stringify(bogus)}`);
  }
}

console.log(JSON.stringify({
  test: "test_v1_5_0_032",
  status: "PASS",
  issue: "CAST/SAFE_CAST parsing across SELECT, WHERE, JOIN ON, GROUP BY, HAVING, ORDER BY, and QUALIFY windows"
}));
