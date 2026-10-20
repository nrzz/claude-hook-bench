// The command line: parse the arguments, run one command, print, return the exit code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildList, explainEvent, explainHook, runBench } from "./bench.mjs";
import { EVENT_NAMES } from "./events.mjs";
import { markdownRun, palette, renderExplain, renderList, renderRun, toJson } from "./report.mjs";
import { VERSION } from "./version.mjs";

const HELP = `claude-hook-bench ${VERSION}: run every hook of a Claude Code setup with the JSON Claude Code sends, and see what each one would do.

Usage: claude-hook-bench <command> [options]

  run      [--event <Event[:value]>] [--hook <#|text>] [--input <file.json>] [--command <text>] [--file <path>] [--http]
           run each command hook (and http hooks with --http) with its event's JSON and report: did it run, exit code, time, what it printed,
           whether the output is valid for the event, and whether it would block, allow, ask or stay silent
  list     [--event <Event>] [--hook <#|text>]
           every hook from the settings files and enabled plugins, with the problems found without running it
  explain  <#|text|Event>
           one hook: when it fires, how it runs, the exact JSON it gets, and how its answer is read;
           or one event (PreToolUse, Stop ...): its input, its output fields and its exit-code rules

Options:
  --project <dir>       the folder Claude Code starts in (default: the current folder)
  --event <name[:val]>  one event, or one matcher value of it: --event PreToolUse:Bash, --event SessionStart:resume
  --hook <#|text>       one hook, by its number in the list or a unique part of its command
  --input <file.json>   run the hooks of that JSON's hook_event_name with the file as stdin, instead of a fixture
  --command <text>      the shell command in the Bash and PowerShell fixtures (default: npm test)
  --file <path>         the file the Read, Edit and Write fixtures name (default: src/hook-bench-sample.ts, which need not exist)
  --plugin-dir <dir>    also load a plugin folder's hooks, as claude --plugin-dir would (repeatable)
  --no-plugins          leave installed plugins out
  --timeout <seconds>   the most a hook may take in this bench (default 30; the hook's own timeout is reported too)
  --fail-on error|warn  exit 1 when any problem (error) or any problem or warning (warn) was found
  --http                run http hooks too (posts each event's JSON to the hook's url)
  --json                one JSON document on stdout
  --markdown            (run) a short markdown report, for the /hook-bench:check skill
  --verbose             (run) full stdout and stderr of every hook
  --no-color            no colour on a terminal (NO_COLOR does the same)
  -h, --help            this text
  -v, --version         the version

Exit codes: 0, or 1 with --fail-on when the threshold is met, or 2 for a usage error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR.
It reads settings files and plugin folders, runs your command hooks (they really run, with a fake session's JSON) in a
throwaway session folder, writes nothing else, and never uses the network unless --http is given. http (without --http),
mcp_tool, prompt and agent hooks are
listed and checked but not run.
`;

class UsageError extends Error {}

const COMMANDS = new Set(["run", "list", "explain"]);
const FLAGS_WITH_VALUE = new Set(["--project", "--event", "--hook", "--input", "--command", "--file", "--plugin-dir", "--timeout", "--fail-on"]);
const FLAGS = new Set([...FLAGS_WITH_VALUE, "--no-plugins", "--http", "--json", "--markdown", "--verbose", "--no-color", "--keep", "--all-tools", "-h", "--help", "-v", "--version"]);

/** Parse argv into options. */
export function parseArgs(argv) {
  const o = { command: null, positional: [], project: null, event: null, hook: null, input: null, commandText: null, file: null, pluginDirs: [], plugins: true, timeout: 30, failOn: null, json: false, markdown: false, verbose: false, noColor: false, keep: false, allTools: false, http: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith("--") && a.includes("=")) { inline = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (a.startsWith("-") && a !== "-") {
      if (!FLAGS.has(a)) throw new UsageError(`unknown option ${a}`);
      let value = null;
      if (FLAGS_WITH_VALUE.has(a)) {
        value = inline !== null ? inline : argv[++i];
        if (value === undefined) throw new UsageError(`${a} needs a value`);
      } else if (inline !== null) throw new UsageError(`${a} does not take a value`);
      switch (a) {
        case "--project": o.project = value; break;
        case "--event": {
          const name = value.split(":")[0];
          const known = EVENT_NAMES.find((e) => e.toLowerCase() === name.toLowerCase());
          if (!known) throw new UsageError(`--event: "${name}" is not a hook event (${EVENT_NAMES.join(", ")})`);
          o.event = known + value.slice(name.length);
          break;
        }
        case "--hook": o.hook = value; break;
        case "--input": o.input = value; break;
        case "--command": o.commandText = value; break;
        case "--file": o.file = value; break;
        case "--plugin-dir": o.pluginDirs.push(value); break;
        case "--timeout":
          if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) throw new UsageError("--timeout needs a number of seconds, such as --timeout 60");
          o.timeout = Number(value);
          break;
        case "--fail-on":
          if (!["error", "warn"].includes(value)) throw new UsageError("--fail-on needs error or warn");
          o.failOn = value;
          break;
        case "--no-plugins": o.plugins = false; break;
        case "--http": o.http = true; break;
        case "--json": o.json = true; break;
        case "--markdown": o.markdown = true; break;
        case "--verbose": o.verbose = true; break;
        case "--no-color": o.noColor = true; break;
        case "--keep": o.keep = true; break;
        case "--all-tools": o.allTools = true; break;
        case "-h": case "--help": o.help = true; break;
        case "-v": case "--version": o.version = true; break;
        default:
      }
      continue;
    }
    if (o.command === null && COMMANDS.has(a)) o.command = a;
    else o.positional.push(a);
  }
  if (o.json && o.markdown) throw new UsageError("--json and --markdown cannot be combined");
  if (o.markdown && o.command !== "run") throw new UsageError("--markdown works with run");
  return o;
}

