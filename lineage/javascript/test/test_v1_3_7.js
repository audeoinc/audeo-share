const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

const cases = [
  {
    name: "SELECT AS STRUCT scalar subquery",
    sql: `SELECT (SELECT AS STRUCT order_id AS detail_order_id, STRUCT(txn_type AS type) AS txn_header) AS txn_info FROM x`
  },
  {
    name: "typed ARRAY STRUCT literal",
    sql: `SELECT ARRAY<STRUCT<order_id STRING, purchase_date DATE>>[STRUCT(order_id, purchase_date)] AS order_chain FROM x`
  },
  {
    name: "SELECT star EXCEPT",
    sql: `WITH x AS (SELECT 1 AS order_id, 2 AS customer_id) SELECT * EXCEPT(order_id) FROM x`
  },
  {
    name: "ARRAY_AGG STRUCT modifiers",
    sql: `SELECT ARRAY_AGG(STRUCT(order_id, STRUCT(txn_type AS type, purchase_date AS date) AS txn_header) ORDER BY purchase_date DESC LIMIT 3) AS recent_order_chain FROM x`
  },
  {
    name: "recursive CTE",
    sql: `WITH RECURSIVE p AS (SELECT 1 AS n UNION ALL SELECT n + 1 AS n FROM p WHERE n < 3) SELECT * FROM p`
  }
];

for (const testCase of cases) {
  const result = new bundle.LineageEngine({
    physicalColumns: [],
    strictMode: false
  }).analyze(testCase.sql);

  if (result.analysis_status === "PARTIAL_FAILURE") {
    const messages = result.diagnostics.map((row) => row.message).join(" | ");
    throw new Error(`${testCase.name} failed: ${messages}`);
  }

  if (!result.query_ast) {
    throw new Error(`${testCase.name} did not produce QUERY AST`);
  }
}

console.log(JSON.stringify({
  version: "1.3.7",
  test_count: cases.length,
  parser_failures: 0
}, null, 2));
