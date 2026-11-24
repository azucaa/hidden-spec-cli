# mend — hidden-spec-cli entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/azucaa/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/azucaa/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — the "Build mend, one patch tool for every AI edit format" bounty.

`mend` is a command-line tool that applies an edit an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON — and mend applies every edit in a patch, or
none of them, exactly as `SPEC.md` (the full specification, version 1) says.

## Running it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- Node 22, standard library only; there is no install step and nothing to download.
- `main.ts` is the CLI. `runner.ts` sits beside it unchanged from the kit: when `MAKEFUN_ENV_URL` is
  set, `main.ts` hands over to it and it runs the CLI once per check in a fresh directory and posts
  the results. `check.ts` runs the public practice set locally:

      node check.ts <practice.json>

- `--check` reports exactly what a real run would, but writes nothing. `--strict` matches lines
  exactly (tier 0 only). Without `--format`, the format is detected from the patch text.

## What it does

- All four formats are parsed completely before any file is looked at, so a parse error is reported
  before any per-edit failure, and usage errors win over everything (SPEC.md sections 1–2).
- Lines named by an edit are found at the first of three matching tiers — exact, trailing-whitespace
  insensitive, then leading-and-trailing-whitespace insensitive — with the re-indentation rule of
  section 5 applied at tier 2 and context lines always written as the file's own matched lines.
- Unified hunks are located by nearest position to the (possibly wrong) line number in the hunk
  header, honouring `\ No newline at end of file`, creations, deletions and renames; a successful
  move is reported as one `R <old> -> <new>` line.
- SEARCH/REPLACE blocks fail `ambiguous` when their old lines occur more than once at the tier where
  they occur; V4A chunks run under a cursor with anchors and end-of-file anchoring; JSON edits match
  exactly, with CRLF files round-tripped.
- Every path is checked for safety before anything else about its edit; a failed edit changes
  nothing, later edits still run, and when any edit failed no file is written at all.

## Choices where the specification leaves room

- A unified section's paths are taken in the order the specification lists them: the `---`/`+++`
  pair first, then `rename from`/`rename to`, then the `diff --git` paths.
- A body line at the end of a unified hunk counts as a removable trailing empty line only when the
  patch line itself was completely empty; a context line written as a single space is a real line.
- A file created by a SEARCH/REPLACE block or a V4A Add File section ends with a line break, as
  section 3 prescribes for created files whose format says nothing otherwise.

## Validation

The public practice set (100 checks: unified 30, search_replace 20, v4a 20, json 15, cli 15) passes
in full — `100 of 100 passed: practice score 1000` — and repeated runs give identical results.

## Licence

MIT — see `LICENSE`.

SPDX-License-Identifier: MIT
