// Static checks of one hook entry: the things Claude Code refuses, ignores or trips over without a word,
// found without running anything. Each finding is { severity: "error" | "warn" | "info", message }.
//   error  the hook will not run, or will not do what it says
//   warn   it runs, but something is off (a field that is ignored, a pitfall the reference names)
//   info   worth knowing, nothing to fix
import { headerEnvVars } from "./http.mjs";
import fs from "node:fs";
import path from "node:path";
import { EVENT_NAMES, TOOL_EVENTS, eventByName, matcherKind, matcherList } from "./events.mjs";
import { candidateValues } from "./fixtures.mjs";
import { parseRule } from "./matcher.mjs";
import { resolveExecutable, findGitBash, substitute } from "./runner.mjs";

const HOOK_FIELDS = new Set(["type", "if", "timeout", "statusMessage", "once", "command", "args", "async", "asyncRewake", "shell", "onFailure", "url", "headers", "allowedEnvVars", "server", "tool", "input", "prompt", "model", "continueOnBlock"]);
const TYPES = ["command", "http", "mcp_tool", "prompt", "agent"];
const IS_WIN = process.platform === "win32";

const closest = (name, list) => {
  let best = null;
  let bestD = 3;
  for (const c of list) {
    const d = lev(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
};
function lev(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * Check one hook entry (from settings.mjs's loadHooks). `ctx` = { project, platform, env, cwd, disableAllHooks, allowManagedHooksOnly }.
 * Returns findings.
 */
export function checkHook(h, ctx = {}) {
  const f = [];
  const platform = ctx.platform || process.platform;
  const env = ctx.env || process.env;
  const raw = h.raw;
  const push = (severity, message) => f.push({ severity, message });

  if (ctx.disableAllHooks && ctx.disableAllHooks.value && h.scope !== "managed") push("error", `disableAllHooks is true in the ${ctx.disableAllHooks.scope} settings, so Claude Code runs no hook from a settings file or plugin`);
  if (ctx.allowManagedHooksOnly && h.scope !== "managed") push("error", "managed settings set allowManagedHooksOnly, so user, project, local and plugin hooks are blocked");

  if (!h.eventKnown) {
    const near = closest(h.event, EVENT_NAMES);
    push("error", `"${h.event}" is not a hook event, so Claude Code never fires it (silently)${near ? `; did you mean ${near}?` : ""}`);
  }
  const event = eventByName(h.event);

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) { push("error", "the handler is not an object"); return f; }
  const type = raw.type;
  if (type === undefined) push("error", 'the handler has no "type" (command, http, mcp_tool, prompt or agent)');
  else if (!TYPES.includes(type)) push("error", `"type": ${JSON.stringify(type)} is not one of ${TYPES.join(", ")}`);
  else if (event && !event.types.includes(type)) push("error", `${h.event} does not run ${type} hooks (it runs ${event.types.join(", ")}): Claude Code skips this one`);

  // matcher
  if (event && !event.matcher && h.matcher !== undefined && h.matcher !== null && h.matcher !== "" && h.matcher !== "*") push("warn", `${h.event} has no matcher support, so the matcher ${JSON.stringify(h.matcher)} is ignored and the hook fires every time`);
  if (event && event.matcher && h.matcher !== undefined && h.matcher !== null) {
    const kind = matcherKind(h.matcher, event);
    if (kind === "invalid") push("error", "the matcher is not a string, so the hook never fires");
    else if (kind === "regex") {
      try { new RegExp(h.matcher); } catch (e) { push("error", `the matcher is read as a regular expression and does not compile (${e.message}), so the hook never fires`); }
      if (h.event === "FileChanged") push("warn", `FileChanged registers the matcher as literal file names: ${JSON.stringify(h.matcher)} watches a file with exactly that name`);
      if (/^mcp__[\w-]+$/.test(h.matcher)) push("error", `${JSON.stringify(h.matcher)} names a server, not a tool, and has only exact-match characters: it matches no tool. Use ${h.matcher}__.*`);
    } else if (kind === "exact") {
      const list = matcherList(h.matcher, event);
      if (Array.isArray(event.values)) {
        const bad = list.filter((v) => !event.values.includes(v));
        if (bad.length === list.length) push("error", `the matcher names no documented ${event.matcher} value for ${h.event} (${event.values.join(", ")}): ${bad.map((b) => JSON.stringify(b)).join(", ")} never match`);
        else if (bad.length) push("warn", `${bad.map((b) => JSON.stringify(b)).join(", ")} ${bad.length === 1 ? "is not a" : "are not"} documented ${event.matcher} value${bad.length === 1 ? "" : "s"} for ${h.event}, so that part of the matcher never matches`);
        for (const v of bad) { const near = closest(v, event.values); if (near && near !== v) push("info", `did you mean ${near} instead of ${v}?`); }
      } else if (TOOL_EVENTS.includes(h.event)) {
        for (const v of list) {
          const near = candidateValues(event).find((t) => t.toLowerCase() === v.toLowerCase());
          if (near && near !== v) push("error", `matchers are case-sensitive: ${JSON.stringify(v)} never matches the ${near} tool`);
          if (v.startsWith("mcp__") && v.split("__").length < 3) push("error", `${JSON.stringify(v)} names an MCP server, not a tool: a tool is mcp__<server>__<tool>; to match every tool of the server write ${v}__.*`);
        }
        if (platform === "win32" && list.includes("Bash") && !list.includes("PowerShell") && !findGitBash(env)) push("warn", "on this Windows machine Claude Code offers the PowerShell tool, not Bash (no Git Bash found), so a matcher for Bash alone never fires here; match Bash|PowerShell");
      }
    }
  }

  // common fields
  if (raw.if !== undefined) {
    if (typeof raw.if !== "string" || !parseRule(raw.if)) push("error", `"if" must be one permission rule such as Bash(git *); got ${JSON.stringify(raw.if)}`);
    else if (event && !TOOL_EVENTS.includes(h.event)) push("error", `"if" is only evaluated on tool events; on ${h.event} a hook with "if" never runs`);
    else if (/&&|\|\|/.test(raw.if)) push("error", '"if" holds exactly one rule: there is no && or || syntax; make a handler per rule');
  }
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) push("error", `"timeout" must be a positive number of seconds; got ${JSON.stringify(raw.timeout)}`);
  if (typeof raw.timeout === "number" && raw.timeout > 0 && raw.timeout < 1 && h.event !== "SessionEnd") push("warn", `a timeout of ${raw.timeout} s leaves almost no time: Claude Code cancels the hook and discards its output`);
  if (raw.statusMessage !== undefined && typeof raw.statusMessage !== "string") push("warn", '"statusMessage" is not a string');
  if (raw.once !== undefined) push("warn", '"once" is honored only in skill frontmatter; in a settings file or a plugin it is ignored');
  if (type === "command") {
    if (typeof raw.command !== "string" || raw.command.trim() === "") push("error", 'a command hook needs a non-empty "command" string');
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))) push("error", '"args" must be a list of strings');
    if (raw.shell !== undefined && !["bash", "powershell"].includes(raw.shell)) push("error", `"shell" must be "bash" or "powershell"; got ${JSON.stringify(raw.shell)}`);
    if (raw.shell !== undefined && Array.isArray(raw.args)) push("warn", '"shell" is ignored when "args" is set (exec form runs no shell)');
    if (raw.onFailure !== undefined && !["continue", "block"].includes(raw.onFailure)) push("error", `"onFailure" must be "continue" or "block"; got ${JSON.stringify(raw.onFailure)}`);
    if (raw.onFailure === "block" && ["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"].includes(h.event)) push("warn", `onFailure: "block" has no effect on ${h.event}`);
    if (raw.onFailure === "block" && (raw.async === true || raw.asyncRewake === true)) push("warn", 'onFailure: "block" has no effect on a background (async) hook');
    if (raw.async === true && ["PreToolUse", "PermissionRequest", "UserPromptSubmit", "Stop", "SubagentStop", "PreCompact", "PreModelSwitch", "ConfigChange", "TaskCreated", "TaskCompleted", "TeammateIdle", "UserPromptExpansion", "PostToolBatch", "Elicitation", "ElicitationResult"].includes(h.event)) push("info", `async: true means this hook cannot block or decide anything on ${h.event}; its additionalContext and systemMessage arrive on the next turn`);
    if (raw.async === true && raw.asyncRewake === true) push("warn", "async and asyncRewake together: asyncRewake alone already runs in the background");
    if (h.event === "WorktreeCreate" && raw.async) push("error", "a WorktreeCreate hook must return the path before it exits; it cannot be async");
  } else {
    for (const k of ["args", "async", "asyncRewake", "shell"]) if (raw[k] !== undefined) push("warn", `"${k}" applies to command hooks only; it is ignored on a ${type} hook`);
  }
  if (type === "http") {
    if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) push("error", 'an http hook needs a "url" starting with http:// or https://');
    if (raw.headers && typeof raw.headers === "object" && Object.values(raw.headers).some(val => headerEnvVars(val).some(name => !Array.isArray(raw.allowedEnvVars) || !raw.allowedEnvVars.includes(name)))) push("warn", 'the headers reference an environment variable, but "allowedEnvVars" does not list it: Claude Code replaces unlisted references with empty strings');
    if (h.event === "WorktreeCreate") push("info", "an HTTP WorktreeCreate hook returns hookSpecificOutput.worktreePath");
  }
  if (type === "mcp_tool") {
    if (typeof raw.server !== "string" || typeof raw.tool !== "string") push("error", 'an mcp_tool hook needs "server" and "tool" strings');
    if (["SessionStart", "Setup"].includes(h.event)) push("warn", `mcp_tool hooks on ${h.event} ${h.event === "Setup" ? "are always skipped" : "are skipped at launch, before MCP servers are available"}`);
  }
  if (type === "prompt" || type === "agent") {
    if (typeof raw.prompt !== "string" || raw.prompt.trim() === "") push("error", `a ${type} hook needs a non-empty "prompt"`);
    else if (!raw.prompt.includes("$ARGUMENTS")) push("info", "the prompt has no $ARGUMENTS placeholder, so the hook input is appended to it");
    if (type === "agent" && raw.continueOnBlock !== undefined) push("warn", "agent hooks have no continueOnBlock field");
    if (type === "prompt" && raw.model !== undefined && typeof raw.model !== "string") push("error", '"model" must be a string');
    push("info", `a ${type} hook calls a model every time it fires: it costs tokens, and this bench does not run it`);
  }
  for (const k of Object.keys(raw)) if (!HOOK_FIELDS.has(k)) push("info", `"${k}" is not a hook field Claude Code reads; it is ignored`);

  // the command itself
  if (type === "command" && typeof raw.command === "string") checkCommand(h, raw, event, ctx, push);
  if (h.duplicateOf) push("info", `the same handler is in ${h.duplicateOf.label} too: Claude Code runs it once`);
  if (h.scope === "plugin" && event && h.event === "SessionStart" && typeof raw.command === "string" && /initialUserMessage|sessionTitle/.test(raw.command)) push("info", "a plugin's SessionStart initialUserMessage or sessionTitle is ignored when the plugin finishes installing after the hooks ran");
  return f;
}

