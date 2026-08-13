/**
 * ColumnResolverがSourceまで解決した参照を、物理テーブルの実カラムへ結び付ける。
 *
 * PhysicalColumnResolverの責務:
 *
 * - INFORMATION_SCHEMA.COLUMNS / COLUMN_FIELD_PATHS相当のメタデータを索引化する。
 * - PHYSICAL_TABLEへ向いたカラム参照について、実カラムの存在を確認する。
 * - 非修飾列が複数Source候補を持つ場合、実スキーマを使って候補を絞り込む。
 * - `*` / `alias.*`を、物理テーブルまたは派生Sourceの公開列へ展開する。
 * - CTEやサブクエリの参照は、次のLineageResolverが内部式を辿れるよう
 *   「派生Sourceとして解決済み」の状態で保持する。
 *
 * このResolverは、CTE出力列の式を物理カラムまで再帰展開しない。
 * その処理は次工程のLineageResolverへ委譲する。
 */
class PhysicalColumnResolver {
  /**
   * @param {Array<object>} physicalColumns
   *
   * 1行の例:
   * {
   *   project_id: "project",
   *   dataset_id: "dataset",
   *   table_name: "sales",
   *   column_name: "amount",
   *   field_path: "amount",
   *   ordinal_position: 3,
   *   data_type: "NUMERIC"
   * }
   *
   * table_nameへ`project.dataset.sales`を直接渡す形式にも対応する。
   */
  constructor(physicalColumns) {
    if (!Array.isArray(physicalColumns)) {
      throw new TypeError(
        "PhysicalColumnResolver: physicalColumns must be an array."
      );
    }

    this.physicalColumns = physicalColumns;
    this.tableColumnsByName = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.nextPhysicalReferenceId = 1;
    this.nextExpandedOutputColumnId = 1;
  }

  /**
   * ResolutionContextへ登録済みのSource / Column / Output Columnを利用し、
   * 物理カラム解決結果を作る公開入口。
   */
  resolve(context) {
    this.#validateContext(context);

    this.nextPhysicalReferenceId = 1;
    this.nextExpandedOutputColumnId = 1;
    this.missingWildcardMetadata = new Map();
    this.#buildMetadataIndex();
    this.#buildResolutionIndexes(context);

    const columnReferences = context.column_resolution.column_references.map(
      (reference) => this.#resolveColumnReference(reference, context)
    );
    const unpivotGeneratedColumns =
      this.#resolveUnpivotGeneratedColumns(context);
    const wildcardExpansions = this.#expandOutputWildcards(context);

    const result = {
      node_type: "PHYSICAL_COLUMN_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      metadata_table_count: this.tableColumnsByName.size,
      column_references: columnReferences,
      unpivot_generated_columns: unpivotGeneratedColumns,
      wildcard_expansions: wildcardExpansions
    };

    context.setPhysicalColumnResolution(result);
    this.#addDiagnostics(result, context);

    return result;
  }

  /**
   * メタデータをテーブル完全名ごとのMapへ変換する。
   *
   * Resolver本処理で毎回全行を走査しないよう、最初に索引化する。
   * 大量Viewを処理する場合、この前処理が探索コストを抑える。
   */
  #buildMetadataIndex() {
    this.tableColumnsByName = new Map();

    for (const [metadataIndex, rawColumn] of this.physicalColumns.entries()) {
      const column = this.#normalizeMetadataColumn(rawColumn, metadataIndex);
      const tableNames = this.#createTableLookupNames(column);

      for (const tableName of tableNames) {
        if (!this.tableColumnsByName.has(tableName)) {
          this.tableColumnsByName.set(tableName, []);
        }

        this.tableColumnsByName.get(tableName).push(column);
      }
    }

