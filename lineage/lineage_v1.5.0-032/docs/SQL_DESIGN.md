# SQL Design

## 01_setup_lineage_environment.sql

目的: Repository Dataset、設定、Repositoryテーブル、Persistent UDFを作成します。

特性:

- Bootstrap変数のみ導入時に編集
- `CREATE TABLE IF NOT EXISTS`と`MERGE`による再実行性
- 設定を作成した後は設定値から処理
- UDF smoke testを実施

## 02_setup_sample_environment.sql

目的: 総合試験用の物理テーブル、データ、Viewチェーンを作成します。

カバレッジ:

- JOIN
- CTE
- GROUP BY
- QUALIFY
- scalar subquery
- `SELECT *`
- `SELECT * EXCEPT`
- STRUCT
- `ARRAY<STRUCT>`
- UNNEST

## 03_run_daily_lineage_pipeline.sql

目的: 日次の全処理を一つのBigQueryスクリプトとして実行します。

処理:

1. 設定読込
2. View Registry同期
3. Scheduled Query・DAG Job同期
4. 生成テーブル定義のRegistry同期
5. 非アクティブ定義の整理
6. 変更オブジェクト解析
7. Impact再構築
8. 実行サマリー

Scheduled Query判定:

- Scheduled Queryラベル
- `SCHEDULED_QUERY`設定配列へのユーザー一致

DAG判定:

- `DAG`設定配列へのユーザー一致
- Scheduled Query判定を優先

## 04_validate_lineage_environment.sql

目的: 構成、Repository、サンプル、UDF、Registry、Dependency、Impact、Diagnosticを段階的に検証します。

結果:

- `PASS`
- `WARN`
- `FAIL`
- overall status

## 05_repository_integration_test.sql

目的: 実データを横断してRepositoryの受入条件を自動判定します。

検証:

- Fixture件数・計算値
- Registryと現行定義の一致
- edge keyの一意性
- ネストfield path
- 多段Impact
- 登録外実行アカウント
- Diagnostic

## 06_analyze_changed_objects.sql

目的: 変更定義だけを個別に解析する保守・詳細確認用SQLです。

統合日次処理では`03`を使用します。`06`は解析ロジックの確認、切り分け、将来の分割運用に利用します。

## コーディング原則

- Standard SQL
- 識別子の完全修飾
- 再実行可能
- 状態変更は解析成功後
- 旧Dependency保護
- 動的SQLの値は`USING`で渡す
- コメントで処理境界と意図を説明
