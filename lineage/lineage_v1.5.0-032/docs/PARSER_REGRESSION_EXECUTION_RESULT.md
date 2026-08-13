# Parser Regression Execution Result

- Execution date: 2026-07-25
- Runtime: Node.js
- Command: `cd javascript && npm test`
- Overall status: **PASS**

## Results

| Check | Result |
|---|---:|
| Source files | 24 |
| Generated bundle build | PASS |
| Generated vs canonical bundle behavior | PASS |
| Golden cases | 48 PASS |
| Verified output columns | 127 |
| Performance regression contract | PASS |

## Performance samples

The release test executed the configured performance cases and stayed within the bundled regression contract. Observed median times were approximately 0.157–0.649 ms and observed p95 times were approximately 0.354–0.975 ms in this execution environment.

These values are execution evidence for this container only. They are not production BigQuery SLA values.

## Notes

- Source files were recovered mechanically from the canonical `v1.5.0-014` bundle's `SOURCE: src/...` markers.
- The implementation was not manually rewritten or inferred.
- The generated bundle is verified directly from `javascript/dist/` through API and smoke-analysis checks.
- BigQuery-side smoke tests are included but were not executed against a live GCP environment in this package-generation run.
