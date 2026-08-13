"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = path.resolve(__dirname, "../dist/lineage_udf_bundle.js");
vm.runInThisContext(fs.readFileSync(bundlePath, "utf8"), { filename: bundlePath });

const sql = "SELECT missing_column AS result_col FROM `p.d.t`";
const result = new LineageEngine({
  strictMode: false,
  physicalColumns: [
    { project_id: "P", dataset_id: "D", table_name: "T", column_name: "OTHER_COLUMN" }
  ]
}).analyze(sql);

assert.strictEqual(result.diagnostics.length, 1);
assert.strictEqual(result.diagnostics[0].severity, "ERROR");
assert.strictEqual(result.diagnostics[0].code, "PHYSICAL_COLUMN_NOT_FOUND");
assert.strictEqual(result.diagnostics[0].sql_fragment, "missing_column");
assert.ok(result.diagnostics[0].sql_context.includes("missing_column"));

const exported = new BigQueryExporter(
  { analysis_id: "diag-compact-test" },
  { runtime_compact: true }
).export(result);

assert.ok(exported.diagnostics[0].diagnostic_json);
const diagnosticJson = JSON.parse(exported.diagnostics[0].diagnostic_json);
assert.strictEqual(diagnosticJson.code, "PHYSICAL_COLUMN_NOT_FOUND");
assert.ok(exported.analyses[0].error_nodes_json);
assert.strictEqual(JSON.parse(exported.analyses[0].error_nodes_json).length, 1);

console.log(JSON.stringify({
  status: "PASS",
  issue: "Compact diagnostic JSON and derived warning suppression"
}, null, 2));
