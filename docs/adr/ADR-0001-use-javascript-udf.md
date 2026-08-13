# ADR-0001: JavaScript UDFによるSQL解析

- Status: Accepted
- Date: 2026-07-21

## Context

BigQuery内でView定義を列単位に解析し、Repositoryへ格納する必要があります。

## Decision

SQL構文解析をPersistent JavaScript UDFで実装し、BigQuery SQLはメタデータ収集と永続化を担当します。

## Consequences

- BigQuery処理から直接呼び出せる
- GCS libraryの配置・権限管理が必要
- Parserの単体・回帰試験が重要
- BigQuery JavaScript環境の制約を受ける