    /*
     * Wildcard展開結果を元テーブルの列順へ揃えるため、
     * ordinal_positionがある場合は昇順に並べる。
     */
    for (const columns of this.tableColumnsByName.values()) {
      columns.sort((left, right) => {
        const leftPosition = left.ordinal_position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.ordinal_position ?? Number.MAX_SAFE_INTEGER;

        return leftPosition - rightPosition;
      });
    }
  }

  #buildResolutionIndexes(context) {
    this.sourceById = new Map();
    this.sourcesByScopeId = new Map();

    for (const scope of context.source_resolution.scopes) {
      this.sourcesByScopeId.set(scope.scope_id, scope.sources);

      for (const source of scope.sources) {
        this.sourceById.set(source.source_id, source);
      }
    }

    this.outputColumnsByScopeId = new Map(
      context.output_column_resolution.scopes.map((scope) => {
        return [scope.scope_id, scope.output_columns];
      })
    );
  }

  #resolveColumnReference(reference, context) {
    if (reference.reference_type === "WILDCARD") {
      return this.#resolveWildcardReference(reference, context);
    }

    /*
     * ワイルドカードテーブルやパーティションの疑似列(_TABLE_SUFFIX 等)は
     * 物理列に対応せず系統も持たない。存在しない列として誤検出しないよう、
     * 依存なしで解決済みとして扱う。
     */
    if (this.#isPseudoColumn(reference.column_name)) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PSEUDO_COLUMN_RESOLVED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    /*
     * GROUP BY / HAVING / QUALIFY / ORDER BYから参照されたSELECT出力
     * エイリアスは物理Sourceの列ではない。SELECT式側のLineageが既に
     * 依存列を保持しているため、ここでは正常解決として通過させる。
     */
    if (reference.resolution_status === "SELECT_ALIAS_RESOLVED") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "SELECT_ALIAS_RESOLVED",
        sourceId: null,
        physicalColumns: []
      });
    }

    const unpivotGeneratedOutput = this.#findUnpivotGeneratedOutput(reference);

    if (unpivotGeneratedOutput) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNPIVOT_GENERATED_RESOLVED",
        sourceId: unpivotGeneratedOutput.unpivot_source_id,
        physicalColumns: []
      });
    }

    if (reference.source_type === "PHYSICAL_TABLE" && reference.source_id) {
      return this.#resolveAgainstPhysicalSource(reference, reference.source_id);
    }

    if (
      reference.resolution_status === "AMBIGUOUS" &&
      reference.candidate_source_ids.length > 0
    ) {
      return this.#resolveAmbiguousReference(reference, context);
    }

    if (reference.source_type === "CTE" || reference.source_type === "SUBQUERY") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "DERIVED_SOURCE_RESOLVED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    if (reference.source_type === "UNNEST") {
      return this.#resolveCorrelatedUnnestReference(reference, context);
    }

    /*
     * 遅延ディスアンビグエーション。
     *
     * ColumnResolverは物理スキーマを持たず、派生ソース(CTE/サブクエリ)の
     * 公開列を * カスケード越しには把握できないため、JOINを含むスコープで
     * 修飾なし列がどのソース由来か決められず UNRESOLVED_COLUMN のまま
     * 候補ゼロになることがある(例: SELECT aid ... FROM cte c JOIN (..) f)。
     * ここでは PhysicalColumnResolver が計算できる派生列一覧を使い、
     * スコープ内で当該列を公開するソースが1つだけなら解決する。
     */
    if (!reference.qualifier &&
        (reference.resolution_status === "UNRESOLVED_COLUMN" ||
         reference.resolution_status === "AMBIGUOUS")) {
      const recovered = this.#resolveUnqualifiedAgainstScopeSources(
        reference,
        context
      );

      if (recovered) {
        return recovered;
      }
    }

    /*
     * STRUCT フィールドアクセス(例: geo.region)。ColumnResolverは修飾子
     * `geo` をソース別名とみなし、一致するソースが無いと UNRESOLVED_SOURCE に
     * する。ここで `修飾子.列名` を field_path として、スコープ内の物理ソースの
     * メタデータ(COLUMN_FIELD_PATHS由来)に一致するネスト列があれば解決する。
     */
    if (reference.qualifier) {
      const structResolved = this.#resolveStructFieldPathReference(reference);

      if (structResolved) {
        return structResolved;
      }
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: reference.resolution_status,
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }

  /*
   * `qualifier.column_name`(および `qualifier` が複数階層の場合はそのまま連結)
   * を field_path とみなし、スコープ内の物理ソースから一致するネスト列を探す。
   * 該当ソースが1つなら解決、複数ならAMBIGUOUS、無ければnull。
   */
  #resolveStructFieldPathReference(reference) {
    /*
     * reference_name には書かれたままのフルパスが入る(例:
     * geo.region / device.web_info.browser)。qualifier/column_name は
     * 先頭2要素しか持たないため、深いネストも拾えるフルパスを優先する。
     */
    const fieldPath = this.#normalizeName(
      reference.reference_name ||
      `${reference.qualifier}.${reference.column_name}`
    );

    if (!fieldPath || !fieldPath.includes(".")) {
      return null;
    }

    const sources = this.sourcesByScopeId.get(reference.scope_id) || [];
    const matches = [];

    for (const source of sources) {
      if (source.source_type !== "PHYSICAL_TABLE") {
        continue;
      }

      const columns = this.#getColumnsForSource(source).filter(
        (column) => this.#normalizeName(column.field_path) === fieldPath
      );

      if (columns.length > 0) {
        matches.push({ source, columns });
      }
    }

    if (matches.length === 1) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PHYSICAL_RESOLVED",
        sourceId: matches[0].source.source_id,
        physicalColumns: matches[0].columns
      });
    }

    if (matches.length > 1) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PHYSICAL_AMBIGUOUS",
        sourceId: null,
        physicalColumns: matches.flatMap((item) => item.columns),
        candidateSourceIds: matches.map((item) => item.source.source_id)
      });
    }

    return null;
  }


  /**
   * 相関UNNESTの別名参照を、元の物理STRUCT/ARRAYフィールドへ展開する。
   *
   * 例:
   *   LEFT JOIN UNNEST(customer.contacts) AS contact
   *   SELECT contact.contact_value
   *
   * UNNEST式の`customer.contacts`から親Sourceと配列フィールドを特定し、
   * `contact.contact_value`を`customer.contacts.contact_value`として
   * INFORMATION_SCHEMA.COLUMN_FIELD_PATHSへ照合する。
   *
   * 安全性のため、次の条件をすべて満たす場合だけ物理解決する。
   * - UNNEST式が単純な修飾識別子である。
   * - 先頭要素が同一scope内の既存Source aliasを指す。
   * - 親Sourceが物理テーブルである。
   * - 完全なfield_pathがメタデータに存在する。
   */
  #resolveCorrelatedUnnestReference(reference, context) {
    const unnestSource = this.sourceById.get(reference.source_id);
    const expressionParts =
      unnestSource?.expression?.node_type === "IDENTIFIER_EXPRESSION" &&
      Array.isArray(unnestSource.expression.parts)
        ? unnestSource.expression.parts.map((part) => this.#normalizeName(part))
        : [];

    const referenceName = this.#normalizeName(reference.column_name);
    const isWholeValue = unnestSource &&
      referenceName === this.#normalizeName(unnestSource.source_alias);
    const isOffset = unnestSource &&
      unnestSource.offset_alias &&
      referenceName === this.#normalizeName(unnestSource.offset_alias);

    /*
     * WITH OFFSET の列は配列内の位置(整数)で、元列への系統を持たない。
     */
    if (isOffset) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_OFFSET",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    if (expressionParts.length === 0) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_DEFERRED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    /*
     * 要素値そのもの(素の別名)への参照。
     *   UNNEST(item_id) AS item_id  -> item_id(配列列)の系統
     *   UNNEST(t.items) AS x        -> t.items フィールドの系統
     */
    if (isWholeValue) {
      if (expressionParts.length === 1) {
        return this.#resolveUnnestArrayColumn(
          reference,
          unnestSource,
          expressionParts[0],
          context
        );
      }

      const parentSource = this.#findSiblingSourceByAlias(
        unnestSource,
        expressionParts[0]
      );

      if (parentSource?.source_type === "PHYSICAL_TABLE") {
        const fieldPath = expressionParts.slice(1).join(".");

        return this.#resolveParentFieldPath(reference, parentSource, fieldPath);
      }

      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_DEFERRED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    /*
     * 要素内フィールドへの参照。
     *   物理の繰り返しSTRUCT: UNNEST(event_params) [AS ep], ep.key
     *     -> 配列列のfield_path接頭辞 + フィールド名 = event_params.key を解決
     *   相関UNNEST:          UNNEST(customer.contacts) AS c, c.contact_value
     *   定数/派生の配列:      UNNEST(str)（cte1のSTRUCTリテラル配列） -> 定数
     */

    // 要素内のフィールドパス(先頭が要素別名ならそれを除去)。
    const elementAlias = this.#normalizeName(unnestSource.source_alias);
    const referenceParts = this.#normalizeName(
      reference.reference_name || reference.column_name
    ).split(".").filter(Boolean);
    const fieldWithinElement =
      (elementAlias && referenceParts.length > 1 &&
        referenceParts[0] === elementAlias)
        ? referenceParts.slice(1).join(".")
        : referenceParts.join(".");

    // 配列式(UNNESTの引数)の所有ソースと、配列のfield_path接頭辞を求める。
    let arrayOwner = null;
    let arrayPrefix = null;

    if (expressionParts.length >= 2) {
      const aliasedOwner = this.#findSiblingSourceByAlias(
        unnestSource,
        expressionParts[0]
      );

      if (aliasedOwner) {
        arrayOwner = aliasedOwner;
        arrayPrefix = expressionParts.slice(1).join(".");
      }
    }

    if (!arrayOwner) {
      arrayPrefix = expressionParts.join(".");
      const siblings = (this.sourcesByScopeId.get(unnestSource.scope_id) || [])
        .filter((source) => source.source_id !== unnestSource.source_id);

      for (const sibling of siblings) {
        if (sibling.source_type !== "PHYSICAL_TABLE") {
          continue;
        }

        const owns = this.#getColumnsForSource(sibling).some((column) =>
          this.#normalizeName(column.field_path) === arrayPrefix ||
          this.#normalizeName(column.column_name) === arrayPrefix);

        if (owns) {
          arrayOwner = sibling;
          break;
        }
      }
    }

    if (arrayOwner && arrayOwner.source_type === "PHYSICAL_TABLE" &&
        arrayPrefix && fieldWithinElement) {
      const fullFieldPath = `${arrayPrefix}.${fieldWithinElement}`;
      const columns = this.#getColumnsForSource(arrayOwner).filter(
        (column) => this.#normalizeName(column.field_path) === fullFieldPath
      );

      if (columns.length > 0) {
        return this.#createPhysicalReference(reference, {
          physicalStatus: "PHYSICAL_RESOLVED",
          sourceId: arrayOwner.source_id,
          physicalColumns: columns
        });
      }
    }

    /*
     * 物理配列に一致するfield_pathが無い、または配列が派生列/リテラル(STRUCT
     * リテラル配列など)の場合、要素フィールドは上流の物理カラムを持たない定数
     * として扱う(誤ったPARTIALLY_RESOLVEDを出さない)。
     */
    return this.#createPhysicalReference(reference, {
      physicalStatus: "UNNEST_CONSTANT",
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }

  #findSiblingSourceByAlias(unnestSource, alias) {
    return Array.from(this.sourceById.values()).find((source) => {
      return source.scope_id === unnestSource.scope_id &&
        source.source_id !== unnestSource.source_id &&
        source.source_alias === alias;
    }) || null;
  }

  #resolveParentFieldPath(reference, parentSource, fieldPath) {
    const matchingColumns = this.#getColumnsForSource(parentSource).filter(
      (column) => column.field_path === fieldPath
    );

    if (matchingColumns.length === 0) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: this.#hasMetadataForSource(parentSource)
          ? "PHYSICAL_COLUMN_NOT_FOUND"
          : "PHYSICAL_METADATA_NOT_FOUND",
        sourceId: parentSource.source_id,
        physicalColumns: []
      });
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: "PHYSICAL_RESOLVED",
      sourceId: parentSource.source_id,
      physicalColumns: matchingColumns
    });
  }

  /*
   * UNNEST(<bare_column>) の要素値を、同一スコープの兄弟ソースが公開する
   * その配列列へ結び付ける。物理テーブルなら物理列、派生ソースなら
   * DERIVED_SOURCE_RESOLVED として系統を継ぐ。
   */
  #resolveUnnestArrayColumn(reference, unnestSource, arrayColumnName, context) {
    const siblings = (this.sourcesByScopeId.get(unnestSource.scope_id) || [])
      .filter((source) => source.source_id !== unnestSource.source_id);

    for (const sibling of siblings) {
      if (sibling.source_type === "PHYSICAL_TABLE") {
        const columns = this.#findPhysicalColumns(sibling, arrayColumnName);

        if (columns.length > 0) {
          return this.#createPhysicalReference(reference, {
            physicalStatus: "PHYSICAL_RESOLVED",
            sourceId: sibling.source_id,
            physicalColumns: columns
          });
        }
      } else if ((sibling.source_type === "CTE" ||
          sibling.source_type === "SUBQUERY") && context &&
          this.#derivedSourceExposesColumn(sibling, arrayColumnName, context)) {
        return this.#createPhysicalReference(reference, {
          physicalStatus: "DERIVED_SOURCE_RESOLVED",
          sourceId: sibling.source_id,
          physicalColumns: []
        });
      }
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: "UNNEST_DEFERRED",
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }

  #resolveAgainstPhysicalSource(reference, sourceId) {
    const source = this.sourceById.get(sourceId);

    /*
     * ソース別名で修飾された STRUCT フィールドアクセス(例: t.geo.region)。
     * reference_name から先頭の別名/テーブル名を取り除いた残りがネストパス
     * (dotを含む)なら、その field_path に厳密一致する列だけへ解決する。
     * こうしないと column_name 一致で geo(トップ)と geo.region の両方が
     * 依存として付いてしまう。
     */
    const accessPath = this.#deriveStructAccessPath(reference, source);
    const matchingColumns = accessPath && accessPath.includes(".")
      ? this.#getColumnsForSource(source).filter(
          (column) => this.#normalizeName(column.field_path) === accessPath
        )
      : this.#findPhysicalColumns(source, reference.column_name);

    return this.#createPhysicalReference(reference, {
      physicalStatus: matchingColumns.length > 0
        ? "PHYSICAL_RESOLVED"
        : this.#hasMetadataForSource(source)
          ? "PHYSICAL_COLUMN_NOT_FOUND"
          : "PHYSICAL_METADATA_NOT_FOUND",
      sourceId,
      physicalColumns: matchingColumns
    });
  }

  /*
   * reference_name から、ソースを指す先頭の別名/テーブル名要素を取り除いた
   * アクセスパスを返す。t.geo.region -> geo.region、geo.region -> geo.region。
   */
  #deriveStructAccessPath(reference, source) {
    const rawName = reference.reference_name || reference.column_name;
    const parts = this.#normalizeName(rawName || "").split(".").filter(Boolean);

    if (parts.length <= 1) {
      return parts.join(".");
    }

    const aliasCandidates = new Set(
      [
        source?.source_alias,
        ...(source?.source_name ? source.source_name.split(".") : [])
      ]
        .filter(Boolean)
        .map((value) => this.#normalizeName(value))
    );

    if (aliasCandidates.has(parts[0])) {
      parts.shift();
    }

    return parts.join(".");
  }

  /**
   * ColumnResolverでは物理スキーマが無いため、非修飾列が複数Sourceに
   * 存在し得る場合はAMBIGUOUSとしていた。
   *
   * ここでは各候補テーブルの実カラムを確認し、列を持つSourceが1件だけなら
   * 曖昧性を解消する。複数テーブルに同名列がある場合は曖昧なまま保持する。
   */
  #resolveAmbiguousReference(reference, context) {
    return this.#disambiguateAcrossSources(
      reference,
      reference.candidate_source_ids,
      context
    );
  }

  /*
   * 修飾なし列を、スコープのFROMソース全体から解決する。
   * ColumnResolverが候補を出せなかった(候補ゼロ)場合の救済に使う。
   */
  #resolveUnqualifiedAgainstScopeSources(reference, context) {
    const sources = this.sourcesByScopeId.get(reference.scope_id) || [];
    const sourceIds = sources.map((source) => source.source_id);

    if (sourceIds.length === 0) {
      return null;
    }

    const resolved = this.#disambiguateAcrossSources(
      reference,
      sourceIds,
      context
    );

    /*
     * スコープ内のどのソースにも当該列が無い場合は解決したことにしない
     * (相関参照など別スコープ由来の可能性を潰さない)。
     */
    if (resolved.physical_resolution_status === "PHYSICAL_RESOLVED" ||
        resolved.physical_resolution_status === "DERIVED_SOURCE_RESOLVED") {
      return resolved;
    }

    return null;
  }

  /*
   * 物理テーブルと派生ソース(CTE/サブクエリ)の両方を対象に、指定列を
   * 公開するソースを探して解決する。該当が1つなら解決、複数ならAMBIGUOUS、
   * 皆無なら COLUMN_NOT_FOUND。
   */
  #disambiguateAcrossSources(reference, candidateSourceIds, context) {
    const physicalMatches = [];
    const derivedMatches = [];
    const unnestCandidates = [];

    for (const sourceId of candidateSourceIds) {
      const source = this.sourceById.get(sourceId);

      if (!source) {
        continue;
      }

      if (source.source_type === "PHYSICAL_TABLE") {
        const columns = this.#findPhysicalColumns(source, reference.column_name);

        if (columns.length > 0) {
          physicalMatches.push({ source, columns });
        }

        continue;
      }

      if (source.source_type === "CTE" || source.source_type === "SUBQUERY") {
        if (this.#derivedSourceExposesColumn(
          source,
          reference.column_name,
          context
        )) {
          derivedMatches.push({ source });
        }

        continue;
      }

      if (source.source_type === "UNNEST") {
        unnestCandidates.push(source);
      }
    }

    const totalMatches = physicalMatches.length + derivedMatches.length;

    if (totalMatches === 1) {
      if (physicalMatches.length === 1) {
        return this.#createPhysicalReference(reference, {
          physicalStatus: "PHYSICAL_RESOLVED",
          sourceId: physicalMatches[0].source.source_id,
          physicalColumns: physicalMatches[0].columns
        });
      }

      return this.#createPhysicalReference(reference, {
        physicalStatus: "DERIVED_SOURCE_RESOLVED",
        sourceId: derivedMatches[0].source.source_id,
        physicalColumns: []
      });
    }

    /*
     * どの物理/派生ソースにも無い修飾なし列で、スコープにUNNESTが1つだけある
     * 場合は、その要素フィールド(例: UNNEST(event_params) の key/value を別名
     * なしで参照)とみなしてUNNEST解決へ委譲する。
     */
    if (totalMatches === 0 && unnestCandidates.length === 1) {
      return this.#resolveCorrelatedUnnestReference(
        { ...reference, source_id: unnestCandidates[0].source_id },
        context
      );
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: totalMatches > 1
        ? "PHYSICAL_AMBIGUOUS"
        : "PHYSICAL_COLUMN_NOT_FOUND",
      sourceId: null,
      physicalColumns: physicalMatches.flatMap((item) => item.columns),
      candidateSourceIds: [
        ...physicalMatches.map((item) => item.source.source_id),
        ...derivedMatches.map((item) => item.source.source_id)
      ]
    });
  }

  #derivedSourceExposesColumn(source, columnName, context) {
    const scopeId = source.cte_query_scope_id ?? source.subquery_scope_id;

    if (scopeId === null || scopeId === undefined || !context) {
      return false;
    }

    const target = this.#normalizeName(columnName);
    const columns = this.#expandDerivedScopeColumns(scopeId, context, new Set());

    return columns.some((column) => {
      return this.#normalizeName(column.output_column_name) === target;
    });
  }

  #resolveWildcardReference(reference, context) {
    const expandedColumns = this.#expandReferenceWildcard(reference, context);

    return this.#createPhysicalReference(reference, {
      physicalStatus: expandedColumns.length > 0
        ? "WILDCARD_EXPANDED"
        : "WILDCARD_NOT_EXPANDED",
      sourceId: reference.source_id,
      physicalColumns: expandedColumns
    });
  }

  #findUnpivotGeneratedOutput(reference) {
    const generatedName = this.#normalizeName(reference.column_name);
    const outputColumns = this.outputColumnsByScopeId.get(reference.scope_id) || [];

    return outputColumns.find((outputColumn) => {
      return outputColumn.output_status === "UNPIVOT_GENERATED" &&
        this.#normalizeName(outputColumn.unpivot_generated_column_name) ===
          generatedName;
    }) || null;
  }

  /**
   * UNPIVOT生成列が依存する物理入力列を、通常のColumn Referenceとは
   * 分離して解決する。UNPIVOT本体のIN句はSELECT式ではないため、
   * ColumnResolverの参照一覧には現れない。
   */
  #resolveUnpivotGeneratedColumns(context) {
    return context.output_column_resolution.output_columns
      .filter((outputColumn) => {
        return outputColumn.output_status === "UNPIVOT_GENERATED";
      })
      .map((outputColumn) => {
        const source = this.sourceById.get(outputColumn.unpivot_source_id);
        const inputColumnNames = outputColumn.unpivot_input_column_names || [];
        const physicalColumns = [];
        const missingColumnNames = [];

        if (source?.source_type === "PHYSICAL_TABLE") {
          for (const inputColumnName of inputColumnNames) {
            const matches = this.#findPhysicalColumns(source, inputColumnName);

            if (matches.length === 0) {
              missingColumnNames.push(this.#normalizeName(inputColumnName));
            } else {
              physicalColumns.push(...matches);
            }
          }
        }

        let resolutionStatus = "DERIVED_SOURCE_RESOLVED";

        if (source?.source_type === "PHYSICAL_TABLE") {
          resolutionStatus = missingColumnNames.length > 0
            ? this.#hasMetadataForSource(source)
              ? "PHYSICAL_COLUMN_NOT_FOUND"
              : "PHYSICAL_METADATA_NOT_FOUND"
            : "PHYSICAL_RESOLVED";
        }

        return {
          output_column_id: outputColumn.output_column_id,
          scope_id: outputColumn.scope_id,
          output_column_name: outputColumn.output_column_name,
          generated_column_name:
            outputColumn.unpivot_generated_column_name,
          generated_column_type:
            outputColumn.unpivot_generated_column_type,
          source_id: source?.source_id ?? null,
          source_type: source?.source_type ?? null,
          source_name: source?.source_name ?? null,
          input_scope_id: outputColumn.unpivot_input_scope_id ?? null,
          input_column_names: [...inputColumnNames],
          missing_column_names: missingColumnNames,
          physical_resolution_status: resolutionStatus,
          physical_columns: physicalColumns.map((column) => ({
            physical_table_name: column.physical_table_name,
            physical_column_name: column.column_name,
            field_path: column.field_path,
            ordinal_position: column.ordinal_position,
            data_type: column.data_type,
            is_nullable: column.is_nullable
          }))
        };
      });
  }

  /**
   * OutputColumnResolverがWILDCARD_PENDINGとして保持したSELECT項目を、
   * 具体的な出力列一覧へ展開する。
   *
   * 元のOutput Columnは消さず、展開結果を別配列へ返す。
   * これにより「元SQLではWildcardだった」という情報と、実際の公開列一覧の
   * 両方を保持できる。
   */
  #expandOutputWildcards(context) {
    const expansions = [];

    for (const outputColumn of context.output_column_resolution.output_columns) {
      if (outputColumn.output_status !== "WILDCARD_PENDING") {
        continue;
      }

      const reference = context.column_resolution.column_references.find((item) => {
        return item.scope_id === outputColumn.scope_id &&
          item.select_item_seq === outputColumn.output_column_seq &&
          item.reference_type === "WILDCARD";
      });

      if (!reference) {
        continue;
      }

      const expandedColumns = this.#expandReferenceWildcard(reference, context);
      const exclusions = new Set(
        (outputColumn.wildcard_exclusions || []).map((name) => this.#normalizeName(name))
      );
      const unpivotInputColumns = new Set(
        context.output_column_resolution.output_columns
          .filter((column) => {
            return column.scope_id === outputColumn.scope_id &&
              column.output_status === "UNPIVOT_GENERATED";
          })
          .flatMap((column) => column.unpivot_all_input_column_names || [])
          .map((name) => this.#normalizeName(name))
      );
      const visibleColumns = expandedColumns.filter((physicalColumn) => {
        const outputName = physicalColumn.output_column_name ||
          physicalColumn.column_name ||
          physicalColumn.physical_column_name;
        const normalizedOutputName = this.#normalizeName(outputName);
        return !exclusions.has(normalizedOutputName) &&
          !unpivotInputColumns.has(normalizedOutputName);
      });
      const replacements = outputColumn.wildcard_replacements || [];
      const replacementByName = new Map(replacements.map((item) => {
        return [this.#normalizeName(item.output_column_name), item];
      }));
      const wildcardBaseExpression = outputColumn.wildcard_qualifier
        ? `${outputColumn.wildcard_qualifier}.*`
        : "*";
      let wildcardExpression = exclusions.size > 0
        ? `${wildcardBaseExpression} EXCEPT(${[...exclusions].join(", ")})`
        : wildcardBaseExpression;
      if (replacements.length > 0) {
        const replacementText = replacements.map((item) => {
          return `${item.expression} AS ${item.output_column_name}`;
        }).join(", ");
        wildcardExpression += ` REPLACE(${replacementText})`;
      }

      for (const [expandedIndex, physicalColumn] of visibleColumns.entries()) {
        expansions.push({
          expanded_output_column_id: this.nextExpandedOutputColumnId++,
          source_output_column_id: outputColumn.output_column_id,
          scope_id: outputColumn.scope_id,
          select_item_seq: outputColumn.output_column_seq,
          expanded_column_seq: expandedIndex + 1,
          output_column_name: physicalColumn.output_column_name ||
            physicalColumn.column_name,
          source_id: physicalColumn.source_id,
          source_type: physicalColumn.source_type,
          source_name: physicalColumn.source_name,
          physical_table_name: physicalColumn.physical_table_name ?? null,
          physical_column_name: physicalColumn.physical_column_name ??
            physicalColumn.column_name ??
            physicalColumn.output_column_name ??
            null,
          field_path: physicalColumn.field_path ??
            physicalColumn.column_name ??
            physicalColumn.output_column_name ??
            null,
          data_type: physicalColumn.data_type ?? null,
          ordinal_position: physicalColumn.ordinal_position ?? null,
          wildcard_type: outputColumn.wildcard_type,
          wildcard_qualifier: outputColumn.wildcard_qualifier ?? null,
          wildcard_expression: wildcardExpression,
          wildcard_replacement: replacementByName.get(this.#normalizeName(
            physicalColumn.output_column_name || physicalColumn.column_name
          )) || null
        });
      }
    }

    return expansions;
  }

  #expandReferenceWildcard(reference, context) {
    const sourceIds = reference.source_id
      ? [reference.source_id]
      : reference.candidate_source_ids;
    const result = [];

    for (const sourceId of sourceIds) {
      const source = this.sourceById.get(sourceId);

      if (!source) {
        continue;
      }

      if (source.source_type === "PHYSICAL_TABLE") {
        this.#recordMissingWildcardMetadata(source, reference);

        for (const column of this.#getTopLevelColumns(source)) {
          result.push({
            ...column,
            source_id: source.source_id,
            source_type: source.source_type,
            source_name: source.source_name,
            output_column_name: column.column_name
          });
        }
        continue;
      }

      const childScopeId = source.cte_query_scope_id || source.subquery_scope_id;
      const expandedDerivedColumns = this.#expandDerivedScopeColumns(
        childScopeId,
        context,
        new Set()
      );

      for (const derivedColumn of expandedDerivedColumns) {
        result.push({
          ...derivedColumn,
          source_id: source.source_id,
          source_type: source.source_type,
          source_name: source.source_name
        });
      }
    }

    return result;
  }

  #expandDerivedScopeColumns(scopeId, context, visitingScopeIds) {
    if (scopeId === null || scopeId === undefined) {
      return [];
    }

    if (visitingScopeIds.has(scopeId)) {
      return [];
    }

    const nextVisiting = new Set(visitingScopeIds);
    nextVisiting.add(scopeId);
    const outputColumns = this.outputColumnsByScopeId.get(scopeId) || [];
    const result = [];

    for (const outputColumn of outputColumns) {
      if (outputColumn.output_status !== "WILDCARD_PENDING") {
        if (!outputColumn.output_column_name) {
          continue;
        }

        result.push({
          output_column_name: outputColumn.output_column_name,
          physical_table_name: null,
          physical_column_name: null,
          field_path: null,
          data_type: null,
          ordinal_position: outputColumn.output_column_seq
        });
        continue;
      }

      const wildcardReference = context.column_resolution.column_references.find((item) => {
        return item.scope_id === scopeId &&
          item.select_item_seq === outputColumn.output_column_seq &&
          item.reference_type === "WILDCARD";
      });

      if (!wildcardReference) {
        continue;
      }

      const sourceIds = wildcardReference.source_id
        ? [wildcardReference.source_id]
        : wildcardReference.candidate_source_ids;

      /*
       * このWILDCARD_PENDING列自身の EXCEPT(...) を、下位ソースから
       * 展開した列へ適用する。これを行わないと、
       *   x_all AS (SELECT * EXCEPT(col_a) FROM t)
       *   x_some AS (SELECT * FROM x_all)      -- 2段以上の * カスケード
       * のように * が多段で伝播するとき、上流でEXCEPTした列が
       * 下流の再展開で復活してしまう。再帰先も各自のEXCEPTを適用するため、
       * 多段のEXCEPTが正しく合成される。
       */
      const exclusions = new Set(
        (outputColumn.wildcard_exclusions || [])
          .map((name) => this.#normalizeName(name))
      );
      const columnsForThisWildcard = [];

      for (const sourceId of sourceIds) {
        const nestedSource = this.sourceById.get(sourceId);

        if (!nestedSource) {
          continue;
        }

        if (nestedSource.source_type === "PHYSICAL_TABLE") {
          this.#recordMissingWildcardMetadata(nestedSource, wildcardReference);

          for (const column of this.#getTopLevelColumns(nestedSource)) {
            columnsForThisWildcard.push({
              output_column_name: column.column_name,
              physical_table_name: column.physical_table_name,
              physical_column_name: column.column_name,
              field_path: column.field_path,
              data_type: column.data_type,
              ordinal_position: column.ordinal_position
            });
          }
          continue;
        }

        const nestedScopeId = nestedSource.cte_query_scope_id ||
          nestedSource.subquery_scope_id;
        columnsForThisWildcard.push(...this.#expandDerivedScopeColumns(
          nestedScopeId,
          context,
          nextVisiting
        ));
      }

      for (const column of columnsForThisWildcard) {
        if (exclusions.has(this.#normalizeName(column.output_column_name))) {
          continue;
        }

        result.push(column);
      }
    }

    const deduplicated = [];
    const seenNames = new Set();

    for (const column of result) {
      const name = this.#normalizeName(column.output_column_name);

      if (!name || seenNames.has(name)) {
        continue;
      }

      seenNames.add(name);
      deduplicated.push(column);
    }

    return deduplicated;
  }

  #findPhysicalColumns(source, columnName) {
    const tableColumns = this.#getColumnsForSource(source);
    const normalizedColumnName = this.#normalizeName(columnName);

    return tableColumns.filter((column) => {
      return column.column_name === normalizedColumnName ||
        column.field_path === normalizedColumnName;
    });
  }

  #getTopLevelColumns(source) {
    const seenNames = new Set();
    const result = [];

    for (const column of this.#getColumnsForSource(source)) {
      const isTopLevel = !column.field_path ||
        column.field_path === column.column_name ||
        !column.field_path.includes(".");

      if (!isTopLevel || seenNames.has(column.column_name)) {
        continue;
      }

      seenNames.add(column.column_name);
      result.push(column);
    }

    return result;
  }

  #getColumnsForSource(source) {
    if (!source?.source_name) {
      return [];
    }

    const name = this.#normalizeName(source.source_name);
    const exact = this.tableColumnsByName.get(name);

    if (exact) {
      return exact;
    }

    /*
     * ワイルドカードテーブル(例: `project.dataset.events_*`)は、収集済みの
     * シャードテーブル(events_20200101 等)のスキーマから列を引く。各シャードは
     * 同一スキーマ想定なので field_path 単位で重複排除して統合する。
     */
    if (name && name.includes("*")) {
      return this.#getWildcardTableColumns(name);
    }

    return [];
  }

  #getWildcardTableColumns(pattern) {
    const regex = this.#wildcardPatternToRegExp(pattern);
    const seen = new Set();
    const result = [];

    for (const [tableName, columns] of this.tableColumnsByName.entries()) {
      if (!regex.test(tableName)) {
        continue;
      }

      for (const column of columns) {
        const key = `${column.field_path}|${column.column_name}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        result.push(column);
      }
    }

    return result;
  }

  #wildcardPatternToRegExp(pattern) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    return new RegExp(`^${escaped}$`);
  }

  #isPseudoColumn(columnName) {
    const pseudoColumns = new Set([
      "_TABLE_SUFFIX",
      "_TABLE_DATE",
      "_PARTITIONTIME",
      "_PARTITIONDATE",
      "_FILE_NAME"
    ]);

    return pseudoColumns.has(this.#normalizeName(columnName));
  }

  #hasMetadataForSource(source) {
    return this.#getColumnsForSource(source).length > 0;
  }

  /*
   * ワイルドカード(*)の展開先が物理テーブルなのに、その列メタデータが
   * 収集集合に1件も無い場合を記録する。明示列参照は
   * PHYSICAL_METADATA_NOT_FOUND で警告されるが、* 展開は静かに0列になる
   * ため、UNION等では下流で列が原因不明のまま未解決になっていた。
   * source_name単位で重複排除する。
   */
  #recordMissingWildcardMetadata(source, positionReference) {
    if (!source || source.source_type !== "PHYSICAL_TABLE") {
      return;
    }

    if (this.#hasMetadataForSource(source)) {
      return;
    }

    const key = this.#normalizeName(source.source_name);

    if (!key || this.missingWildcardMetadata.has(key)) {
      return;
    }

    this.missingWildcardMetadata.set(key, {
      source_id: source.source_id ?? null,
      source_name: source.source_name ?? null,
      resolved_source_name:
        source.resolved_source_name ?? source.source_name ?? null,
      scope_id: positionReference?.scope_id ?? source.scope_id ?? null,
      start_token_seq:
        positionReference?.start_token_seq ?? source.start_token_seq ?? null,
      end_token_seq:
        positionReference?.end_token_seq ?? source.end_token_seq ?? null
    });
  }

  #createPhysicalReference(reference, details) {
    const source = details.sourceId
      ? this.sourceById.get(details.sourceId)
      : null;

    return {
      physical_reference_id: this.nextPhysicalReferenceId++,
      column_reference_id: reference.column_reference_id,
      scope_id: reference.scope_id,
      clause_type: reference.clause_type,
      select_item_seq: reference.select_item_seq,
      reference_type: reference.reference_type,
      reference_name: reference.reference_name,
      column_name: reference.column_name,
      original_resolution_status: reference.resolution_status,
      physical_resolution_status: details.physicalStatus,
      source_id: source?.source_id ?? details.sourceId ?? null,
      source_type: source?.source_type ?? reference.source_type ?? null,
      source_name: source?.source_name ?? reference.source_name ?? null,
      source_alias: source?.source_alias ?? reference.source_alias ?? null,
      candidate_source_ids: details.candidateSourceIds ??
        reference.candidate_source_ids ?? [],
      physical_columns: details.physicalColumns.map((column) => ({
        physical_table_name: column.physical_table_name ?? null,
        physical_column_name: column.column_name ??
          column.physical_column_name ?? null,
        field_path: column.field_path ?? null,
        ordinal_position: column.ordinal_position ?? null,
        data_type: column.data_type ?? null,
        is_nullable: column.is_nullable ?? null
      })),
      start_token_seq: reference.start_token_seq,
      end_token_seq: reference.end_token_seq
    };
  }

  #normalizeMetadataColumn(rawColumn, metadataIndex) {
    if (!rawColumn || typeof rawColumn !== "object") {
      throw new TypeError(
        `PhysicalColumnResolver: metadata row ${metadataIndex + 1} is invalid.`
      );
    }

    const physicalTableName = this.#derivePhysicalTableName(rawColumn);
    const columnName = this.#normalizeName(rawColumn.column_name);

    if (!physicalTableName || !columnName) {
      throw new TypeError(
        `PhysicalColumnResolver: metadata row ${metadataIndex + 1} requires ` +
        "table_name and column_name."
      );
    }

    return {
      physical_table_name: physicalTableName,
      project_id: this.#normalizeName(rawColumn.project_id),
      dataset_id: this.#normalizeName(rawColumn.dataset_id),
      table_name: this.#normalizeName(rawColumn.table_name),
      column_name: columnName,
      field_path: this.#normalizeName(rawColumn.field_path || columnName),
      ordinal_position: rawColumn.ordinal_position ?? null,
      data_type: rawColumn.data_type ?? null,
      is_nullable: rawColumn.is_nullable ?? null
    };
  }

  #derivePhysicalTableName(rawColumn) {
    const tableName = this.#normalizeName(rawColumn.table_name);
    const projectId = this.#normalizeName(rawColumn.project_id);
    const datasetId = this.#normalizeName(rawColumn.dataset_id);

    if (tableName?.includes(".")) {
      return tableName;
    }

    return [projectId, datasetId, tableName].filter(Boolean).join(".");
  }

  /**
   * SQL側が`dataset.table`や`table`だけで記述される可能性を考慮し、
   * 完全名だけでなく末尾2要素・末尾1要素も索引へ登録する。
   */
  #createTableLookupNames(column) {
    const parts = column.physical_table_name.split(".");
    const names = new Set([column.physical_table_name]);

    if (parts.length >= 2) {
      names.add(parts.slice(-2).join("."));
    }

    names.add(parts[parts.length - 1]);
    return [...names];
  }

  #addDiagnostics(result, context) {
    for (const reference of result.column_references) {
      if (reference.physical_resolution_status === "PHYSICAL_METADATA_NOT_FOUND") {
        context.addDiagnostic(
          "WARNING",
          "PHYSICAL_METADATA_NOT_FOUND",
          `Physical metadata was not found for source "${reference.source_name}".`,
          {
            source_id: reference.source_id,
            source_name: reference.source_name,
            column_reference_id: reference.column_reference_id,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq
          }
        );
      }

      if (reference.physical_resolution_status === "PHYSICAL_COLUMN_NOT_FOUND") {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_NOT_FOUND",
          `Column "${reference.column_name}" was not found in the candidate ` +
          "physical table metadata.",
          {
            column_reference_id: reference.column_reference_id,
            column_name: reference.column_name,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq,
            candidate_source_ids: reference.candidate_source_ids
          }
        );
      }

      if (reference.physical_resolution_status === "PHYSICAL_AMBIGUOUS") {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_AMBIGUOUS",
          `Column "${reference.column_name}" exists in multiple physical sources.`,
          {
            column_reference_id: reference.column_reference_id,
            column_name: reference.column_name,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq,
            candidate_source_ids: reference.candidate_source_ids
          }
        );
      }
    }

    for (const entry of this.missingWildcardMetadata.values()) {
      const displayName = entry.resolved_source_name || entry.source_name;

      context.addDiagnostic(
        "WARNING",
        "SOURCE_METADATA_NOT_COLLECTED",
        `Columns for source "${displayName}" are not in the collected ` +
        "metadata, so the wildcard (*) over it could not be expanded. Add its " +
        "project/dataset to the metadata collection (source_project_filters / " +
        "dataset include-exclude filters), then re-run.",
        {
          source_id: entry.source_id,
          source_name: entry.source_name,
          resolved_source_name: entry.resolved_source_name,
          scope_id: entry.scope_id,
          start_token_seq: entry.start_token_seq,
          end_token_seq: entry.end_token_seq
        }
      );
    }

    for (const generatedColumn of result.unpivot_generated_columns || []) {
      if (
        generatedColumn.physical_resolution_status ===
        "PHYSICAL_METADATA_NOT_FOUND"
      ) {
        context.addDiagnostic(
          "WARNING",
          "PHYSICAL_METADATA_NOT_FOUND",
          `Physical metadata was not found for UNPIVOT source ` +
          `"${generatedColumn.source_name}".`,
          {
            source_id: generatedColumn.source_id,
            source_name: generatedColumn.source_name,
            scope_id: generatedColumn.scope_id,
            output_column_name: generatedColumn.output_column_name
          }
        );
      }

      if (
        generatedColumn.physical_resolution_status ===
        "PHYSICAL_COLUMN_NOT_FOUND"
      ) {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_NOT_FOUND",
          `UNPIVOT input column(s) ` +
          `"${generatedColumn.missing_column_names.join(", ")}" were not ` +
          "found in the candidate physical table metadata.",
          {
            source_id: generatedColumn.source_id,
            source_name: generatedColumn.source_name,
            scope_id: generatedColumn.scope_id,
            output_column_name: generatedColumn.output_column_name,
            column_names: generatedColumn.missing_column_names
          }
        );
      }
    }
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("PhysicalColumnResolver.resolve: invalid context.");
    }

    const requiredProperties = [
      "source_resolution",
      "column_resolution",
      "output_column_resolution"
    ];

    for (const propertyName of requiredProperties) {
      if (!context[propertyName]) {
        throw new TypeError(
          `PhysicalColumnResolver.resolve: ${propertyName} is not set.`
        );
      }
    }
  }

  #normalizeName(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return String(value).replace(/^`|`$/g, "").toUpperCase();
  }
}
