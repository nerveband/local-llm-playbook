import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  checkPythonPerfHazards,
  checkSyntaxForFile,
  detectHardcodedSecrets,
  detectPrematureStop,
  extractAgentBrowserSessions,
  findClosestEditLineHint,
  inspectJsonClusterSkew,
  lintFileIssues,
  repairEditArguments,
  repairMacOsTimeoutCommand,
} from "../extensions/local-context-guard.ts";
import { evaluateVerifySpec } from "../extensions/local-goal-gate.ts";
import { parseCriticVerdict, collectCriticBundle } from "../extensions/local-critic.ts";
import {
  isSplashProvider,
  resolveEscalatedThinkingLevel,
  resolveInklingReasoningEffort,
  resolveServerOrigin,
  resolveSplashThinkingBudget,
} from "../extensions/local-omlx-meter.ts";
import { appendLocalTrace } from "../extensions/local-trace.ts";

const REPO_DIR = path.resolve(import.meta.dirname, "..");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("repairEditArguments repairs stringified edits, XML, triple quotes, indent shifts, and quote normalization", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "sample.py");
    fs.writeFileSync(
      file,
      [
        "def compute(items):",
        "    if not items:",
        '        return "empty"',
        "    return len(items)",
        "",
      ].join("\n"),
      "utf-8",
    );

    // 1. Stringified JSON array with snake_case aliases & triple quotes
    const args1 = {
      file_path: "sample.py",
      edits: '[{"old_text": """    return len(items)""", "new_text": """    return sum(items)"""}]',
    };
    assert.equal(repairEditArguments(args1, dir), true);
    assert.ok(Array.isArray(args1.edits));
    assert.equal(args1.edits[0].oldText, "    return len(items)");

    // 2. XML <oldText>/<newText> inside args.edit
    const args2 = {
      path: "sample.py",
      edit: "<oldText>    if not items:</oldText><newText>    if len(items) == 0:</newText>",
    };
    assert.equal(repairEditArguments(args2, dir), true);
    assert.equal(args2.edits[0].oldText, "    if not items:");

    // 3. Cascade 2 uniform indentation shift
    const args3 = {
      path: "sample.py",
      oldText: "if not items:\n    return \"empty\"",
      newText: "if not items:\n    return \"none\"",
    };
    assert.equal(repairEditArguments(args3, dir), true);
    assert.equal(args3.oldText, '    if not items:\n        return "empty"');
    assert.equal(args3.newText, '    if not items:\n        return "none"');

    // 4. Cascade 4 quote normalization
    const args4 = {
      path: "sample.py",
      oldText: "        return 'empty'",
      newText: '        return "zero"',
    };
    assert.equal(repairEditArguments(args4, dir), true);
    assert.equal(args4.oldText, '        return "empty"');

    // 5. Hashline edits without oldText/newText pass through untouched cleanly
    const args5 = {
      path: "sample.py",
      edits: [{ op: "replace", pos: "2#ab", lines: ["    if not items:"] }],
    };
    assert.equal(repairEditArguments(args5, dir), false);
  });
});

test("detectHardcodedSecrets blocks high-confidence secrets and allows normal code", () => {
  assert.equal(detectHardcodedSecrets('const a = "AKIAIOSFODNN7EXAMPLE";'), "AWS Access Key ID");
  assert.equal(detectHardcodedSecrets("-----BEGIN OPENSSH PRIVATE KEY-----"), "PEM Private Key");
  assert.equal(detectHardcodedSecrets("token = 'ghp_1234567890abcdefghijklmnop'"), "GitHub Token");
  assert.equal(detectHardcodedSecrets('const x = process.env.API_KEY || "placeholder";'), null);
});

test("lintFileIssues catches syntax and semantic lint issues (ruff + oxlint)", () => {
  withTempDir((dir) => {
    const pyBad = path.join(dir, "bad.py");
    fs.writeFileSync(pyBad, "def f():\n    return missing_var + 1\n", "utf-8");
    const pyRes = lintFileIssues(pyBad, dir);
    assert.equal(pyRes.syntaxError, null);
    assert.ok(pyRes.lintErrors.length >= 1, "Expected ruff to catch undefined name missing_var");

    const jsBad = path.join(dir, "bad.js");
    fs.writeFileSync(jsBad, "function g() {\n  const x = 1;\n  return y;\n}\n", "utf-8");
    const jsRes = lintFileIssues(jsBad, dir);
    assert.equal(jsRes.syntaxError, null);
    assert.ok(jsRes.lintErrors.length >= 1, "Expected oxlint to catch unused/undefined variable");

    const pySyntax = path.join(dir, "broken.py");
    fs.writeFileSync(pySyntax, "def broken(:\n  pass\n", "utf-8");
    assert.ok(checkSyntaxForFile(pySyntax, dir));
  });
});

