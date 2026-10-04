# Teaching session findings and fixes

This report covers the CS3214 session on 2026-10-04. Teaching remains paused.
The scope was lectures 1 to 10, exercises 0 to 1, and Project 1 Minibash.

The worktree started at `b5e7de1`, version 0.2.1. It advanced by fast-forward to
`origin/main` at `2a1067e`, version 0.3.0. At that point, its `src/` files matched
those in the installed 0.3.0 plugin cache. The fixes prepare version 0.3.1.

The real classroom was read only. Its lessons, submissions, scores, notes, and
learning records were not changed. Tests use temporary classrooms. The fixes are
prepared for review. Nothing was released.

## Findings

| Finding                                | Classification                                                    | Verified cause and result                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission notification friction       | Current MCP delivery constraint and teacher behavior              | This adapter delivers browser events through `wait_for_learner`. It cannot wake an idle client. Pi can push with `sendUserMessage`. Missing waits contributed to the session friction. Recovery and clearer instructions help. Other host delivery mechanisms were not implemented in this change.            |
| Partial credit disagreement            | Confirmed representation bug and authoring error                  | Question grades stored only `correct`. Overall scores could include partial credit without recording its distribution. The lesson 2 final is 78% with one of three questions marked correct. Changing rubrics between lessons was a teacher error.                                                            |
| Stale health after corrections         | Confirmed missing evidence link                                   | Health and review read quiz grades. Free-form learning records had no review-item link. Records 0002, 0003, 0005, and 0006 describe later corrections, but the computation could not use them. Health also flagged repeated misses after a later correct quiz answer. A regression test reproduced that case. |
| Changing URLs and occupied ports       | Session design and confirmed silent fallback                      | An unset port intentionally selects an ephemeral port for each session. The old server retried port 0 after `EADDRINUSE` on a configured port. The incident has no saved startup log that proves which path produced each reported port.                                                                      |
| Restart notification loss              | Hypothesis confirmed by regression                                | An ungraded submission on disk did not enter a fresh inbox when its classroom reopened. The test timed out instead of returning the submission. The submission itself was preserved.                                                                                                                          |
| Invalid JSON and missing teaching text | Confirmed silent error handling                                   | Config and store reads caught parse errors as absent state. `readDoc` returned empty text when a required document was missing. A corrupt annotation test reproduced the loss of the error.                                                                                                                   |
| Short-only response templates          | Confirmed authoring error; runtime conversion hypothesis rejected | The three real lessons contain 6, 5, and 5 questions. All 16 use `short`. The teacher received all nine supported types. Browser tests now submit and restore all nine types. No forced conversion to short was found.                                                                                        |
| Long wait loops                        | Teacher behavior encouraged by old guidance                       | The old default was 600 seconds. The maximum was 3000 seconds. The host brief told the teacher to repeat timed-out waits. This did not create a separate submission or grading defect.                                                                                                                        |

The saved diagnostic/final scores remain 0/33, 25/78, and 50/100. None of those
saved grades has per-question points. The fixes do not reconstruct missing points
or revise historical scores.

## Implemented changes

### Submission delivery and recovery

`open_classroom` restores pending questions, card follow-ups, and ungraded
submissions from the opened classroom. `wait_for_learner` also scans the classrooms
opened in this session. A request is delivered once per inbox lifetime. Requests
that are already answered or graded are excluded before delivery. Cancelled waits
keep later requests. A fresh MCP session can recover unfinished work again.

Recovery is tied to reopening and listening. It does not start a background server
or wake an idle client. Saved self-explanations are still available in lesson state
and health. They are not replayed as notifications because they have no persistent
acknowledgment state.

Waits accept integer values from 1 to 60 seconds. The default is 60 seconds.
Invalid values cause an error. A timeout tells the teacher to report the pause and
end its turn. The learner can ask it to resume. The pending quiz message explains
that MCP page requests reach the teacher while it listens.

### Partial credit and a fixed rubric

