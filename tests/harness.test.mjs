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
  evaluateFileModifyChurn,
  extractAgentBrowserSessions,
  extractCliCommandFamily,
  findClosestEditLineHint,
  inspectJsonClusterSkew,
  isRootFilesystemFind,
  isTmpScratchScriptWrite,
  isWorkspaceScratchScript,
  lintFileIssues,
  normalizeErrorClass,
  repairEditArguments,
  repairMacOsTimeoutCommand,
  repairMisnamedCliToolCall,
} from "../extensions/local-context-guard.ts";
import { evaluateVerifySpec } from "../extensions/local-goal-gate.ts";
import { parseCriticVerdict, collectCriticBundle, shouldSkipAutoCriticForProvider } from "../extensions/local-critic.ts";
import {
  isSplashProvider,
  resolveAdaptiveSplashThinkingBudget,
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
    fs.writeFileSync(path.join(dir, "tool.py"), `def ok():\n    return 1\n# ${"x".repeat(7000)}\n`);
    fs.writeFileSync(path.join(dir, "app.js"), "console.log('ready');\n");
    fs.writeFileSync(path.join(dir, "view.html"), "<html><body>ok</body></html>\n");
    fs.writeFileSync(path.join(dir, "style.css"), "body { color: #111; }\n");
    const bundle = collectCriticBundle(dir);
    assert.ok(bundle.includes("Workspace inventory"));
    assert.ok(bundle.includes("### tool.py"));
    assert.ok(bundle.includes("### app.js"));
    assert.ok(bundle.includes("### view.html"));
    assert.ok(bundle.includes("### style.css"));
    assert.ok(!bundle.includes("Alice"), "Must never leak CSV data rows into critic bundle");
  });

  assert.equal(isSplashProvider("ornith-splash"), true);
  assert.equal(isSplashProvider("surogate-local"), true);
  assert.equal(isSplashProvider("inkling-local"), false);
  assert.equal(resolveServerOrigin({ provider: "ornith-splash" }), "http://127.0.0.1:18092");
  assert.equal(resolveSplashThinkingBudget("low"), 640);
  assert.equal(resolveSplashThinkingBudget("medium"), 1152);
  assert.equal(resolveSplashThinkingBudget("high"), 2048);
  assert.equal(shouldSkipAutoCriticForProvider("inkling-local"), true);
  assert.equal(shouldSkipAutoCriticForProvider("ornith-splash"), false);
  assert.equal(shouldSkipAutoCriticForProvider("surogate-local"), false);
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

