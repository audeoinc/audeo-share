# Architecture

## 1. 全体像

本システムは、定義収集、変更検知、SQL解析、直接依存関係の保存、Impact展開、診断・検証の六つの領域で構成します。

```mermaid
flowchart TB
  subgraph Metadata
    V[INFORMATION_SCHEMA.VIEWS]
    J[INFORMATION_SCHEMA.JOBS_BY_PROJECT]
    C[INFORMATION_SCHEMA.COLUMNS]
    F[INFORMATION_SCHEMA.COLUMN_FIELD_PATHS]
  end

  subgraph Configuration
    LC[lineage_config]
    AC[lineage_execution_account_config]
  end

  subgraph Repository
    DR[lineage_definition_registry]
    JR[lineage_job_registry]
    DD[lineage_direct_dependency]
    IM[lineage_impact]
    DG[lineage_diagnostic]
  end

  V --> DR
  J --> JR
  AC --> J
  JR --> DR
  C --> UDF
  F --> UDF
  DR --> UDF[Persistent JavaScript UDF]
  UDF --> DD
  UDF --> DG
  DD --> IM
  LC --> DR
  LC --> UDF
  LC --> IM
```

## 2. コンポーネント責務

### Configuration

環境、対象Dataset、UDF、Impact上限などを管理します。実行アカウントは変更頻度と多値性が異なるため、`lineage_execution_account_config`へ分離します。

### Definition Registry

解析対象のSQL定義と状態を管理します。定義ハッシュにより変更を検出し、`is_changed`と`analysis_status`で解析対象と結果を表します。

### Job Registry

Scheduled QueryとDAGのジョブメタデータを保持します。Scheduled Queryはラベルと登録アカウントの組み合わせで判定し、DAGは登録アカウントで判定します。

### JavaScript UDF

SQLをトークン化・解析し、依存関係と診断結果をJSONで返します。BigQuery SQL側はメタデータ収集、状態管理、永続化を担当します。

### Direct Dependency

一つのsource columnから一つのtarget columnへの直接エッジを保持します。多段展開前の正規化された事実テーブルです。

### Impact

Direct Dependencyを再帰的に連結し、物理カラムを起点とする下流影響経路を保持します。

## 3. 日次シーケンス

```mermaid
sequenceDiagram
  participant S as Scheduler
  participant P as Daily Pipeline
  participant M as INFORMATION_SCHEMA
  participant R as Definition Registry
  participant U as JavaScript UDF
  participant D as Direct Dependency
  participant I as Impact
  participant G as Diagnostic

  S->>P: Execute
  P->>M: Collect Views and Jobs
  P->>R: MERGE definitions and detect changes
  P->>M: Collect columns and field paths
  loop changed object
    P->>U: SQL + physical metadata
    U-->>P: dependencies + diagnostics
    P->>D: replace target dependencies
    P->>G: persist diagnostics
    P->>R: mark analyzed
  end
  P->>I: rebuild impact paths
  P-->>S: summary
```

## 4. 障害境界

解析結果は一時領域で完成させてから既存Dependencyを置換します。置換に失敗した場合はバックアップから復元し、RegistryをFAILEDとして次回再解析対象に残します。

## 5. 拡張ポイント

- SQL構文対応の追加
- Job source種別の追加
- 複数region・複数projectの収集
- Impact snapshotの保持方針
- Looker Studio監視画面
- CIによるParser回帰試験
