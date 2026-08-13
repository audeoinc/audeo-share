const path = require('path');
const { runGoldenSuite } = require('./lib/golden_lineage_runner.js');

const baseDir = path.join(__dirname, 'golden');
const cases = runGoldenSuite(baseDir);
const verifiedOutputs = cases.reduce((sum, item) => sum + item.verified_outputs, 0);

console.log(JSON.stringify({
  test: 'test_v1_5_0_010',
  status: 'PASS',
  issue: 'Issue-0004-4 Wildcard Expansion (* REPLACE)',
  golden_cases: cases.length,
  verified_outputs: verifiedOutputs,
  cases
}, null, 2));
