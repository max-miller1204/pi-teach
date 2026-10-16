/** Dedicated teachers allocate points. The service calculates their total score. */
import { gradeScore } from "../assets/runtime/grade.mjs";
import type { ClassroomTool } from "./tools.ts";

export const GRADE_ANSWERS = "grade_quiz_answers";

export interface AnswerGrades {
  submission_id: string;
  feedback_markdown: string;
  questions: Array<{
    question_id: string;
    correct: boolean;
    feedback: string;
    points_earned?: number;
    points_possible?: number;
  }>;
}

/** Reject a redundant score before calculating from the unchanged point allocations. */
export function scoredAnswers(args: AnswerGrades) {
  if (Object.hasOwn(args, "score"))
    throw new Error(
      "grade_quiz_answers must omit score. The service calculates it from question points.",
    );
  if (!Array.isArray(args.questions)) throw new Error("Grade every submitted question.");
  const score = gradeScore(
    args.questions.map((q) => ({
      questionId: q.question_id,
      correct: q.correct,
      pointsEarned: q.points_earned,
      pointsPossible: q.points_possible,
    })),
  );
  return { ...args, score };
}

/** Keep the public grading tool and its rubric, identity, and score checks. */
export function answerGradingTool(tool: ClassroomTool): ClassroomTool {
  if (tool.name !== "grade_lesson_quiz") throw new Error("Expected the public grading tool.");
  const parameters = structuredClone(tool.parameters);
  delete (parameters.properties as Record<string, unknown>).score;
  parameters.required = (parameters.required as string[]).filter((key) => key !== "score");
  parameters.additionalProperties = false;
  return {
    ...tool,
    name: GRADE_ANSWERS,
    description:
      "Grade every submitted question from the fixed private rubric. Supply per-question points and feedback. Omit score. The service calculates the total from raw question points and validates the grade before saving it.",
    parameters,
    execute: (args: AnswerGrades) => tool.execute(scoredAnswers(args)),
  };
}
