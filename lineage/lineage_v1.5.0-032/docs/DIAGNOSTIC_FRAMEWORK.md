# Diagnostic Framework

## Purpose

The framework is for repository operators investigating lineage analysis failures. It reports which column or node failed, where it appears in SQL, and why the engine could not resolve it. It does not suggest fixes or perform automatic correction.

## Output

Each diagnostic uses a common structure including severity, code, message, node and scope identifiers, token range, line and column, SQL fragment, nearby SQL context, and the original SQL statement.

`error_nodes_json` contains only `ERROR` diagnostics and is always represented as a JSON array. Successful analyses return `[]`.
