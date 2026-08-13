const path = require('path');
const bundle = require(path.join(__dirname, '../dist/lineage_udf_bundle.js'));

const physicalColumns = [
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CUSTOMER_ID', field_path: 'CUSTOMER_ID' },
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CONTACTS', field_path: 'CONTACTS' },
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CONTACTS', field_path: 'CONTACTS.CONTACT_TYPE' },
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CONTACTS', field_path: 'CONTACTS.CONTACT_VALUE' },
  { table_name: 'PROJECT.DATASET.CUSTOMERS', column_name: 'CONTACTS', field_path: 'CONTACTS.IS_PRIMARY' }
];

const metadata = {
  analysis_id: 'v1_5_0_016',
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

function assertContactValueResolved(name, sql) {
  const result = analyze(sql);
  const lineage = result.exported_tables.output_lineages.find((row) => {
    return row.output_column_name === 'CONTACT_VALUE';
  });

  if (!lineage) {
    throw new Error(`${name}: CONTACT_VALUE lineage was not exported.`);
  }

  if (lineage.lineage_status !== 'RESOLVED') {
    throw new Error(`${name}: expected RESOLVED but found ${lineage.lineage_status}.`);
  }

  const dependencies = JSON.parse(lineage.dependencies_json);
  const expected = dependencies.find((dependency) => {
    return dependency.physical_table_name === 'PROJECT.DATASET.CUSTOMERS' &&
      dependency.physical_column_name === 'CONTACTS' &&
      dependency.field_path === 'CONTACTS.CONTACT_VALUE';
  });

  if (!expected) {
    throw new Error(`${name}: CONTACTS.CONTACT_VALUE dependency was not resolved: ${lineage.dependencies_json}`);
  }
}

assertContactValueResolved('conditionless correlated LEFT JOIN UNNEST', `
SELECT customer.customer_id, contact.contact_value
FROM project.dataset.customers AS customer
LEFT JOIN UNNEST(customer.contacts) AS contact
`);

assertContactValueResolved('correlated LEFT JOIN UNNEST ON TRUE', `
SELECT customer.customer_id, contact.contact_value
FROM project.dataset.customers AS customer
LEFT JOIN UNNEST(customer.contacts) AS contact ON TRUE
`);

console.log(JSON.stringify({
  test: 'test_v1_5_0_016',
  status: 'PASS',
  issue: 'Resolve correlated UNNEST alias fields to physical STRUCT field paths'
}, null, 2));
