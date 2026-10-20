// How a hook's output is read: the parsing rule, the type rules, and the verdict per event. The tables below
// are the outputs that were put to the real Claude Code 2.1.295 through its own binary on 2026-10-15 (README
// "What was verified"), with what it did; judge() must say the same.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENTS } from "../src/events.mjs";
import { OUTCOMES, checkType, judge, parseStdout, terminalSequenceOk, validateOutput } from "../src/output.mjs";

const J = (o) => JSON.stringify(o);
const ran = (stdout = "", exitCode = 0, stderr = "") => ({ status: "ran", exitCode, stdout, stderr, ms: 5, timeoutMs: 600000 });
const cmd = { type: "command", async: false, onFailure: "continue" };
const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "probe deny" } };

test("parseStdout: the four rules of the reference", () => {
  assert.deepEqual(parseStdout(""), { kind: "empty" });
  assert.deepEqual(parseStdout("  \n"), { kind: "empty" });
  assert.equal(parseStdout("deny").kind, "text");
  assert.equal(parseStdout('{"a":1}').kind, "json");
  assert.deepEqual(parseStdout('{"a":1}').value, { a: 1 });
  assert.equal(parseStdout('\n   {"a":1}\n\n').kind, "json", "whitespace around the object is fine");
  assert.equal(parseStdout('{\n  "a": 1\n}').kind, "json", "pretty-printed over several lines");
  assert.equal(parseStdout('[{"decision":"block"}]').kind, "text", "a JSON array is plain text");
  assert.equal(parseStdout('"quoted"').kind, "text", "a JSON string is plain text");
  assert.equal(parseStdout('{"a":1}\ndone').kind, "text", "does not end with }");
  assert.equal(parseStdout('Shell ready\n{"a":1}').kind, "text", "does not start with {");
  assert.equal(parseStdout('{"a":1,}').kind, "parse-error", "a trailing comma");
  assert.equal(parseStdout('{"a":1}\n{"b":2}').kind, "text", "two JSON lines, neither sets an output field");
  assert.equal(parseStdout(`{"a":1}\n${J(DENY)}`).kind, "parse-error", "two JSON lines, one sets a field");
  assert.equal(parseStdout("{not json}").kind, "parse-error");
});

test("checkType: the type words", () => {
  assert.equal(checkType("x", "string", "f"), null);
  assert.match(checkType(5, "string", "f"), /expected string, received number/);
  assert.equal(checkType(true, "boolean", "f"), null);
  assert.match(checkType("true", "boolean", "f"), /expected boolean, received string/);
  assert.equal(checkType({}, "object", "f"), null);
  assert.match(checkType([], "object", "f"), /received array/);
  assert.match(checkType(null, "object", "f"), /received null/);
  assert.equal(checkType(["a"], "string[]", "f"), null);
  assert.match(checkType(["a", 1], "string[]", "f"), /array of strings/);
  assert.equal(checkType("deny", "enum:allow|deny", "f"), null);
  assert.match(checkType("DENY", "enum:allow|deny", "f"), /expected one of "allow" \| "deny", received "DENY"/);
  assert.equal(checkType(anything(), "any", "f"), null);
});
const anything = () => ({ x: [1, "2", null] });

