# Correlated UNNEST field resolution

Version: `1.5.0-016`

## Supported forms

```sql
LEFT JOIN UNNEST(customer.contacts) AS contact
```

```sql
LEFT JOIN UNNEST(customer.contacts) AS contact
  ON TRUE
```

A reference such as `contact.contact_value` is expanded to the physical field
path `customer.contacts.contact_value` and resolved against
`INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`.

The expansion is intentionally limited to a simple correlated identifier path
whose first component resolves to an earlier physical source in the same query
scope. Other UNNEST expression forms remain deferred.

## Debug output

When the debug daily pipeline receives a non-publishable UDF status, its final
result set includes `debug_udf_result_json` together with the staged diagnostics.
