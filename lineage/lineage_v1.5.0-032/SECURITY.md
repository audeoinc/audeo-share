# Security

## 報告対象

- 過剰なIAM権限
- GCS UDF bundleの改ざん可能性
- 意図しないproject・datasetのメタデータ収集
- Repositoryに保存されるSQL定義の閲覧権限
- 実行アカウント設定の不正変更

## 運用原則

- 最小権限
- UDF bundleの世代管理
- Repository Datasetへのアクセス制御
- 本番変更のレビュー
- サービスアカウントの定期棚卸し

公開リポジトリでの脆弱性連絡先は、公開主体が決定した窓口を設定してください。
