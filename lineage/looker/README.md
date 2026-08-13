# Looker report SQL

## 01_query_column_impact.sql

指定したRoot TABLEのカラムから、影響を受けるVIEWとカラムを抽出します。

追加情報:

- `impact_type`
- `dependency_usage_type`
- `dependency_path_display`
- `impacted_expression`

検索条件はSQL末尾の次の4項目です。

- `origin_project`
- `origin_dataset`
- `origin_object`
- `origin_column`

現行のRepository投入処理では`usage_type`が主に`SELECT`として保存されます。`GROUP_BY`、`JOIN`、`WHERE`などの詳細分類は、Parserから句別利用情報を出力した後に精度が上がります。
