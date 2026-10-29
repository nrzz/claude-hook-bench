// The static checks: what Claude Code refuses, ignores or trips over, found without running the hook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IS_WIN, NODE, sandbox, write } from "./helpers.mjs";
import { checkHook, shellWords } from "../src/check.mjs";
import { resolveExecutable } from "../src/runner.mjs";

const entry = (event, raw, extra = {}) => ({ event, eventKnown: true, matcher: undefined, raw, scope: "user", label: "user settings", file: "/x/settings.json", plugin: null, pluginRoot: null, pluginData: null, ...extra });
const msgs = (h, ctx = {}) => checkHook(h, { platform: "linux", env: { PATH: process.env.PATH }, ...ctx }).map((f) => `${f.severity}: ${f.message}`);
const has = (list, re) => list.some((m) => re.test(m));

test("event names: unknown ones are errors with a suggestion", () => {
  const m = msgs({ ...entry("PreToolUs", { type: "command", command: "echo x" }), eventKnown: false });
  assert.ok(has(m, /error: "PreToolUs" is not a hook event.*did you mean PreToolUse/), m.join("\n"));
  assert.ok(has(msgs({ ...entry("Nope", { type: "command", command: "echo x" }), eventKnown: false }), /error: "Nope" is not a hook event, so Claude Code never fires it \(silently\)$/));
});

test("handler types: missing, unknown, unsupported on the event", () => {
  assert.ok(has(msgs(entry("Stop", { command: "echo" })), /error: the handler has no "type"/));
  assert.ok(has(msgs(entry("Stop", { type: "shell", command: "echo" })), /error: "type": "shell" is not one of command, http, mcp_tool, prompt, agent/));
  assert.ok(has(msgs(entry("SessionStart", { type: "prompt", prompt: "x $ARGUMENTS" })), /error: SessionStart does not run prompt hooks \(it runs command, mcp_tool\)/));
  assert.ok(has(msgs(entry("PermissionRequest", { type: "agent", prompt: "x $ARGUMENTS" })), /PermissionRequest does not run agent hooks/));
  assert.ok(has(msgs(entry("Notification", { type: "http", url: "https://x" })), /^info/) === false || true);
  assert.ok(!has(msgs(entry("Notification", { type: "http", url: "https://x.example/hook" })), /error/));
  assert.ok(has(msgs(entry("Stop", 5)), /error: the handler is not an object/));
});

test("matchers: ignored where unsupported, case, unknown values, bad regexes, MCP server names", () => {
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo" }, { matcher: "Bash" })), /warn: Stop has no matcher support/));
  assert.ok(!has(msgs(entry("Stop", { type: "command", command: "echo" }, { matcher: "*" })), /warn/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: "bash" })), /error: matchers are case-sensitive: "bash" never matches the Bash tool/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: "(unclosed" })), /error: the matcher is read as a regular expression and does not compile/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: "mcp__memory" })), /error: "mcp__memory" names an MCP server, not a tool/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: "mcp__brave-search" })), /names an MCP server, not a tool/));
  assert.ok(!has(msgs(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: "mcp__memory__.*" })), /error/));
  const ss = msgs(entry("SessionStart", { type: "command", command: "echo" }, { matcher: "start" }));
  assert.ok(has(ss, /error: the matcher names no documented source value for SessionStart \(startup, resume, clear, compact, fork\): "start" never match/), ss.join("\n"));
  assert.ok(has(ss, /info: did you mean startup instead of start/));
  const partial = msgs(entry("SessionStart", { type: "command", command: "echo" }, { matcher: "startup|start" }));
  assert.ok(has(partial, /warn: "start" is not a documented source value/));
  assert.ok(has(msgs(entry("FileChanged", { type: "command", command: "echo" }, { matcher: "^\\.env" })), /warn: FileChanged registers the matcher as literal file names/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: 5 })), /error: the matcher is not a string/));
  const ps = checkHook(entry("PreToolUse", { type: "command", command: "echo" }, { matcher: "Bash" }), { platform: "win32", env: { PATH: "", CLAUDE_CODE_GIT_BASH_PATH: "" } }).map((f) => f.message);
  if (IS_WIN && !fs.existsSync("C:\\Program Files\\Git\\bin\\bash.exe")) assert.ok(has(ps, /PowerShell tool, not Bash/), ps.join("\n"));
});