test("validateOutput: wrong types anywhere fail the whole output; unknown keys are ignored", () => {
  assert.equal(validateOutput(DENY, "PreToolUse").ok, true);
  assert.equal(validateOutput({ ...DENY, foo: 1 }, "PreToolUse").ok, true, "unknown top-level keys are fine");
  assert.deepEqual(validateOutput({ ...DENY, systemMessage: 5 }, "PreToolUse").problems, ["systemMessage: expected string, received number"]);
  assert.deepEqual(validateOutput({ reason: 7 }, "Stop").problems, ["reason: expected string, received number"]);
  assert.deepEqual(validateOutput({ continue: "false" }, "Stop").problems, ["continue: expected boolean, received string"]);
  assert.deepEqual(validateOutput({ suppressOutput: "yes" }, "Stop").problems, ["suppressOutput: expected boolean, received string"]);
  assert.deepEqual(validateOutput({ hookSpecificOutput: "deny" }, "PreToolUse").problems, ["hookSpecificOutput: expected object, received string"]);
  assert.deepEqual(validateOutput({ hookSpecificOutput: { permissionDecision: "deny" } }, "PreToolUse").problems, ["hookSpecificOutput.hookEventName: expected string, received undefined"]);
  assert.deepEqual(validateOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "DENY" } }, "PreToolUse").problems, ['hookSpecificOutput.permissionDecision: expected one of "allow" | "deny" | "ask" | "defer", received "DENY"']);
  assert.deepEqual(validateOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecisionReason: 7 } }, "PreToolUse").problems, ["hookSpecificOutput.permissionDecisionReason: expected string, received number"]);
  assert.deepEqual(validateOutput({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: 42 } }, "UserPromptSubmit").problems, ["hookSpecificOutput.additionalContext: expected string, received number"]);
  assert.deepEqual(validateOutput({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "yes" } } }, "PermissionRequest").problems, ['hookSpecificOutput.decision.behavior: expected one of "allow" | "deny", received "yes"']);
  const wrongEvent = validateOutput({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } }, "PreToolUse");
  assert.equal(wrongEvent.ok, true);
  assert.equal(wrongEvent.eventNameMismatch, "PostToolUse");
  assert.deepEqual(wrongEvent.fields.specific, {}, "nothing is applied");
  const ignored = validateOutput({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } }, "PostToolUse");
  assert.equal(ignored.ok, true);
  assert.deepEqual(ignored.ignored, ["hookSpecificOutput.permissionDecision"]);
  assert.deepEqual(validateOutput({ decision: "block", reason: "x" }, "Stop").fields.top, { decision: "block", reason: "x" });
  assert.deepEqual(validateOutput({ decision: "approve" }, "PreToolUse").fields.top, { decision: "approve" });
  assert.deepEqual(validateOutput({ decision: "allow" }, "PreToolUse").problems, ['decision: expected one of "approve" | "block", received "allow"']);
});

// PreToolUse, Bash with an allow rule unless noted; "ran" is whether the tool then ran in the real binary.
const PRE_CASES = [
  ["deny-json", J(DENY), 0, "", "block"],
  ["deny+systemMessage-number", J({ ...DENY, systemMessage: 5 }), 0, "", "error"],
  ["deny+unknown-field", J({ ...DENY, foo: 1 }), 0, "", "block"],
  ["deny-uppercase", J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "DENY" } }), 0, "", "error"],
  ["deny-no-eventname", J({ hookSpecificOutput: { permissionDecision: "deny" } }), 0, "", "error"],
  ["deny-wrong-eventname", J({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } }), 0, "", "error"],
  ["deprecated-block", J({ decision: "block", reason: "probe block" }), 0, "", "block"],
  ["plain-text", "deny", 0, "", "silent"],
  ["exit2-stderr", "", 2, "probe exit 2", "block"],
  ["exit1-stderr", "", 1, "boom", "error"],
  ["exit1+deny-json", J(DENY), 1, "", "block"],
  ["two-json-lines", `{"a":1}\n${J(DENY)}`, 0, "", "error"],
  ["allow-no-rule", J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }), 0, "", "allow"],
  ["ask-with-rule", J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "probe ask" } }), 0, "", "ask"],
  ["allow+updatedInput", J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "echo REPLACED" } } }), 0, "", "allow"],
  ["deprecated-approve", J({ decision: "approve", reason: "probe approve" }), 0, "", "allow"],
  ["hookSpecificOutput-string", J({ hookSpecificOutput: "deny" }), 0, "", "error"],
  ["deny+exit2", J(DENY), 2, "probe exit 2 stderr", "block"],
  ["empty-exit0", "", 0, "", "silent"],
  ["deny-with-whitespace", `\n   ${J(DENY)}\n\n`, 0, "", "block"],
  ["additionalContext-only", J({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "PROBE-CONTEXT" } }), 0, "", "context"],
  ["deny+additionalContext-number", J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", additionalContext: 42 } }), 0, "", "error"],
  ["json-array", J([{ decision: "block" }]), 0, "", "silent"],
  ["reason-only", J({ reason: "x" }), 0, "", "silent"],
  ["deny+continue-true", J({ ...DENY, continue: true }), 0, "", "block"],
  ["permissionDecision-top-level", J({ permissionDecision: "deny", permissionDecisionReason: "probe" }), 0, "", "silent"],
  ["deny-reason-number", J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: 7 } }), 0, "", "error"],
  ["deny-pretty-multiline", JSON.stringify(DENY, null, 2), 0, "", "block"],
  ["deny+trailing-text", `${J(DENY)}\ndone`, 0, "", "silent"],
  ["text+deny-json", `Shell ready\n${J(DENY)}`, 0, "", "silent"],
  ["deny-trailing-comma", '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",}}', 0, "", "error"],
  ["stopReason-only", J({ stopReason: "probe" }), 0, "", "silent"],
  ["deny-suppressOutput-string", J({ ...DENY, suppressOutput: "yes" }), 0, "", "error"],
  ["deny-continue-string", J({ ...DENY, continue: "false" }), 0, "", "error"],
];

