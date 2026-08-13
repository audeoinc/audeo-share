# Repository Table Reference

BigQuery Physical Lineage Repositoryで利用する永続テーブルのカラム辞書です。テーブル定義のSource of Truthは`sql/setup/01_setup_lineage_environment.sql`です。この資料は、各テーブルを参照・運用する際の意味と使い分けを説明します。

## 1. 全体像

| テーブル | 粒度 | 主な役割 |
|---|---|---|
| `lineage_config` | 1環境につき1設定 | 対象環境、UDF、収集期間などの実行設定 |
| `lineage_execution_account_config` | 実行元種別ごと | Scheduled Query・DAGを識別するサービスアカウント設定 |
| `lineage_definition_registry` | 解析対象オブジェクトごと | View・実行SQLの最新定義、変更状態、解析状態 |
| `lineage_job_registry` | BigQuery Jobごと | Scheduled Query・DAG由来の実行SQLと生成先 |
| `lineage_direct_dependency` | 直接カラム依存エッジごと | 1段分の物理カラム依存関係 |
| `lineage_impact` | 起点・経路・スナップショットごと | Direct Dependencyを多段展開した下流Impact |
| `lineage_diagnostic` | 診断イベントごと | Parser、Resolver、Pipelineで発生した診断情報 |

通常の参照順は、`lineage_definition_registry`で解析状態を確認し、`lineage_direct_dependency`で直接依存を確認し、`lineage_impact`で下流への多段影響を確認する。

## 2. `lineage_config`

1行だけを保持する環境・実行設定テーブルです。セットアップSQLが`config_id = 'default'`を`MERGE`で維持し、日次パイプラインと保守SQLが読み込みます。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `config_id` | STRING | 不可 | 設定行の識別子。標準値は`default` |
| `repository_project_id` | STRING | 不可 | Repositoryを配置するProject |
| `repository_dataset` | STRING | 不可 | Repository Dataset |
| `repository_location` | STRING | 不可 | Repository DatasetのLocation |
| `udf_project_id` | STRING | 不可 | 永続JavaScript UDFを配置するProject |
| `udf_dataset` | STRING | 不可 | 永続JavaScript UDFを配置するDataset |
| `udf_function_name` | STRING | 不可 | 呼び出すUDF名 |
| `udf_library_uri` | STRING | 不可 | UDFが参照するGCS上のbundle URI |
| `target_project_id` | STRING | 不可 | 解析対象Project |
| `target_region` | STRING | 不可 | JOBS取得および対象DatasetのRegion |
| `target_datasets` | ARRAY<STRING> | 可 | 解析対象Dataset一覧 |
| `initial_job_lookback_days` | INT64 | 不可 | 初回JOBS収集の遡及日数 |
| `incremental_job_lookback_days` | INT64 | 不可 | 通常更新時のJOBS収集遡及日数 |
| `parser_strict_mode` | BOOL | 不可 | 解析結果の厳格性に関するUDF実行設定 |
| `compact_export` | BOOL | 不可 | UDF出力JSONの圧縮形式設定 |
| `max_impact_rank` | INT64 | 不可 | `lineage_impact`を展開する最大Rank |
| `created_at` | TIMESTAMP | 不可 | 設定行の作成日時 |
| `updated_at` | TIMESTAMP | 不可 | 設定行の最終更新日時 |

## 3. `lineage_execution_account_config`

実行SQLをScheduled QueryまたはDAG由来として識別するサービスアカウント設定です。`execution_source`ごとに1行を保持します。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `execution_source` | STRING | 不可 | 実行元種別。標準では`SCHEDULED_QUERY`または`DAG` |
| `service_accounts` | ARRAY<STRING> | 可 | 識別対象のサービスアカウント一覧 |
| `is_active` | BOOL | 不可 | 現在の収集対象であるか |
| `description` | STRING | 可 | 設定の説明 |
| `created_at` | TIMESTAMP | 不可 | 作成日時 |
| `updated_at` | TIMESTAMP | 不可 | 最終更新日時 |

## 4. `lineage_definition_registry`

