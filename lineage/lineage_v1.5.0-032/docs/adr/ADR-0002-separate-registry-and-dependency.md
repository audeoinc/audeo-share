# ADR-0002: Definition RegistryとDependencyの分離

- Status: Accepted
- Date: 2026-07-21

## Context

定義の状態管理と解析結果を同一テーブルへ格納すると、変更検知、再実行、失敗時保護が複雑になります。

## Decision

定義・ハッシュ・解析状態をDefinition Registryで管理し、解析結果をDirect Dependencyへ分離します。

## Consequences

- 状態遷移が明確
- 解析失敗時に旧Dependencyを維持できる
- 整合性検証が必要
