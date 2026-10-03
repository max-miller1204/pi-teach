# pi-teach e2e run

### Browsing: landing, classroom, lesson

- ✅ Landing page lists the classroom
- ✅ Classroom page lists lesson 001
- ✅ Classroom page links MISSION and NOTES
- ✅ Classroom page shows learning records
- ✅ Runtime adds breadcrumb header + theme toggle

### Pretest (ungraded diagnostic) and predict-then-reveal

- ✅ Pretest has no confidence ratings
- ✅ Pretest submitted and locked
- ✅ Predict answer hidden before a guess
- ✅ Predict answer revealed after committing a guess

### Highlight to ask (sent while the pretest is being graded)

- ✅ Selecting lesson text shows the Ask pill
- ✅ Card inserted in the document flow with a pending spinner
- ✅ Pretest graded by the agent via grade_lesson_quiz — Pretest
- ✅ Question answered into its card over SSE (answer_lesson_question) — It saves transferring the CSS, not making the request.  With no-cache and an ETag, the cac…

### Links

- ✅ External source link opens in a new tab on click (links.mjs) — https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2

### Card thread: persistence, follow-up, minimise

- ✅ Card and answer survive a reload (/api/state hydration)
- ✅ Pretest grade survives a reload
- ✅ Follow-up appended to the same card thread
- ✅ Follow-up answered in the thread with full context — Yes—if changing the CSS always changes its filename, you can favor reuse without checking.…
- ✅ Minimise collapses the card to a margin badge
- ✅ Badge reopens the card

### Graded quiz with confidence ratings

- ✅ Graded quiz gets Sure/Unsure/Guessing controls
- ✅ Quiz graded inline by the agent — 100%
- ✅ Per-question verdicts rendered
- ✅ Retake button offered after grading

### Retake (spaced retrieval) — a confident mistake

- ✅ Retake clears answers and grade
- ✅ Retake graded as a separate attempt — 0%
- ✅ Reload restores the latest attempt for this quiz id

### Keyboard asking (Alt+A) and deleting a card

- ✅ Alt+A opens the composer for a keyboard selection
- ✅ Escape closes the composer

### Dark theme

- ✅ Theme toggle sets data-theme=dark
- ✅ Theme persists across pages (localStorage bootstrap)
- ✅ Classroom page shows the lesson's latest score and question count — badges "0%" and "1 Q"

### Search, records, and documents

- ✅ Header search finds ETag across lesson/notes/threads — 6 links on results page
- ✅ Search indexes question threads (follow-up text)
- ✅ Learning records page renders
- ✅ NOTES.md renders as a document
- ✅ MISSION.md renders as a document

### Request guards (DNS rebinding, cross-site writes, quiz/ privacy, traversal)

- ✅ Foreign Host header refused (DNS rebinding)
- ✅ Cross-site POST /api/ask refused
- ✅ Form-encoded POST refused (needs application/json)
- ✅ quiz/ (submissions + answer key) is not served
- ✅ Path traversal refused

### Deleting a card

- ✅ Delete asks for confirmation; cancel keeps the card

### Leftover work survives an aborted run and a Pi restart

- ✅ Aborted run leaves the question pending on disk — How do I make a CDN drop the old CSS right after a deploy?
- ✅ New session's /classroom mentions the waiting question — 📚 http-caching-headers has 1 question from an earlier session still waiting — run /teach http-caching-headers to have them answered.
- ✅ Reloaded lesson shows the leftover question still pending
- ✅ /teach in the new session claimed and answered it; card updated live over SSE — Use your CDN’s purge/invalidation feature for the CSS URL. Make the new CSS available at t…
- ✅ /teach brief carries the computed snapshot (scores, review state, missed questions)

### Spaced review schedule

- ✅ Failed attempt from 2 days ago (attempts backdated on disk) → lesson shows 'review due'

### Offline export

- ✅ /classroom export reports the written index — 📚 Exported http-caching-headers — open /tmp/pi-teach-e2e/classrooms/_exports/http-caching-headers/index.html in any browser. It reads offline; asking and gradi
- ✅ Export has index.html and lessons/<slug>.html — MISSION.html, NOTES.html, RESOURCES.html, index.html, learning-records/0001-prior-http-knowledge.html, learning-records/0002-pretest-freshness.html, learning-records/0003-validation-understood.html, learning-records/0004-revalidation-not-secure.html, learning-records/index.html, lessons/001-freshness-before-revalidation.html, notes/deployment-context.html
- ✅ Export never contains quiz/ (answer key, submissions)
- ✅ Exported lesson has a UTF-8 BOM
- ✅ Exported lesson includes the question threads and grades, readable offline

### Deleting a card, status widget, stopping the server

- ✅ Confirmed delete removes the card and its highlight, persisted
- ✅ Status widget reads 'classroom server running on port 4199'
- ✅ /classroom stop closes the server and clears the widget
