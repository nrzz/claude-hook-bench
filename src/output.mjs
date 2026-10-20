// How Claude Code reads what a hook printed, and what it then does: the stdout parsing rule, the output
// schema with its type rules, and the verdict for the event. Follows the hooks reference ("Exit code output",
// "JSON output", each event's decision control) and what Claude Code 2.1.295 did with 80 outputs put to it
// through its own binary (README "What was verified"): a wrong type anywhere makes the whole output invalid
// (nothing is applied, the action goes ahead as a non-blocking error); unknown top-level keys are fine; a key
// hookSpecificOutput does not know for the event is ignored; another event's name in hookEventName applies nothing.
import { UNIVERSAL, blocksOnExit2, eventByName, plainStdoutIsContext } from "./events.mjs";

/** Parse stdout the way Claude Code does. Returns { kind: "empty" | "text" | "json" | "parse-error", value?, message? }. */
export function parseStdout(stdout) {
  const text = String(stdout ?? "");
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { kind: "text", text };
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "text", text };
    return { kind: "json", value };
  } catch (e) {
    // several lines that each parse on their own: plain text unless one sets an output field
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } });
      if (parsed.every((p) => p !== undefined)) {
        const sets = parsed.some((p) => p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).some((k) => k in UNIVERSAL));
        if (!sets) return { kind: "text", text, note: "several JSON lines, none of which sets an output field: plain text" };
        return { kind: "parse-error", message: "two or more JSON lines, and one of them sets an output field: Claude Code reads the output as one object and cannot" };
      }
    }
    return { kind: "parse-error", message: `starts with { and ends with } but is not valid JSON (${String(e.message).replace(/\s+/g, " ")})` };
  }
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Check a value against a type word. Returns null when fine, else the problem. */
export function checkType(value, type, where) {
  if (type === "any") return null;
  if (type.startsWith("enum:")) {
    const allowed = type.slice(5).split("|");
    return typeof value === "string" && allowed.includes(value) ? null : `${where}: expected one of ${allowed.map((a) => `"${a}"`).join(" | ")}, received ${typeof value === "string" ? JSON.stringify(value) : typeOf(value)}`;
  }
  if (type === "string[]") return Array.isArray(value) && value.every((x) => typeof x === "string") ? null : `${where}: expected an array of strings, received ${typeOf(value)}`;
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value) ? null : `${where}: expected object, received ${typeOf(value)}`;
  if (type === "array") return Array.isArray(value) ? null : `${where}: expected array, received ${typeOf(value)}`;
  return typeOf(value) === type ? null : `${where}: expected ${type}, received ${typeOf(value)}`;
}

/**
 * Validate a parsed JSON output against the schema for `eventName`.
 * Returns { ok, problems: [string], ignored: [string], eventNameMismatch: string|null, fields: {top: {...}, specific: {...}} }
 */
export function validateOutput(value, eventName) {
  const event = eventByName(eventName);
  const problems = [];
  const ignored = [];
  const top = {};
  for (const [key, v] of Object.entries(value)) {
    if (!(key in UNIVERSAL)) continue; // unknown top-level keys are ignored silently (verified)
    const p = checkType(v, UNIVERSAL[key], key);
    if (p) problems.push(p);
    else top[key] = v;
  }
  let specific = {};
  let eventNameMismatch = null;
  const hso = value.hookSpecificOutput;
  if (hso !== undefined && top.hookSpecificOutput) {
    if (typeof hso.hookEventName !== "string") problems.push("hookSpecificOutput.hookEventName: expected string, received " + typeOf(hso.hookEventName));
    else if (hso.hookEventName !== eventName) eventNameMismatch = hso.hookEventName;
    const known = event ? event.fields : {};
    for (const [key, v] of Object.entries(hso)) {
      if (key === "hookEventName") continue;
      if (!(key in known)) { ignored.push(`hookSpecificOutput.${key}`); continue; }
      const p = checkType(v, known[key], `hookSpecificOutput.${key}`);
      if (p) problems.push(p);
      else specific[key] = v;
    }
    if (event && event.decisionObject && specific.decision) {
      for (const [key, v] of Object.entries(specific.decision)) {
        if (!(key in event.decisionObject)) { ignored.push(`hookSpecificOutput.decision.${key}`); continue; }
        const p = checkType(v, event.decisionObject[key], `hookSpecificOutput.decision.${key}`);
        if (p) problems.push(p);
      }
    }
    if (eventNameMismatch) specific = {};
  }
  return { ok: problems.length === 0, problems, ignored, eventNameMismatch, fields: { top, specific } };
}