test("detectPrematureStop, timeout repair, browser session extraction, and closest line hint", () => {
  assert.equal(
    detectPrematureStop({ stopReason: "stop", toolCallCount: 0, visibleText: "", thinkingChars: 200, hadToolCallsInSession: true }),
    "empty_after_thinking",
  );
  assert.equal(
    detectPrematureStop({ stopReason: "stop", toolCallCount: 0, visibleText: "Let me inspect the CSV schema next:", thinkingChars: 100, hadToolCallsInSession: true }),
    "announced_intent",
  );
  assert.equal(
    repairMacOsTimeoutCommand("timeout 30 python3 run.py && timeout -k 5 10 node app.js", false),
    "python3 run.py && node app.js",
  );
  const sess = extractAgentBrowserSessions('AGENT_BROWSER_SESSION="ui-99" agent-browser open file:///a.html && agent-browser close');
  assert.deepEqual(sess.closed, ["ui-99"]);

  withTempDir((dir) => {
    const f = path.join(dir, "app.py");
    fs.writeFileSync(f, "line1 = 1\ndef target_helper(a, b):\n    return a + b\n", "utf-8");
    const hint = findClosestEditLineHint(f, "def target_helper(a, c):", dir);
    assert.ok(hint && hint.includes("near line 2"));
  });
});

test("local-goal-gate evaluateVerifySpec validates required, JSON, HTML UI, and shell checks", () => {
  withTempDir((dir) => {
    const outJson = path.join(dir, "summary.json");
    const cleanHtml = path.join(dir, "clean.html");
    const brokenHtml = path.join(dir, "broken.html");
    fs.writeFileSync(outJson, JSON.stringify({ ok: true, count: 3 }), "utf-8");
    fs.writeFileSync(
      cleanHtml,
      "<!doctype html><html><head><title>Clean</title></head><body><h1>Review Queue</h1><p>Loaded candidate duplicate pairs ready for inspection.</p><button>Export</button></body></html>",
      "utf-8",
    );
    fs.writeFileSync(
      brokenHtml,
      "<!doctype html><html><head><title>Broken</title></head><body><h1>Broken</h1><script>missingFnCall();</script></body></html>",
      "utf-8",
    );

    const passFailures = evaluateVerifySpec(dir, {
      requiredFiles: ["summary.json", "clean.html"],
      jsonFiles: ["summary.json"],
      htmlFiles: ["clean.html"],
      shellChecks: ["test -s summary.json"],
    });
    assert.deepEqual(passFailures, []);

    const failResults = evaluateVerifySpec(dir, {
      requiredFiles: ["missing.csv"],
      htmlFiles: ["broken.html"],
    });
    assert.equal(failResults.length, 2);
    assert.match(failResults[0], /Missing required file/);
    assert.match(failResults[1], /Browser UI verification failed/);
  });
});

test("local-critic parser, PII-free bundle collection, meter helpers, and trace writer work", () => {
  assert.deepEqual(parseCriticVerdict('<think>checking</think>\n{"pass": true, "defects": []}'), { pass: true, defects: [] });
  assert.deepEqual(parseCriticVerdict('{"pass": false, "defects": ["Missing export handler"]}'), {
    pass: false,
    defects: ["Missing export handler"],
  });
  assert.deepEqual(
    parseCriticVerdict("I'll start by reading the context files.\n<tool_call>\n<function=read_file>\n<parameter=path>PROMPT.md</parameter>"),
    { pass: true, defects: [] },
  );

  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, "DataExport-2026-11-21"));
    fs.writeFileSync(path.join(dir, "DataExport-2026-11-21", "secret.csv"), "Name,Email\nAlice,a@example.com\n");
    fs.writeFileSync(path.join(dir, "tool.py"), "def ok():\n    return 1\n");
    const bundle = collectCriticBundle(dir);
    assert.ok(bundle.includes("tool.py"));
    assert.ok(!bundle.includes("Alice"), "Must never leak CSV data rows into critic bundle");
  });

  assert.equal(isSplashProvider("ornith-splash"), true);
  assert.equal(isSplashProvider("surogate-local"), true);
  assert.equal(isSplashProvider("inkling-local"), false);
  assert.equal(resolveServerOrigin({ provider: "ornith-splash" }), "http://127.0.0.1:18092");
  assert.equal(resolveSplashThinkingBudget("high"), 2048);
  assert.equal(resolveInklingReasoningEffort("low"), "0.25");
  assert.equal(resolveInklingReasoningEffort("medium"), "0.50");
  assert.equal(resolveInklingReasoningEffort("high"), "0.75");
  assert.equal(resolveEscalatedThinkingLevel("low", 1), "medium");
  assert.equal(resolveEscalatedThinkingLevel("high", 2), "high");

  withTempDir((dir) => {
    const traceFile = path.join(dir, "trace.jsonl");
    process.env.PI_LOCAL_TRACE_FILE = traceFile;
    appendLocalTrace("test", "ping", { n: 1 });
    delete process.env.PI_LOCAL_TRACE_FILE;
    const row = JSON.parse(fs.readFileSync(traceFile, "utf-8").trim());
    assert.equal(row.source, "test");
    assert.equal(row.n, 1);
  });
});

