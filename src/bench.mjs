// The three questions as plain objects: what hooks are there (list), what does each do with its event's JSON
// (run), and what is one hook or event about (explain). The reports render these; the CLI parses the flags.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVENTS, TOOL_EVENTS, defaultTimeout, eventByName, matcherMatches } from "./events.mjs";
import { candidateValues, fixtureFor, sessionContext } from "./fixtures.mjs";
import { ifAllows, valuesFor } from "./matcher.mjs";
import { loadHooks, shortPath } from "./settings.mjs";
import { checkHook } from "./check.mjs";
import { runHook, plan as planRun } from "./runner.mjs";
import { runHttpHook } from "./http.mjs";
import { judge } from "./output.mjs";
import { VERSION } from "./version.mjs";

const describeHandler = (raw) => {
  if (!raw || typeof raw !== "object") return String(raw);
  switch (raw.type) {
    case "command": return Array.isArray(raw.args) ? [raw.command, ...raw.args].join(" ") : String(raw.command);
    case "http": return `POST ${raw.url}`;
    case "mcp_tool": return `${raw.server}: ${raw.tool}`;
    case "prompt": return `prompt: ${String(raw.prompt || "").slice(0, 80)}`;
    case "agent": return `agent: ${String(raw.prompt || "").slice(0, 80)}`;
    default: return JSON.stringify(raw).slice(0, 120);
  }
};