test("PreToolUse: judge() agrees with the binary on every output put to it", () => {
  for (const [id, stdout, code, stderr, outcome] of PRE_CASES) {
    const v = judge("PreToolUse", cmd, ran(stdout, code, stderr));
    assert.equal(v.outcome, outcome, `${id}: ${v.verdict}; ${v.effects.join(" / ")} ${v.problems.join(" / ")}`);
  }
});

test("PreToolUse: the special cases around failure, timeouts and async", () => {
  // continue: false on PreToolUse: the binary ran the tool, then stopped
  const c = judge("PreToolUse", cmd, ran(J({ continue: false, stopReason: "probe stop" })));
  assert.equal(c.outcome, "stop");
  assert.match(c.effects[0], /tool call still went ahead/);
  // a timeout lets the call through, unless onFailure is block
  const t = judge("PreToolUse", cmd, { status: "timed-out", exitCode: null, stdout: "", stderr: "", ms: 1000, timeoutMs: 1000 });
  assert.equal(t.outcome, "cancelled");
  assert.match(t.problems[0], /timed out after 1 s/);
  assert.equal(judge("PreToolUse", { ...cmd, onFailure: "block" }, { status: "timed-out", exitCode: null, stdout: "", stderr: "", ms: 1000, timeoutMs: 1000 }).outcome, "block");
  assert.equal(judge("PreToolUse", { ...cmd, onFailure: "block" }, ran("", 1, "boom")).outcome, "block");
  assert.equal(judge("PreToolUse", { ...cmd, onFailure: "block" }, ran("", 127, "not found")).outcome, "block");
  assert.equal(judge("PreToolUse", { ...cmd, onFailure: "block" }, ran(J({ ...DENY, systemMessage: 5 }))).outcome, "block", "invalid output counts as a failure");
  assert.equal(judge("PreToolUse", { ...cmd, onFailure: "block" }, ran(J(DENY), 1)).outcome, "block", "a non-0/2 exit counts as a failure even with an allow");
  const f = judge("PreToolUse", cmd, { status: "failed-to-start", exitCode: null, stdout: "", stderr: "", ms: 0, timeoutMs: 1000, error: "x: not found" });
  assert.equal(f.outcome, "error");
  assert.equal(judge("PreToolUse", { ...cmd, onFailure: "block" }, { status: "failed-to-start", exitCode: null, stdout: "", stderr: "", ms: 0, timeoutMs: 1000, error: "x" }).outcome, "block");
  // async: a deny has no effect
  const a = judge("PreToolUse", { ...cmd, async: true }, ran(J(DENY)));
  assert.equal(a.outcome, "ignored");
  assert.match(a.warnings.join(" "), /async hook: decisions have no effect/);
  // exit 2 from an async hook blocks nothing
  const a2 = judge("PreToolUse", { ...cmd, async: true }, ran("", 2, "stop"));
  assert.notEqual(a2.outcome, "block");
  // messages name the reason Claude sees
  const d = judge("PreToolUse", cmd, ran(J(DENY)));
  assert.match(d.effects[0], /Claude sees: "probe deny"/);
  const e2 = judge("PreToolUse", cmd, ran("", 2, "no rm\nmore"));
  assert.match(e2.effects[0], /stderr: "no rm"/);
  const both = judge("PreToolUse", cmd, ran(J(DENY), 2, "stderr text"));
  assert.match(both.effects[0], /the JSON's reason/);
  const e1 = judge("PreToolUse", cmd, ran("", 1, "boom"));
  assert.match(e1.problems[0], /Failed with non-blocking status code: boom/);
  assert.match(e1.warnings.join(" "), /exit code 1 does not block/);
  const misplaced = judge("PreToolUse", cmd, ran(J({ permissionDecision: "deny" })));
  assert.match(misplaced.warnings.join(" "), /permissionDecision at the top level is ignored/);
  const wrongEvent = judge("PreToolUse", cmd, ran(J({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } })));
  assert.match(wrongEvent.problems[0], /hookEventName is "PostToolUse" but the hook runs on PreToolUse/);
  const text = judge("PreToolUse", cmd, ran("decision: block"));
  assert.match(text.warnings.join(" "), /looks like it was meant to be JSON/);
  const defer = judge("PreToolUse", cmd, ran(J({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer", updatedInput: { a: 1 }, additionalContext: "x" } })));
  assert.equal(defer.outcome, "defer");
  assert.match(defer.warnings.join(" "), /updatedInput is ignored with defer/);
  assert.match(defer.warnings.join(" "), /additionalContext is ignored with defer/);
});

// The other events, as the binary showed them (sync command hooks).
const OTHER_CASES = [
  ["Stop", "stop-block", J({ decision: "block", reason: "keep going" }), 0, "", "continue"],
  ["Stop", "stop-exit2", "", 2, "keep going", "continue"],
  ["Stop", "stop-context", J({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "more" } }), 0, "", "continue"],
  ["Stop", "stop-plain", "PROBE-STOP-PLAIN", 0, "", "silent"],
  ["Stop", "stop-block-no-reason", J({ decision: "block" }), 0, "", "continue"],
  ["Stop", "stop-block-reason-number", J({ decision: "block", reason: 5 }), 0, "", "error"],
  ["Stop", "stop-continue-false", J({ continue: false, stopReason: "x" }), 0, "", "stop"],
  ["Stop", "stop-systemMessage", J({ systemMessage: "hi" }), 0, "", "message"],
  ["UserPromptSubmit", "ups-block", J({ decision: "block", reason: "no" }), 0, "", "block"],
  ["UserPromptSubmit", "ups-exit2", "", 2, "no", "block"],
  ["UserPromptSubmit", "ups-plain", "PROBE-CONTEXT", 0, "", "context"],
  ["UserPromptSubmit", "ups-context", J({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" } }), 0, "", "context"],
  ["UserPromptSubmit", "ups-context-wrong-type", J({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: 42 } }), 0, "", "error"],
  ["UserPromptSubmit", "ups-exit1-plain", "PROBE", 1, "", "error"],
  ["UserPromptSubmit", "ups-wrong-eventname", J({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" } }), 0, "", "error"],
  ["SessionStart", "ss-plain", "Current branch: main", 0, "", "context"],
  ["SessionStart", "ss-context", J({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" } }), 0, "", "context"],
  ["SessionStart", "ss-block", J({ decision: "block", reason: "x" }), 0, "", "silent"],
  ["SessionStart", "ss-exit2", "", 2, "stderr", "ignored"],
  ["SessionStart", "ss-initial-message", J({ hookSpecificOutput: { hookEventName: "SessionStart", initialUserMessage: "first" } }), 0, "", "context"],
  ["PostToolUse", "post-block", J({ decision: "block", reason: "look again" }), 0, "", "message"],
  ["PostToolUse", "post-exit2", "", 2, "warning", "message"],
  ["PostToolUse", "post-context", J({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } }), 0, "", "context"],
  ["PostToolUse", "post-updated-output", J({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: "[redacted]", stderr: "", interrupted: false, isImage: false } } }), 0, "", "replace"],
  ["PostToolUse", "post-plain", "PROBE", 0, "", "silent"],
  ["PostToolUse", "post-permissionDecision", J({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } }), 0, "", "silent"],
  ["PostToolUseFailure", "fail-context", J({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "x" } }), 0, "", "context"],
  ["PostToolUseFailure", "fail-exit2", "", 2, "note", "message"],
  ["PermissionRequest", "perm-allow", J({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }), 0, "", "allow"],
  ["PermissionRequest", "perm-deny", J({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } }), 0, "", "block"],
  ["PermissionRequest", "perm-exit2", "", 2, "no", "ignored"],
  ["PermissionRequest", "perm-allow-updated", J({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "echo x" } } } }), 0, "", "allow"],
  ["PermissionRequest", "perm-behavior-bad", J({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "yes" } } }), 0, "", "error"],
  ["SubagentStop", "substop-block", J({ decision: "block", reason: "go on" }), 0, "", "continue"],
  ["MessageDisplay", "display-replace", J({ hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent: "x" } }), 0, "", "replace"],
];

