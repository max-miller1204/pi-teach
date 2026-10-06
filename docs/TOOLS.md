# Tool reference

[Back to the README](../README.md)

The agent uses these tools to create lessons and respond to learners.

| Tool                     | Purpose                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `answer_lesson_question` | Answer a highlighted-text question or a follow-up. The only thing that puts an answer on the learner's page. |
| `grade_lesson_quiz`      | Grade a submitted quiz. Writes to `quiz/grades/` and renders inline.                                         |
| `scaffold_classroom`     | Create a classroom in the canonical location with a `MISSION.md` stub.                                       |
| `scaffold_lesson`        | Create a numbered page. Choose mode lesson, quiz, or pretest. Return the authoring steps.                    |
| `scaffold_review`        | Create a spaced review lesson from the due questions, and return them with their keys and authoring steps.   |
| `record_retrieval_check` | Link successful chat evidence to a review item without changing scores.                                      |
| `lesson_health`          | Report threads, misses, glossary problems, unfinished questions, missing rubrics, and recent response types. |

Grades support per-question points. Partial credit appears separately from fully
correct answers. Health distinguishes incomplete answers and resolved gaps.
Historical grades stay unchanged. Historical grades without points cannot show
how partial credit was distributed.

The Claude Code and Codex plugin exposes authoring tools and these service tools.
The dedicated teacher owns answer, grade, and retrieval writes:

| Tool                | Purpose                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `begin_teaching`    | Return the teaching method and the learner's classroom. Replaces `/teach`.                         |
| `open_classroom`    | Start the service and return the URL. Open the browser only when requested. Replaces `/classroom`. |
| `list_classrooms`   | List classrooms and lessons with scores. Replaces `/classroom list`.                               |
| `classroom_service` | Start, inspect, or explicitly stop the service.                                                    |
| `classroom_phone`   | Start, inspect, or stop the owned phone route.                                                     |