function checkCommand(h, raw, event, ctx, push) {
  const platform = ctx.platform || process.platform;
  const env = ctx.env || process.env;
  const cwd = ctx.cwd || ctx.project || process.cwd();
  const vars = { CLAUDE_PROJECT_DIR: ctx.project || cwd, CLAUDE_PLUGIN_ROOT: h.pluginRoot || undefined, CLAUDE_PLUGIN_DATA: h.pluginData || undefined };
  const cmd = raw.command;
  const exec = Array.isArray(raw.args);
  if (!h.plugin && /\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/.test(cmd + JSON.stringify(raw.args || []))) push("error", "${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA} are filled in for plugin hooks only; in a settings file they stay as written and the path does not exist");
  if (h.plugin && !exec && /\$\{user_config\./.test(cmd)) push("error", "${user_config.*} is substituted in exec form only; a shell-form plugin hook that references it fails instead of running (read $CLAUDE_PLUGIN_OPTION_<KEY> or add \"args\")");
  if (exec) {
    const file = substitute(cmd, vars);
    if (!/[\\/]/.test(file) && /\s/.test(file.trim())) push("error", `in exec form "command" is the executable only; "${cmd}" has spaces, so the spawn fails. Move the rest into "args"`);
    else {
      const found = resolveExecutable(file, { cwd, env });
      if (!found) push("error", `"${file}" was not found on PATH or as a file, so the hook cannot start (a non-blocking error, unless onFailure is "block")`);
      else if (platform === "win32" && /\.(cmd|bat)$/i.test(found)) push("error", `${path.basename(found)} is a .cmd/.bat shim, which exec form cannot spawn on Windows; run the underlying script with node, or drop "args" for shell form`);
    }
    for (const a of raw.args || []) checkScriptPath(substitute(a, vars), cwd, push, h);
    if (/[\\/]/.test(cmd) || !/^[A-Za-z]/.test(cmd)) { /* a path: checked above */ }
  } else {
    const isPs = raw.shell === "powershell" || (platform === "win32" && !findGitBash(env));
    if (isPs && /\$CLAUDE_(PROJECT_DIR|PLUGIN_ROOT|PLUGIN_DATA)\b/.test(cmd) && !/\$\{?env:/.test(cmd)) push("error", "in a PowerShell hook a bare $CLAUDE_PROJECT_DIR is an undefined PowerShell variable (empty); write ${CLAUDE_PROJECT_DIR} or $env:CLAUDE_PROJECT_DIR");
    if (/\$\{CLAUDE_(PROJECT_DIR|PLUGIN_ROOT|PLUGIN_DATA)\}/.test(cmd) && !/"\$\{CLAUDE_(PROJECT_DIR|PLUGIN_ROOT|PLUGIN_DATA)\}[^"]*"/.test(cmd) && !isPs) push("warn", "a path placeholder in shell form should be in double quotes, or a space in the path splits it into two words");
    // the first word, or the script a runner is given
    const expanded = substitute(cmd, vars);
    const words = shellWords(expanded);
    const first = words[0];
    const runners = new Set(["node", "python", "python3", "bash", "sh", "zsh", "pwsh", "powershell", "powershell.exe", "deno", "bun", "ruby", "perl", "npx", "uv", "uvx"]);
    if (first && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) && !["cd", "echo", "exit", "export", "if", "test", "[", "true", "false", "set", "source", "."].includes(first)) {
      const found = resolveExecutable(first, { cwd, env: isPs ? env : env });
      if (!found && (/[\\/]/.test(first) || !isPs)) {
        if (/[\\/]/.test(first)) push("error", `"${first}" does not exist, so the shell cannot run it ("No such file or directory", exit 127: a non-blocking error unless onFailure is "block")`);
        else if (!isPs) push(first === "jq" ? "error" : "warn", `"${first}" was not found on PATH${first === "jq" ? " (install jq, or build the JSON with node or python)" : ""}`);
      }
      if (runners.has(first) && words[1] && !words[1].startsWith("-")) checkScriptPath(words[1], cwd, push, h);
    }
    for (const w of words.slice(1)) if (w === "jq" && !resolveExecutable("jq", { cwd, env })) push("error", "the command uses jq, which is not on PATH: the hook fails where it calls it");
    if (/\bjq\b/.test(expanded) && !resolveExecutable("jq", { cwd, env }) && first !== "jq") push("error", "the command uses jq, which is not on PATH");
    if (/(^|[^>])>\s*\/dev\/tty|\/dev\/tty\b/.test(cmd)) push("warn", "/dev/tty is not available to hooks; return terminalSequence in JSON instead");
  }
  if (event && h.event === "UserPromptSubmit" && typeof raw.timeout === "number" && raw.timeout > 30) push("info", `a UserPromptSubmit hook blocks every prompt until it answers; this one may take up to ${raw.timeout} s`);
  if (event && h.event === "SessionEnd" && (raw.timeout === undefined || raw.timeout <= 1.5)) push("info", "SessionEnd hooks share a 1.5-second budget by default; a longer per-hook timeout raises it, up to 60 s");
}

function checkScriptPath(word, cwd, push, h) {
  const w = word.replace(/^["']|["']$/g, "");
  if (!/[\\/]/.test(w) || /^-/.test(w) || /\$|%/.test(w)) return;
  if (!/\.(sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl|ps1|exe|cmd|bat)$/i.test(w) && !path.isAbsolute(w)) return;
  const file = path.resolve(cwd, w);
  if (!fs.existsSync(file)) push("error", `${w} does not exist${h.plugin ? " in the plugin" : ""}: the hook fails with "No such file or directory" (a non-blocking error unless onFailure is "block")`);
  else if (process.platform !== "win32" && /\.(sh|bash|zsh|py|rb|pl)$/i.test(w) && !/^(node|python3?|bash|sh|zsh|ruby|perl)\s/.test(h.raw.command || "")) {
    try { fs.accessSync(file, fs.constants.X_OK); } catch { push("error", `${w} is not executable (chmod +x), so the shell cannot run it`); }
  }
}

/** Split a shell command into words, honouring quotes, for a best-effort look at what it runs. */
export function shellWords(command) {
  const words = [];
  let cur = "";
  let q = null;
  let has = false;
  for (const ch of String(command)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { words.push(cur); cur = ""; has = false; } continue; }
    if (ch === "|" || ch === ";" || ch === "&") { if (cur || has) { words.push(cur); cur = ""; has = false; } continue; }
    cur += ch;
  }
  if (cur || has) words.push(cur);
  return words;
}