test("the other events: judge() agrees with the binary", () => {
  for (const [event, id, stdout, code, stderr, outcome] of OTHER_CASES) {
    const v = judge(event, cmd, ran(stdout, code, stderr));
    assert.equal(v.outcome, outcome, `${event} ${id}: ${v.verdict}; ${v.effects.join(" / ")} ${v.problems.join(" / ")}`);
  }
  assert.match(judge("Stop", cmd, ran(J({ decision: "block" }))).warnings.join(" "), /must give a reason/);
  assert.match(judge("SessionStart", cmd, ran(J({ decision: "block", reason: "x" }))).warnings.join(" "), /discarded on SessionStart/);
  assert.match(judge("PostToolUse", cmd, ran(J({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } }))).warnings.join(" "), /ignored by Claude Code on PostToolUse: hookSpecificOutput.permissionDecision/);
  assert.match(judge("PermissionRequest", cmd, ran("", 2, "no")).warnings.join(" "), /not honored on PermissionRequest/);
  assert.match(judge("SessionEnd", cmd, ran(J({ systemMessage: "bye" }))).warnings.join(" "), /systemMessage is discarded on SessionEnd/);
  assert.equal(judge("Notification", cmd, ran(J({ continue: false }))).outcome, "silent");
  assert.match(judge("Notification", cmd, ran(J({ continue: false }))).warnings.join(" "), /continue: false is discarded/);
});

