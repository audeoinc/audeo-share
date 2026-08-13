# ADR-0003: 実行サービスアカウントをARRAYで管理

- Status: Accepted
- Date: 2026-07-21

## Context

Scheduled QueryとDAGには複数の実行サービスアカウントが存在し得ます。

## Decision

`lineage_execution_account_config`を作成し、source種別ごとに`ARRAY<STRING>`でサービスアカウントを保持します。

## Consequences

- `IN UNNEST()`で安全に判定できる
- カンマ区切り文字列の解析を日次処理から排除できる
- 同一アカウントが重複区分にある場合の優先順位が必要
- Scheduled Queryラベルがある場合はScheduled Queryを優先
