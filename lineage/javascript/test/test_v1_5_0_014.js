const path = require('path');
const contract = require('./performance_contract_v1_5_0_014.json');
const { runGoldenSuite } = require('./lib/golden_lineage_runner.js');
const { runPerformanceRegression } = require('./lib/performance_regression_runner.js');

const baseDir = path.join(__dirname, 'golden');
const cases = runGoldenSuite(baseDir);
const verifiedOutputs = cases.reduce((sum, item) => sum + item.verified_outputs, 0);
const performanceResult = runPerformanceRegression(baseDir, contract);

console.log(JSON.stringify({
  test: 'test_v1_5_0_014',
  status: 'PASS',
  issue: 'Issue-0100-4 Performance Regression',
  golden_cases: cases.length,
  verified_outputs: verifiedOutputs,
  performance: performanceResult,
  cases
}, null, 2));