test("the events this bench reads from the reference only: a few verdicts", () => {
  assert.equal(judge("PreCompact", cmd, ran(J({ decision: "block" }))).outcome, "block");
  assert.equal(judge("PreCompact", cmd, ran("", 2, "no")).outcome, "block");
  assert.equal(judge("ConfigChange", cmd, ran(J({ decision: "block", reason: "x" }))).outcome, "block");
  assert.equal(judge("TaskCreated", cmd, ran(J({ decision: "block", reason: "x" }))).outcome, "block");
  assert.equal(judge("TaskCreated", cmd, ran(J({ continue: false }))).outcome, "silent", "TaskCreated ignores continue: false");
  assert.equal(judge("TeammateIdle", cmd, ran(J({ continue: false, stopReason: "x" }))).outcome, "stop");
  assert.equal(judge("TeammateIdle", cmd, ran("", 2, "more")).outcome, "continue");
  assert.equal(judge("PermissionDenied", cmd, ran(J({ hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } }))).outcome, "message");
  assert.equal(judge("PermissionDenied", cmd, ran("", 2, "x")).outcome, "ignored");
  assert.equal(judge("Elicitation", cmd, ran(J({ hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { k: "v" } } }))).outcome, "replace");
  assert.equal(judge("Elicitation", cmd, ran(J({ hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } }))).outcome, "block");
  assert.equal(judge("Elicitation", cmd, ran("", 2, "")).outcome, "block");
  assert.match(judge("Elicitation", cmd, ran(J({ hookSpecificOutput: { hookEventName: "Elicitation", content: { k: "v" } } }))).warnings.join(" "), /content without action is ignored/);
  assert.equal(judge("PreModelSwitch", cmd, ran(J({ hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: "retired" } }))).outcome, "block");
  assert.equal(judge("PreModelSwitch", cmd, { status: "timed-out", exitCode: null, stdout: "", stderr: "", ms: 30000, timeoutMs: 30000 }).outcome, "block", "a PreModelSwitch timeout blocks the switch");
  assert.equal(judge("WorktreeCreate", cmd, ran("checking out\n/tmp/wt\n")).outcome, "replace");
  assert.match(judge("WorktreeCreate", cmd, ran("checking out\n/tmp/wt\n")).effects[0], /"\/tmp\/wt"/);
  assert.equal(judge("WorktreeCreate", cmd, ran("")).outcome, "error");
  assert.equal(judge("WorktreeCreate", cmd, ran("/tmp/wt", 1)).outcome, "error");
  assert.equal(judge("CwdChanged", cmd, ran(J({ hookSpecificOutput: { hookEventName: "CwdChanged", watchPaths: ["/a/.envrc"] } }))).outcome, "message");
  assert.equal(judge("PostModelSwitch", cmd, ran("Delegate to subagents.")).outcome, "context");
  assert.equal(judge("UserPromptExpansion", cmd, ran(J({ decision: "block", reason: "not now" }))).outcome, "block");
  assert.equal(judge("PostToolBatch", cmd, ran(J({ decision: "block", reason: "stop" }))).outcome, "block");
  assert.equal(judge("PostToolBatch", cmd, ran(J({ continue: false }))).outcome, "stop");
  assert.equal(judge("TaskCompleted", cmd, ran("", 2, "tests fail")).outcome, "block", "the task stays open");
});

