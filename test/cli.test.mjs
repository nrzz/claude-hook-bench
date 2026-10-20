// The command line: options, usage errors, help, version, and the process entry point.
import test from "node:test";
import assert from "node:assert/strict";
import { runMain, sandbox } from "./helpers.mjs";
import { main, parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

test("parseArgs: commands, flags, values, inline values, repeats", () => {
  const o = parseArgs(["run", "--event", "pretooluse:Bash", "--hook", "3", "--command=rm -rf /", "--file", "a.ts", "--plugin-dir", "p1", "--plugin-dir", "p2", "--timeout", "2.5", "--fail-on", "warn", "--http", "--json", "--verbose", "--no-plugins", "--keep", "--all-tools"]);
  assert.equal(o.command, "run");
  assert.equal(o.event, "PreToolUse:Bash", "the event name is corrected to its case");
  assert.equal(o.hook, "3");
  assert.equal(o.commandText, "rm -rf /");
  assert.equal(o.file, "a.ts");
  assert.deepEqual(o.pluginDirs, ["p1", "p2"]);
  assert.equal(o.timeout, 2.5);
  assert.equal(o.failOn, "warn");
  assert.deepEqual([o.http, o.json, o.verbose, o.plugins, o.keep, o.allTools], [true, true, true, false, true, true]);
  assert.deepEqual(parseArgs(["explain", "Stop"]).positional, ["Stop"]);
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["list", "--no-color"]).noColor, true);
});

test("parseArgs: the usage errors", () => {
  const bad = (argv, re) => assert.throws(() => parseArgs(argv), re);
  bad(["run", "--bogus"], /unknown option --bogus/);
  bad(["run", "--event"], /--event needs a value/);
  bad(["run", "--event", "Nope"], /"Nope" is not a hook event/);
  bad(["run", "--timeout", "x"], /--timeout needs a number of seconds/);
  bad(["run", "--timeout", "0"], /--timeout needs a number/);
  bad(["run", "--fail-on", "all"], /--fail-on needs error or warn/);
  bad(["run", "--json", "--markdown"], /--json and --markdown cannot be combined/);
  bad(["list", "--markdown"], /--markdown works with run/);
  bad(["run", "--json=1"], /--json does not take a value/);
});

test("main: help, version, no command, unknown command, stray arguments", async () => {
  const s = sandbox();
  const io = s.io();
  const help = await runMain(main, ["--help"], io);
  assert.equal(help.code, 0);
  assert.match(help.out, /^claude-hook-bench \d+\.\d+\.\d+: run every hook/);
  assert.match(help.out, /--fail-on error\|warn/);
  assert.match(help.out, /never uses the network/);
  const v = await runMain(main, ["-v"], io);
  assert.equal(v.out, `${VERSION}\n`);
  const none = await runMain(main, [], io);
  assert.equal(none.code, 2);
  assert.match(none.err, /a command is needed: run, list or explain/);
  const unknown = await runMain(main, ["frob"], io);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command frob/);
  const stray = await runMain(main, ["list", "extra"], io);
  assert.equal(stray.code, 2);
  assert.match(stray.err, /list takes no arguments \(got "extra"\)/);
  const stray2 = await runMain(main, ["run", "extra"], io);
  assert.match(stray2.err, /run takes no arguments .*use --hook, --event or --input/);
  const ex = await runMain(main, ["explain"], io);
  assert.equal(ex.code, 2);
  assert.match(ex.err, /explain needs one argument/);
  const opt = await runMain(main, ["run", "--nope"], io);
  assert.equal(opt.code, 2);
  assert.match(opt.err, /unknown option --nope\nTry: claude-hook-bench --help/);
});

test("the bin runs as a process, with --project and NO_COLOR", () => {
  const s = sandbox({ user: { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } } });
  const r = s.cli(["list", "--project", s.proj]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#1 Stop \(every\)  command  echo hi/);
  assert.doesNotMatch(r.out, /\x1b\[/, "no colour when NO_COLOR is set");
  const v = s.cli(["--version"]);
  assert.equal(v.out.trim(), VERSION);
  const bad = s.cli(["nope"]);
  assert.equal(bad.code, 2);
});
