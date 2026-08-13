"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const buildOrder = [
  "src/ast/ast_factory.js",
  "src/exporter/bigquery_exporter.js",
  "src/token/token_reader.js",
  "src/parser/clause_parser.js",
  "src/parser/select_parser.js",
  "src/parser/expression_parser.js",
  "src/resolver/column_resolver.js",
  "src/parser/from_parser.js",
  "src/parser/group_by_parser.js",
  "src/parser/having_parser.js",
  "src/resolver/impact_resolver.js",
  "src/lexer/lexer.js",
  "src/parser/limit_parser.js",
  "src/parser/where_parser.js",
  "src/parser/qualify_parser.js",
  "src/parser/order_by_parser.js",
  "src/parser/query_parser.js",
  "src/resolver/source_resolver.js",
  "src/resolver/output_column_resolver.js",
  "src/resolver/physical_column_resolver.js",
  "src/resolver/lineage_resolver.js",
  "src/diagnostics/diagnostic_engine.js",
  "src/resolver/resolution_context.js",
  "src/engine/lineage_engine.js"
];

const output = [
  '"use strict";',
  '',
  '/**',
  ' * AUTO-GENERATED FILE.',
  ' * scripts/build_udf.jsから生成されるため、直接編集しない。',
  ' */',
  ''
];

for (const relativePath of buildOrder) {
  const sourcePath = path.join(rootDir, relativePath);
  const sourceText = fs.readFileSync(sourcePath, "utf8").trimEnd();
  const legacyName = path.basename(relativePath);
  output.push("// ============================================================");
  output.push(`// SOURCE: src/${legacyName}`);
  output.push("// ============================================================");
  output.push(sourceText);
  output.push("");
}

const outputPath = path.join(rootDir, "dist", "lineage_udf_bundle.js");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output.join("\n"), "utf8");
console.log(`Built ${outputPath} from ${buildOrder.length} source files.`);
