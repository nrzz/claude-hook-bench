// The package itself: what it says it is, what it imports, which Node it needs, that only one file starts
// processes and none touches the network, and that the plugin's skill calls the tool with flags the tool has.
import { ROOT } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const json = (rel) => JSON.parse(read(rel));
const files = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");

test("package.json: name, version, bin, engines, no dependencies, tests run with node --test", () => {
  assert.equal(pkg.name, "claude-hook-bench");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.bin, { "claude-hook-bench": "bin/claude-hook-bench.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.scripts.test, "node --test");
  assert.deepEqual(pkg.files, ["bin", "src", ".claude-plugin", "skills", "README.md", "LICENSE"]);
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed and exists`);
  assert.match(pkg.description, /^Run every hook/);
  assert.match(pkg.description, /Zero tokens/i);
  for (const k of ["claude-code", "claude-code-hooks", "hooks", "settings", "testing"]) assert.ok(pkg.keywords.includes(k), k);
});

test("the plugin manifest matches the package", () => {
  assert.equal(plugin.name, "hook-bench");
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.license, "MIT");
  assert.match(plugin.homepage, /github\.com\/nrzz\/claude-hook-bench/);
  assert.match(plugin.repository, /github\.com\/nrzz\/claude-hook-bench/);
  for (const k of ["documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) assert.match(plugin[k], /^https:\/\/github\.com\/nrzz\/claude-hook-bench/, k);
  assert.equal(plugin.hooks, undefined, "no hooks: the plugin is one skill");
  assert.equal(plugin.mcpServers, undefined);
  assert.ok(!fs.existsSync(path.join(ROOT, "hooks")), "a bench of hooks adds no hook of its own");
});

test("one skill, /hook-bench:check, that only runs this tool and runs the hooks for real", () => {
  const dirs = fs.readdirSync(path.join(ROOT, "skills"));
  assert.deepEqual(dirs, ["check"]);
  const text = read("skills/check/SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "has frontmatter");
  assert.match(front[1], /^name: check$/m);
  assert.match(front[1], /^disable-model-invocation: true$/m);
  const desc = /^description: (.+)$/m.exec(front[1])[1];
  assert.ok(desc.length <= 60, `the description is counted in every session's estimate: ${desc.length} characters`);
  const allowed = /^allowed-tools: (.+)$/m.exec(front[1])[1];
  assert.match(allowed, /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-hook-bench\.mjs" \*\)/);
  assert.doesNotMatch(allowed, /Bash\(\*\)|Bash\s|Edit|Write/, "nothing wider than the one command");
  const body = text.slice(front[0].length);
  const commands = [...body.matchAll(/^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-hook-bench\.mjs" (.+)`$/gm)].map((m) => m[1]);
  assert.equal(commands.length, 1);
  const parsed = parseArgs(commands[0].replace(/"\$\{CLAUDE_PROJECT_DIR\}"/g, "dir").split(/\s+/));
  assert.equal(parsed.command, "run");
  assert.ok(parsed.markdown && parsed.project === "dir", "markdown for the project folder");
  assert.match(body, /Change nothing until the user agrees/);
  assert.match(body, /was run once per matching event value/);
});

test("every source file is .mjs and imports only node built-ins it needs and the package itself; only runner.mjs starts processes", () => {
  const sources = [...files("src", ".mjs"), ...files("bin", ".mjs")];
  assert.ok(sources.length >= 10);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "src")).filter((n) => !n.endsWith(".mjs")), []);
  const allowed = new Set(["node:fs", "node:os", "node:path"]);
  for (const f of sources) {
    for (const m of read(f).matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
      const spec = m[1];
      if (spec === "node:child_process") { assert.equal(path.basename(f), "runner.mjs", `${f} may not start processes`); continue; }
      if (spec === "node:http" || spec === "node:https") { assert.equal(path.basename(f), "http.mjs", `${f} may not make network requests`); continue; }
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || allowed.has(spec), `${f} imports ${spec}`);
    }
    assert.doesNotMatch(read(f), /\brequire\(|\bimport\(/, `${f} has no dynamic loading`);
  }
});

test("nothing in the package can reach the network except http.mjs with node:http/https", () => {
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|node:(http|https|http2|net|tls|dns|dgram|worker_threads|cluster|vm)\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  const httpBanned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|node:(http2|net|tls|dns|dgram|worker_threads|cluster|vm)\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) {
    assert.doesNotMatch(read(f), path.basename(f) === "http.mjs" ? httpBanned : banned, f);
  }
});

test("only APIs that exist in Node 18 are used", () => {
  const newer = [
    [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, "Array copy-methods (Node 20)"],
    [/\bObject\.groupBy\b|\bMap\.groupBy\b/, "groupBy (Node 21)"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"],
    [/import\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"],
    [/\bfs\.(glob|globSync)\b/, "fs.glob (Node 22)"],
    [/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Node 20)"],
    [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Node 22)"],
    [/process\.getBuiltinModule|process\.loadEnvFile|util\.styleText|\bstyleText\b/, "newer process/util APIs"],
    [/\bimport\s[^;]*\swith\s*\{/, "import attributes"],
    [/\bstructuredClone\b/, "structuredClone (Node 17; avoided for clarity)"],
  ];
  for (const f of [...files("src", ".mjs"), ...files("bin", ".mjs")]) {
    const text = read(f);
    for (const [re, what] of newer) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("the license, the conduct file and the changelog are there and agree on the version", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE"), /Copyright \(c\) \d{4} /);
  assert.ok(fs.existsSync(path.join(ROOT, "CODE_OF_CONDUCT.md")));
  if (fs.existsSync(path.join(ROOT, "CHANGELOG.md"))) assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\]`, "m"));
});

test("the CI workflow runs the suite on three systems and the real-binary checks on two", () => {
  const ci = read(".github/workflows/test.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node: 18/);
  assert.match(ci, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(ci, /E2E_CLAUDE: claude/);
  assert.match(ci, /test\/e2e-claude\.test\.mjs/);
});

test("the README has the sections the house keeps, and names every command and option the CLI has", () => {
  if (!fs.existsSync(path.join(ROOT, "README.md"))) return;
  const readme = read("README.md");
  for (const h of ["## What you get", "## What it costs in tokens", "## Install", "## Use", "## How it works", "## What was verified, and how", "## Not verified", "## Files", "## Contributing", "## Part of the Claude Code toolkit"]) assert.ok(readme.includes(`\n${h}`), h);
  for (const flag of ["--project", "--event", "--hook", "--input", "--command", "--file", "--plugin-dir", "--no-plugins", "--timeout", "--fail-on", "--json", "--markdown", "--verbose", "--no-color", "--http"]) assert.ok(readme.includes(`\`${flag}`), flag);
  for (const cmd of ["claude-hook-bench run", "claude-hook-bench list", "claude-hook-bench explain"]) assert.ok(readme.includes(cmd), cmd);
  assert.ok(readme.includes("npx -y github:nrzz/claude-hook-bench"));
  assert.ok(readme.includes("/plugin install hook-bench@claude-code-toolkit"));
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji");
});

test("a settings file in a test never points at the real Claude folder", () => {
  assert.notEqual(process.env.CLAUDE_CONFIG_DIR, "");
  assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME), "the config folder is inside the throwaway home");
  assert.match(process.env.CLAUDE_HOOK_BENCH_MANAGED_DIR, /no-managed-settings$/);
});