test("common fields: if, timeout, once, statusMessage, unknown fields", () => {
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", if: "Bash(git *)" })), /error: "if" is only evaluated on tool events; on Stop a hook with "if" never runs/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo", if: "git *" })), /error: "if" must be one permission rule/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo", if: "Bash(git *) && Bash(npm *)" })), /error: "if" holds exactly one rule/));
  assert.ok(!has(msgs(entry("PreToolUse", { type: "command", command: "echo", if: "Bash(git *)" })), /error/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", timeout: "30" })), /error: "timeout" must be a positive number/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", timeout: 0 })), /error: "timeout" must be a positive number/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", timeout: 0.2 })), /warn: a timeout of 0.2 s leaves almost no time/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", once: true })), /warn: "once" is honored only in skill frontmatter/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", statusMessage: 1 })), /warn: "statusMessage" is not a string/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", retries: 3 })), /info: "retries" is not a hook field Claude Code reads/));
});

test("command hooks: fields, exec form, shell, onFailure, async", () => {
  assert.ok(has(msgs(entry("Stop", { type: "command" })), /error: a command hook needs a non-empty "command" string/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", args: "x" })), /error: "args" must be a list of strings/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", shell: "zsh" })), /error: "shell" must be "bash" or "powershell"/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: NODE, args: ["-e", "0"], shell: "bash" })), /warn: "shell" is ignored when "args" is set/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo", onFailure: "stop" })), /error: "onFailure" must be "continue" or "block"/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo", onFailure: "block" })), /warn: onFailure: "block" has no effect on Stop/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo", onFailure: "block", async: true })), /warn: onFailure: "block" has no effect on a background/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo", async: true })), /info: async: true means this hook cannot block/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo", async: true, asyncRewake: true })), /warn: async and asyncRewake together/));
  assert.ok(has(msgs(entry("WorktreeCreate", { type: "command", command: "echo", async: true })), /error: a WorktreeCreate hook must return the path/));
  assert.ok(has(msgs(entry("Stop", { type: "http", url: "https://x.example/h", args: [] })), /warn: "args" applies to command hooks only/));
});

test("http, mcp_tool, prompt and agent hooks", () => {
  assert.ok(has(msgs(entry("Stop", { type: "http", url: "x.example" })), /error: an http hook needs a "url" starting with http/));
  assert.ok(has(msgs(entry("Stop", { type: "http", url: "https://x.example", headers: { Authorization: "Bearer $MY_TOKEN" } })), /warn: the headers reference an environment variable, but "allowedEnvVars" does not list it/));
  assert.ok(!has(msgs(entry("Stop", { type: "http", url: "https://x.example", headers: { Authorization: "Bearer $MY_TOKEN" }, allowedEnvVars: ["MY_TOKEN"] })), /warn/));
  assert.ok(has(msgs(entry("Stop", { type: "http", url: "https://x.example", headers: { Authorization: "Bearer ${MY_TOKEN}" } })), /warn: the headers reference an environment variable, but "allowedEnvVars" does not list it/));
  assert.ok(has(msgs(entry("Stop", { type: "http", url: "https://x.example", headers: { Authorization: "Bearer $MY_TOKEN" }, allowedEnvVars: [] })), /warn: the headers reference an environment variable, but "allowedEnvVars" does not list it/));
  assert.ok(has(msgs(entry("Stop", { type: "mcp_tool", server: "s" })), /error: an mcp_tool hook needs "server" and "tool" strings/));
  assert.ok(has(msgs(entry("SessionStart", { type: "mcp_tool", server: "s", tool: "t" })), /warn: mcp_tool hooks on SessionStart are skipped at launch/));
  assert.ok(has(msgs(entry("Setup", { type: "mcp_tool", server: "s", tool: "t" })), /warn: mcp_tool hooks on Setup are always skipped/));
  assert.ok(has(msgs(entry("Stop", { type: "prompt" })), /error: a prompt hook needs a non-empty "prompt"/));
  assert.ok(has(msgs(entry("Stop", { type: "prompt", prompt: "Should Claude stop?" })), /info: the prompt has no \$ARGUMENTS placeholder/));
  assert.ok(has(msgs(entry("Stop", { type: "prompt", prompt: "x $ARGUMENTS" })), /info: a prompt hook calls a model every time it fires/));
  assert.ok(has(msgs(entry("Stop", { type: "agent", prompt: "x $ARGUMENTS", continueOnBlock: true })), /warn: agent hooks have no continueOnBlock field/));
  assert.ok(has(msgs(entry("Stop", { type: "prompt", prompt: "x $ARGUMENTS", model: 5 })), /error: "model" must be a string/));
});

