# Group classrooms

The learner groups classrooms in folders without changing lesson links.

## Sub-features

- Create and rename folders.
- Move a classroom between folders or return it to Unfiled.
- Delete a folder and keep its classrooms and lessons.
- Keep folder membership after reload.
- Show failed edits and folder load errors. Require an explicit retry.

## How to get to it (user POV)

1. Open the Classrooms page at the server root.
2. Select `New folder`.
3. Enter a folder name.
4. Select `Create folder`.
5. Select `Move to folder` on a classroom.
6. Select its destination.
7. Select `Move classroom`.
8. Open the folder to rename or delete it.

## Driving it with playwright-cli

Run `npm run verify -- browser --artifacts /tmp/pi-teach-folders`.

The suite drives `New folder`, the `Folder name` input, and `Create folder`. It
rejects a duplicate name. It opens each classroom's `Move <title> to folder`
button, selects the `Folder` control, and submits `Move classroom`. The classroom
must appear only in its saved destination after reload. Moving to `Unfiled` must
return it to the Classrooms page.

The suite opens `Rename folder` and saves a new name. The folder URL must stay
unchanged. Its classroom link must still open the same lesson list. A refused
move must show its error, keep the dialog open, and preserve saved membership.
The next move starts only after an explicit user action.

The suite cancels `Delete folder` before confirming it. Confirmation must return
the classrooms to Unfiled. Reload must keep that result. The suite checks saved
membership and unchanged lesson content. It captures desktop light and mobile
dark layouts and checks mobile overflow.

The suite opens a page with corrupt folder state. The page must show a specific
read error. After the fixture repairs that state, `Retry loading` must restore
the saved classrooms.

The required checks also send concurrent folder requests to two loopback servers
with one shared root. Every accepted edit must remain saved. Conflicts must
return HTTP 409. Explicit retries must save the refused edits.

## Gotchas

Use the shared launch and cleanup instructions. The browser suite uses scratch
classrooms. It does not change the learner's saved folders. Folder load errors
must not create an empty folder list. A process that stops during a save can
leave a lock file. The error names that file. Remove it only after the owning
server stops, then retry the edit.
