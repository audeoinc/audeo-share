# Debug array type fix

`exported_json` is declared as `STRING`. Therefore the STRING overload of
`JSON_QUERY_ARRAY(exported_json, json_path)` returns `ARRAY<STRING>`.

The fallback used in the same `COALESCE()` must also be `ARRAY<STRING>`:

```sql
COALESCE(
  JSON_QUERY_ARRAY(exported_json, '$.exported_tables.diagnostics'),
  CAST([] AS ARRAY<STRING>)
)
```

Use `ARRAY<JSON>` only when the first argument passed to `JSON_QUERY_ARRAY`
is a value of BigQuery `JSON` type.