test("repairEditArguments handles missing closing bracket, single-quoted Python lines, double-escaped quotes, and replace_text", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "sample.py");
    fs.writeFileSync(file, "def f():\n    x = 1\n    return x\n", "utf-8");

    // 1. Missing trailing ] + \' inside double-quoted JSON string (real Surogate failure)
    const missingBracket = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": ["        acct = txn.get(r[\'TransactionNumber\'])"]}',
    };
    assert.equal(repairEditArguments(missingBracket, dir), true);
    assert.ok(Array.isArray(missingBracket.edits));
    assert.equal(missingBracket.edits[0].lines[0], "        acct = txn.get(r['TransactionNumber'])");

    // 2. Python single-quoted lines array (real Ornith failure)
    const singleQuoted = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": [\'contact_cluster("Addresses.csv", "Street", "address")\']}]',
    };
    assert.equal(repairEditArguments(singleQuoted, dir), true);
    assert.ok(Array.isArray(singleQuoted.edits));
    assert.equal(singleQuoted.edits[0].lines[0], 'contact_cluster("Addresses.csv", "Street", "address")');

    // 3. Double-escaped inner quotes inside JSON string (real Ornith failure)
    const doubleEscaped = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": ["      if (tab === \\\\"actionable\\\\") return true;"]}]',
    };
    assert.equal(repairEditArguments(doubleEscaped, dir), true);
    assert.ok(Array.isArray(doubleEscaped.edits));
    assert.equal(doubleEscaped.edits[0].lines[0], '      if (tab === "actionable") return true;');

    // 4. Hashline replace_text item indent shift recovery
    const replaceText = {
      path: "sample.py",
      edits: [{ op: "replace_text", old_text: "x = 1\nreturn x", new_text: "x = 2\nreturn x" }],
    };
    assert.equal(repairEditArguments(replaceText, dir), true);
    assert.equal(replaceText.edits[0].oldText, "    x = 1\n    return x");
    assert.equal(replaceText.edits[0].newText, "    x = 2\n    return x");

    // 5. Real ornith-opt-r4 malformed stringified edits: raw inner quotes, missing \ before ", stray ], stray ), invalid \, escape
    const innerQuotes = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": ["      try { localStorage.setItem(GUIDE_KEY, "1"); } catch {}"]}]',
    };
    assert.equal(repairEditArguments(innerQuotes, dir), true);
    assert.equal(innerQuotes.edits[0].lines[0], '      try { localStorage.setItem(GUIDE_KEY, "1"); } catch {}');

    const droppedSlash = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": ["    report_groups.sort(key=lambda g: (-g[\\\\"score\\\\"], g[\\\\"group_id"]))"]}]',
    };
    assert.equal(repairEditArguments(droppedSlash, dir), true);
    assert.equal(droppedSlash.edits[0].lines[0], '    report_groups.sort(key=lambda g: (-g["score"], g["group_id"]))');

    const strayBracketBeforeEnd = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "1#XM", "lines": ["line 1", "line 2"]], "end": "7#VT"}]',
    };
    assert.equal(repairEditArguments(strayBracketBeforeEnd, dir), true);
    assert.equal(strayBracketBeforeEnd.edits[0].end, "7#VT");
    assert.deepEqual(strayBracketBeforeEnd.edits[0].lines, ["line 1", "line 2"]);

    const trailingParen = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": ["heading line\\n", "footer line\\n", "#WX:"]])',
    };
    assert.equal(repairEditArguments(trailingParen, dir), true);
    assert.equal(trailingParen.edits[0].lines.length, 3);

    const invalidCommaEscape = {
      path: "sample.py",
      edits: '[{"op": "replace", "pos": "2#ab", "lines": ["        \\"is_organization\\": r[\\\\"_isorg\\,"]}]',
    };
    assert.equal(repairEditArguments(invalidCommaEscape, dir), true);
    assert.ok(invalidCommaEscape.edits[0].lines[0].includes('"_isorg'));
  });
});

test("isWorkspaceScratchScript and pi-verify-ui zeroSizeSelectors + file input exclusion work cleanly", () => {
  assert.equal(isWorkspaceScratchScript("write", { path: "_explore4.py" }), "_explore4.py");
  assert.equal(isWorkspaceScratchScript("write", { path: "/tmp/_probe_csv.py" }), "_probe_csv.py");
  assert.equal(isWorkspaceScratchScript("write", { path: "analyze_dupes.py" }), null);
  assert.equal(isWorkspaceScratchScript("write", { path: "review_ui.js" }), null);

  withTempDir((dir) => {
    const html = path.join(dir, "ui.html");
    fs.writeFileSync(
      html,
      [
        "<!doctype html><html><head><title>Test UI</title></head><body>",
        "<h1>Duplicate Review Queue</h1>",
        "<p>Loaded groups ready for approval and keyboard shortcuts check.</p>",
        '<input type="file" id="importFile" style="width:0;height:0">',
        '<button id="btnOk">Approve</button>',
        '<button id="zeroBtn" class="tiny-btn" style="width:0;height:0;padding:0;border:0"></button>',
        "</body></html>",
      ].join("\n"),
      "utf-8",
    );
    const raw = execFileSync(path.join(REPO_DIR, "bin/pi-verify-ui"), [html], { encoding: "utf-8" });
    const parsed = JSON.parse(raw.trim().split("\n").pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "chrome-cdp");
    assert.equal(parsed.layoutChecked, true);
    assert.equal(parsed.zeroSizeInteractive, 1);
    assert.deepEqual(parsed.zeroSizeSelectors, ["button#zeroBtn.tiny-btn"]);
  });
});

