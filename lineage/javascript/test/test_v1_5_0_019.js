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

assert.ok(Array.isArray(result.error_nodes));
assert.ok(result.error_nodes.length > 0);
const errorNode = result.error_nodes[0];
assert.strictEqual(errorNode.severity, "ERROR");
assert.strictEqual(errorNode.original_sql, sql);
assert.ok(errorNode.referenced_column_name || errorNode.code);

const exported = new BigQueryExporter({ analysis_id: "diag-test" }).export(result);
assert.ok(exported.analyses[0].error_nodes_json);
assert.ok(JSON.parse(exported.analyses[0].error_nodes_json).length > 0);

console.log(JSON.stringify({
  status: "PASS",
  issue: "Diagnostic Framework and error_nodes_json",
  diagnostic_code: errorNode.code
}, null, 2));
