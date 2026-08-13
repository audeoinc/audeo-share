const path = require('path');
const { runGoldenSuite } = require('./lib/golden_lineage_runner.js');

const results = runGoldenSuite(path.join(__dirname, 'golden'));
console.log(JSON.stringify({
  test: 'test_v1_5_0_004',
  status: 'PASS',
  issue: '#1 UNION / UNION ALL all-branch lineage merge',
  golden_cases: results.length,
  verified_outputs: results.reduce((sum, result) => sum + result.verified_outputs, 0),
  cases: results
}, null, 2));