test("pi-verify-ui --dom (happy-dom) executes local script src, eval-js, and captures errors fast", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        "window.__count = 0;",
        "document.getElementById('incBtn').addEventListener('click', () => {",
        "  window.__count += 1;",
        "  document.getElementById('out').textContent = 'Clicks: ' + window.__count;",
        "});",
      ].join("\n"),
      "utf-8",
    );
    const html = path.join(dir, "dom_ok.html");
    fs.writeFileSync(
      html,
      [
        "<!doctype html><html><head><title>DOM Mode</title></head><body>",
        "<h1>Interactive Queue</h1>",
        "<p id='out'>Loaded virtual DOM review fixture cleanly.</p>",
        "<button id='incBtn'>Increment</button>",
        '<script src="app.js"></script>',
        "</body></html>",
      ].join("\n"),
      "utf-8",
    );

    const t0 = performance.now();
    const rawOk = execFileSync(
      path.join(REPO_DIR, "bin/pi-verify-ui"),
      [
        html,
        "--dom",
        "--eval-js",
        "(() => { document.getElementById('incBtn').click(); return { ok: document.getElementById('out').textContent === 'Clicks: 1', txt: document.getElementById('out').textContent }; })()",
      ],
      { encoding: "utf-8" },
    );
    const elapsedMs = performance.now() - t0;
    const resOk = JSON.parse(rawOk.trim().split("\n").pop());
    assert.equal(resOk.ok, true);
    assert.equal(resOk.mode, "happy-dom");
    assert.equal(resOk.layoutChecked, false);
    assert.equal(resOk.custom?.txt, "Clicks: 1");
    assert.ok(elapsedMs < 2500, `pi-verify-ui --dom took ${elapsedMs}ms`);

    const badHtml = path.join(dir, "dom_bad.html");
    fs.writeFileSync(
      badHtml,
      "<!doctype html><html><head><title>Bad DOM</title></head><body><h1>Broken DOM Fixture</h1><p>This body has enough characters to pass text length checks.</p><script>console.error('ui_fail'); missingDomFn();</script></body></html>",
      "utf-8",
    );
    let failOut = "";
    try {
      execFileSync(path.join(REPO_DIR, "bin/pi-verify-ui"), [badHtml, "--dom"], { encoding: "utf-8" });
      assert.fail("Expected pi-verify-ui --dom to fail on console.error + ReferenceError");
    } catch (err) {
      failOut = String(err.stdout || "");
    }
    const resBad = JSON.parse(failOut.trim().split("\n").pop());
    assert.equal(resBad.ok, false);
    assert.ok(resBad.consoleErrorCount >= 1);
    assert.ok(resBad.pageErrorCount >= 1);
  });
});

test("pi-verify-ui Chrome CDP supports screenshot and eval-js with zero orphan processes", () => {
  withTempDir((dir) => {
    const html = path.join(dir, "cdp.html");
    const shot = path.join(dir, "shot.png");
    fs.writeFileSync(
      html,
      [
        "<!doctype html><html><head><title>CDP Mode</title></head><body>",
        "<h1>CDP Verification</h1>",
        "<p id='status'>Ready for headless Chromium evaluation and screenshot capture.</p>",
        "<button id='btn' onclick=\"document.getElementById('status').textContent='Done'\">Run</button>",
        "</body></html>",
      ].join("\n"),
      "utf-8",
    );

    const raw = execFileSync(
      path.join(REPO_DIR, "bin/pi-verify-ui"),
      [
        html,
        "--eval-js",
        "(() => { document.getElementById('btn').click(); return { ok: document.getElementById('status').textContent === 'Done' }; })()",
        "--screenshot",
        shot,
      ],
      { encoding: "utf-8" },
    );
    const parsed = JSON.parse(raw.trim().split("\n").pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "chrome-cdp");
    assert.equal(parsed.layoutChecked, true);
    assert.equal(parsed.custom?.ok, true);
    assert.ok(fs.existsSync(shot) && fs.statSync(shot).size > 100);
  });
});

test("general harness guardrails: churn breaker, CLI family detector, error class normalizer, and adaptive Splash thinking cap", () => {
  const churnMap = new Map();
  for (let i = 1; i <= 7; i += 1) {
    assert.equal(evaluateFileModifyChurn(churnMap, "./app.py")?.shouldNudge, false);
  }
  assert.equal(evaluateFileModifyChurn(churnMap, "app.py")?.shouldNudge, true);
  assert.equal(evaluateFileModifyChurn(churnMap, "app.py")?.shouldNudge, false);
  for (let i = 10; i <= 11; i += 1) {
    assert.equal(evaluateFileModifyChurn(churnMap, "app.py")?.shouldNudge, false);
  }
  assert.equal(evaluateFileModifyChurn(churnMap, "app.py")?.shouldNudge, true);

  assert.equal(extractCliCommandFamily('AGENT_BROWSER_SESSION="ui" agent-browser eval "1+1"'), "agent-browser");
  assert.equal(extractCliCommandFamily("browser-use open http://localhost"), "browser-use");
  assert.equal(extractCliCommandFamily("TOKEN=x curl -s http://127.0.0.1:8080/health"), "http-cli");
  assert.equal(extractCliCommandFamily("python3 build_report.py"), null);

  const err1 = normalizeErrorClass("edit", "Line 14#AB [E_NO_MATCH] Could not find \"foo_bar\" at line 14");
  const err2 = normalizeErrorClass("edit", "Line 99#ZZ [E_NO_MATCH] Could not find \"baz_qux\" at line 99");
  assert.equal(err1, err2);
  assert.ok(err1 && err1.startsWith("edit:"));

  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("low", 0), { budget: 640, escalated: false, steps: 0 });
  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("low", 2), { budget: 640, escalated: false, steps: 0 });
  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("low", 3), { budget: 1024, escalated: true, steps: 1 });
  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("low", 6), { budget: 1536, escalated: true, steps: 2 });
  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("medium", 3), { budget: 1536, escalated: true, steps: 1 });
  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("high", 3), { budget: 2560, escalated: true, steps: 1 });
  assert.deepEqual(resolveAdaptiveSplashThinkingBudget("off", 5), { budget: undefined, escalated: false, steps: 0 });
});

