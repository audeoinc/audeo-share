const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-046 — SQL structural fingerprint.
 *
 * fingerprintSqlForBigQuery(sql) returns a canonical string in which STRING and
 * NUMBER literals are replaced with "?", comments are dropped, and remaining
 * tokens (identifiers, keywords, operators) are normalized and space-joined.
 * SQL that differs only in literal values yields the same fingerprint; SQL that
 * differs in structure (columns, tables, joins, clause shape) yields a different
 * one. The 03 pipeline hashes this string (TO_HEX(SHA256(...))) to collapse
 * structurally-identical statement_type='SELECT' jobs to one representative.
 */

const fp = bundle.fingerprintSqlForBigQuery;

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_046: " + message);
  }
}

// 1. Literal-only differences collapse to the same fingerprint.
const a = fp("SELECT id, name FROM `p.d.t` WHERE dt = '2024-01-01' AND n > 100");
const b = fp("SELECT id, name FROM `p.d.t` WHERE dt = '2024-02-15' AND n > 999");
assert(a === b, "literal-only difference must produce the same fingerprint");

// 2. Comments and whitespace are ignored.
const c = fp("SELECT id, name  FROM `p.d.t`\n  WHERE dt = '2024-03-03' -- daily\n  AND n > 1");
assert(a === c, "comments/whitespace must not affect the fingerprint");

// 3. Case differences in identifiers/keywords are normalized.
const d = fp("select ID, NAME from `p.d.t` where DT = '2024-01-01' and N > 5");
assert(a === d, "identifier/keyword case must be normalized");

// 4. Structural differences produce a different fingerprint.
assert(fp("SELECT id FROM `p.d.t` WHERE dt = '2024-01-01'") !== a,
  "fewer columns must change the fingerprint");
assert(fp("SELECT id, name FROM `p.d.u` WHERE dt = '2024-01-01' AND n > 1") !== a,
  "different source table must change the fingerprint");
assert(fp("SELECT id, name FROM `p.d.t` WHERE dt = '2024-01-01' OR n > 1") !== a,
  "AND vs OR must change the fingerprint");

// 5. Typed literals (DATE 'x') collapse via the trailing string literal.
assert(fp("SELECT x FROM t WHERE d = DATE '2024-01-01'")
  === fp("SELECT x FROM t WHERE d = DATE '2025-12-31'"),
  "DATE-typed literals must collapse");

// 6. Different IN-list arity is structural (not a literal-only difference).
assert(fp("SELECT x FROM t WHERE k IN (1, 2, 3)")
  !== fp("SELECT x FROM t WHERE k IN (1, 2, 3, 4)"),
  "different IN-list arity must change the fingerprint");

// 7. Determinism.
assert(fp("SELECT a FROM t") === fp("SELECT a FROM t"), "fingerprint must be deterministic");

// 8. Non-string input throws.
let threw = false;
try { fp(null); } catch (e) { threw = true; }
assert(threw, "non-string input must throw");

console.log(JSON.stringify({
  test: "test_v1_5_0_046",
  status: "PASS",
  issue: "SQL structural fingerprint collapses literal-only differences and separates structural ones"
}));
