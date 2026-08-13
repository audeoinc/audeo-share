# Operation Guide

## 1. 初回導入

1. 対象regionを確認する。
2. JavaScript UDF bundleをGCSへ配置する。
3. `01_setup_lineage_environment.sql`のBootstrap変数を編集する。
4. Scheduled QueryとDAGのサービスアカウント配列を設定する。
5. `01_setup_lineage_environment.sql`を実行する。
6. 必要に応じて`02_setup_sample_environment.sql`を実行する。
7. `03_run_daily_lineage_pipeline.sql`を実行する。
8. `04_validate_lineage_environment.sql`を実行する。
9. `05_repository_integration_test.sql`を実行する。

## 2. 日次運用

`03_run_daily_lineage_pipeline.sql`をScheduled Queryなどから起動します。

実行後の確認順:

1. 実行サマリー
2. RegistryのFAILED
3. ERROR Diagnostic
4. WARNING Diagnostic
5. 変更オブジェクト残件
6. Impact更新

## 3. サービスアカウント変更

`lineage_execution_account_config`の該当配列を更新します。カンマ区切りで入力値を準備する場合も、保存時は`ARRAY<STRING>`へ変換します。

更新後は日次処理を実行し、Job Registryに登録外アカウントが存在しないことを検証します。

## 4. UDF更新

1. 新bundleを別名でGCSへ配置する。
2. 非本番環境の設定URIを更新する。
3. setup SQLでPersistent UDFを再作成する。
4. smoke testと総合試験を実施する。
5. 本番設定を更新する。
6. 問題時に戻せる旧bundleを保持する。

## 5. View変更・削除

日次処理がハッシュ差分と非アクティブ化を検知します。削除後は対象をtargetとするDependencyとImpactが残っていないことを確認します。

## 6. 定期保守

推奨確認項目:

- Diagnostic増加傾向
- Job Registry容量
- Impact容量
- 解析時間
- 未解決構文の種類
- 対象Dataset追加・削除
- 実行アカウント棚卸し
- GCS bundle世代管理

## 7. リリース判定

リリース前に次を満たすこと:

- Validationが`COMPLETED`
- Integration Testが`COMPLETED`
- ERROR Diagnosticが0件
- 既知のWARNINGがレビュー済み
- ロールバック手順が確認済み
