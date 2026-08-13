const path = require('path');
const bundle = require(path.join(__dirname, '../dist/lineage_udf_bundle.js'));

const physicalColumns = [
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CUSTOMER_ID', field_path: 'CUSTOMER_ID' },
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CONTACTS', field_path: 'CONTACTS' },
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CONTACTS', field_path: 'CONTACTS.CONTACT_VALUE' }
];

const metadata = {
  analysis_id: 'v1_5_0_015',
  view_project: 'PROJECT',
  view_dataset: 'DATASET',
  view_name: 'TEST_VIEW',
  analyzed_at: '2026-07-22T00:00:00Z'
};

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(physicalColumns),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assertPublishable(name, sql) {
  const result = analyze(sql);
  if (!['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(result.analysis.analysis_status)) {
    throw new Error(`${name} was not publishable: ${JSON.stringify(result.exported_tables.diagnostics)}`);
  }
}

assertPublishable('conditionless correlated LEFT JOIN UNNEST', `
SELECT customer.customer_id, contact.contact_value
FROM project.dataset.customers AS customer
LEFT JOIN UNNEST(customer.contacts) AS contact
`);

assertPublishable('correlated LEFT JOIN UNNEST ON TRUE', `
SELECT customer.customer_id, contact.contact_value
FROM project.dataset.customers AS customer
LEFT JOIN UNNEST(customer.contacts) AS contact ON TRUE
`);

const invalid = analyze(`
SELECT customer.customer_id
FROM project.dataset.customers AS customer
LEFT JOIN project.dataset.customers AS other
`);

if (invalid.analysis.analysis_status !== 'PARTIAL_FAILURE') {
  throw new Error('Conditionless normal LEFT JOIN must remain rejected.');
}

console.log(JSON.stringify({
  test: 'test_v1_5_0_015',
  status: 'PASS',
  issue: 'Correlated LEFT JOIN UNNEST without condition and ON TRUE'
}, null, 2));
