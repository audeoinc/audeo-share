"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const bundlePath = path.join(rootDir, "dist", "lineage_udf_bundle.js");

assert.ok(fs.existsSync(bundlePath), "Generated bundle does not exist.");

const generated = require(bundlePath);
assert.strictEqual(typeof generated.LineageEngine, "function");
assert.strictEqual(typeof generated.analyzeLineageForBigQuery, "function");

const sql = "SELECT customer_id, amount * 1.1 AS adjusted_amount FROM `project.dataset.sales`";
const physicalColumns = [
  { table_name: "PROJECT.DATASET.SALES", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID", ordinal_position: 1 },
  { table_name: "PROJECT.DATASET.SALES", column_name: "AMOUNT", field_path: "AMOUNT", ordinal_position: 2 }
];

const engineResult = new generated.LineageEngine({
  physicalColumns,
  strictMode: false
}).analyze(sql);

assert.ok(engineResult);
assert.ok(engineResult.lineage);

const exported = JSON.parse(generated.analyzeLineageForBigQuery(
  sql,
  JSON.stringify(physicalColumns),
  JSON.stringify({ strict_mode: false }),
  JSON.stringify({
    analysis_id: "verify_bundle",
    view_project: "PROJECT",
    view_dataset: "DATASET",
    view_name: "VERIFY_VIEW",
    analyzed_at: "2026-07-22T00:00:00Z"
  })
));

assert.strictEqual(exported.analysis.analysis_status, "COMPLETED");
console.log(JSON.stringify({
  status: "PASS",
  check: "generated dist bundle exports the required API and completes a smoke analysis"
}, null, 2));