test("pi-outline and pi-preflight run fast and never leak CSV rows", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "demo.py"), "class A:\n    def m(self, x):\n        return x\n\ndef top():\n    pass\n");
    fs.writeFileSync(path.join(dir, "accounts.csv"), "Account Number,Full Name,Email\n1001,Test Donor,test@example.org\n");

    const outline = execFileSync(path.join(REPO_DIR, "bin/pi-outline"), [path.join(dir, "demo.py")], { encoding: "utf-8" });
    assert.match(outline, /class A/);
    assert.match(outline, /def top\(\)/);

    const t0 = performance.now();
    const preflight = execFileSync(path.join(REPO_DIR, "bin/pi-preflight"), [dir], { encoding: "utf-8" });
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 1500, `pi-preflight took ${elapsedMs}ms`);
    assert.match(preflight, /accounts\.csv: 1 rows, 3 cols/);
    assert.ok(!preflight.includes("Test Donor"), "pi-preflight must never emit CSV data values");

    const rows = ["Id,Status,Email"];
    for (let i = 0; i < 120; i += 1) {
      rows.push(`${i},${i % 2 === 0 ? "ActiveStatusValue" : "InactiveStatusValue"},user${i}@example.org`);
    }
    fs.writeFileSync(path.join(dir, "many.csv"), rows.join("\n"));
    const manyOut = execFileSync(path.join(REPO_DIR, "bin/pi-preflight"), [dir], { encoding: "utf-8" });
    assert.match(manyOut, /Status \(distinct=2\)/);
    assert.doesNotMatch(manyOut, /Email \(distinct=/);
    assert.ok(!manyOut.includes("ActiveStatusValue"), "pi-preflight must never leak low-cardinality values");
    assert.ok(!manyOut.includes("user0@example.org"), "pi-preflight must never leak emails");
  });
});

test("inspectJsonClusterSkew flags mega-clusters while ignoring healthy cluster sizes", () => {
  withTempDir((dir) => {
    const startMs = Date.now();
    fs.writeFileSync(
      path.join(dir, "healthy.json"),
      JSON.stringify({ groups: [{ members: [1, 2] }, { members: [3, 4, 5] }] }),
    );
    assert.equal(inspectJsonClusterSkew(dir, startMs, false), null);

    fs.writeFileSync(
      path.join(dir, "mid.json"),
      JSON.stringify({ groups: [{ record_count: 55 }, { record_count: 2 }] }),
    );
    assert.equal(inspectJsonClusterSkew(dir, startMs, false), null);
    const slowMid = inspectJsonClusterSkew(dir, startMs, true);
    assert.equal(slowMid?.file, "mid.json");
    assert.equal(slowMid?.maxGroupSize, 55);

    fs.writeFileSync(
      path.join(dir, "skew.json"),
      JSON.stringify({ groups: [{ records: new Array(120).fill(1) }, { records: [2, 3] }] }),
    );
    const bigSkew = inspectJsonClusterSkew(dir, startMs, false);
    assert.equal(bigSkew?.file, "skew.json");
    assert.equal(bigSkew?.maxGroupSize, 120);
    assert.equal(bigSkew?.groupCount, 2);
  });
});

test("checkPythonPerfHazards catches unguarded O(K^2) loops and allows guarded ones", () => {
  const unguarded = [
    "for key, members in blocks.items():",
    "    for i in range(len(members)):",
    "        for j in range(i + 1, len(members)):",
    "            union(members[i], members[j])",
    "for root, items in clusters.items():",
    "    for i in range(len(items)):",
    "        for j in range(i + 1, len(items)):",
    "            pair_score(items[i], items[j])",
  ].join("\n");
  const hits = checkPythonPerfHazards(unguarded);
  assert.equal(hits.length, 2);
  assert.match(hits[0], /unguarded O\(K\^2\) union-find loop over 'members'/);
  assert.match(hits[1], /unguarded O\(K\^2\) pairwise loop over 'items'/);

  const guarded = [
    "for key, members in blocks.items():",
    "    if len(members) > 50:",
    "        continue",
    "    for i in range(len(members)):",
    "        for j in range(i + 1, len(members)):",
    "            pair_score(members[i], members[j])",
    "for root, items in clusters.items():",
    "    items = items[:50]",
    "    for i in range(len(items)):",
    "        for j in range(i + 1, len(items)):",
    "            pair_score(items[i], items[j])",
  ].join("\n");
  assert.deepEqual(checkPythonPerfHazards(guarded), []);
});
