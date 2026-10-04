import { describe, expect, it } from "vitest";
import {
  gradePointsNotice,
  gradeSummary,
  questionGradeLabel,
  questionOutcome,
  validateGrade,
} from "../assets/runtime/grade.mjs";

const questions = [
  { questionId: "q1", correct: true, pointsEarned: 9, pointsPossible: 9 },
  { questionId: "q2", correct: false, pointsEarned: 7, pointsPossible: 9 },
  { questionId: "q3", correct: false, pointsEarned: 5, pointsPossible: 9 },
];

describe("partial credit", () => {
  it("represents a rounded 78% score with one complete and two incomplete answers", () => {
    expect(validateGrade(78, questions, ["q1", "q2", "q3"])).toBeCloseTo(77.7778);
    expect(gradeSummary(questions)).toBe("1 of 3 fully correct · 2 partial credit");
    expect(questionGradeLabel(questions[1])).toBe("Partial credit (7/9 points)");
    expect(questionOutcome(questions[1])).toBe("partial");
  });

  it("reads historical binary grades without inferring unrecorded partial points", () => {
    const old = [{ questionId: "q1", correct: false }];
    expect(questionGradeLabel(old[0])).toBe("Incorrect");
    expect(gradeSummary(old)).toBe("0 of 1 fully correct");
    expect(gradePointsNotice({ score: 75, questions: old })).toContain("no per-question points");
    expect(gradePointsNotice({ score: 0, questions: old })).toBe("");
  });

  it("refuses inconsistent scores, correctness, invalid points, and duplicate questions", () => {
    expect(() => validateGrade(33, questions, ["q1", "q2", "q3"])).toThrow(/Score must match/);
    expect(() => validateGrade(78, [{ ...questions[1], correct: true }], ["q2"])).toThrow(
      /full credit/,
    );
    for (const patch of [
      { pointsEarned: -1 },
      { pointsEarned: 10 },
      { pointsPossible: 0 },
      { pointsEarned: undefined },
    ]) {
      expect(() => validateGrade(78, [{ ...questions[1], ...patch }], ["q2"])).toThrow(
        /Invalid points/,
      );
    }
    expect(() => validateGrade(100, [questions[0], questions[0]], ["q1"])).toThrow(/exactly once/);
    expect(() => validateGrade(140, [questions[0]], ["q1"])).toThrow(/Score must match/);
    expect(() => validateGrade(99.8, [questions[0]], ["q1"])).toThrow(/Score must match/);
  });
});