/** Pick the hooks a --event filter (Event or Event:value) and a --hook selector keep. */
export function selectHooks(hooks, { event, hook } = {}) {
  let list = hooks;
  if (event) {
    const [name, ...rest] = event.split(":");
    list = list.filter((h) => h.event.toLowerCase() === name.toLowerCase());
    const value = rest.join(":");
    if (value) {
      // Event:value keeps only the hooks that can fire for that value (an exact list naming it, a matching regex, a catch-all)
      list = list.filter((h) => {
        const e = eventByName(h.event);
        if (!e || !e.matcher) return true;
        const m = matcherMatches(h.matcher, value, e);
        return m.match || !!m.error;
      });
    }
  }
  if (hook !== undefined && hook !== null) {
    const needle = String(hook);
    if (/^#?\d+$/.test(needle)) list = list.filter((h) => h.n === Number(needle.replace("#", "")));
    else list = list.filter((h) => describeHandler(h.raw).includes(needle) || (h.plugin && h.plugin === needle));
  }
  return list;
}

/** Common fields of every model: the setup that was read. */
function describeSetup(loaded, io) {
  const disp = (p) => shortPath(p, { home: loaded.home, project: loaded.project });
  return {
    version: VERSION,
    project: loaded.project,
    configDir: loaded.configDir,
    configSource: loaded.configSource,
    platform: io.platform || process.platform,
    files: loaded.files.map((f) => ({ ...f, display: disp(f.path) })),
    plugins: loaded.plugins.map((p) => ({ id: p.id, name: p.name, marketplace: p.marketplace, version: p.version, enabled: p.enabled, hooks: p.hooks, installPath: p.installPath, missing: !!p.missing, inline: !!p.inline })),
    notes: loaded.notes,
    disableAllHooks: loaded.disableAllHooks,
    allowManagedHooksOnly: loaded.allowManagedHooksOnly,
  };
}

function hookModel(h, loaded, io) {
  const event = eventByName(h.event);
  const type = h.raw && typeof h.raw === "object" ? h.raw.type : undefined;
  const findings = checkHook(h, { project: loaded.project, platform: io.platform, env: io.env, cwd: loaded.project, disableAllHooks: loaded.disableAllHooks, allowManagedHooksOnly: loaded.allowManagedHooksOnly });
  const timeout = h.raw && typeof h.raw.timeout === "number" && h.raw.timeout > 0 ? h.raw.timeout : defaultTimeout(event, type);
  return {
    n: h.n, event: h.event, eventKnown: h.eventKnown, matcher: h.matcher === undefined ? null : h.matcher,
    type: type || null, handler: describeHandler(h.raw), raw: h.raw,
    scope: h.scope, source: h.label, file: h.file, display: shortPath(h.file, { home: loaded.home, project: loaded.project }), line: h.line,
    plugin: h.plugin, pluginRoot: h.pluginRoot, pluginData: h.pluginData,
    timeout, timeoutDefault: !(h.raw && typeof h.raw.timeout === "number"), async: !!(h.raw && (h.raw.async === true || h.raw.asyncRewake === true)), if: h.raw && h.raw.if !== undefined ? h.raw.if : null,
    onFailure: h.raw && h.raw.onFailure === "block" ? "block" : "continue",
    duplicateOf: h.duplicateOf ? h.duplicateOf.n : null,
    findings,
  };
}

/** The list model. `io` = { env, home, platform, managed, pluginDirs, plugins, filter: { event, hook } }. */
export function buildList(io = {}) {
  const loaded = loadHooks({ project: io.project, pluginDirs: io.pluginDirs || [], plugins: io.plugins !== false, env: io.env, home: io.home, platform: io.platform, managed: io.managed });
  const all = loaded.hooks.map((h) => hookModel(h, loaded, io));
  const selected = selectHooks(all, io.filter || {});
  const errors = selected.reduce((n, h) => n + h.findings.filter((f) => f.severity === "error").length, 0) + loaded.notes.filter((n) => n.severity === "error").length;
  const warns = selected.reduce((n, h) => n + h.findings.filter((f) => f.severity === "warn").length, 0) + loaded.notes.filter((n) => n.severity === "warn").length;
  return { command: "list", ...describeSetup(loaded, io), hooks: selected, total: all.length, summary: { hooks: selected.length, errors, warns, events: [...new Set(selected.map((h) => h.event))] } };
}

// ---- the session a run pretends to be -------------------------------------------------------------------

function uuid() {
  const b = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Make the throwaway session folder: a transcript in Claude Code's shape, a subagent transcript, an env file. */
export function makeSession({ project, home, dir }) {
  const sessionId = uuid();
  const promptId = uuid();
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), "hook-bench-"));
  const slug = project.replace(/[^a-zA-Z0-9]/g, "-");
  const projDir = path.join(root, "projects", slug);
  fs.mkdirSync(path.join(projDir, sessionId, "subagents"), { recursive: true });
  const now = Date.now();
  const at = (k) => new Date(now - (5 - k) * 60000).toISOString();
  const lines = [
    { type: "user", uuid: uuid(), parentUuid: null, sessionId, cwd: project, timestamp: at(0), isSidechain: false, version: "2.1.295", gitBranch: "main", message: { role: "user", content: "Add a test for the factorial function" } },
    { type: "assistant", uuid: uuid(), parentUuid: null, sessionId, cwd: project, timestamp: at(1), isSidechain: false, version: "2.1.295", requestId: "req_hookbench_1", message: { id: "msg_hookbench_1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "I'll add the test." }, { type: "tool_use", id: "toolu_01HB0001BENCH00000000", name: "Bash", input: { command: "npm test", description: "Run the test suite" } }], usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "user", uuid: uuid(), parentUuid: null, sessionId, cwd: project, timestamp: at(2), isSidechain: false, version: "2.1.295", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01HB0001BENCH00000000", content: "# pass 12\n# fail 0", is_error: false }] } },
    { type: "assistant", uuid: uuid(), parentUuid: null, sessionId, cwd: project, timestamp: at(3), isSidechain: false, version: "2.1.295", requestId: "req_hookbench_2", message: { id: "msg_hookbench_2", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "I've added the test and it passes. Here's a summary of the change." }], usage: { input_tokens: 1400, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  const transcriptPath = path.join(projDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const agentTranscriptPath = path.join(projDir, sessionId, "subagents", "agent-a4d2c8f1e0b3a297.jsonl");
  fs.writeFileSync(agentTranscriptPath, `${JSON.stringify({ type: "user", uuid: uuid(), parentUuid: null, sessionId, cwd: project, timestamp: at(2), isSidechain: true, agentId: "a4d2c8f1e0b3a297", message: { role: "user", content: "Find where hooks are configured in this project and list the files." } })}\n`);
  const envDir = path.join(root, "session-env", sessionId);
  fs.mkdirSync(envDir, { recursive: true });
  return { root, sessionId, promptId, transcriptPath, agentTranscriptPath, envDir, home: home || root };
}

/**
 * Run the bench. `io` adds to buildList's: { input, command, file, timeoutCapMs, allTools, keep, log }.
 * Returns the list model plus session, runs and a summary.
 */
export async function runBench(io = {}) {
  const list = buildList(io);
  const session = makeSession({ project: list.project, home: io.home });
  const permissionMode = "default";
  const ctx = sessionContext({ project: list.project, sessionId: session.sessionId, promptId: session.promptId, transcriptPath: session.transcriptPath, agentTranscriptPath: session.agentTranscriptPath, file: io.file, readFile: io.readFile, command: io.command, permissionMode, home: io.home || list.home });
  const cap = io.timeoutCapMs || 30000;
  const runs = [];
  let n = 0;
  const custom = io.input ? { input: io.input, event: io.input.hook_event_name } : null;
  const filterValue = io.filter && io.filter.event && io.filter.event.includes(":") ? io.filter.event.split(":").slice(1).join(":") : null;
  const hooks = custom ? list.hooks.filter((h) => h.event === custom.event) : list.hooks;

  for (const h of hooks) {
    const event = eventByName(h.event);
    const skip = (reason) => runs.push({ hook: h.n, event: h.event, value: null, label: null, skipped: reason });
    if (!event) { skip("not a hook event, so there is no JSON to send it"); continue; }
    if (h.type !== "command" && !(io.http && h.type === "http")) { skip(`${h.type || "untyped"} hooks are not run by this bench${h.type === "prompt" || h.type === "agent" ? " (they call a model)" : h.type === "http" ? " (it opens no network connection)" : h.type === "mcp_tool" ? " (it needs the MCP server)" : ""}`); continue; }
    if (h.findings.some((f) => /disableAllHooks|allowManagedHooksOnly/.test(f.message))) { skip(h.findings.find((f) => /disableAllHooks|allowManagedHooksOnly/.test(f.message)).message); continue; }
    let fixtures = [];
    if (custom) {
      const field = event.matcher;
      const value = field ? custom.input[field === "file_name" ? "file_path" : field] : null;
      const v = field === "file_name" && value ? path.basename(String(value)) : value;
      const m = event.matcher ? matcherMatches(h.matcher, String(v ?? ""), event) : { match: true };
      if (m.error) { skip(m.error); continue; }
      if (!m.match) { skip(`the matcher ${JSON.stringify(h.matcher)} does not match ${field} ${JSON.stringify(v)}`); continue; }
      fixtures = [{ value: v, label: v === null || v === undefined || !event.matcher ? null : String(v), input: custom.input, verified: "yours", note: null }];
    } else {
      const vf = valuesFor(h, h.event, { allTools: io.allTools });
      if (vf.error) { skip(vf.error); continue; }
      let values = vf.values;
      if (filterValue !== null) {
        const want = filterValue;
        const known = candidateValues(event);
        if (!values.includes(want) && !(TOOL_EVENTS.includes(h.event) && known.includes(want) && vf.kind === "all")) {
          const m = matcherMatches(h.matcher, want, event);
          if (!m.match) { skip(`the matcher ${JSON.stringify(h.matcher)} does not match ${event.matcher || "a value"} ${JSON.stringify(want)}`); continue; }
        }
        values = [want];
      }
      if (!values.length) { skip(vf.note || "no fixture matches this matcher"); continue; }
      fixtures = values.map((v) => fixtureFor(h.event, v, ctx)).filter(Boolean);
      if (vf.note) fixtures.forEach((f) => { f.matcherNote = vf.note; });
    }
    for (const fx of fixtures) {
      const gate = ifAllows(h.if, h.event, fx.input);
      const rec = { hook: h.n, event: h.event, value: fx.value, label: event.matcher ? fx.label : null, verified: fx.verified, note: fx.note, matcherNote: fx.matcherNote || null, input: fx.input };
      if (!gate.runs) { rec.skipped = `"if" keeps the hook from running: ${gate.reason}`; runs.push(rec); continue; }
      if (gate.reason) rec.ifNote = gate.reason;
      const envFile = path.join(session.envDir, `hook-${++n}.sh`);
      if (["SessionStart", "Setup", "CwdChanged", "FileChanged"].includes(h.event)) fs.writeFileSync(envFile, "");
      const hookTimeoutMs = Math.round(h.timeout * 1000);
      const timeoutMs = Math.min(hookTimeoutMs, cap);
      const vars = { CLAUDE_PROJECT_DIR: list.project, CLAUDE_PLUGIN_ROOT: h.pluginRoot || undefined, CLAUDE_PLUGIN_DATA: h.pluginData || undefined };
      if (io.log) io.log(`running #${h.n} ${h.event}${fx.label ? `:${fx.label}` : ""}`);
      const run = h.type === "http"
        ? await runHttpHook(h.raw, { input: fx.input, timeoutMs, env: io.env || process.env })
        : await runHook(h.raw, { input: fx.input, vars, session: { sessionId: session.sessionId, effort: "medium", envFile: fs.existsSync(envFile) ? envFile : null }, cwd: list.project, env: io.env || process.env, timeoutMs });
      const verdict = judge(h.event, { type: h.type, async: h.async, onFailure: h.onFailure }, run);
      if (run.status === "ran" && run.ms > hookTimeoutMs / 2 && hookTimeoutMs <= 60000) verdict.warnings.push(`took ${(run.ms / 1000).toFixed(1)} s of its ${h.timeout} s timeout`);
      if (run.status === "timed-out" && timeoutMs < hookTimeoutMs) verdict.problems[0] = `still running after ${(timeoutMs / 1000).toFixed(0)} s (the bench's cap; the hook's own timeout is ${h.timeout} s, raise the cap with --timeout)`;
      let envWritten = null;
      if (fs.existsSync(envFile)) { const t = fs.readFileSync(envFile, "utf8"); if (t.trim()) envWritten = t; }
      rec.run = h.type === "http"
        ? { status: run.status, exitCode: run.exitCode, statusCode: run.statusCode, ms: run.ms, timeoutMs, hookTimeoutMs, stdout: run.stdout, stderr: run.stderr, error: run.error, command: null, form: null, shell: null, url: h.raw.url, method: "POST" }
        : { status: run.status, exitCode: run.exitCode, ms: run.ms, timeoutMs, hookTimeoutMs, stdout: run.stdout, stderr: run.stderr, error: run.error, command: run.plan ? run.plan.display : null, form: run.plan ? run.plan.form : null, shell: run.plan ? run.plan.shell : null };
      rec.verdict = verdict;
      rec.envFile = envWritten;
      runs.push(rec);
    }
  }
  if (!io.keep) { try { fs.rmSync(session.root, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder */ } }
  const outcomes = {};
  let problems = 0;
  let warnings = 0;
  for (const r of runs) {
    if (!r.verdict) continue;
    outcomes[r.verdict.outcome] = (outcomes[r.verdict.outcome] || 0) + 1;
    problems += r.verdict.problems.length;
    warnings += r.verdict.warnings.length;
  }
  const ran = runs.filter((r) => r.run).length;
  return { ...list, command: "run", session: { sessionId: session.sessionId, folder: io.keep ? session.root : null }, custom: custom ? { event: custom.event } : null, cap, runs, summary: { ...list.summary, runs: ran, skipped: runs.filter((r) => r.skipped).length, outcomes, problems: problems + list.summary.errors, warnings: warnings + list.summary.warns } };
}

/** Explain one event, by name. */
export function explainEvent(name) {
  const event = eventByName(name) || EVENTS.find((e) => e.name.toLowerCase() === String(name).toLowerCase());
  if (!event) return null;
  const sample = fixtureFor(event.name, candidateValues(event)[0], sessionContext({ project: "/home/me/project", sessionId: "4f1a2b3c-0000-4000-8000-000000000001", promptId: "7e2f3a4b-0000-4000-8000-000000000002", transcriptPath: "/home/me/.claude/projects/-home-me-project/4f1a2b3c-0000-4000-8000-000000000001.jsonl", agentTranscriptPath: "/home/me/.claude/projects/-home-me-project/4f1a2b3c-0000-4000-8000-000000000001/subagents/agent-a4d2c8f1e0b3a297.jsonl", home: "/home/me" }));
  return { command: "explain", kind: "event", event, sample: sample ? sample.input : null, values: candidateValues(event) };
}

/** Explain one hook of the setup (by number or a unique substring). Returns null when none or several match. */
export function explainHook(selector, io = {}) {
  const list = buildList(io);
  const matches = selectHooks(list.hooks, { hook: selector });
  if (matches.length !== 1) return { command: "explain", kind: "hook", matches: matches.length, total: list.hooks.length, hooks: list.hooks };
  const h = matches[0];
  const event = eventByName(h.event);
  const ctx = sessionContext({ project: list.project, sessionId: "4f1a2b3c-0000-4000-8000-000000000001", promptId: "7e2f3a4b-0000-4000-8000-000000000002", transcriptPath: path.join(list.configDir, "projects", list.project.replace(/[^a-zA-Z0-9]/g, "-"), "4f1a2b3c-0000-4000-8000-000000000001.jsonl"), agentTranscriptPath: path.join(list.configDir, "projects", list.project.replace(/[^a-zA-Z0-9]/g, "-"), "4f1a2b3c-0000-4000-8000-000000000001", "subagents", "agent-a4d2c8f1e0b3a297.jsonl"), file: io.file, command: io.command, home: list.home });
  const vf = event ? valuesFor(h, h.event) : { values: [], kind: "none" };
  const fixtures = vf.values.map((v) => fixtureFor(h.event, v, ctx)).filter(Boolean);
  const plan = h.type === "command" ? planRun(h.raw, { CLAUDE_PROJECT_DIR: list.project, CLAUDE_PLUGIN_ROOT: h.pluginRoot || undefined, CLAUDE_PLUGIN_DATA: h.pluginData || undefined }, { env: io.env, cwd: list.project }) : null;
  return { command: "explain", kind: "hook", ...describeSetup({ ...list, hooks: [], home: list.home || os.homedir() }, io), hook: h, event, values: vf, fixtures, plan: plan ? { form: plan.form, shell: plan.shell, file: plan.file, resolved: plan.resolved, display: plan.display } : null };
}
