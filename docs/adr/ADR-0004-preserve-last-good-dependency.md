# ADR-0004: 最終正常Dependencyの保護

- Status: Accepted
- Date: 2026-07-21

## Context

Parser障害や一時的なUDFエラーにより、既存の正常な依存関係が消えるとImpact分析が不正になります。

## Decision

新しい解析結果がstagingで完成するまで既存Dependencyを変更せず、置換失敗時はバックアップから復元します。RegistryはFAILEDかつchangedの状態を維持します。

## Consequences

- 一時障害時も最後の正常状態を参照可能
- 更新処理が複雑になる
- 古いDependencyであることをRegistry状態と併せて判断する必要がある