解析対象となるView定義と、JOBSから収集したCTAS・DMLなどの実行SQLを統合して保持します。定義ハッシュを比較し、変更された対象だけをUDF解析へ送る起点です。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `object_project` | STRING | 不可 | 生成先オブジェクトのProject |
| `object_dataset` | STRING | 不可 | 生成先オブジェクトのDataset |
| `object_name` | STRING | 不可 | 生成先ViewまたはTable名 |
| `object_type` | STRING | 不可 | オブジェクト種別。`VIEW`または`TABLE`等 |
| `generation_type` | STRING | 不可 | 定義の生成方式。View、CTAS、DMLなど |
| `definition_source` | STRING | 不可 | 定義の取得元。View MetadataまたはJOBSなど |
| `definition_text` | STRING | 可 | 解析対象のSQL定義本文 |
| `definition_hash` | STRING | 不可 | 現行SQL定義のハッシュ |
| `previous_definition_hash` | STRING | 可 | 直前に保持していた定義ハッシュ |
| `source_job_id` | STRING | 可 | JOBS由来の場合のJob ID |
| `source_job_time` | TIMESTAMP | 可 | JOBの実行時刻 |
| `source_user_email` | STRING | 可 | JOB実行主体のメールアドレス |
| `labels` | ARRAY<STRUCT<key STRING, value STRING>> | 可 | Generated TableのソースJOBのLabel（dag_id等）。エラー原因追跡用にJOBからそのまま転記。Viewは常にNULL |
| `is_changed` | BOOL | 不可 | UDF再解析が必要な変更対象であるか |
| `is_active` | BOOL | 不可 | 現在も有効な解析対象であるか |
| `analysis_status` | STRING | 可 | 直近の解析状態 |
| `last_analyzed_hash` | STRING | 可 | 最後に正常解析した定義ハッシュ |
| `first_seen_at` | TIMESTAMP | 不可 | 初回検知日時 |
| `last_seen_at` | TIMESTAMP | 不可 | 最新検知日時 |
| `last_analyzed_at` | TIMESTAMP | 可 | 最終解析日時 |
| `updated_at` | TIMESTAMP | 不可 | Registry更新日時 |

## 5. `lineage_job_registry`

JOBSから収集した、Generated Tableを作る実行SQLの原記録です。定義の候補を収集する役割であり、最終的な解析対象は`lineage_definition_registry`へ統合されます。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `job_project` | STRING | 不可 | Jobが実行されたProject |
| `job_id` | STRING | 不可 | BigQuery Job ID |
| `creation_time` | TIMESTAMP | 不可 | Job作成日時。パーティションキー |
| `start_time` | TIMESTAMP | 可 | Job開始日時 |
| `end_time` | TIMESTAMP | 可 | Job終了日時 |
| `execution_source` | STRING | 不可 | Scheduled Query、DAGなどの判定結果 |
| `source_detection_method` | STRING | 不可 | labels、`user_email`などの判定方法 |
| `user_email` | STRING | 可 | Job実行主体 |
| `labels` | ARRAY<STRUCT<key STRING, value STRING>> | 可 | JOBS MetadataのLabel一覧 |
| `statement_type` | STRING | 可 | 実行Statement種別 |
| `query_text` | STRING | 可 | JOBSに記録された実行SQL |
| `definition_text` | STRING | 可 | 解析に利用する生成先・SELECT部分を特定したSQL |
| `definition_hash` | STRING | 不可 | `definition_text`のハッシュ |
| `destination_project` | STRING | 不可 | 生成先Project |
| `destination_dataset` | STRING | 不可 | 生成先Dataset |
| `destination_table` | STRING | 不可 | 生成先Table |
| `collected_at` | TIMESTAMP | 不可 | Repositoryへ収集した日時 |
| `updated_at` | TIMESTAMP | 不可 | 最終更新日時 |

## 6. `lineage_direct_dependency`

1段分のカラム依存エッジです。`source_*`から`target_*`への直接依存を表し、`lineage_impact`を構築する元データです。対象オブジェクトを再解析した際は、当該オブジェクトを出力先とする既存エッジを安全に置換します。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `definition_hash` | STRING | 不可 | このエッジを生成したSQL定義ハッシュ |
| `source_project` | STRING | 可 | 参照元Project |
| `source_dataset` | STRING | 可 | 参照元Dataset |
| `source_object` | STRING | 不可 | 参照元TableまたはView |
| `source_object_type` | STRING | 不可 | 参照元オブジェクト種別 |
| `source_column` | STRING | 可 | 参照元カラムまたはfield path |
| `target_project` | STRING | 不可 | 出力先Project |
| `target_dataset` | STRING | 不可 | 出力先Dataset |
| `target_object` | STRING | 不可 | 出力先TableまたはView |
| `target_object_type` | STRING | 不可 | 出力先オブジェクト種別 |
| `target_column` | STRING | 可 | 出力先カラム |
| `generation_type` | STRING | 不可 | 出力先を生成した方式 |
| `dependency_type` | STRING | 不可 | 依存種別。現行は`COLUMN` |
| `expression` | STRING | 可 | 出力カラムを生成したSELECT式 |
| `usage_type` | STRING | 可 | 利用箇所分類用の予約列。現行パイプラインでは`SELECT`固定 |
| `resolution_status` | STRING | 可 | 物理カラムへの解決状態 |
| `resolution_reason` | STRING | 可 | 未解決・部分解決の理由 |
| `edge_key` | STRING | 不可 | 直接依存エッジの論理的一意キー |
| `analyzed_at` | TIMESTAMP | 不可 | UDF解析日時 |

## 7. `lineage_impact`

`lineage_direct_dependency`を再帰的に連結し、起点カラムから下流カラムへ到達する経路をRank付きで保持します。日次パイプラインがDirect Dependency全体から再構築するスナップショットテーブルです。