A question grade can store `pointsEarned` and `pointsPossible`. The grading tool
accepts `points_earned` and `points_possible`. When points are supplied, both fields
are required for every question. `correct` means full credit. Partial credit keeps
the item due for an early review and marks the incomplete idea in health.

The overall score must match the total earned points divided by the total possible
points. Integer rounding is allowed. Duplicate questions, missing questions,
invalid points, invalid scores, and contradictory correctness cause errors. The
stored score uses the exact point ratio. Scores are no longer clamped.

The browser shows fully correct and partial answers separately. Each point grade
shows its earned and possible points. An old score that disagrees with binary
question counts has a notice that its points or weights were not recorded.

The teaching brief and quiz contract require a private rubric before submission.
The teacher must use that rubric for every attempt. A missing rubric is an
explicit authoring error. Guidance stops grading until the teacher supplies it.
The runtime verifies score arithmetic. It does not judge whether a teacher applied
the educational criteria fairly.

### Current understanding and historical attempts

`record_retrieval_check` links a successful chat answer to an original review item
and an existing active learning record. It stores the actual answer and the new
question and evidence under `<classroom>/quiz/retrieval-checks/`. That directory
has no static route. The tool rejects unknown items, missing records, superseded
records, empty evidence, and duplicate links.

Health separates resolved quiz gaps from current misses. The original miss counts
stay visible as history. Review treats the later chat check as one correct answer.
A single correction does not meet the long-term mastery threshold. A later quiz
miss opens the gap again. Quiz grades and submissions stay unchanged.

The existing CS3214 prose records were not migrated. Their links need an explicit
review-item assessment. The code does not guess those links from prose.

### Ports and invalid state

A configured port is fixed. An occupied port now causes an error with the port and
`EADDRINUSE`. An invalid configured port also causes an error. With no port set,
the server uses an ephemeral port. Concurrent starts share one server.

A fixed port gives the same URL across session restarts when that port is free.
Only one session can own it at a time. There is no automatic stable alias for an
ephemeral URL. Always obtain the active URL from the classroom tool or command.
The session-scoped, in-process architecture remains intact.

An absent optional config or state file is allowed. Invalid JSON, incorrect JSON
container types, required state read failures, and filesystem access errors are
reported. A missing required teaching document throws. No substitute document or
settings are selected after an error.

### Question formats

Normal lesson guidance now asks for suitable response types within and across
lessons. Short explanations remain valid. Health reports a lesson with at least
three authored questions when all use `short`. This diagnostic asks the teacher to
check whether another retrieval format fits. It does not block submission.

For CS3214, numeric fits fork counts. Order fits state transitions. Cloze fits file
descriptor numbers and API names. Locate fits incorrect pipe closes. Choice and
multi fit quick privileged-operation checks. Short fits exec and race explanations.

## Verification

Regression tests cover restart recovery, request deduplication, stale queued
requests, classroom scope, partial credit, current health, linked chat checks,
later misses, preserved grades, invalid state, fixed ports, and wait validation.

The browser test covers all nine response types through submission and reload.
It also checks the 78% partial-credit fixture, pending MCP guidance, cross-tab
state, stale grades, quiz locking, and a grade that arrives before the submit
response.

The Claude Code and Codex round trips use temporary classrooms. Each answers a
page question, grades a wrong quiz answer, asks a new retrieval question in chat,
and ends its turn. They do not teach in the real CS3214 classroom.

| Command                    | Result                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- |
| `npm run check`            | Passed.                                                                           |
| `npm test`                 | Passed. 267 tests in 21 files.                                                    |
| `npm run e2e:browser`      | Passed. All nine types and partial-credit display passed.                         |
| `npm run e2e:claude`       | Passed. Page answer, grade, and chat check completed.                             |
| `npm run e2e:codex`        | Passed. Page answer, grade, and chat check completed.                             |
| `claude plugin validate .` | Passed. It reported the existing omitted-version warning for the Claude manifest. |
| `git diff --check`         | Passed.                                                                           |

The T3 shared preview did not attach automation. Browser verification used the
repository's existing Playwright test runner. No global package was installed.
The dependency lockfile changed only in its two root version fields.
