# claude-hook-bench

[![test](https://github.com/nrzz/claude-hook-bench/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-hook-bench/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

claude-hook-bench runs every hook of a Claude Code setup with the exact JSON Claude Code sends for its event, and tells you what each one would do. For every hook in your user, project and local settings files and in your enabled plugins it reports whether it ran, its exit code, how long it took, what it printed, whether that output is valid for the event (the fields Claude Code reads, with the types it insists on), and whether Claude Code would block, allow, ask, add context or stay silent. Before running anything it finds the mistakes Claude Code swallows without a word: a misspelled event name, a lowercase matcher, an `if` on an event that never evaluates it, a script that does not exist, a field of the wrong type that makes Claude Code drop the whole answer. It is a plain Node program that runs outside Claude, so checking your hooks costs no tokens.

## What you get

- `run`: every command hook (and `http` hooks with `--http`), run once per matching event value (a `PreToolUse` hook with matcher `Edit|Write` runs with an Edit call and a Write call; a `SessionStart` hook runs for `startup` and `resume`) with a session's JSON on stdin, from a throwaway transcript folder. Per run: the verdict (`denies`, `allows`, `asks`, `keeps Claude working`, `adds context`, `shows a message`, `silent`, `non-blocking error`, `timed out`, `cannot start`), what Claude Code does with the answer, the problems (an invalid field, an exit code that does not block, a timeout) and the warnings (a field the event discards, a misplaced key, a deprecated form), then stdout and stderr. `--command "rm -rf /"` and `--file src/x.ts` change the shell and file fixtures; `--input my.json` sends your own JSON.
- `list`: every hook with its source file and line, event, matcher, type, timeout and the findings of the static checks: unknown events, matchers that can never match, unsupported handler types, missing scripts and executables, `.cmd` shims in exec form, `jq` that is not installed, `${CLAUDE_PLUGIN_ROOT}` outside a plugin, a bare `$CLAUDE_PROJECT_DIR` in PowerShell, `once` in a settings file, `onFailure` where it has no effect, and more.
- `explain <hook>`: one hook: when it fires, how it runs, the JSON it gets (every field, as Claude Code sends it) and how its answer is read: what exit 2 does on that event, whether plain stdout reaches Claude, which JSON fields the event honours and which it discards. `explain <Event>` describes an event the same way.
- `--json` on everything, `--markdown` for the skill, `--fail-on error|warn` for CI.
- A plugin with one user-only skill, `/hook-bench:check`, that runs the bench for the current project and summarises what fails.

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: `run`, `list`, `explain`, `--json`, `--markdown` | 0 | A separate Node process. It reads settings files and plugin folders, runs your hooks, and never calls Claude or the network |
| The skill in Claude's skill list | 0 | `/hook-bench:check` is user-only (`disable-model-invocation`), so Claude Code leaves it out of what the model is given; `claude plugin details` still counts its 44-character description (about 15 tokens) in its always-on estimate, because the estimate counts user-only skills too (checked for the toolkit's other user-only skills with a fake API; see [the toolkit README](https://github.com/nrzz/claude-code-toolkit#the-plugins-from-one-marketplace)) |
| `/hook-bench:check` | about 500 to 900, once | The skill text (about 120 tokens) plus the markdown table, one row per run: about 40 to 60 tokens a row, capped at 40 rows. The free route is the same report in a terminal: `claude-hook-bench run` |

Token figures are characters divided by 4, an estimate, not a count by Claude's tokenizer.

## Install

From a terminal, with Node 18 or newer. There is nothing to install and no dependency:

```bash
npx -y github:nrzz/claude-hook-bench run
```

```bash
npx -y github:nrzz/claude-hook-bench list
```

```bash
npx -y github:nrzz/claude-hook-bench explain 1
```

`claude-hook-bench` in the rest of this document means `npx -y github:nrzz/claude-hook-bench`, or `npm i -g github:nrzz/claude-hook-bench` once.

As a Claude Code plugin, in Claude Code:

```text
/plugin marketplace add nrzz/claude-code-toolkit
/plugin install hook-bench@claude-code-toolkit
```

Then type `/hook-bench:check`. It runs every hook of the current setup (they really run, as `run` does below) and answers in at most 10 lines: the hooks that fail or time out, the ones whose output Claude Code would drop, and whether any hook blocks on its fixture. It changes nothing. To try the plugin from a clone before it is in the marketplace: `claude --plugin-dir ./claude-hook-bench`.

## Use

```text
claude-hook-bench run     [--event <Event[:value]>] [--hook <#|text>] [--input <file.json>] [--command <text>] [--file <path>] [--timeout <s>] [--http] [--json | --markdown] [--verbose] [--fail-on error|warn]
claude-hook-bench list    [--event <Event>] [--hook <#|text>] [--json] [--fail-on error|warn]
claude-hook-bench explain <#|text|Event> [--json]
```

| Option | What it does |
| --- | --- |
| `--project <dir>` | The folder Claude Code starts in. Default: the current folder |
| `--event <name[:value]>` | One event, or one matcher value of it: `--event PreToolUse:Bash`, `--event SessionStart:resume`, `--event Notification:idle_prompt` |
| `--hook <#\|text>` | One hook, by its number in `list` or a unique part of its command (or a plugin's name) |
| `--input <file.json>` | `run`: send this JSON (its `hook_event_name` picks the event) to the hooks whose matcher matches it, instead of a fixture |
| `--command <text>` | `run`, `explain`: the shell command in the Bash and PowerShell fixtures. Default `npm test` |
| `--file <path>` | `run`, `explain`: the file the Read, Edit and Write fixtures name. Default `src/hook-bench-sample.ts` in the project, which need not exist, so a formatter hook changes nothing real |
| `--plugin-dir <dir>` | Also load a plugin folder's hooks, as `claude --plugin-dir` would. Repeatable |
| `--no-plugins` | Leave installed plugins out |
| `--timeout <seconds>` | `run`: the most a hook may take in this bench. Default 30. The hook's own timeout (its `timeout` field, or the event's default) still applies when it is shorter, and is reported either way |
| `--http` | `run`: also run `http` hooks (posts the event's JSON to each hook's url and judges the response) |
| `--fail-on error\|warn` | Exit 1 when any problem (`error`), or any problem or warning (`warn`), was found. For a build |
| `--json` | One JSON document on stdout |
| `--markdown` | `run`: a short markdown report for the skill (at most 40 rows) |
| `--verbose` | `run`: full stdout and stderr of every hook, and a line per hook as it starts |
| `--no-color` | No colour on a terminal; `NO_COLOR` does the same |

Exit codes: 0 for a normal run, whatever the verdicts; 1 with `--fail-on` when the threshold is met; 2 for a usage error, or an `explain` that matches no hook or several. `CLAUDE_CONFIG_DIR` moves Claude's config folder, as it does for Claude Code, and the report says which folder it used.

### `run`

A real run on a project settings file with one hook and a user settings file with eleven (paths shortened; the runs of the catch-all hook #3 are cut to three):

```text
$ claude-hook-bench run --command "rm -rf /tmp/build"
claude-hook-bench 1.0.0  every hook, run with its event's JSON
project   ~/work/shop
config    ~/.claude  (from CLAUDE_CONFIG_DIR)

Hook sources (managed, local, project and user settings, then enabled plugins)
  managed  C:/Program Files/ClaudeCode/managed-settings.json  not found
  local    .claude/settings.local.json                        not found
  project  .claude/settings.json                              1 hook
  user     ~/.claude/settings.json                            11 hooks

  #1 PreToolUse "Bash"  command  node ${CLAUDE_PROJECT_DIR}/.claude/hooks/no-rm.mjs
      project, .claude/settings.json:3  timeout 600s (default)
      PreToolUse:Bash              denies  (exit 0, 54 ms)
          permissionDecision: deny blocks the tool call; Claude sees: "no rm -rf"
          stdout:
            {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no rm -rf"}}

  #2 PreToolUse "Edit|Write"  command  echo formatted
      user, ~/.claude/settings.json:3  timeout 600s (default)
      PreToolUse:Edit              silent  (exit 0, 39 ms)
          plain stdout goes to the debug log only; Claude never sees it
          stdout:
            formatted
      PreToolUse:Write             silent  (exit 0, 37 ms)
          plain stdout goes to the debug log only; Claude never sees it
          stdout:
            formatted

  #3 PreToolUse (every)  command  node -e 0
      user, ~/.claude/settings.json  timeout 600s (default)
      PreToolUse:Bash              silent  (exit 0, 47 ms)
          nothing printed, exit 0: no decision, the normal flow applies
      PreToolUse:PowerShell        silent  (exit 0, 46 ms)  [input from the docs]
          nothing printed, exit 0: no decision, the normal flow applies
      PreToolUse:Read              silent  (exit 0, 44 ms)
          nothing printed, exit 0: no decision, the normal flow applies
      ...

  #4 PostToolUse "Write|Edit"  command  node ${CLAUDE_PROJECT_DIR}/../cfg/hooks/generated.mjs
      user, ~/.claude/settings.json:26  timeout 600s (default)
      PostToolUse:Write            adds context  (exit 0, 52 ms)
          additionalContext (23 characters) reaches Claude next to the tool result
          stdout:
            {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"This file is generated."}}
      PostToolUse:Edit             adds context  (exit 0, 51 ms)
          additionalContext (23 characters) reaches Claude next to the tool result
          stdout:
            {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"This file is generated."}}

  #5 UserPromptSubmit (every)  command  node ~/.claude/hooks/budget.mjs
      user, ~/.claude/settings.json:40  timeout 30s (default)
      UserPromptSubmit             silent  (exit 0, 48 ms)
          nothing printed, exit 0: no decision, the normal flow applies

  #6 Stop (every)  command  node ~/.claude/hooks/tests-first.mjs
      user, ~/.claude/settings.json:53  timeout 600s (default)
      Stop                         keeps Claude working  (exit 0, 57 ms)
          decision: "block" keeps Claude working and gives it the reason as its next instruction; reason: "run the tests first"
          stdout:
            {"decision":"block","reason":"run the tests first"}

  #7 Stop (every)  command  node ~/.claude/hooks/summary.mjs
      user, ~/.claude/settings.json  timeout 600s (default)
      Stop                         non-blocking error  (exit 0, 57 ms)
          a non-blocking error: nothing is applied, the action goes ahead, and the notice carries the parse or validation message
          problem  invalid JSON output, systemMessage: expected string, received number
          stdout:
            {"systemMessage":5}

  #8 SessionStart "startup|resume"  command  node ~/.claude/hooks/issues.mjs
      user, ~/.claude/settings.json:77  timeout 600s (default)
      SessionStart:startup         adds context  (exit 0, 53 ms)
          plain stdout is added to Claude's context (19 characters)
          stdout:
            Issues assigned: 3
      SessionStart:resume          adds context  (exit 0, 50 ms)
          plain stdout is added to Claude's context (19 characters)
          stdout:
            Issues assigned: 3

  #9 SessionEnd (every)  command  node -e 0
      user, ~/.claude/settings.json:91  timeout 1.5s (default)
      note  SessionEnd hooks share a 1.5-second budget by default; a longer per-hook timeout raises it, up to 60 s
      SessionEnd:other             silent  (exit 0, 48 ms)
          nothing printed, exit 0: nothing happens

  #10 Notification "permission_prompt|idle_prompt"  command  /home/me/bin/ping.sh
      user, ~/.claude/settings.json:105  timeout 600s (default)
      error "/home/me/bin/ping.sh" does not exist, so the shell cannot run it ("No such file or directory", exit 127: a non-blocking error unless onFailure is "block")
      Notification:permission_prompt non-blocking error  (exit 127, 37 ms)  [input from the docs]
          a hook error notice appears in the transcript
          problem  exit code 127 with no valid JSON on stdout: a non-blocking error ("Failed with non-blocking status code: /usr/bin/bash: line 1: /home/me/bin/ping.sh: No such file or directory")
          stderr:
            /usr/bin/bash: line 1: /home/me/bin/ping.sh: No such file or directory
      Notification:idle_prompt     non-blocking error  (exit 127, 35 ms)  [input from the docs]
          ...

  #11 PreCompact (every)  command  node -e 0
      user, ~/.claude/settings.json:116  timeout 600s (default)
      PreCompact:manual            silent  (exit 0, 46 ms)  [input from the docs]
          nothing printed, exit 0: no decision, the normal flow applies

  #12 SubagentStop (every)  command  node -e 0
      user, ~/.claude/settings.json:130  timeout 600s (default)
      SubagentStop:Explore         silent  (exit 0, 46 ms)
          nothing printed, exit 0: nothing happens

26 runs of 12 hooks: 17 stay silent, 4 add context, 3 fail, 1 block, 1 keep Claude working
4 problems, 0 warnings
```

`[input from the docs]` marks a run whose JSON follows the hooks reference rather than a recording from the binary (see "What was verified"). Every tool-event hook with no matcher runs once per tool fixture: Bash, PowerShell, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Agent and an MCP tool (`mcp__memory__create_entities`, with its `mcp_server` field). A hook with `if` runs only when the fixture passes its rule, and the report says why it did not.

What the fixtures hold: the common fields (`session_id`, `transcript_path` to a transcript the bench wrote, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`) and the event's own fields with realistic values: a `Stop` hook gets `stop_hook_active`, `last_assistant_message`, `background_tasks` and `session_crons`; a `PostToolUse` hook on Edit gets the `tool_response` with `structuredPatch`; a `Notification` hook gets `message`, `title` and `notification_type`; a `SessionStart` hook on `resume` gets the cost fields of 2.1.251 and later. `explain` prints the whole document for any hook or event.

`http`, `mcp_tool`, `prompt` and `agent` hooks are listed and checked, not run: the first would open a connection, the second needs the MCP server, the last two call a model. `run` says so for each.

### `list`

```text
$ claude-hook-bench list
claude-hook-bench 1.0.0  the hooks Claude Code would run here
project   ~/work/shop
config    ~/.claude  (the default; CLAUDE_CONFIG_DIR is not set)

Hook sources (managed, local, project and user settings, then enabled plugins)
  managed  /etc/claude-code/managed-settings.json  not found
  local    .claude/settings.local.json             not found
  project  .claude/settings.json                   1 hook
  user     ~/.claude/settings.json                 7 hooks

  #1 PostToolUse "bash"  command  echo done
      project, .claude/settings.json:1  if Bash(git *)  timeout 600s (default)
      error matchers are case-sensitive: "bash" never matches the Bash tool

  #2 PreToolUse "Bash"  command  node ~/.claude/hooks/no-rm.mjs
      user, ~/.claude/settings.json:3  timeout 600s (default)
  #3 PreToolUse "Edit|Write"  command  echo checked
      user, ~/.claude/settings.json  timeout 5s

  #6 Notification "permission_prompt"  command  /nonexistent/notify.sh
      user, ~/.claude/settings.json:9  timeout 600s (default)
      error "/nonexistent/notify.sh" was not found on PATH or as a file, so the hook cannot start (a non-blocking error, unless onFailure is "block")

  #7 PreToolUs (every)  command  echo typo
      user, ~/.claude/settings.json:10  timeout 600s (default)
      error "PreToolUs" is not a hook event, so Claude Code never fires it (silently); did you mean PreToolUse?

  #8 UserPromptSubmit (every)  command  node ~/.claude/hooks/budget.mjs
      user, ~/.claude/settings.json:11  timeout 30s (default)

8 hooks on 7 events; 3 errors, 0 warnings

Not read by this tool: hooks in skill and subagent frontmatter, hooks added for the session, and server-managed settings.
```

The checks, from the hooks reference and from the binary (the ones marked verified were put to Claude Code 2.1.295; see below):

| Finding | Severity | Verified |
| --- | --- | --- |
| An event name Claude Code does not know (`PreToolUs`): the hook never fires, silently | error | yes |
| A matcher that can never match: the wrong case (`bash`), a value the event does not have (`SessionStart` with `start`), an MCP server name without `__.*`, a regular expression that does not compile | error | case and regex: yes |
| A matcher on an event without matcher support (`Stop`, `UserPromptSubmit` ...): ignored, the hook fires every time | warn | docs |
| `if` on an event that is not a tool event: the hook never runs; `if` that is not one permission rule | error | docs |
| A handler type the event does not run (`prompt` on `SessionStart`, `agent` on `PermissionRequest`) | error | docs |
| Exec form (`args` present): the executable is not on PATH, is a `.cmd` or `.bat` shim on Windows, or `command` has spaces; a script named in `args` does not exist | error | docs |
| Shell form: the script does not exist or is not executable, `jq` is used but not installed, a path placeholder is not quoted, `/dev/tty` is written to | error or warn | docs |
| `${CLAUDE_PLUGIN_ROOT}` in a settings file (only plugins get it), `${user_config.*}` in a shell-form plugin hook, a bare `$CLAUDE_PROJECT_DIR` in a PowerShell hook | error | docs |
| `timeout` that is not a positive number; `shell`, `onFailure`, `args` values that are not allowed; `once` in a settings file; `onFailure: "block"` on `Stop` or with `async`; `async` on a blocking event | error, warn or note | docs |
| `disableAllHooks` in effect, `allowManagedHooksOnly` set: which hooks still run | error | docs |
| The same handler in two settings files: runs once | note | docs |

### `explain`

```text
$ claude-hook-bench explain 2
claude-hook-bench 1.0.0  hook #2
...
When it fires  PreToolUse: before a tool call runs.
  The matcher is tested against tool_name: exactly "Bash".

How it runs  command hook in shell form through sh; timeout 600 s (the default for this event and type).

What Claude Code sends it  (stdin, one JSON object)
  {
    "session_id": "4f1a2b3c-0000-4000-8000-000000000001",
    "transcript_path": "~/.claude/projects/-home-me-work-shop/4f1a2b3c-0000-4000-8000-000000000001.jsonl",
    "cwd": "/home/me/work/shop",
    "prompt_id": "7e2f3a4b-0000-4000-8000-000000000002",
    "permission_mode": "default",
    "effort": { "level": "medium" },
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": { "command": "npm test", "description": "Run the test suite" },
    "tool_use_id": "toolu_01HB0001BENCH00000000"
  }
  This shape was recorded from Claude Code 2.1.295.

What Claude Code does with its answer
  exit 0, nothing printed: no decision, the normal flow applies.
  exit 2: blocks (stops the action); stderr is the reason.
  any other exit code: a non-blocking error (the action goes ahead; onFailure "block" would turn it into a block); a hook error notice names the first line of stderr.
  plain stdout on exit 0: written to the debug log only.
  JSON on stdout: hookSpecificOutput may hold permissionDecision (allow|deny|ask|defer), permissionDecisionReason (string), updatedInput (object), additionalContext (string); a top-level "decision": "block" deprecated here: "block" means deny and "approve" means allow.
  continue: false stops Claude after the hook (the tool call still went ahead when checked on 2.1.295); systemMessage shown to the user.
  A field of the wrong type anywhere makes Claude Code drop the whole output (nothing applied, a non-blocking error); a key hookSpecificOutput does not know for this event is ignored.
  Precedence between hooks: deny > defer > ask > allow.
  A timed-out command hook does not block (set onFailure: "block" to change that).
  Staying silent does not approve: the normal permission flow applies.

Run it: claude-hook-bench run --hook 2
```

`explain Stop` (any event name) prints the same for the event: its matcher values, handler types, default timeout, exit-code rules, output fields and a sample of its input.

### The JSON documents

`--json` prints one object. For `run`: `version`, `project`, `configDir`, `configSource`, `platform`, `files` (each settings file with `scope`, `path`, `exists`, `error`, `hooks`), `plugins` (`id`, `version`, `enabled`, `hooks`, `installPath`), `notes`, `disableAllHooks`, `allowManagedHooksOnly`, `hooks` (each with `n`, `event`, `matcher`, `type`, `handler`, `raw`, `scope`, `file`, `line`, `plugin`, `timeout`, `async`, `if`, `onFailure`, `findings`), `session` (`sessionId`, `folder` with `--keep`), `runs` and `summary`. A run holds `hook` (its number), `event`, `value` (the matcher value), `verified` (`recorded`, `docs`, `none` or `yours`), `input` (the JSON sent), `run` (`status`: `ran`, `timed-out` or `failed-to-start`; `exitCode`, `ms`, `timeoutMs`, `hookTimeoutMs`, `stdout`, `stderr`, `command`, `form`, `shell`), `verdict` (`outcome`: one of `block`, `allow`, `ask`, `defer`, `continue`, `stop`, `context`, `message`, `replace`, `silent`, `error`, `ignored`, `cancelled`; `verdict`, `effects`, `problems`, `warnings`, `parsed`, `validation` with its `problems` and `ignored` keys) and `envFile` (what the hook wrote to `CLAUDE_ENV_FILE`), or `skipped` with the reason. `summary` counts `hooks`, `runs`, `skipped`, `outcomes`, `problems` and `warnings`.

## How it works

It reads, on your machine only: the settings files that apply (`managed-settings.json` and `managed-settings.d/*.json` in the system folder, `<config folder>/settings.json`, `<project>/.claude/settings.json` and `<project>/.claude/settings.local.json`, in a git repository also the local file at the repository root as Claude Code does, except on Windows), `<config folder>/plugins/installed_plugins.json` and the `enabledPlugins` of the settings files to find the plugins that load, each one's `hooks/hooks.json` (and the manifest's `hooks` key), and the folders given with `--plugin-dir`.

`run` makes a throwaway session folder under the system temp folder: a transcript in Claude Code's format (two turns, with a tool call), a subagent transcript, and an empty file for `CLAUDE_ENV_FILE`. For each hook and each matching event value it builds the event's JSON, checks the hook's `if` rule against it, and runs the hook as Claude Code would: exec form (`command` plus `args`, spawned directly, no shell) or shell form (`sh -c` on macOS and Linux; Git Bash on Windows, with the placeholders written with forward slashes as Claude Code does; PowerShell when Git Bash is not installed or the hook says `shell: "powershell"`, with `${CLAUDE_PROJECT_DIR}` rewritten to `${env:CLAUDE_PROJECT_DIR}`), in the project folder, with `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` substituted and exported, and `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT` and (on `SessionStart`, `Setup`, `CwdChanged` and `FileChanged`) `CLAUDE_ENV_FILE` set. It also sets `CLAUDE_HOOK_BENCH=1`, which Claude Code never does, so a hook that must not run in a bench can check for it. The JSON goes to stdin; stdout, stderr, the exit code and the time are collected; a hook that is still running at its timeout (its own, or the bench's 30-second cap, whichever is shorter) is killed and reported as timed out.

The output is then read the way the hooks reference says Claude Code reads it, confirmed on the binary: stdout that is one JSON object (with nothing around it but whitespace) is JSON, anything else is plain text or, when it starts with `{` and ends with `}` without parsing, a parse failure; a JSON object is checked against the output schema (the universal fields and the event's own `hookSpecificOutput` fields, each with its type); the exit code is combined with that (0: the fields apply; 2: a block on the events that block, with stderr as the reason; anything else: a non-blocking error unless the JSON is valid, in which case the fields alone decide); and each field that survives is turned into what Claude Code does with it on that event. The folder is removed at the end (`--keep` keeps it).

It writes nothing else: never a settings file, a plugin or a hook script. It makes no network request and has no telemetry or account. The tests check that: a test fails if any file of the package imports anything but `node:fs`, `node:os` and `node:path`, except `src/runner.mjs`, the one file allowed to start a process.

## What was verified, and how

Checked on 2026-10-15 and 2026-10-16 on Windows 11 with Node 24.19.0, git 2.55 and Claude Code 2.1.295 (the binary bundled with the desktop app). CI runs the unit tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18, and the real-binary checks on Linux and macOS against the npm release of Claude Code; the badge at the top shows the latest run.

- **94 automated tests** (`npm test`, Node's own runner, no dependencies, about seven seconds; on Node 20 and newer `node --test` also reports each of the three helper files under `test/` as a passing test, which is not counted here). Five run only when `E2E_CLAUDE` names a Claude Code binary and are skipped otherwise; with it pointing at Claude Code 2.1.295, all 94 passed here. They cover the event table against the reference's list, the fixtures (every event and value, the recorded key lists in order, the tool inputs), the stdout parsing rule, the type rules and 70 outputs with the verdict the binary gave each, matchers and `if` rules against the reference's tables, the settings loader (precedence, drop-in folders, git roots, plugins, `--plugin-dir`, files that are not JSON or not the right shape), every static check, the runner (exec and shell form, placeholders, the environment, stdin, timeouts, a missing executable), the three commands end to end on sandboxes with their reports in text, markdown and JSON, the command line, and the package files. Nothing reads or writes outside temporary folders: `test/helpers.mjs` points `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the managed-settings folder at a throwaway folder before any test runs.
- **The JSON Claude Code sends, recorded from the binary.** A recording hook was registered on every event in a throwaway config, and Claude Code 2.1.295 was run in `-p` mode against a fake Messages API on 127.0.0.1 that made the model call Bash, Read (two at once), Write, Edit, Glob, Grep, a failing Bash command, an Agent, and change a watched file and a settings file; a second run used `--permission-mode default` so that a Write needed permission, a third a slash command, a fourth `--init-only`. 17 events fired and were recorded: SessionStart, Setup, InstructionsLoaded, UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest, SubagentStart, SubagentStop, MessageDisplay, Stop, SessionEnd, FileChanged and ConfigChange. The fixtures for those events have exactly the recorded keys, in the recorded order, with the recorded types (`test/fixtures.test.mjs` pins the key lists), including the `tool_response` shapes of Bash, Read, Write, Edit, Glob and Grep and the fields the reference does not show: `prompt_id` on every event after the first prompt, `effort: { level }` on the tool and turn events, `permission_mode` on some events and not others, `tool_use_id` absent from PermissionRequest, `noOutputExpected` in a Bash result, `countIsComplete` in a Glob result. `test/e2e-claude.test.mjs` repeats the recording against the binary (9 events in one `-p` run) and fails if a fixture has a key or a type the binary did not send; CI runs it on Linux and macOS with the newest npm release, so a change in Claude Code's JSON shows up there. The other 16 events (Notification, PermissionDenied, TaskCreated, TaskCompleted, StopFailure, TeammateIdle, CwdChanged, DirectoryAdded, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult) could not be fired in a `-p` run; their fixtures follow the reference's examples, and `run` marks them `[input from the docs]`.
- **What Claude Code does with a hook's answer: 86 outputs put to the binary.** With a `PreToolUse` hook on Bash printing a given stdout and stderr and exiting with a given code, and a `PostToolUse` hook recording whether the tool then ran, 45 outputs were put to Claude Code 2.1.295 (a valid deny; the same with a wrong-typed `systemMessage`, an unknown top-level field, an uppercase `DENY`, no `hookEventName`, another event's `hookEventName`; the deprecated `decision: "block"` and `"approve"`; plain text; exit 2 with stderr; exit 1 with stderr; exit 1 with valid JSON; two JSON lines; `allow` with no allow rule; `ask`; `updatedInput`; a timeout with and without `onFailure: "block"`; exit 1 with `onFailure: "block"`; an async deny; `hookSpecificOutput` as a string; pretty-printed JSON; JSON with trailing text; text before the JSON; a trailing comma; a JSON array; `permissionDecision` at the top level; `continue: false`; `if` that matches and that does not; a regex matcher; a lowercase matcher; a comma list; a misspelled event; and more), 36 on Stop, UserPromptSubmit, SessionStart, PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStop and MessageDisplay, and 5 more on PermissionRequest with a command that needs permission. `judge()` in `src/output.mjs` gives the verdict the binary gave on all 86 (`test/output.test.mjs` holds the tables), and `test/e2e-claude.test.mjs` re-runs 17 of the PreToolUse cases against the binary in CI, failing if the binary and the verdict disagree. Findings the reference does not state are listed below.
- **The bench against the binary.** `test/e2e-claude.test.mjs` also writes a settings file with a hook that denies `rm -rf`, runs the real binary twice (a harmless command runs, `rm -rf` is refused and listed under `permission_denials`), then runs this bench on the same config: `silent` for the harmless command, `denies` with the hook's reason for `rm -rf`.
- **The environment a hook gets** was read from the recording hook: `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID` on every event; `CLAUDE_ENV_FILE` (`<config>/session-env/<session>/sessionstart-hook-0.sh`) on SessionStart and Setup only; `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (`<config>/plugins/data/<name>-<marketplace>`, `-inline` for `--plugin-dir`) for a plugin's hooks, with forward slashes for a shell-form hook under Git Bash and the platform's slashes for an exec-form hook. On Windows with `CLAUDE_CODE_GIT_BASH_PATH` set, shell-form hooks ran in Git Bash (`$0` was `/usr/bin/bash`); without it, in PowerShell (the file a `>>` redirect wrote was UTF-16).
- **The plugin.** `claude plugin validate .` passes, also with `--strict`, with Claude Code 2.1.295 and a throwaway config folder; installed from a local marketplace, `claude plugin details` lists one skill and an always-on estimate under 30 tokens (`test/e2e-claude.test.mjs`). The toolkit's marketplace does not list it yet, so the `/plugin install hook-bench@claude-code-toolkit` line above has not been tried.
- **Timings** on this machine, for the twelve hooks of the `run` sample above: `list` 0.23 s, `explain` 0.23 s, `run` 1.45 s for 26 runs (each hook is a Node process that starts in about 45 ms); medians of three runs.

### Found on the binary, not in the reference

- **A field of the wrong type anywhere makes the whole output invalid.** The reference says, of async hooks, that Claude Code "drops any field whose value has the wrong type". For a synchronous hook on 2.1.295 nothing is kept: a valid deny with `"systemMessage": 5` beside it, or with `"permissionDecisionReason": 7`, or with `"additionalContext": 42`, let the tool run, as did `"continue": "false"`, `"suppressOutput": "yes"`, `"permissionDecision": "DENY"` and `hookSpecificOutput` as a string. The debug log reads `Hook JSON output validation failed — reason: expected string, received number`, and the run counts as a non-blocking error. `run` reports each such output as `non-blocking error` with the offending field.
- **Unknown top-level keys are fine; unknown keys inside `hookSpecificOutput` are dropped; another event's name applies nothing.** A deny with `"foo": 1` beside it still denied. `permissionDecision` inside a `hookSpecificOutput` whose `hookEventName` is `PostToolUse` was logged as `unrecognized keys (ignored)` and the tool ran; `additionalContext` under `hookEventName: "SessionStart"` from a UserPromptSubmit hook failed with `Hook returned incorrect event name`. `permissionDecision` at the top level is ignored with the same `unrecognized keys` line.
- **`hookEventName` is required.** `{"hookSpecificOutput": {"permissionDecision": "deny"}}` without it let the tool run.
- **A misspelled event (`PreToolUs`) and a lowercase matcher (`bash`) fire nothing, silently.** The hook ran zero times and the debug log did not mention it.
- **`continue: false` on PreToolUse does not stop the tool call** on 2.1.295: the tool ran (the PostToolUse hook fired), and the session ended after it with `stop_reason: tool_use`.
- **`decision: "block"` without a `reason` still blocks a Stop hook** (Claude Code continued the turn with an empty instruction); a `reason` that is a number is a validation failure and Claude stops.
- **A timed-out PreToolUse hook lets the call through, and `onFailure: "block"` turns the same timeout into a block** with the message `timed out; blocking because onFailure is "block"`; exit 1 with `onFailure: "block"` blocks with `failed; blocking because onFailure is "block"` and the hook's stderr after it.
- **An async PreToolUse hook's deny has no effect**; its output arrived after the tool ran.
- **Exit 1 with valid JSON: the JSON decides.** A deny printed by a hook that exits 1 still denied.
- **Exit 2 on PermissionRequest is not honoured**: with no allow rule the call was refused by the normal flow ("This command requires approval"), not by the hook; a `decision.behavior` of `deny` was, with its `message` as the tool result.
- **`updatedToolOutput` that does not match the tool's shape is logged** (`does not match Bash's output shape: reason=schema_invalid`) and the original result is kept; one that matches replaces what the model sees.
- **`displayContent` from a MessageDisplay hook replaces the `result` of a `-p` run** too, not only what an interactive session shows.
- **`SessionStart` plain stdout and `additionalContext`, and `UserPromptSubmit` plain stdout, reached the model's request** (checked on the fake API's record of it); plain stdout from a UserPromptSubmit hook that exits 1 did not.
- **`initialUserMessage` from a SessionStart hook became the first turn** of a `-p` run: the fake API saw two requests.

## Not verified

- **16 of the 33 events** were not fired on the binary (the list above); their fixtures follow the reference. `run` marks them `[input from the docs]`.
- **PowerShell, WebFetch and WebSearch tool inputs**, the MCP tool input and `mcp_server` field, and the `tool_response` of Agent, WebFetch, WebSearch and MCP tools follow the reference, not a recording: the Agent in the recording ran in the background (`status: "async_launched"`), and WebFetch and WebSearch would have reached the network.
- **Output rules on the 24 events not in the tables above** (Notification, PreCompact, ConfigChange, TaskCreated ...) follow the reference's per-event sections and were not put to the binary.
- **`http` hooks** are run only when `--http` is given (they post the event's JSON to each hook's URL); without `--http`, and for `mcp_tool`, `prompt` and `agent` hooks, they are listed and checked, not run.
- **Hooks in skill and subagent frontmatter**, hooks added during a session, and server-managed settings are not read.
- **The `if` filter** is a reading of the reference's rules (subcommands, `$()`, leading assignments, file globs, `domain:` for WebFetch); Claude Code calls its own filter best-effort, and this one was checked against the reference's table, not against the binary.
- **Which shell Claude Code uses for a shell-form hook** on macOS and Linux (`sh -c` here, as the reference says) was not read from the binary; on Windows it was (Git Bash with `CLAUDE_CODE_GIT_BASH_PATH` set, PowerShell otherwise).
- **Other versions.** The Windows runs are Claude Code 2.1.295; CI runs the real-binary checks with the latest npm release on Linux and macOS, so a later version that sends different JSON or reads an answer differently shows up there as a red job.
- **The skill with a model.** Its one command was checked; what Claude then says about the report was not.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-hook-bench.mjs` | The command |
| `src/cli.mjs`, `src/bench.mjs` | Option parsing and exit codes; the three commands as plain objects |
| `src/events.mjs` | The 33 events: matcher field and values, handler types, timeouts, exit-code rules, output fields and types |
| `src/fixtures.mjs` | The JSON for every event and tool, as Claude Code sends it |
| `src/settings.mjs` | Finding the settings files and the enabled plugins |
| `src/matcher.mjs`, `src/check.mjs` | Matchers and `if` rules; the static checks |
| `src/runner.mjs` | Running a hook: exec and shell form, placeholders, environment, timeout. The only file that starts a process |
| `src/http.mjs` | HTTP hooks: posting event JSON, headers with `allowedEnvVars`, timeout. The only file using network modules |
| `src/output.mjs` | Parsing a hook's stdout, the output schema, the verdict |
| `src/report.mjs` | The text, markdown and JSON reports |
| `skills/check/` | `/hook-bench:check`, the user-only skill |
| `.claude-plugin/plugin.json` | The plugin manifest |
| `test/` | `npm test`; `e2e-claude.test.mjs` runs against the binary when `E2E_CLAUDE` is set, with `claude-sandbox.mjs` and `record-hook.mjs` |

Related: [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails), [claude-code-notify](https://github.com/nrzz/claude-code-notify) and [claude-cost-guard](https://github.com/nrzz/claude-cost-guard) are hooks; this bench runs them like any other.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-hook-bench/issues?q=is%3Aopen+label%3A%22good+first+issue%22). For a wrong verdict, send the hook entry and what it printed; that pair becomes a row of the table. Questions go to [Discussions](https://github.com/nrzz/claude-hook-bench/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay
- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them
- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep
- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases.

## License

MIT