// terminalSequence: OSC 0/1/2/9/99/777 ended by BEL or ST, and bare BEL; anything else makes Claude Code ignore the field
const OSC = /^(?:\x07|\x1b\](?:0|1|2|9|99|777);[^\x07\x1b]*(?:\x07|\x1b\\))+$/;
export const terminalSequenceOk = (s) => OSC.test(s);

const CAP = 10000;

/**
 * The verdict for one run of a hook on an event, from how it ended and what it printed.
 *   run    { status: "ran" | "timed-out" | "failed-to-start", exitCode, stdout, stderr, ms, timeoutMs, error }
 *   hook   { type, async, onFailure }
 * Returns { outcome, verdict, effects: [string], problems: [string], warnings: [string], parsed, validation }.
 *   outcome   block | allow | ask | defer | continue | stop | context | message | replace | silent | error | ignored | cancelled
 */
export function judge(eventName, hook, run) {
  const event = eventByName(eventName);
  const effects = [];
  const problems = [];
  const warnings = [];
  const parsed = run.status === "ran" ? parseStdout(run.stdout) : { kind: "empty" };
  const validation = parsed.kind === "json" ? validateOutput(parsed.value, eventName) : null;
  const canBlock = event ? blocksOnExit2(event) : false;
  const onFailureBlock = hook.onFailure === "block" && !hook.async && !["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"].includes(eventName);
  const blockedByFailure = (what) => {
    effects.push(`${what}; blocking because onFailure is "block"${eventName === "PermissionRequest" ? " (the request is denied)" : ""}`);
    return { outcome: "block", verdict: "blocks", effects, problems, warnings, parsed, validation };
  };

  if (run.status === "failed-to-start") {
    problems.push(hook.type === "http" ? `HTTP request failed: ${run.error || "unknown error"}` : `the hook could not start: ${run.error || "unknown error"}`);
    if (onFailureBlock) return blockedByFailure(hook.type === "http" ? "connection failure" : "failed to start");
    effects.push(event && canBlock ? "a hook that cannot start is a non-blocking error: the action goes ahead and a hook error notice appears in the transcript" : "a hook that cannot start is a non-blocking error; a notice appears in the transcript");
    return { outcome: "error", verdict: "cannot start", effects, problems, warnings, parsed, validation };
  }
  if (run.status === "timed-out") {
    problems.push(`timed out after ${(run.timeoutMs / 1000).toFixed(run.timeoutMs % 1000 ? 1 : 0)} s: Claude Code cancels it and discards its output`);
    if (eventName === "PreModelSwitch") { effects.push("a PreModelSwitch hook that times out blocks the model switch"); return { outcome: "block", verdict: "blocks (timed out)", effects, problems, warnings, parsed, validation }; }
    if (onFailureBlock) return blockedByFailure("timed out");
    effects.push(canBlock ? "the action goes ahead; a timed-out hook renders no decision" : "the output is discarded");
    return { outcome: "cancelled", verdict: "timed out", effects, problems, warnings, parsed, validation };
  }

  const code = run.exitCode;
  const stderrFirst = String(run.stderr || "").trim().split(/\r?\n/)[0] || "";
  const jsonOk = parsed.kind === "json" && validation.ok;
  if (parsed.kind === "parse-error") problems.push(`stdout ${parsed.message}`);
  if (parsed.kind === "json" && !validation.ok) problems.push(...validation.problems.map((p) => `invalid JSON output, ${p}`));
  if (parsed.kind === "json" && validation.ok && validation.eventNameMismatch) problems.push(`hookSpecificOutput.hookEventName is "${validation.eventNameMismatch}" but the hook runs on ${eventName}: Claude Code applies none of its fields (an "incorrect event name" error, or the fields are dropped as unrecognized)`);
  if (validation && validation.ignored.length) warnings.push(`ignored by Claude Code on ${eventName}: ${validation.ignored.join(", ")}`);
  for (const key of ["permissionDecision", "permissionDecisionReason", "additionalContext", "updatedInput", "retry", "displayContent", "action", "watchPaths", "sessionTitle"]) {
    if (parsed.kind === "json" && key in parsed.value) warnings.push(`${key} at the top level is ignored: it belongs inside hookSpecificOutput`);
  }
  const bigs = [];
  if (jsonOk) for (const [k, v] of [["systemMessage", validation.fields.top.systemMessage], ["additionalContext", validation.fields.specific.additionalContext], ["initialUserMessage", validation.fields.specific.initialUserMessage]]) if (typeof v === "string" && v.length > CAP) bigs.push(k);
  if (parsed.kind === "text" && parsed.text.length > CAP) bigs.push("stdout");
  for (const b of bigs) warnings.push(`${b} is over 10,000 characters: Claude Code saves it to a file and passes the path with a 2,000-character preview`);
  if (hook.async && code === 2) warnings.push("exit code 2 from an async hook blocks nothing; with asyncRewake it wakes Claude");

  if (hook.type === "http") {
    if (code !== 0) {
      problems.push(`HTTP status ${code}: a non-blocking error`);
      if (onFailureBlock) return blockedByFailure(`HTTP status ${code}`);
      effects.push(canBlock ? "the action goes ahead; a hook error notice appears in the transcript" : "a hook error notice appears in the transcript");
      return { outcome: "error", verdict: "non-blocking error", effects, problems, warnings, parsed, validation };
    }
    if (parsed.kind !== "empty" && parsed.kind !== "json") {
      problems.push("HTTP response body is not a JSON object: a non-blocking error");
      effects.push(canBlock ? "the action goes ahead; a hook error notice appears in the transcript" : "a hook error notice appears in the transcript");
      return { outcome: "error", verdict: "non-blocking error", effects, problems, warnings, parsed, validation };
    }
  }

  // exit code 2: a block on the events that block, whatever the JSON says
  if (code === 2 && !hook.async) {
    const reason = jsonOk && blockingReason(eventName, validation.fields) ? blockingReason(eventName, validation.fields) : stderrFirst || "(empty stderr)";
    if (canBlock) {
      effects.push(`${exit2Text(eventName)}; the reason Claude${["UserPromptSubmit", "UserPromptExpansion", "PreCompact", "PreModelSwitch"].includes(eventName) ? " Code shows the user" : " sees"} is ${jsonOk && blockingReason(eventName, validation.fields) ? "the JSON's reason" : "stderr"}: ${JSON.stringify(reason).slice(0, 200)}`);
      if (jsonOk) effects.push("the JSON fields are still read, but they cannot override the block");
      return { outcome: eventName === "Stop" || eventName === "SubagentStop" || eventName === "TeammateIdle" ? "continue" : "block", verdict: ["Stop", "SubagentStop", "TeammateIdle"].includes(eventName) ? "keeps Claude working" : "blocks", effects, problems, warnings, parsed, validation };
    }
    effects.push(`${event ? event.exit2 : "exit code 2 is not a block on this event"}${stderrFirst ? ` (stderr: ${JSON.stringify(stderrFirst).slice(0, 160)})` : ""}`);
    if (!stderrFirst && ["PostToolUse", "PostToolUseFailure"].includes(eventName)) warnings.push("exit code 2 with nothing on stderr shows Claude an empty error");
    if (eventName === "PermissionRequest") warnings.push("exit code 2 is not honored on PermissionRequest: deny through hookSpecificOutput.decision instead");
    const outcome = ["PostToolUse", "PostToolUseFailure"].includes(eventName) ? "message" : "ignored";
    return { outcome, verdict: outcome === "message" ? "shows stderr to Claude" : "exit 2 not honored", effects, problems, warnings, parsed, validation };
  }

  // other non-zero exit codes without valid JSON: a non-blocking error
  if (code !== 0 && !jsonOk) {
    problems.push(`exit code ${code} with ${parsed.kind === "json" ? "invalid JSON" : parsed.kind === "parse-error" ? "unparseable JSON" : "no valid JSON"} on stdout: a non-blocking error${stderrFirst ? ` ("Failed with non-blocking status code: ${stderrFirst.slice(0, 120)}")` : ""}`);
    if (onFailureBlock) return blockedByFailure(`exit code ${code}`);
    effects.push(canBlock ? "the action goes ahead; a hook error notice appears in the transcript" : "a hook error notice appears in the transcript");
    if (code === 1) warnings.push("exit code 1 does not block: a policy hook must exit 2 (or print a JSON decision)");
    return { outcome: "error", verdict: "non-blocking error", effects, problems, warnings, parsed, validation };
  }
  if (code !== 0 && jsonOk) {
    if (onFailureBlock) return blockedByFailure(`exit code ${code}`);
    warnings.push(`exit code ${code} is ignored because the JSON is valid: the fields alone decide (with onFailure "block" this would count as a failure)`);
  }

  // exit 0 (or a non-zero code with valid JSON)
  if (parsed.kind === "parse-error" || (parsed.kind === "json" && !validation.ok)) {
    if (onFailureBlock) return blockedByFailure("invalid output");
    effects.push(canBlock ? "a non-blocking error: nothing is applied, the action goes ahead, and the notice carries the parse or validation message" : "a non-blocking error: nothing is applied");
    return { outcome: "error", verdict: "non-blocking error", effects, problems, warnings, parsed, validation };
  }
  if (parsed.kind === "json" && validation.eventNameMismatch) {
    effects.push("nothing is applied");
    return { outcome: "error", verdict: "non-blocking error", effects, problems, warnings, parsed, validation };
  }
  if (parsed.kind === "text") {
    if (eventName === "WorktreeCreate") {
      const last = parsed.text.trim().split(/\r?\n/).filter((l) => l.trim()).pop();
      effects.push(`Claude Code uses the last non-empty line of stdout as the worktree path: ${JSON.stringify(last)}`);
      return { outcome: "replace", verdict: "returns a path", effects, problems, warnings, parsed, validation };
    }
    if (event && plainStdoutIsContext(event)) {
      effects.push(`plain stdout is added to Claude's context (${parsed.text.length} characters)`);
      if (hook.async) effects.push("(async: delivered on the next turn)");
      return { outcome: "context", verdict: "adds context", effects, problems, warnings, parsed, validation };
    }
    effects.push("plain stdout goes to the debug log only; Claude never sees it");
    if (/^\s*\{/.test(parsed.text) || /\bhookSpecificOutput\b|\bdecision\b/.test(parsed.text)) warnings.push("the text looks like it was meant to be JSON; Claude Code read it as plain text");
    return { outcome: "silent", verdict: "silent", effects, problems, warnings, parsed, validation };
  }
  if (parsed.kind === "empty") {
    if (eventName === "WorktreeCreate") { problems.push("no path on stdout: worktree creation fails"); return { outcome: "error", verdict: "no path", effects, problems, warnings, parsed, validation }; }
    effects.push(canBlock && eventName !== "Stop" && eventName !== "SubagentStop" ? "nothing printed, exit 0: no decision, the normal flow applies" : "nothing printed, exit 0: nothing happens");
    return { outcome: "silent", verdict: "silent", effects, problems, warnings, parsed, validation };
  }

  // valid JSON: apply the fields for this event
  return applyFields(eventName, event, hook, validation.fields, effects, problems, warnings, parsed, validation);
}

const exit2Text = (eventName) => ({
  PreToolUse: "exit code 2 blocks the tool call", UserPromptSubmit: "exit code 2 blocks the prompt, so it never reaches Claude", UserPromptExpansion: "exit code 2 blocks the expansion",
  Stop: "exit code 2 keeps Claude working", SubagentStop: "exit code 2 keeps the subagent working", TeammateIdle: "exit code 2 keeps the teammate working",
  TaskCreated: "exit code 2 rolls back the task", TaskCompleted: "exit code 2 keeps the task open", ConfigChange: "exit code 2 blocks the configuration change (not for policy_settings)",
  PostToolBatch: "exit code 2 stops the loop before the next model call", PreCompact: "exit code 2 blocks the compaction", PreModelSwitch: "exit code 2 blocks the model switch",
  Elicitation: "exit code 2 declines the request", ElicitationResult: "exit code 2 blocks the response", WorktreeCreate: "a non-zero exit code fails the worktree creation", WorktreeRemove: "a non-zero exit code fails the removal if the folder still exists",
}[eventName] || "exit code 2 blocks the action");

/** The reason a blocking JSON decision carries, or null when the JSON does not block. */
function blockingReason(eventName, fields) {
  const { top, specific } = fields;
  if (eventName === "PreToolUse" && specific.permissionDecision === "deny") return specific.permissionDecisionReason || "";
  if (top.decision === "block") return top.reason || "";
  return null;
}

function applyFields(eventName, event, hook, fields, effects, problems, warnings, parsed, validation) {
  const { top, specific } = fields;
  let outcome = "silent";
  let verdict = "silent";
  const set = (o, v) => { if (RANK[o] > RANK[outcome]) { outcome = o; verdict = v; } };
  const discard = (key, what) => warnings.push(`${key} is discarded on ${eventName}${what ? ` (${what})` : ""}`);

  if (hook.async) {
    warnings.push("async hook: decisions have no effect, because the action has already happened by the time it answers; only additionalContext and systemMessage are delivered, on the next turn");
  }

  // the universal fields
  if (top.continue === false) {
    if (event && event.continue && !hook.async) { effects.push(`continue: false ${event.continue}${top.stopReason ? `; stopReason shown to the user: ${JSON.stringify(top.stopReason).slice(0, 160)}` : ""}`); set("stop", "stops Claude"); }
    else if (!hook.async) discard("continue: false", event && event.continue === null ? "no effect on this event" : "");
  }
  if (top.stopReason !== undefined && top.continue !== false) warnings.push("stopReason without continue: false does nothing");
  if (top.suppressOutput !== undefined) warnings.push("suppressOutput has no effect: a successful hook's stdout is never shown in the transcript anyway");
  if (top.systemMessage !== undefined) {
    if (event && event.systemMessage) { effects.push(`systemMessage: ${event.systemMessage}${hook.async ? " (async: delivered on the next turn, not shown to the user)" : ""}`); set("message", "shows a message"); }
    else discard("systemMessage");
  }
  if (top.terminalSequence !== undefined) {
    if (terminalSequenceOk(top.terminalSequence)) { effects.push("terminalSequence: emitted through Claude Code's own terminal write (interactive sessions only; ignored with -p and in the Agent SDK)"); set("message", "emits a terminal sequence"); }
    else problems.push("terminalSequence has something outside the allowlist (OSC 0, 1, 2, 9, 99, 777 and BEL), so Claude Code ignores the field");
  }
  if (top.reason !== undefined && top.decision !== "block") warnings.push("reason without decision: \"block\" does nothing");

  // top-level decision
  if (top.decision === "block") {
    if (eventName === "PreToolUse") { effects.push(`decision: "block" (deprecated here) denies the tool call${top.reason ? `; Claude sees: ${JSON.stringify(top.reason).slice(0, 160)}` : ""}`); set("block", "denies the tool call"); }
    else if (event && event.decision) {
      effects.push(`decision: "block" ${event.decision}${top.reason ? `; reason: ${JSON.stringify(top.reason).slice(0, 160)}` : ""}`);
      if (["Stop", "SubagentStop"].includes(eventName)) { set("continue", "keeps Claude working"); if (!top.reason) warnings.push("Stop hooks must give a reason with decision: \"block\" (Claude Code blocked without one when checked, but Claude gets no instruction)"); }
      else if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") set("message", "adds the reason for Claude");
      else if (["Elicitation", "ElicitationResult"].includes(eventName)) set("block", "declines");
      else set("block", "blocks");
    } else discard('decision: "block"', "no decision control on this event");
  } else if (top.decision === "approve") {
    if (eventName === "PreToolUse") { effects.push('decision: "approve" (deprecated) allows the tool call without a prompt'); set("allow", "allows"); }
    else discard('decision: "approve"', "only PreToolUse reads it");
  }

  // event-specific fields
  const s = specific;
  if (eventName === "PreToolUse" || eventName === "PreModelSwitch") {
    const d = s.permissionDecision;
    const subject = eventName === "PreToolUse" ? "the tool call" : "the model switch";
    if (d === "deny") { effects.push(`permissionDecision: deny blocks ${subject}${s.permissionDecisionReason ? `; ${eventName === "PreToolUse" ? "Claude sees" : "the user sees"}: ${JSON.stringify(s.permissionDecisionReason).slice(0, 160)}` : ""}`); set("block", "denies"); }
    if (d === "allow") { effects.push(`permissionDecision: allow lets ${subject} through without a prompt${eventName === "PreToolUse" ? " (deny and ask rules still apply; the reason goes to the debug log only)" : ""}`); set("allow", "allows"); }
    if (d === "ask") { effects.push(`permissionDecision: ask makes Claude Code prompt the user${s.permissionDecisionReason ? ` with: ${JSON.stringify(s.permissionDecisionReason).slice(0, 160)}` : ""}${eventName === "PreToolUse" ? " (in a -p run with no one to ask, the call is denied)" : " (only /model in an interactive session can show it; elsewhere a refusal)"}`); set("ask", "asks"); }
    if (d === "defer") { effects.push("permissionDecision: defer pauses the run for a -p integration to resume later (ignored, with a warning, in an interactive session)"); set("defer", "defers"); }
    if (s.updatedInput !== undefined) {
      if (d === "defer") warnings.push("updatedInput is ignored with defer");
      else if (d === "allow" || d === "ask" || d === undefined) { effects.push(`updatedInput replaces the whole tool input${d === undefined ? " (with no permissionDecision the normal permission flow judges the new input)" : ""}`); set("replace", `${verdict === "silent" ? "replaces the input" : verdict}`); }
      else warnings.push("updatedInput does nothing with deny");
    }
    if (s.permissionDecisionReason !== undefined && d === undefined) warnings.push("permissionDecisionReason without permissionDecision does nothing");
  }
  if (eventName === "PermissionRequest" && s.decision) {
    const d = s.decision;
    if (d.behavior === "allow") { effects.push(`decision.behavior: allow grants the permission${d.updatedInput ? " with a replaced input" : ""}${d.updatedPermissions ? ` and applies ${Array.isArray(d.updatedPermissions) ? d.updatedPermissions.length : ""} permission update(s)` : ""} (deny and ask rules still apply)`); set("allow", "allows"); }
    if (d.behavior === "deny") { effects.push(`decision.behavior: deny denies the request${d.message ? `; Claude sees: ${JSON.stringify(d.message).slice(0, 160)}` : ""}${d.interrupt ? "; interrupt stops Claude" : ""}`); set("block", "denies"); }
    if (d.behavior === "deny" && (d.updatedInput || d.updatedPermissions)) warnings.push("updatedInput and updatedPermissions apply only with behavior: allow");
    if (d.behavior === "allow" && (d.message || d.interrupt !== undefined)) warnings.push("message and interrupt apply only with behavior: deny");
  }
  if (s.additionalContext !== undefined) {
    const where = { SessionStart: "at the start of the conversation", SubagentStart: "at the start of the subagent's conversation", UserPromptSubmit: "alongside the prompt", UserPromptExpansion: "alongside the expanded prompt", PreToolUse: "next to the tool result", PostToolUse: "next to the tool result", PostToolUseFailure: "next to the error", PostToolBatch: "before the next model call", Stop: "at the end of the turn, and the conversation continues so Claude can act on it", SubagentStop: "at the end of the subagent's turn, and it continues", PostModelSwitch: "with the next request" }[eventName] || "as a system reminder";
    if (eventName === "PreToolUse" && s.permissionDecision === "defer") warnings.push("additionalContext is ignored with defer");
    else { effects.push(`additionalContext (${String(s.additionalContext).length} characters) reaches Claude ${where}${hook.async ? ", on the next turn" : ""}`); set(["Stop", "SubagentStop"].includes(eventName) ? "continue" : "context", ["Stop", "SubagentStop"].includes(eventName) ? "keeps Claude working (feedback)" : "adds context"); }
  }
  if (s.classifierContext !== undefined) { effects.push("classifierContext goes to the auto mode classifier, not to Claude (synchronous hooks only, 2,000 characters per call)"); set("context", "adds classifier context"); }
  if (s.updatedToolOutput !== undefined) { effects.push("updatedToolOutput replaces the tool result Claude sees (the tool already ran); it must match the tool's own output shape or Claude Code keeps the original"); set("replace", "replaces the result"); }
  if (s.updatedMCPToolOutput !== undefined) { effects.push("updatedMCPToolOutput replaces an MCP tool's result (prefer updatedToolOutput)"); set("replace", "replaces the result"); }
  if (s.retry !== undefined) { effects.push(s.retry ? "retry: true tells the model it may retry the denied call (ignored for no-verdict denials)" : "retry: false leaves the denial as it is"); if (s.retry) set("message", "allows a retry"); }
  if (s.sessionTitle !== undefined) { effects.push(`sessionTitle names the session: ${JSON.stringify(s.sessionTitle).slice(0, 80)}`); set("message", "sets the session title"); }
  if (s.suppressOriginalPrompt !== undefined) { if (top.decision !== "block") warnings.push("suppressOriginalPrompt only matters when the hook blocks the prompt"); else effects.push("suppressOriginalPrompt leaves the prompt text out of the block message"); }
  if (s.initialUserMessage !== undefined) { effects.push("initialUserMessage becomes the first user turn of a -p run"); set("context", "sets the first message"); }
  if (s.watchPaths !== undefined) { effects.push(`watchPaths: ${s.watchPaths.length} path(s) watched for FileChanged events`); set("message", "sets watch paths"); }
  if (s.reloadSkills !== undefined) { effects.push(s.reloadSkills ? "reloadSkills: true re-scans the skill folders after the SessionStart hooks" : "reloadSkills: false changes nothing"); if (s.reloadSkills) set("message", "reloads skills"); }
  if (s.displayContent !== undefined) { effects.push("displayContent replaces the displayed text on screen only (the transcript and Claude keep the original)"); set("replace", "replaces the display"); }
  if (s.action !== undefined) {
    const what = { accept: eventName === "Elicitation" ? "answers the request for the user with `content`; no dialog appears" : "replaces the user's values with `content`", decline: "declines the request", cancel: "cancels the request" }[s.action];
    effects.push(`action: ${s.action} ${what}`);
    set(s.action === "accept" ? "replace" : "block", s.action === "accept" ? "answers" : s.action === "decline" ? "declines" : "cancels");
    if (s.action === "accept" && s.content === undefined) warnings.push("accept without content sends an empty answer");
  } else if (s.content !== undefined) warnings.push("content without action is ignored: return action with it");
  if (s.worktreePath !== undefined) { effects.push(`worktreePath: ${s.worktreePath} (HTTP hooks only; a command hook prints the path)`); set("replace", "returns a path"); }

  if (effects.length === 0) effects.push("valid JSON that sets nothing Claude Code reads on this event: nothing happens");
  if (hook.async && ["block", "allow", "ask", "defer", "stop", "replace"].includes(outcome)) { outcome = "ignored"; verdict = "no effect (async)"; }
  return { outcome, verdict, effects, problems, warnings, parsed, validation };
}

const RANK = { silent: 0, ignored: 0, message: 1, context: 2, replace: 3, continue: 4, allow: 5, defer: 6, ask: 7, stop: 8, block: 9, error: 1, cancelled: 1 };

/** A one-word category for a verdict, for summaries: block, allow, ask, defer, continue, stop, context, message, replace, silent, error, ignored, cancelled. */
export const OUTCOMES = Object.keys(RANK);
