// The whole thing through main(): list, run and explain on sandboxes, the filters, the custom input, the
// reports in text, markdown and JSON, and the exit codes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NODE, echoHook, nodeHook, parse, printJson, printText, runMain, sandbox, write } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { makeSession, selectHooks } from "../src/bench.mjs";

const hooks = (event, matcher, ...hs) => ({ [event]: [matcher === null ? { hooks: hs } : { matcher, hooks: hs }] });
const DENY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no rm" } };
const run = (s, args, extra = {}) => runMain(main, args, s.io(extra));

test("list: the sources, every hook with its findings, the summary, and --json", async () => {
  const s = sandbox({
    user: { hooks: { ...hooks("PreToolUse", "Bash", printJson(DENY)), ...hooks("Stop", null, nodeHook("0", { timeout: 5 })), PreToolUs: [{ hooks: [printText("typo")] }] } },
    project: { hooks: hooks("PostToolUse", "bash", printText("done")) },
  });
  const r = await run(s, ["list"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^claude-hook-bench \d+\.\d+\.\d+  the hooks Claude Code would run here/);
  assert.match(r.out, /config    .*\(from CLAUDE_CONFIG_DIR\)/);
  assert.match(r.out, /project  \.claude\/settings\.json\s+1 hook/);
  assert.match(r.out, /user     .*settings\.json\s+3 hooks/);
  assert.match(r.out, /local    \.claude\/settings\.local\.json\s+not found/);
  assert.match(r.out, /#1 PostToolUse "bash"/);
  assert.match(r.out, /error matchers are case-sensitive/);
  assert.match(r.out, /#4 PreToolUs \(every\)/);
  assert.match(r.out, /did you mean PreToolUse/);
  assert.match(r.out, /timeout 5s\n/);
  assert.match(r.out, /4 hooks on 4 events; 2 errors, 0 warnings/);
  assert.match(r.out, /Not read by this tool: hooks in skill and subagent frontmatter/);
  const j = await run(s, ["list", "--json"]);
  const m = parse(j.out);
  assert.equal(m.command, "list");
  assert.equal(m.hooks.length, 4);
  assert.deepEqual(m.summary, { hooks: 4, errors: 2, warns: 0, events: ["PostToolUse", "PreToolUse", "Stop", "PreToolUs"] });
  assert.equal(m.hooks[1].raw.type, "command");
  assert.equal(m.hooks[0].findings[0].severity, "error");
  // --fail-on on list
  assert.equal((await run(s, ["list", "--fail-on", "error"])).code, 1);
  assert.equal((await run(s, ["list", "--fail-on", "error", "--event", "Stop"])).code, 0);
  assert.match((await run(s, ["list", "--event", "Stop"])).out, /1 hook on 1 event/);
});

test("list with nothing configured, and with unreadable files", async () => {
  const s = sandbox();
  const r = await run(s, ["list"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /No hooks found\. Claude Code reads hooks from settings\.json files/);
  const t = sandbox({ user: "{ nope" });
  const u = await run(t, ["list"]);
  assert.match(u.out, /user settings .* is not valid JSON/);
  assert.equal((await run(t, ["list", "--fail-on", "error"])).code, 1);
});

test("run: every hook with its fixtures, the verdicts, stdout and stderr shown, the summary", async () => {
  const s = sandbox({
    user: {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [nodeHook("const i=JSON.parse(require('fs').readFileSync(0,'utf8')); if(/rm -rf/.test(i.tool_input.command)) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'no rm -rf'}}))")] },
          { matcher: "Edit|Write", hooks: [printText("checked")] },
        ],
        Stop: [{ hooks: [printJson({ systemMessage: 5 })] }],
        SessionStart: [{ matcher: "startup|resume", hooks: [printText("Current branch: main")] }],
        UserPromptSubmit: [{ hooks: [printText("", "boom", 1)] }],
        Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: "no-such-program-hb", args: [] }] }],
      },
    },
  });
  const r = await run(s, ["run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PreToolUse:Bash\s+silent\s+\(exit 0, \d+ ms\)/, "npm test is not rm -rf");
  assert.match(r.out, /PreToolUse:Edit\s+silent/);
  assert.match(r.out, /PreToolUse:Write\s+silent/);
  assert.match(r.out, /plain stdout goes to the debug log only/);
  assert.match(r.out, /Stop\s+non-blocking error/);
  assert.match(r.out, /problem  invalid JSON output, systemMessage: expected string, received number/);
  assert.match(r.out, /SessionStart:startup\s+adds context/);
  assert.match(r.out, /SessionStart:resume\s+adds context/);
  assert.match(r.out, /UserPromptSubmit\s+non-blocking error\s+\(exit 1/);
  assert.match(r.out, /warn     exit code 1 does not block/);
  assert.match(r.out, /Notification:permission_prompt cannot start/);
  assert.match(r.out, /\[input from the docs\]/);
  assert.match(r.out, /stderr:\n\s+boom/);
  assert.match(r.out, /8 runs of 6 hooks: /);
  assert.match(r.out, /\d+ problems?, \d+ warnings?/);
  // the same with the destructive command: the Bash hook denies
  const d = await run(s, ["run", "--event", "PreToolUse:Bash", "--command", "rm -rf /tmp/build"]);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /PreToolUse:Bash\s+denies\s+\(exit 0/);
  assert.match(d.out, /permissionDecision: deny blocks the tool call; Claude sees: "no rm -rf"/);
  assert.match(d.out, /1 run of 1 hook: 1 block/);
  assert.doesNotMatch(d.out, /PreToolUse:Edit/);
  // --fail-on
  assert.equal((await run(s, ["run", "--fail-on", "error"])).code, 1);
  assert.equal((await run(s, ["run", "--fail-on", "error", "--event", "SessionStart"])).code, 0);
  assert.equal((await run(s, ["run", "--fail-on", "warn", "--event", "SessionStart"])).code, 0);
});

test("run --json: the full model, with the input each hook got and the verdict", async () => {
  const s = sandbox({ user: { hooks: hooks("PreToolUse", "Bash", echoHook()) } });
  const r = await run(s, ["run", "--json"]);
  assert.equal(r.code, 0, r.err);
  const m = parse(r.out);
  assert.equal(m.command, "run");
  assert.equal(m.runs.length, 1);
  const x = m.runs[0];
  assert.equal(x.event, "PreToolUse");
  assert.equal(x.value, "Bash");
  assert.equal(x.verified, "recorded");
  assert.equal(x.input.tool_name, "Bash");
  assert.deepEqual(x.input.tool_input, { command: "npm test", description: "Run the test suite" });
  assert.equal(x.run.status, "ran");
  assert.equal(x.run.exitCode, 0);
  assert.equal(x.run.form, "exec");
  assert.equal(x.run.hookTimeoutMs, 600000);
  assert.equal(x.run.timeoutMs, 30000, "the bench's cap");
  assert.equal(x.verdict.outcome, "silent", "the echo hook prints JSON that sets nothing Claude Code reads");
  const got = parse(x.run.stdout).got;
  assert.equal(got.session_id, m.session.sessionId);
  assert.ok(got.transcript_path.includes(m.session.sessionId), "the transcript path names the session");
  assert.equal(got.cwd, s.proj);
  assert.equal(parse(x.run.stdout).env.CLAUDE_PROJECT_DIR, s.proj);
  assert.deepEqual(m.summary.outcomes, { silent: 1 });
  assert.equal(m.session.folder, null, "the throwaway session folder is removed");
});

test("run: the transcript the fixture names exists while the hook runs, and --keep leaves the folder", async () => {
  const s = sandbox({ user: { hooks: hooks("Stop", null, nodeHook("const i=JSON.parse(require('fs').readFileSync(0,'utf8')); const t=require('fs').readFileSync(i.transcript_path,'utf8').split('\\n').filter(Boolean); process.stdout.write(JSON.stringify({systemMessage: 'lines ' + t.length}))")) } });
  const r = await run(s, ["run", "--json", "--keep"]);
  const m = parse(r.out);
  assert.equal(m.runs[0].verdict.outcome, "message", JSON.stringify(m.runs[0].verdict));
  assert.match(m.runs[0].run.stdout, /lines 4/);
  assert.ok(m.session.folder && fs.existsSync(m.session.folder));
  const lines = fs.readFileSync(path.join(m.session.folder, "projects", s.proj.replace(/[^a-zA-Z0-9]/g, "-"), `${m.session.sessionId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["user", "assistant", "user", "assistant"]);
  assert.equal(lines[1].message.content[1].name, "Bash");
  fs.rmSync(m.session.folder, { recursive: true, force: true });
});

test("run: hooks that are skipped, with the reason, and the if filter", async () => {
  const s = sandbox({
    user: {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [printJson(DENY, 0, { if: "Bash(git *)" })] }, { matcher: "^Notebook", hooks: [printText("x")] }],
        Stop: [{ hooks: [{ type: "prompt", prompt: "Done? $ARGUMENTS" }, { type: "http", url: "https://example.com/hook" }, { type: "mcp_tool", server: "s", tool: "t" }] }],
        Nope: [{ hooks: [printText("x")] }],
      },
    },
  });
  const r = await run(s, ["run", "--json"]);
  const m = parse(r.out);
  const skipped = m.runs.filter((x) => x.skipped).map((x) => [x.hook, x.skipped]);
  assert.deepEqual(skipped, [
    [1, '"if" keeps the hook from running: no subcommand of "npm test" matches Bash(git *)'],
    [2, 'no known tool_name value matches the regular expression "^Notebook"; use --input to run it with your own JSON'],
    [3, "prompt hooks are not run by this bench (they call a model)"],
    [4, "http hooks are not run by this bench (it opens no network connection)"],
    [5, "mcp_tool hooks are not run by this bench (it needs the MCP server)"],
    [6, "not a hook event, so there is no JSON to send it"],
  ]);
  assert.equal(m.summary.runs, 0);
  const g = await run(s, ["run", "--json", "--hook", "1", "--command", "git push origin main"]);
  const gm = parse(g.out);
  assert.equal(gm.runs[0].verdict.outcome, "block", "with a git command the if lets the hook run, and it denies");
  const t = await run(s, ["run"]);
  assert.match(t.out, /PreToolUse:Bash\s+skipped\s+"if" keeps the hook from running/);
  assert.match(t.out, /Stop\s+skipped\s+prompt hooks are not run by this bench/);
});

test("run: disableAllHooks and allowManagedHooksOnly skip everything but managed hooks", async () => {
  const s = sandbox({ user: { disableAllHooks: true, hooks: hooks("Stop", null, printText("x")) } });
  const m = parse((await run(s, ["run", "--json"])).out);
  assert.match(m.runs[0].skipped, /disableAllHooks is true in the user settings/);
  const t = sandbox({ managed: { allowManagedHooksOnly: true, hooks: hooks("Stop", null, printText("m")) }, user: { hooks: hooks("Stop", null, printText("u")) } });
  const tm = parse((await run(t, ["run", "--json"])).out);
  assert.deepEqual(tm.runs.map((x) => [x.hook, !!x.skipped]), [[1, false], [2, true]]);
});

test("run --input: your own JSON goes to the hooks of its event whose matcher matches", async () => {
  const s = sandbox({ user: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [echoHook()] }, { matcher: "Edit", hooks: [echoHook()] }], Stop: [{ hooks: [echoHook()] }] } } });
  const file = write(path.join(s.base, "in.json"), { session_id: "s", transcript_path: "", cwd: s.proj, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, tool_use_id: "toolu_x" });
  const r = await run(s, ["run", "--input", file, "--json"]);
  assert.equal(r.code, 0, r.err);
  const m = parse(r.out);
  assert.deepEqual(m.custom, { event: "PreToolUse" });
  assert.deepEqual(m.runs.map((x) => [x.hook, x.skipped || x.verified]), [[1, "yours"], [2, 'the matcher "Edit" does not match tool_name "Bash"']]);
  assert.deepEqual(parse(m.runs[0].run.stdout).got.tool_input, { command: "ls -la" });
  const bad = await run(s, ["run", "--input", write(path.join(s.base, "bad.json"), { hook_event_name: "Nope" })]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /hook_event_name must name an event/);
  const missing = await run(s, ["run", "--input", path.join(s.base, "none.json")]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
  const notJson = await run(s, ["run", "--input", write(path.join(s.base, "nj.json"), "{")]);
  assert.match(notJson.err, /not valid JSON/);
  const disagree = await run(s, ["run", "--input", file, "--event", "Stop"]);
  assert.match(disagree.err, /disagree/);
});

test("run --file points the file tools at a file; the default names a file that need not exist", async () => {
  const s = sandbox({ user: { hooks: hooks("PreToolUse", "Write", echoHook()) } });
  const m = parse((await run(s, ["run", "--json"])).out);
  assert.equal(parse(m.runs[0].run.stdout).got.tool_input.file_path, path.join(s.proj, "src", "hook-bench-sample.ts"));
  const f = parse((await run(s, ["run", "--json", "--file", "lib/real.ts"])).out);
  assert.equal(parse(f.runs[0].run.stdout).got.tool_input.file_path, path.join(s.proj, "lib", "real.ts"));
});

test("run: the hook's own timeout is reported, the bench cap applies, and CLAUDE_ENV_FILE writes are shown", async () => {
  const s = sandbox({
    user: {
      hooks: {
        SessionEnd: [{ hooks: [nodeHook("setTimeout(() => process.exit(0), 1800)")] }],
        SessionStart: [{ matcher: "startup", hooks: [nodeHook("require('fs').appendFileSync(process.env.CLAUDE_ENV_FILE, 'export NODE_ENV=test\\n')")] }],
        Stop: [{ hooks: [nodeHook("setTimeout(() => {}, 20000)", { timeout: 1 })] }],
      },
    },
  });
  const r = await run(s, ["run", "--json", "--timeout", "3"]);
  const m = parse(r.out);
  const end = m.runs.find((x) => x.event === "SessionEnd");
  assert.equal(end.run.status, "timed-out", "SessionEnd's 1.5-second budget is the hook's timeout, so an 1.8-second hook is cut off as Claude Code would");
  assert.equal(end.run.hookTimeoutMs, 1500);
  assert.equal(end.run.timeoutMs, 1500);
  assert.match(end.verdict.problems.join(" "), /timed out after 1\.5 s: Claude Code cancels it and discards its output/);
  const start = m.runs.find((x) => x.event === "SessionStart");
  assert.equal(start.envFile, "export NODE_ENV=test\n");
  const stop = m.runs.find((x) => x.event === "Stop");
  assert.equal(stop.run.status, "timed-out");
  assert.equal(stop.run.timeoutMs, 1000, "min of the hook's 1 s and the cap");
  assert.equal(stop.verdict.outcome, "cancelled");
  const t = await run(s, ["run", "--event", "SessionStart"]);
  assert.match(t.out, /CLAUDE_ENV_FILE:\n\s+export NODE_ENV=test/);
});

test("run --markdown: the skill's report", async () => {
  const s = sandbox({ user: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [printJson(DENY)] }], Stop: [{ hooks: [printText("", "boom", 1)] }], Nope: [{ hooks: [printText("x")] }] } } });
  const r = await run(s, ["run", "--markdown"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^## hook-bench: 2 runs of 3 hooks in /);
  assert.match(r.out, /\| # \| hook \| event \| verdict \| exit \| time \| problems \|/);
  assert.match(r.out, /\| 1 \| `.*` \| PreToolUse:Bash \| denies \| 0 \| \d+ ms \|  \|/);
  assert.match(r.out, /\| 2 \| `.*` \| Stop \| non-blocking error \| 1 \| \d+ ms \| exit code 1 with no valid JSON/);
  assert.match(r.out, /\| 3 \| `.*` \| Nope \| skipped \| \| \| not a hook event/);
  assert.match(r.out, /\d+ problems?, \d+ warnings?\./);
  assert.match(r.out, /Verdicts: 1 block, 1 fail\./);
  assert.ok(r.out.split("\n").length < 70, "capped for the model");
  const empty = await run(sandbox(), ["run", "--markdown"]);
  assert.match(empty.out, /No hooks found/);
});

test("run: plugin hooks run from the installed copy with CLAUDE_PLUGIN_ROOT filled in", async () => {
  const s = sandbox({ plugins: [{ name: "fmt", hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: NODE, args: ["${CLAUDE_PLUGIN_ROOT}/fmt.mjs"] }] }] }, files: { "fmt.mjs": "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'formatted ' + process.env.CLAUDE_PLUGIN_ROOT + ' ' + process.env.CLAUDE_PLUGIN_DATA}}))" } }] });
  const r = await run(s, ["run", "--json"]);
  const m = parse(r.out);
  assert.equal(m.hooks[0].plugin, "fmt");
  assert.equal(m.runs[0].verdict.outcome, "context", JSON.stringify(m.runs[0]));
  assert.match(m.runs[0].run.stdout, /formatted .*cache.*fmt.*1\.0\.0 .*plugins.*data.*fmt-mkt/);
  const t = await run(s, ["run"]);
  assert.match(t.out, /plugin\s+fmt@mkt 1\.0\.0\s+1 hook/);
  assert.match(t.out, /PostToolUse:Write\s+adds context/);
  // --plugin-dir
  const dir = path.join(s.base, "inline");
  write(path.join(dir, ".claude-plugin", "plugin.json"), { name: "inl", version: "0.0.1" });
  write(path.join(dir, "hooks", "hooks.json"), { hooks: hooks("Stop", null, printText("inline ran")) });
  const i = parse((await run(s, ["run", "--json", "--plugin-dir", dir, "--no-plugins"])).out);
  assert.deepEqual(i.hooks.map((h) => h.plugin), ["inl"]);
  assert.equal(i.runs[0].run.stdout, "inline ran");
});

test("explain: a hook by number or text, an event by name, and the failures", async () => {
  const s = sandbox({ user: { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "node ./hooks/fmt.js", if: "Edit(*.ts)" }] }], Stop: [{ hooks: [printText("a")] }, { hooks: [printText("b")] }] } } });
  const r = await run(s, ["explain", "1"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hook #1/);
  assert.match(r.out, /Defined in user settings/);
  assert.match(r.out, /When it fires  PreToolUse: before a tool call runs\./);
  assert.match(r.out, /tested against tool_name: exactly "Edit" or "Write"/);
  assert.match(r.out, /if Edit\(\*\.ts\): the hook runs only when the tool call matches/);
  assert.match(r.out, /How it runs  command hook in shell form through/);
  assert.match(r.out, /one run per matcher value: Edit, Write/);
  assert.match(r.out, /"hook_event_name": "PreToolUse"/);
  assert.match(r.out, /This shape was recorded from Claude Code 2\.1\.295\./);
  assert.match(r.out, /exit 2: blocks/);
  assert.match(r.out, /permissionDecision \(allow\|deny\|ask\|defer\)/);
  assert.match(r.out, /Run it: claude-hook-bench run --hook 1/);
  const byText = await run(s, ["explain", "fmt.js"]);
  assert.match(byText.out, /hook #1/);
  const several = await run(s, ["explain", "process.stdout.write"]);
  assert.equal(several.code, 2);
  assert.match(several.out, /2 hooks match; give a number instead/);
  const none = await run(s, ["explain", "zzz"]);
  assert.equal(none.code, 2);
  assert.match(none.out, /No hook matches\. Pick one of the 3 by number/);
  const ev = await run(s, ["explain", "sessionstart"]);
  assert.equal(ev.code, 0);
  assert.match(ev.out, /SessionStart: when a session begins or resumes/);
  assert.match(ev.out, /documented values: startup, resume, clear, compact, fork/);
  assert.match(ev.out, /Exit 2: Shows stderr to the user only/);
  assert.match(ev.out, /"source": "startup"/);
  const j = parse((await run(s, ["explain", "1", "--json"])).out);
  assert.equal(j.kind, "hook");
  assert.equal(j.hook.n, 1);
  assert.equal(j.fixtures.length, 2);
  assert.equal(j.plan.form, "shell");
  const ej = parse((await run(s, ["explain", "Stop", "--json"])).out);
  assert.equal(ej.event.name, "Stop");
  assert.equal(ej.sample.hook_event_name, "Stop");
});

test("selectHooks and makeSession", () => {
  const list = [{ n: 1, event: "Stop", raw: { type: "command", command: "echo a" }, plugin: null }, { n: 2, event: "PreToolUse", raw: { type: "command", command: "node", args: ["x.mjs"] }, plugin: "p" }];
  assert.deepEqual(selectHooks(list, { event: "stop" }).map((h) => h.n), [1]);
  assert.deepEqual(selectHooks(list, { event: "PreToolUse:Bash" }).map((h) => h.n), [2]);
  assert.deepEqual(selectHooks(list, { hook: "2" }).map((h) => h.n), [2]);
  assert.deepEqual(selectHooks(list, { hook: "#1" }).map((h) => h.n), [1]);
  assert.deepEqual(selectHooks(list, { hook: "x.mjs" }).map((h) => h.n), [2]);
  assert.deepEqual(selectHooks(list, { hook: "p" }).map((h) => h.n), [2], "a plugin name");
  assert.deepEqual(selectHooks(list, {}).map((h) => h.n), [1, 2]);
  const s = sandbox();
  const ses = makeSession({ project: s.proj, dir: path.join(s.base, "ses") });
  assert.match(ses.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(ses.transcriptPath) && fs.existsSync(ses.agentTranscriptPath) && fs.existsSync(ses.envDir));
});

test("run --http: post event JSON to http hooks, judge the five response kinds, and fill allowedEnvVars", async () => {
  let recordedHeaders = null;
  let recordedBody = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      recordedHeaders = req.headers;
      try { recordedBody = JSON.parse(body); } catch { recordedBody = body; }
      if (req.url === "/empty") {
        res.writeHead(200);
        res.end("");
      } else if (req.url === "/json-deny") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(DENY));
      } else if (req.url === "/other-body") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("plain text verdict");
      } else if (req.url === "/error-500") {
        res.writeHead(500);
        res.end("internal error");
      } else if (req.url === "/env-headers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const s = sandbox({
      user: {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/empty` }] },
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/json-deny` }] },
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/other-body` }] },
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/other-body`, onFailure: "block" }] },
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/error-500` }] },
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/error-500`, onFailure: "block" }] },
            { matcher: "Bash", hooks: [{ type: "http", url: "http://127.0.0.1:59999/down" }] },
            { matcher: "Bash", hooks: [{ type: "http", url: "http://127.0.0.1:59999/down", onFailure: "block" }] },
            { matcher: "Bash", hooks: [{ type: "http", url: `${base}/env-headers`, headers: { "Authorization": "Bearer $TOKEN", "X-Unallowed": "$SECRET", "X-Braced": "${TOKEN}", "X-Mixed": "$TOKEN-$SECRET" }, allowedEnvVars: ["TOKEN"] }] },
          ],
        },
      },
    });

    // 1. Without --http, http hooks are not run
    const off = await run(s, ["run", "--json"]);
    const offModel = parse(off.out);
    assert.equal(offModel.summary.runs, 0);
    assert.ok(offModel.runs.every((r) => r.skipped === "http hooks are not run by this bench (it opens no network connection)"));

    // 2. With --http, they run and report their verdicts
    const on = await run(s, ["run", "--http", "--json"], { env: s.env({ TOKEN: "test-token-123", SECRET: "hidden-key" }) });
    const m = parse(on.out);
    assert.equal(m.summary.runs, 9);

    // #1: 2xx with empty body -> silent
    assert.equal(m.runs[0].run.status, "ran");
    assert.equal(m.runs[0].verdict.outcome, "silent");
    assert.equal(m.runs[0].verdict.verdict, "silent");
    assert.equal(m.runs[0].verdict.problems.length, 0);

    // #2: 2xx with JSON object body -> denies
    assert.equal(m.runs[1].run.status, "ran");
    assert.equal(m.runs[1].verdict.outcome, "block");
    assert.equal(m.runs[1].verdict.verdict, "denies");
    assert.match(m.runs[1].verdict.effects[0], /no rm/);

    // #3: 2xx with other body -> non-blocking error
    assert.equal(m.runs[2].run.status, "ran");
    assert.equal(m.runs[2].verdict.outcome, "error");
    assert.equal(m.runs[2].verdict.verdict, "non-blocking error");
    assert.match(m.runs[2].verdict.problems[0], /not a JSON object/);

    // #4: 2xx with other body and onFailure: "block" -> still non-blocking error!
    assert.equal(m.runs[3].run.status, "ran");
    assert.equal(m.runs[3].verdict.outcome, "error");
    assert.equal(m.runs[3].verdict.verdict, "non-blocking error");

    // #5: non-2xx status code (500) -> non-blocking error
    assert.equal(m.runs[4].run.status, "ran");
    assert.equal(m.runs[4].verdict.outcome, "error");
    assert.equal(m.runs[4].verdict.verdict, "non-blocking error");
    assert.match(m.runs[4].verdict.problems[0], /HTTP status 500/);

    // #6: non-2xx status code (500) with onFailure: "block" -> blocks
    assert.equal(m.runs[5].run.status, "ran");
    assert.equal(m.runs[5].verdict.outcome, "block");
    assert.equal(m.runs[5].verdict.verdict, "blocks");

    // #7: connection failure -> cannot start (non-blocking error)
    assert.equal(m.runs[6].run.status, "failed-to-start");
    assert.equal(m.runs[6].verdict.outcome, "error");
    assert.equal(m.runs[6].verdict.verdict, "cannot start");

    // #8: connection failure with onFailure: "block" -> blocks
    assert.equal(m.runs[7].run.status, "failed-to-start");
    assert.equal(m.runs[7].verdict.outcome, "block");
    assert.equal(m.runs[7].verdict.verdict, "blocks");

    // #9: allowedEnvVars in headers
    assert.equal(recordedHeaders["authorization"], "Bearer test-token-123");
    assert.equal(recordedHeaders["x-unallowed"], "");
    assert.equal(recordedHeaders["x-braced"], "test-token-123");
    assert.equal(recordedHeaders["x-mixed"], "test-token-123-");
    assert.equal(recordedBody.hook_event_name, "PreToolUse");
    assert.equal(recordedBody.tool_name, "Bash");

    // Also test human-readable terminal output with --http
    const textRun = await run(s, ["run", "--http", "--hook", "1"]);
    assert.match(textRun.out, /PreToolUse:Bash\s+silent/);
  } finally {
    server.close();
  }
});
