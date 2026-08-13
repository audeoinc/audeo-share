/**
 * 物理テーブル・物理カラムを起点として、影響を受ける出力列を逆引きする。
 *
 * LineageResolverが作成する依存関係は、次の向きである。
 *
 *   出力列 -> 物理カラム
 *
 * ImpactResolverは、その結果を逆向きに検索して次を返す。
 *
 *   物理カラム -> 影響を受ける出力列
 *
 * このクラスはSQLやASTを再解析しない。
 * LineageResolverの結果だけを利用し、影響調査に使いやすい形へ変換する。
 */
class ImpactResolver {
  constructor() {
    this.nextImpactId = 1;
  }

  /**
   * 指定した物理オブジェクトの影響範囲を返す。
   *
   * target例:
   *
   * {
   *   physical_table_name: "PROJECT.DATASET.SALES",
   *   physical_column_name: "AMOUNT"
   * }
   *
   * physical_column_nameを省略すると、テーブル全体の影響を検索する。
   * field_pathを指定すると、STRUCT等のネスト列を完全一致で検索する。
   */
  resolve(context, target) {
    this.#validateContext(context);
    const normalizedTarget = this.#normalizeTarget(target);

    this.nextImpactId = 1;

    const affectedOutputs = [];

    for (const lineage of context.lineage_resolution.output_lineages) {
      const matchedDependencies = lineage.dependencies.filter((dependency) => {
        return this.#matchesTarget(dependency, normalizedTarget);
      });

      if (matchedDependencies.length === 0) {
        continue;
      }

      affectedOutputs.push(
        this.#createAffectedOutput(lineage, matchedDependencies, context)
      );
    }

    const rootScopeId = context.source_resolution.root_scope_id;
    const rootAffectedOutputs = affectedOutputs.filter((output) => {
      return output.output_scope_id === rootScopeId;
    });

    const result = {
      node_type: "IMPACT_RESOLUTION",
      target: normalizedTarget,
      root_scope_id: rootScopeId,
      impact_status: affectedOutputs.length > 0 ? "IMPACT_FOUND" : "NO_IMPACT",
      affected_outputs: affectedOutputs,
      root_affected_outputs: rootAffectedOutputs,
      affected_output_count: affectedOutputs.length,
      root_affected_output_count: rootAffectedOutputs.length,
      impact_paths: this.#flattenImpactPaths(rootAffectedOutputs)
    };

    context.setImpactResolution(result);

    if (affectedOutputs.length === 0) {
      context.addDiagnostic(
        "INFO",
        "IMPACT_NOT_FOUND",
        "No output column depends on the specified physical target.",
        { target: normalizedTarget }
      );
    }

    return result;
  }

  /**
   * 影響を受ける出力列を1行の情報へまとめる。
   *
   * lineage_pathはLineageResolverが保持した経路をそのまま利用する。
   * これにより、CTEやサブクエリを経由した場合でも途中経路を失わない。
   */
  #createAffectedOutput(lineage, matchedDependencies, context) {
    const uniquePaths = this.#deduplicatePaths(
      matchedDependencies.map((dependency) => dependency.lineage_path)
    );

    return {
      impact_id: this.nextImpactId++,
      output_column_id: lineage.output_column_id,
      output_scope_id: lineage.output_scope_id,
      output_column_seq: lineage.output_column_seq,
      output_column_name: lineage.output_column_name,
      expression_text: lineage.expression_text,
      is_root_output: lineage.output_scope_id === context.source_resolution.root_scope_id,
      lineage_status: lineage.lineage_status,
      matched_dependency_count: matchedDependencies.length,
      matched_dependencies: matchedDependencies.map((dependency) => {
        return {
          physical_table_name: dependency.physical_table_name,
          physical_column_name: dependency.physical_column_name,
          field_path: dependency.field_path,
          lineage_path: dependency.lineage_path
        };
      }),
      impact_paths: uniquePaths,
      start_token_seq: lineage.start_token_seq,
      end_token_seq: lineage.end_token_seq
    };
  }

  /**
   * ルートQueryの出力列について、保存・テーブル化しやすい平坦な行を作る。
   */
  #flattenImpactPaths(rootAffectedOutputs) {
    const rows = [];

    for (const output of rootAffectedOutputs) {
      for (const dependency of output.matched_dependencies) {
        rows.push({
          output_column_id: output.output_column_id,
          output_column_name: output.output_column_name,
          output_scope_id: output.output_scope_id,
          physical_table_name: dependency.physical_table_name,
          physical_column_name: dependency.physical_column_name,
          field_path: dependency.field_path,
          impact_path: dependency.lineage_path
        });
      }
    }

    return rows;
  }

  /**
   * 指定対象とLineage上の物理依存を比較する。
   *
   * - tableは必須で完全一致
   * - columnを省略した場合は、そのtable配下をすべて対象にする
   * - field_path指定時はfield_pathを完全一致で比較する
   */
  #matchesTarget(dependency, target) {
    if (dependency.dependency_type !== "PHYSICAL_COLUMN") {
      return false;
    }

    if (dependency.physical_table_name !== target.physical_table_name) {
      return false;
    }

    if (target.field_path !== null) {
      return this.#normalizeName(dependency.field_path) === target.field_path;
    }

    if (target.physical_column_name === null) {
      return true;
    }

    return dependency.physical_column_name === target.physical_column_name;
  }

  #deduplicatePaths(paths) {
    const result = [];
    const seen = new Set();

    for (const path of paths) {
      const key = JSON.stringify(path);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(path);
    }

    return result;
  }

  #normalizeTarget(target) {
    if (!target || !target.physical_table_name) {
      throw new TypeError(
        "ImpactResolver.resolve: target.physical_table_name is required."
      );
    }

    return {
      physical_table_name: this.#normalizeName(target.physical_table_name),
      physical_column_name: this.#normalizeName(target.physical_column_name),
      field_path: this.#normalizeName(target.field_path)
    };
  }

  #normalizeName(value) {
    return value === null || value === undefined
      ? null
      : String(value).toUpperCase();
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("ImpactResolver.resolve: invalid ResolutionContext.");
    }

    if (context.lineage_resolution?.node_type !== "LINEAGE_RESOLUTION") {
      throw new TypeError(
        "ImpactResolver.resolve: lineage_resolution must be registered first."
      );
    }
  }
}
