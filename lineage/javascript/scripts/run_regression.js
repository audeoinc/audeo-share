"use strict";

const path = require("path");
const contract = require("../test/performance_contract_v1_5_0_014.json");
const { runGoldenSuite } = require("../test/lib/golden_lineage_runner.js");
const { runPerformanceRegression } = require("../test/lib/performance_regression_runner.js");

const baseDir = path.join(__dirname, "..", "test", "golden");
const cases = runGoldenSuite(baseDir);
const verifiedOutputs = cases.reduce((sum, item) => sum + item.verified_outputs, 0);
const performance = runPerformanceRegression(baseDir, contract);

console.log(JSON.stringify({
  status: "PASS",
  golden_cases: cases.length,
  verified_outputs: verifiedOutputs,
  performance
}, null, 2));
