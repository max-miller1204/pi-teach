# Notes Format

`NOTES.md` is an **index**, not a notebook. It stays short enough to read in full at the start of every session, and it points to topic files in `./notes/` that hold the detail. You open a topic file only when the work in front of you touches it.

This is progressive disclosure: the index tells you what is known and where, and you pay for the detail only when you need it. A `NOTES.md` that grows into one long blob has to be read end to end every time anything in it changes.

## Template

```md
# Notes

## Preferences

- {A standing preference that shapes every lesson — keep this to a handful of bullets}

## Index

- [{Topic title}](notes/{slug}.md) — {one line: what is in it and when to open it}
```

`## Preferences` is the only detail that lives in `NOTES.md` itself, because it applies to every lesson: how they like to be taught, how long a session should run, what to avoid. If a preference needs more than a line, it is a topic file.

Each index line is a link and a hook. Write the hook so you can decide from the index alone whether to open the file — "how they debug, and the misconceptions that keep recurring" beats "debugging notes".

## Topic files

One file per topic in `./notes/`, named with a lowercase slug: `notes/debugging-habits.md`, `notes/session-log.md`, `notes/curriculum-plan.md`. Create the directory lazily, when the first topic file is written.

```md
# {Topic title}

{The notes. Any shape that suits the topic.}
```

Good topics are the things you keep coming back to: a curriculum plan, observed misconceptions, how they respond to different kinds of exercise, things they have asked to revisit, a running log of sessions.

## Editing

1. Read `NOTES.md`.
2. Open only the topic file the change belongs to. If none fits, create one.
3. Edit the topic file.
4. Add or update its index line in `NOTES.md` if the file is new, or if its hook no longer describes it.

Never append detail to `NOTES.md` itself. If you find it has already grown into a blob, split it into topic files the first time you touch it, and leave behind the preferences and the index.

## What does not belong here

- What they have learned. That is a learning record (see `LEARNING-RECORD-FORMAT.md`).
- Sources. Those go in `RESOURCES.md`.
- Terminology. That goes in `GLOSSARY.md`.
