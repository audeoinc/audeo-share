# BigQuery Physical Lineage Repository 総合試験手順

## 1. 試験対象

- `01_setup_lineage_environment.sql`
- `02_setup_sample_environment.sql`
- `03_run_daily_lineage_pipeline.sql`
- `04_validate_lineage_environment.sql`
- `05_repository_integration_test.sql`
- `06_analyze_changed_objects.sql`

## 2. 前提条件

1. `lineage_udf_bundle.js`をGCSへ配置する。
2. `01_setup_lineage_environment.sql`の`bootstrap_udf_library_uri`を実URIへ変更する。
3. 実行ユーザーにDataset、Table、Routine、GCS Object、`INFORMATION_SCHEMA.JOBS_BY_PROJECT`の参照権限を付与する。
4. Repository、対象Dataset、UDF Datasetを`asia-northeast1`にそろえる。

## 3. 正常系試験

次の順に実行する。

1. `01_setup_lineage_environment.sql`
2. `02_setup_sample_environment.sql`
3. `03_run_daily_lineage_pipeline.sql`
4. `04_validate_lineage_environment.sql`
5. `05_repository_integration_test.sql`

合格条件:

- 04の`overall_status`が`COMPLETED`
- 05の`overall_status`が`COMPLETED`
- `lineage_definition_registry`の`is_changed = TRUE`が0件
- `lineage_diagnostic`の`severity = 'ERROR'`が0件
- `v_customer_sales_ranked`まで3階層以上のImpactが存在する

## 4. 再実行性試験

正常系の直後に、変更を加えず次を再実行する。

1. `01_setup_lineage_environment.sql`
2. `02_setup_sample_environment.sql`
3. `03_run_daily_lineage_pipeline.sql`
4. `03_run_daily_lineage_pipeline.sql`
5. `05_repository_integration_test.sql`

合格条件:

- DDLとMERGEが重複エラーにならない
- `edge_key`重複が0件
- `job_project + job_id`重複が0件
- 2回目の日次実行後も`is_changed = TRUE`が0件
- Direct Dependency件数が日次実行前後で不必要に増えない

注意:
`02_setup_sample_environment.sql`はサンプルオブジェクトを再作成するため、View定義の更新時刻は変わっても定義ハッシュは変わらないことを確認する。

## 5. View変更検知試験

### 5.1 変更前件数の保存

```sql
CREATE OR REPLACE TABLE
  `project_id.lineage_repository.test_before_change`
AS
SELECT *
FROM `project_id.lineage_repository.lineage_direct_dependency`
WHERE target_object = 'v_customer_sales_ranked';
```

### 5.2 View変更

`v_customer_sales_ranked`へ次の列を追加する。

```sql
CREATE OR REPLACE VIEW `project_id.dataset.v_customer_sales_ranked` AS
SELECT
  customer_sales.*,
  DENSE_RANK() OVER (
    ORDER BY customer_sales.sales_amount DESC
  ) AS sales_rank,
  customer_sales.sales_amount >= 100000 AS is_high_value
FROM `project_id.dataset.v_customer_sales` AS customer_sales
QUALIFY sales_rank <= 100;
```

### 5.3 再解析

1. `03_run_daily_lineage_pipeline.sql`
2. `04_validate_lineage_environment.sql`
3. `05_repository_integration_test.sql`

合格条件:

- Registryの`previous_definition_hash`が変更前ハッシュになる
- `definition_hash != previous_definition_hash`
- `is_changed`が解析後に`FALSE`
- `is_high_value`のDependencyが登録される
- 旧Dependencyの重複が発生しない

## 6. View削除検知試験

```sql
DROP VIEW `project_id.dataset.v_customer_sales_ranked`;
```

その後、`03_run_daily_lineage_pipeline.sql`を実行する。

合格条件:

- Registryの対象行が`is_active = FALSE`
- 対象ViewをtargetとするDirect Dependencyが0件
- 対象Viewを通るImpactが次回再構築後に0件

試験後は`02_setup_sample_environment.sql`を再実行して復元する。

## 7. Scheduled Query試験

Scheduled QueryとDAGの実行サービスアカウントは、`03_run_daily_lineage_pipeline.sql`のSTEP 2パラメータブロック（`scheduled_query_service_accounts` / `dag_service_accounts` の`ARRAY<STRING>`）で管理する。複数アカウントは配列要素としてカンマ区切りで登録する。

`02_setup_sample_environment.sql`末尾に表示されるSQLをScheduled Queryとして登録・実行する。

合格条件:

- `lineage_job_registry.execution_source = 'SCHEDULED_QUERY'`
- `source_detection_method = 'LABEL_AND_ACCOUNT'`
- `user_email = 'project_id@appspot.gserviceaccount.com'`
- `daily_customer_sales`がDefinition Registryへ登録される
- `v_customer_sales`から`daily_customer_sales`へのDependencyが作成される

## 8. 解析失敗時の旧Dependency保護試験

1. 正常な`v_customer_sales_ranked`のDependencyを保存する。
2. 一時的にUDFライブラリURIを存在しないGCS URIへ変更する。
3. View定義を変更して`is_changed = TRUE`にする。
4. `03_run_daily_lineage_pipeline.sql`を実行する。

合格条件:

- Registryは`analysis_status = 'FAILED'`
- `is_changed = TRUE`を維持する
- `ANALYSIS_EXECUTION_FAILED` Diagnosticが登録される
- 変更前のDirect Dependencyが失われない

試験後は正しいGCS URIへ戻し、`01`と`03`を再実行する。

## 9. 現時点の実行制約

このChatGPT実行環境には、対象GCPプロジェクトの認証情報とBigQuery実行権限がないため、実データ上のSQL実行結果までは取得していない。ファイル横断の静的整合性確認と、実環境で結果を再現できる試験SQL・判定基準の作成までを総合試験準備として実施している。