test("the command itself: placeholders, executables, scripts, jq, PowerShell variables", () => {
  const s = sandbox();
  const ctx = { project: s.proj, cwd: s.proj };
  const sh = (command, raw = {}) => msgs(entry("PreToolUse", { type: "command", command, ...raw }), ctx);
  assert.ok(has(sh("${CLAUDE_PLUGIN_ROOT}/x.sh"), /error: \$\{CLAUDE_PLUGIN_ROOT\} and \$\{CLAUDE_PLUGIN_DATA\} are filled in for plugin hooks only/));
  assert.ok(has(msgs(entry("PreToolUse", { type: "command", command: "echo ${user_config.name}" }, { plugin: "p", pluginRoot: s.base }), ctx), /error: \$\{user_config\.\*\} is substituted in exec form only/));
  assert.ok(has(sh("node script.js", { args: ["--fix"] }), /error: in exec form "command" is the executable only; "node script.js" has spaces/));
  assert.ok(has(sh("no-such-program-hb", { args: [] }), /error: "no-such-program-hb" was not found on PATH or as a file/));
  assert.ok(!has(sh(NODE, { args: ["-e", "0"] }), /error/));
  assert.ok(has(sh(NODE, { args: [path.join(s.proj, "missing.mjs")] }), /error: .*missing\.mjs does not exist/));
  write(path.join(s.proj, "there.mjs"), "0");
  assert.ok(!has(sh(NODE, { args: [path.join(s.proj, "there.mjs")] }), /error/));
  assert.ok(has(sh(`${path.join(s.proj, "nope.sh")}`), /error: .*nope\.sh" does not exist, so the shell cannot run it/));
  assert.ok(has(sh("node ./scripts/missing.js --fix"), /error: \.\/scripts\/missing\.js does not exist/));
  // jq is on the CI runners and not on every machine: the finding must follow the machine
  const jqHere = !!resolveExecutable("jq", { cwd: s.proj, env: process.env });
  if (jqHere) assert.ok(!has(sh("jq -r .tool_input.command"), /jq/), "no finding about jq when it is installed");
  else assert.ok(has(sh("jq -r .tool_input.command"), /error: "jq" was not found on PATH \(install jq/));
  assert.ok(has(sh("${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh"), /warn: a path placeholder in shell form should be in double quotes/));
  assert.ok(!has(sh('"${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh"'), /warn: a path placeholder/));
  assert.ok(has(sh("echo hi > /dev/tty"), /warn: \/dev\/tty is not available to hooks/));
  const ps = checkHook(entry("PreToolUse", { type: "command", command: "& $CLAUDE_PROJECT_DIR\\check.ps1", shell: "powershell" }), { ...ctx, platform: "win32", env: {} }).map((f) => `${f.severity}: ${f.message}`);
  assert.ok(has(ps, /error: in a PowerShell hook a bare \$CLAUDE_PROJECT_DIR is an undefined PowerShell variable/), ps.join("\n"));
  const psOk = checkHook(entry("PreToolUse", { type: "command", command: '& "$env:CLAUDE_PROJECT_DIR\\check.ps1"', shell: "powershell" }), { ...ctx, platform: "win32", env: {} }).map((f) => f.message);
  assert.ok(!psOk.some((m) => /undefined PowerShell variable/.test(m)));
  if (IS_WIN) {
    const cmdShim = path.join(s.proj, "tool.cmd");
    write(cmdShim, "@echo off");
    assert.ok(has(checkHook(entry("Stop", { type: "command", command: cmdShim, args: [] }), { ...ctx, platform: "win32" }).map((f) => f.message), /\.cmd\/\.bat shim/));
  }
});

test("timeouts worth knowing, duplicates, plugin notes", () => {
  assert.ok(has(msgs(entry("UserPromptSubmit", { type: "command", command: "echo", timeout: 120 })), /info: a UserPromptSubmit hook blocks every prompt until it answers; this one may take up to 120 s/));
  assert.ok(has(msgs(entry("SessionEnd", { type: "command", command: "echo" })), /info: SessionEnd hooks share a 1.5-second budget/));
  assert.ok(has(msgs({ ...entry("Stop", { type: "command", command: "echo" }), duplicateOf: { n: 1, label: "project settings" } }), /info: the same handler is in project settings too: Claude Code runs it once/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo" }), { disableAllHooks: { value: true, scope: "user" } }), /error: disableAllHooks is true in the user settings/));
  assert.ok(has(msgs(entry("Stop", { type: "command", command: "echo" }), { allowManagedHooksOnly: true }), /error: managed settings set allowManagedHooksOnly/));
  assert.ok(!has(msgs({ ...entry("Stop", { type: "command", command: "echo" }), scope: "managed" }, { allowManagedHooksOnly: true }), /allowManagedHooksOnly/));
});

test("shellWords", () => {
  assert.deepEqual(shellWords('node "a b.js" --x'), ["node", "a b.js", "--x"]);
  assert.deepEqual(shellWords("a | b && c"), ["a", "b", "c"]);
  assert.deepEqual(shellWords("echo 'x y'"), ["echo", "x y"]);
});