test("empirical microtest fixes: happy-dom textContent=0, auto-invoke eval function, root find block, /tmp js/py block, pi-verify-ui repair & family", () => {
  assert.equal(extractCliCommandFamily("pi-verify-ui --dom /tmp/app.html"), "pi-verify-ui");

  assert.equal(isTmpScratchScriptWrite("write", { path: "/tmp/test_triage.mjs" }), true);
  assert.equal(isTmpScratchScriptWrite("write", { path: "/private/tmp/_probe.py" }), true);
  assert.equal(isTmpScratchScriptWrite("write", { path: "app.js" }), false);

  assert.equal(isRootFilesystemFind("bash", { command: 'which pi-verify-ui; find / -name "pi-verify-ui*"' }), true);
  assert.equal(isRootFilesystemFind("bash", { command: "find . -name '*.py'" }), false);
  assert.equal(isRootFilesystemFind("bash", { command: "find /tmp -maxdepth 1 -type f" }), false);

  const misnamed = { name: "pi-verify-ui", arguments: { path: "/abs/app.html", dom: true, evalJs: "(() => ({ok:true}))()" } };
  assert.equal(repairMisnamedCliToolCall(misnamed), true);
  assert.equal(misnamed.name, "bash");
  assert.match(misnamed.arguments.command, /^pi-verify-ui '\/abs\/app\.html' --dom --eval-js /);

  withTempDir((dir) => {
    const html = path.join(dir, "zero_badge.html");
    fs.writeFileSync(
      html,
      [
        "<!doctype html><html><head><title>Zero TextContent</title></head><body>",
        "<h1>Triage Queue</h1>",
        "<p>Testing zero numeric textContent assignment in happy-dom.</p>",
        '<span id="badge">init</span>',
        "<script>document.getElementById('badge').textContent = 0;</script>",
        "</body></html>",
      ].join("\n"),
      "utf-8",
    );
    const raw = execFileSync(
      path.join(REPO_DIR, "bin/pi-verify-ui"),
      [
        html,
        "--dom",
        "--eval-js",
        "function() { return { ok: document.getElementById('badge').textContent === '0', val: document.getElementById('badge').textContent }; }",
      ],
      { encoding: "utf-8" },
    );
    const parsed = JSON.parse(raw.trim().split("\n").pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.custom?.val, "0");
  });
});

test("parseCriticVerdict filters inline/embedded JSON false positives while preserving real defects", () => {
  const surogateFp = JSON.stringify({
    pass: false,
    defects: [
      "build_review_html.py embeds the entire duplicates_report.json into review.html via /*@__INLINE__*/ replacement, producing a 172641-byte single file; this violates the no-external-URLs and file://-safe standalone requirements by coupling the builder to a large embedded payload rather than loading data via a local file reference.",
    ],
  });
  assert.deepEqual(parseCriticVerdict(surogateFp), { pass: true, defects: [] });

  const ornithMixed = JSON.stringify({
    pass: false,
    defects: [
      "review.html embeds 1.14 MB of inline JSON directly in HTML instead of loading duplicates_report.json via fetch(), making the file too large.",
      "apply_decisions.py synthesizes decisions deterministically instead of reading decisions.json.",
    ],
  });
  assert.deepEqual(parseCriticVerdict(ornithMixed), {
    pass: false,
    defects: ["apply_decisions.py synthesizes decisions deterministically instead of reading decisions.json."],
  });
});
