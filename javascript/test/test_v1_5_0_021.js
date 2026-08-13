"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = path.resolve(__dirname, "../dist/lineage_udf_bundle.js");
vm.runInThisContext(fs.readFileSync(bundlePath, "utf8"), { filename: bundlePath });

const sql = [
  "SELECT",
  "  customer_id,",
  "  missing_metric",
  "FROM",
  "  `project_id.dataset.t_diagnostic_unpivot_source`"
].join("\n");

const result = new LineageEngine({
  strictMode: false,
  physicalColumns: [
    {
      project_id: "PROJECT_ID",
      dataset_id: "DATASET",
      table_name: "T_DIAGNOSTIC_UNPIVOT_SOURCE",
      column_name: "CUSTOMER_ID"
    },
    {
      project_id: "PROJECT_ID",
      dataset_id: "DATASET",
      table_name: "T_DIAGNOSTIC_UNPIVOT_SOURCE",
      column_name: "SALES_AMOUNT"
    },
    {
      project_id: "PROJECT_ID",
      dataset_id: "DATASET",
      table_name: "T_DIAGNOSTIC_UNPIVOT_SOURCE",
      column_name: "COST_AMOUNT"
    }
  ]
}).analyze(sql);

const diagnostic = result.diagnostics.find((item) => {
  return item.code === "PHYSICAL_COLUMN_NOT_FOUND" &&
    item.column_name === "MISSING_METRIC";
});

assert.ok(diagnostic);
assert.strictEqual(diagnostic.scope_type, "ROOT_QUERY");
assert.strictEqual(
  diagnostic.candidate_source_name,
  "PROJECT_ID.DATASET.T_DIAGNOSTIC_UNPIVOT_SOURCE"
);
assert.deepStrictEqual(
  diagnostic.candidate_source_names,
  ["PROJECT_ID.DATASET.T_DIAGNOSTIC_UNPIVOT_SOURCE"]
);
assert.strictEqual(
  diagnostic.resolved_source_name,
  "PROJECT_ID.DATASET.T_DIAGNOSTIC_UNPIVOT_SOURCE"
);
assert.strictEqual(diagnostic.sql_context, "missing_metric");

console.log(JSON.stringify({
  status: "PASS",
  issue: "Diagnostic scope/source enrichment and AST SQL context"
}, null, 2));