test("terminalSequence: the allowlist", () => {
  assert.equal(terminalSequenceOk("\x1b]777;notify;Claude;done\x07"), true);
  assert.equal(terminalSequenceOk("\x1b]9;hello\x07"), true);
  assert.equal(terminalSequenceOk("\x1b]2;title\x1b\\"), true);
  assert.equal(terminalSequenceOk("\x07"), true);
  assert.equal(terminalSequenceOk("\x1b]8;;http://x\x07"), false, "OSC 8 hyperlinks are rejected");
  assert.equal(terminalSequenceOk("\x1b[31mred\x1b[0m"), false, "CSI is rejected");
  assert.equal(terminalSequenceOk("plain"), false);
  const ok = judge("Notification", cmd, ran(J({ terminalSequence: "\x1b]777;notify;Claude;done\x07" })));
  assert.equal(ok.outcome, "message");
  const bad = judge("Notification", cmd, ran(J({ terminalSequence: "\x1b[31mred" })));
  assert.match(bad.problems[0], /outside the allowlist/);
});

test("warnings for fields that do nothing where they are, and the 10,000-character cap", () => {
  const v = judge("Stop", cmd, ran(J({ stopReason: "x", reason: "y", suppressOutput: true })));
  assert.match(v.warnings.join(" | "), /stopReason without continue: false/);
  assert.match(v.warnings.join(" | "), /reason without decision/);
  assert.match(v.warnings.join(" | "), /suppressOutput has no effect/);
  const big = judge("UserPromptSubmit", cmd, ran(J({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x".repeat(10001) } })));
  assert.match(big.warnings.join(" "), /over 10,000 characters/);
  const bigText = judge("UserPromptSubmit", cmd, ran("y".repeat(10001)));
  assert.match(bigText.warnings.join(" "), /stdout is over 10,000/);
  const slowEvent = judge("SessionEnd", cmd, ran(""));
  assert.equal(slowEvent.outcome, "silent");
});

test("http hook response judging covers the five response kinds", () => {
  const httpHook = { type: "http", async: false, onFailure: "continue" };
  const httpBlock = { type: "http", async: false, onFailure: "block" };

  // 1. 2xx with empty body
  const empty = judge("PreToolUse", httpHook, ran("", 0));
  assert.equal(empty.outcome, "silent");
  assert.equal(empty.verdict, "silent");
  assert.equal(empty.problems.length, 0);

  // 2. 2xx with JSON object body
  const denyJson = judge("PreToolUse", httpHook, ran(J(DENY), 0));
  assert.equal(denyJson.outcome, "block");
  assert.equal(denyJson.verdict, "denies");

  // 3. 2xx with any other body: non-blocking error (even with onFailure: block)
  const textBody = judge("PreToolUse", httpHook, ran("plain text", 0));
  assert.equal(textBody.outcome, "error");
  assert.equal(textBody.verdict, "non-blocking error");
  assert.match(textBody.problems[0], /not a JSON object/);

  const textBodyBlock = judge("PreToolUse", httpBlock, ran("plain text", 0));
  assert.equal(textBodyBlock.outcome, "error", "2xx with non-JSON body stays a non-blocking error");
  assert.equal(textBodyBlock.verdict, "non-blocking error");

  const invalidJson = judge("PreToolUse", httpHook, ran("{bad json", 0));
  assert.equal(invalidJson.outcome, "error");
  assert.equal(invalidJson.verdict, "non-blocking error");

  // 4. non-2xx status: non-blocking error, turned to block by onFailure: block
  const err500 = judge("PreToolUse", httpHook, ran("internal error", 500));
  assert.equal(err500.outcome, "error");
  assert.equal(err500.verdict, "non-blocking error");
  assert.match(err500.problems[0], /HTTP status 500/);

  const err500Block = judge("PreToolUse", httpBlock, ran("internal error", 500));
  assert.equal(err500Block.outcome, "block");
  assert.equal(err500Block.verdict, "blocks");

  // 5. connection failure: cannot start, turned to block by onFailure: block
  const connErr = judge("PreToolUse", httpHook, { status: "failed-to-start", exitCode: null, stdout: "", stderr: "", ms: 0, timeoutMs: 1000, error: "connect ECONNREFUSED" });
  assert.equal(connErr.outcome, "error");
  assert.equal(connErr.verdict, "cannot start");
  assert.match(connErr.problems[0], /HTTP request failed/);

  const connErrBlock = judge("PreToolUse", httpBlock, { status: "failed-to-start", exitCode: null, stdout: "", stderr: "", ms: 0, timeoutMs: 1000, error: "connect ECONNREFUSED" });
  assert.equal(connErrBlock.outcome, "block");
  assert.equal(connErrBlock.verdict, "blocks");
  assert.match(connErrBlock.effects[0], /connection failure; blocking because onFailure is "block"/);
});

test("every outcome word the reports know is one judge() can produce", () => {
  assert.deepEqual([...OUTCOMES].sort(), ["allow", "ask", "block", "cancelled", "context", "continue", "defer", "error", "ignored", "message", "replace", "silent", "stop"]);
  for (const e of EVENTS) assert.ok(OUTCOMES.includes(judge(e.name, cmd, ran("")).outcome), e.name);
});