### `impacted_*`と`direct_source_*`の違い

次の直接依存があるとします。

```text
raw.orders.amount
  → mart.order_summary.total_amount
  → mart.customer_sales.customer_sales_amount
```

`raw.orders.amount`を起点にしたImpactでは、次のように記録します。

| impact_rank | origin | impacted | direct_source |
|---:|---|---|---|
| 1 | `raw.orders.amount` | `mart.order_summary.total_amount` | `raw.orders.amount` |
| 2 | `raw.orders.amount` | `mart.customer_sales.customer_sales_amount` | `mart.order_summary.total_amount` |

`impacted_*`は、起点から到達した下流の影響先です。`direct_source_*`は、その影響先を直接生成している最後の1段の参照元です。Rank 1では起点と直接元は同じですが、Rank 2以降では中間ViewやTableのカラムになります。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `snapshot_at` | TIMESTAMP | 不可 | Impact再構築時点。パーティションキー |
| `origin_project` | STRING | 可 | 変更影響の起点Project |
| `origin_dataset` | STRING | 可 | 変更影響の起点Dataset |
| `origin_object` | STRING | 不可 | 変更影響の起点TableまたはView |
| `origin_object_type` | STRING | 不可 | 起点オブジェクト種別 |
| `origin_column` | STRING | 可 | 変更影響の起点カラム |
| `impact_rank` | INT64 | 不可 | 起点から影響先までの直接依存段数。1は直接依存 |
| `impacted_project` | STRING | 可 | 到達した下流影響先のProject |
| `impacted_dataset` | STRING | 可 | 到達した下流影響先のDataset |
| `impacted_object` | STRING | 不可 | 到達した下流影響先のTableまたはView |
| `impacted_object_type` | STRING | 不可 | 影響先オブジェクト種別 |
| `impacted_column` | STRING | 可 | 到達した下流影響先カラム |
| `direct_source_project` | STRING | 可 | 影響先へ直接つながる最後の1段の参照元Project |
| `direct_source_dataset` | STRING | 可 | 影響先へ直接つながる最後の1段の参照元Dataset |
| `direct_source_object` | STRING | 不可 | 影響先へ直接つながる最後の1段の参照元TableまたはView |
| `direct_source_object_type` | STRING | 不可 | 直接元オブジェクト種別 |
| `direct_source_column` | STRING | 可 | 影響先へ直接つながる最後の1段の参照元カラム |
| `dependency_path` | ARRAY<STRING> | 可 | 起点から影響先までを順に並べた完全な表示・追跡用経路 |
| `path_hash` | STRING | 不可 | `dependency_path`から計算した経路の識別子。スナップショット内の重複排除に使用 |
| `generation_type` | STRING | 可 | 最後の影響先を生成した方式 |
| `resolution_status` | STRING | 可 | 最後の依存エッジの解決状態 |
| `is_cycle` | BOOL | 不可 | 経路内で同一オブジェクト・カラムを再訪した循環経路か |

## 8. `lineage_diagnostic`

UDF解析とRepository更新の診断情報です。失敗・警告時の第一調査先として利用します。正常なDependencyを保持したまま、問題のある定義を追跡できます。

| カラム | 型 | NULL | 意味 |
|---|---|:---:|---|
| `definition_hash` | STRING | 不可 | 診断対象SQLの定義ハッシュ |
| `object_project` | STRING | 不可 | 診断対象オブジェクトのProject |
| `object_dataset` | STRING | 不可 | 診断対象オブジェクトのDataset |
| `object_name` | STRING | 不可 | 診断対象オブジェクト名 |
| `object_type` | STRING | 不可 | 診断対象オブジェクト種別 |
| `diagnostic_code` | STRING | 不可 | 機械判定に利用する診断コード |
| `engine_stage` | STRING | 可 | Lexer、Parser、Resolver、Exporter、Pipelineなどの発生工程 |
| `severity` | STRING | 不可 | ERROR、WARNING、INFOなどの重要度 |
| `output_column` | STRING | 可 | 問題に関連する出力カラム |
| `expression` | STRING | 可 | 問題に関連するSQL式 |
| `message` | STRING | 可 | 読みやすい診断メッセージ |
| `diagnostic_json` | JSON | 可 | 詳細な構造化診断情報 |
| `analyzed_at` | TIMESTAMP | 不可 | 診断を記録した日時 |

## 9. 参照時の注意

- 識別子はパイプラインで小文字に正規化して比較する。検索条件も小文字化して扱う。
- `lineage_impact`はスナップショット再構築結果であり、直接依存の更新履歴テーブルではない。
- `usage_type`は現行では`SELECT`固定である。Clause別の利用箇所はUDF内部に保持するが、Repository・Impactにはまだ引き継いでいない。
- 解析失敗時は`lineage_diagnostic`と`lineage_definition_registry.analysis_status`を確認し、既存の正常なDirect Dependencyが維持されていることを確認する。
