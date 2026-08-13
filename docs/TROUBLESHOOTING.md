# Troubleshooting

## analysis_status = FAILED

確認順:

1. `lineage_diagnostic`
2. 対象Registry行
3. UDF library URI
4. GCSアクセス権
5. SQL構文の未対応箇所
6. 物理カラムメタデータ

失敗時は`is_changed = TRUE`が維持され、次回実行で再試行されることを確認します。

## UDF smoke testが失敗する

- GCS URIの誤り
- bundleが存在しない
- BigQueryとGCSのアクセス権不足
- JavaScript syntax error
- UDF引数・戻り値の不一致

## Scheduled Queryが登録されない

- `data_source_id = scheduled_query`相当のラベルがあるか
- 実行ユーザーが`SCHEDULED_QUERY`配列に存在するか
- JOBSメタデータの参照regionが一致しているか
- 対象期間内のジョブか
- destination tableがあるか

## DAGが登録されない

- 実行ユーザーが`DAG`配列に存在するか
- Scheduled Queryとして先に判定されていないか
- destination tableとqueryが取得可能か

## Dependencyが0件

- Registryがactiveか
- `is_changed`が解析前に誤って解除されていないか
- UDF戻り値にdependencyがあるか
- 対象テーブルのCOLUMNSが取得できるか
- AliasやCTEが未解決Diagnosticになっていないか

## Impactが不足する

- Direct Dependencyの中間Viewエッジがあるか
- `max_impact_rank`が小さすぎないか
- object・column名の小文字正規化が揃っているか
- cycle Diagnosticが発生していないか

## 重複が発生する

- Direct Dependencyの`edge_key`
- Job Registryのproject + job ID
- Impactのsnapshot + origin + path hash

総合試験SQLで重複箇所を特定します。

## 旧Dependencyが消えた

本来、解析または置換失敗時には旧Dependencyを保護します。該当処理が統合日次SQLではなく旧版・個別SQLから実行されていないか、バックアップ・復元ブロックが実行されたかを確認してください。
