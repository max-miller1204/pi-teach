# Start a review

Start a spaced review from the classroom page. Pi uses its live session. Claude Code
and Codex use the persistent teacher. The service saves the authoring plan before
it writes the review files.

## Sub-features

- Start a review of due items from classroom Progress.
- Keep creation status after reload.
- Reject unfinished controls and show an explicit retry.
- Return to saved answers in an unfinished review.
- Grade a review and update its original item schedule.
- Preserve the host that owns each request.

## How to get to it (user POV)

1. Open a classroom with due questions.
2. Select `Start review` in Progress.
3. Read the creation status. You can reload or leave the page.
4. Use `Retry review` if creation fails.
5. Answer the review when it opens.
6. Use `Continue review` to return to an unfinished review.

## Driving it with playwright-cli

Run `npm run verify -- browser --artifacts /tmp/pi-teach-review-browser`.

The review fixtures check Pi and the service. They cover creation, reload, failure,
explicit retry, invalid controls, host ownership, automatic navigation, saved answers, mobile controls, private
rubric routes, submission, grading, and the original item schedule. Inspect `review/pi/result.json` and `review/service/result.json`.
Inspect the screenshots before citing them.

Live host review authoring remains a coverage gap in this layer. The browser fixtures
prove the UI, persistence, and recovery through the production teacher boundaries.

## Gotchas

Repeated clicks reuse the request and selected items. Failed work needs an explicit
retry. A saved service plan resumes without another model turn. Interrupted Pi
creation fails visibly after its owning process stops. A live Pi process and service
work must keep their requests. The service cannot take over Pi review work.

Private selected items and rubric files must stay off HTTP routes. An unfinished
review must stay unavailable. A completed review uses the existing quiz runtime.
The browser fixtures do not judge question quality or human retention.
