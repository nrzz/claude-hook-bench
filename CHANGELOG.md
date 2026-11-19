# Changelog

All notable changes to claude-hook-bench are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-19

- `list`, `run --http` and `/hook-bench:check` warn when an `http` hook's header uses an environment variable that `allowedEnvVars` does not list, which Claude Code fills with an empty string: one warning for each reference, naming the header and the variable (`the header "X-Team" uses $TEAM, which allowedEnvVars does not list: Claude Code sends an empty string for it`), so `$TOKEN-$SECRET` gives two. A hook with no `allowedEnvVars` at all keeps its earlier warning. An `allowedEnvVars` entry that no header uses is a note, not a warning. The README's findings table has a row for http hooks.
- The check and the request share one pattern for a reference (`ENV_REF` in `src/http.mjs`), so they cannot disagree about what counts as one.
- Contributed by [@madhavidayma21](https://github.com/madhavidayma21) in [#4](https://github.com/nrzz/claude-hook-bench/pull/4), for the good first issue [#3](https://github.com/nrzz/claude-hook-bench/issues/3). The pull request's tests ran on Windows, macOS and Linux with Node 18 to 24, and the real-binary checks against Claude Code on Ubuntu and macOS, before the merge.
- The README's test count is 98: it counts tests, not the runner's 101, which includes the three helper files under `test/`.

## [1.1.0] - 2026-10-28

- `run --http` runs `http` hooks, which were listed and checked but not run: it posts the event's JSON to each hook's `url` and judges the response as Claude Code does. A 2xx with an empty body is success with no output; a 2xx with a JSON object goes through the same parsing, validation and verdict as a command hook's stdout; a 2xx with any other body, a non-2xx status and a connection failure are non-blocking errors. Header values fill `$VAR` and `${VAR}` only for the variables the hook lists in `allowedEnvVars` (any other reference becomes an empty string), and the hook's `timeout` applies. It is off by default because it opens a connection, and `src/http.mjs` is the only file that may.
- With `onFailure: "block"`, a 2xx whose body is neither empty nor a JSON object blocks, as invalid output, which is what the hooks reference says. The first version of the pull request left it a non-blocking error, as the issue had described it.
- Contributed by [@yoreva-01](https://github.com/yoreva-01) in [#2](https://github.com/nrzz/claude-hook-bench/pull/2), for the good first issue [#1](https://github.com/nrzz/claude-hook-bench/issues/1). The pull request's tests ran on Windows, macOS and Linux with Node 18 to 24, and the real-binary checks against Claude Code 2.1.312 on Ubuntu and macOS, before the merge.
- The README, CONTRIBUTING.md and SECURITY.md said the bench opens no network connection; they now say it opens none unless `--http` is given, and then only to the `url` of each `http` hook. "Not verified" says that the response rules follow the hooks reference, not a recording from the binary, that an administrator's `allowedHttpHookUrls` and `httpHookAllowedEnvVars` are not applied, and that a redirect is not followed here.
- The README's test count is 96: it counts tests, not the runner's 99, which includes the three helper files under `test/`.

## [1.0.0] - 2026-10-16

- First release. `run` runs every command hook of a Claude Code setup (the managed, user, project and local settings files, the enabled plugins' `hooks/hooks.json`, and folders given with `--plugin-dir`) once per matching event value, with the JSON Claude Code sends for that event on stdin, from a throwaway session folder, and reports per run: did it run, exit code, time, stdout and stderr, whether the output is valid for the event, and what Claude Code would do with it (`denies`, `allows`, `asks`, `keeps Claude working`, `adds context`, `shows a message`, `silent`, `non-blocking error`, `timed out`, `cannot start`). `--command` and `--file` change the shell and file fixtures, `--input` sends your own JSON, `--event Event:value` and `--hook` pick a run, `--timeout` caps a run. `list` shows every hook with its source and the findings of the static checks. `explain` describes one hook (when it fires, how it runs, the exact JSON it gets, how its answer is read) or one event. `--json` everywhere, `--markdown` for the skill, `--fail-on error|warn` for a build.
- A plugin with one user-only skill, `/hook-bench:check`.
- The event table covers the 33 events of the hooks reference. The JSON for 17 of them was recorded from Claude Code 2.1.295 through its own binary and a fake API, and the fixtures pin the recorded keys, order and types; 86 hook outputs were put to the binary to see what it does with each, and the verdicts follow the binary where it and the reference differ (README "What was verified"). `test/e2e-claude.test.mjs` repeats the recording and 17 of the outputs against the binary; CI runs it on Linux and macOS with the newest npm release.

[1.2.0]: https://github.com/nrzz/claude-hook-bench/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/nrzz/claude-hook-bench/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nrzz/claude-hook-bench/releases/tag/v1.0.0