/**
 * Run the tool. `io` lets tests capture output and fake the machine: { stdout, stderr, env, cwd, home, platform, managed }.
 * Returns the exit code: 0, 1 (--fail-on met) or 2 (usage or error).
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const home = io.home || os.homedir();
  const cwd = io.cwd || process.cwd();
  let o;
  try {
    o = parseArgs(argv);
    if (!o.help && !o.version && o.command === null) throw new UsageError(argv.length ? `unknown command ${o.positional[0] || argv[0]}` : "a command is needed: run, list or explain");
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr.write(`claude-hook-bench: ${e.message}\nTry: claude-hook-bench --help\n`);
    return 2;
  }
  if (o.help) { stdout.write(HELP); return 0; }
  if (o.version) { stdout.write(`${VERSION}\n`); return 0; }

  const color = !!stdout.isTTY && !env.NO_COLOR && !o.noColor;
  const project = path.resolve(cwd, o.project || ".");
  const common = { project, env, home, platform: io.platform || process.platform, managed: io.managed, pluginDirs: o.pluginDirs.map((d) => path.resolve(cwd, d)), plugins: o.plugins, filter: { event: o.event, hook: o.hook } };
  const emit = (model, text) => stdout.write(o.json ? `${toJson(model)}\n` : text);
  const failed = (m) => (o.failOn === "error" ? (m.summary.problems ?? m.summary.errors) > 0 : o.failOn === "warn" ? (m.summary.problems ?? m.summary.errors) > 0 || (m.summary.warnings ?? m.summary.warns) > 0 : false);

  try {
    switch (o.command) {
      case "list": {
        if (o.positional.length) throw new UsageError(`list takes no arguments (got "${o.positional[0]}")`);
        const m = buildList(common);
        emit(m, renderList(m, { color }));
        return failed({ ...m, summary: { ...m.summary, problems: m.summary.errors, warnings: m.summary.warns } }) ? 1 : 0;
      }
      case "run": {
        if (o.positional.length) throw new UsageError(`run takes no arguments (got "${o.positional[0]}"); use --hook, --event or --input`);
        let input = null;
        if (o.input) {
          let text;
          try { text = fs.readFileSync(path.resolve(cwd, o.input), "utf8"); } catch (e) { throw new UsageError(`--input ${o.input}: ${e.code === "ENOENT" ? "no such file" : e.message}`); }
          try { input = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { throw new UsageError(`--input ${o.input} is not valid JSON (${e.message})`); }
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new UsageError(`--input ${o.input} must hold one JSON object`);
          if (!EVENT_NAMES.includes(input.hook_event_name)) throw new UsageError(`--input ${o.input}: hook_event_name must name an event (${EVENT_NAMES.join(", ")})`);
          if (o.event && o.event.split(":")[0] !== input.hook_event_name) throw new UsageError(`--event ${o.event} and the input's hook_event_name ${input.hook_event_name} disagree`);
        }
        const m = await runBench({ ...common, http: o.http, input, command: o.commandText, file: o.file ? path.resolve(cwd, o.file) : null, timeoutCapMs: Math.round(o.timeout * 1000), allTools: o.allTools, keep: o.keep, log: o.verbose && !o.json && !o.markdown ? (s) => stderr.write(`${s}\n`) : null });
        if (o.json) stdout.write(`${toJson(m)}\n`);
        else if (o.markdown) stdout.write(markdownRun(m));
        else stdout.write(renderRun(m, { color, verbose: o.verbose }));
        return failed(m) ? 1 : 0;
      }
      case "explain": {
        if (o.positional.length !== 1) throw new UsageError("explain needs one argument: a hook number from the list, a unique part of a hook's command, or an event name");
        const what = o.positional[0];
        const ev = EVENT_NAMES.find((e) => e.toLowerCase() === what.toLowerCase());
        const m = ev && !/^#?\d+$/.test(what) ? explainEvent(ev) : explainHook(what.replace(/^#/, ""), common);
        emit(m, renderExplain(m, { color }));
        return m.matches !== undefined && m.matches !== 1 ? 2 : 0;
      }
      default:
        throw new UsageError(`unknown command ${o.command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`claude-hook-bench: ${e.message}\nTry: claude-hook-bench --help\n`);
      return 2;
    }
    stderr.write(`claude-hook-bench: ${e && e.stack ? e.stack : e}\n`);
    return 2;
  }
}

export { palette };
