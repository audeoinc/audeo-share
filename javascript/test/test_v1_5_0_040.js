const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-040 — nested STRUCT field resolution (e.g. GA4 `geo.region`).
 *
 * `geo.region` was parsed as qualifier=geo / column=region and, finding no
 * source aliased `geo`, left UNRESOLVED_SOURCE — so nested fields never resolved
 * even though COLUMN_FIELD_PATHS metadata (field_path "geo.region") was present.
 * The PhysicalColumnResolver now resolves a qualified reference as a STRUCT field
 * path:
 *   - unqualified struct access (geo.region, device.web_info.browser) matches the
 *     full reference_name against a scope source's field_path metadata;
 *   - alias-qualified access (t.geo.region) strips the source alias and matches
 *     the remaining path exactly (so it no longer also attaches the top-level
 *     struct column as a dependency).
 */

const metadata = {
  analysis_id: "v1_5_0_040",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "myproj.d.t", column_name: "id", field_path: "id" },
  { table_name: "myproj.d.t", column_name: "geo", field_path: "geo" },
  { table_name: "myproj.d.t", column_name: "geo", field_path: "geo.region" },
  { table_name: "myproj.d.t", column_name: "geo", field_path: "geo.country" },
  { table_name: "myproj.d.t", column_name: "device", field_path: "device" },
  { table_name: "myproj.d.t", column_name: "device", field_path: "device.web_info.browser" }
];

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_040: " + message);
  }
}

function deps(result, outputName) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) =>
      String(p.output_column_name).toUpperCase() === outputName && p.physical_table_name)
    .map((p) => String(p.field_path || p.physical_column_name).toUpperCase()))];
}

function noError(name, result) {
  const errors = (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR");
  assert(errors.length === 0 && result.analysis.analysis_status !== "PARTIAL_FAILURE",
    `${name}: expected no error, got ${result.analysis.analysis_status} ` +
    JSON.stringify(errors.map((d) => d.code)));
}

// plain nested access
let r = analyze("SELECT geo.region AS region FROM myproj.d.t");
noError("geo.region", r);
assert(
  deps(r, "REGION").length === 1 && deps(r, "REGION")[0] === "GEO.REGION",
  "geo.region must resolve to exactly GEO.REGION, got " + JSON.stringify(deps(r, "REGION"))
);

// deep nested access (3 levels)
r = analyze("SELECT device.web_info.browser AS b FROM myproj.d.t");
noError("device.web_info.browser", r);
assert(
  deps(r, "B").includes("DEVICE.WEB_INFO.BROWSER"),
  "deep struct must resolve to DEVICE.WEB_INFO.BROWSER, got " + JSON.stringify(deps(r, "B"))
);

// alias-qualified nested access resolves to the exact field only (no top-level geo)
r = analyze("SELECT t.geo.region AS region FROM myproj.d.t AS t");
noError("t.geo.region", r);
assert(
  deps(r, "REGION").length === 1 && deps(r, "REGION")[0] === "GEO.REGION",
  "t.geo.region must resolve to exactly GEO.REGION (not also GEO), got " + JSON.stringify(deps(r, "REGION"))
);

// regression: a plain aliased top-level column still resolves normally
r = analyze("SELECT t.id AS id FROM myproj.d.t AS t");
noError("t.id", r);
assert(
  deps(r, "ID").includes("ID"),
  "t.id must resolve to ID, got " + JSON.stringify(deps(r, "ID"))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_040",
  status: "PASS",
  issue: "Nested STRUCT field resolution (geo.region, device.web_info.browser, t.geo.region) via COLUMN_FIELD_PATHS metadata"
}));
