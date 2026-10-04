export interface QuestionCredit {
  questionId: string;
  correct: boolean;
  pointsEarned?: number;
  pointsPossible?: number;
}
export declare function questionCredit(question: QuestionCredit): {
  earned: number;
  possible: number;
};
export declare function gradeScore(questions: QuestionCredit[]): number;
export declare function validateGrade(
  score: number,
  questions: QuestionCredit[],
  questionIds: string[],
): number;
export declare function questionOutcome(
  question: QuestionCredit,
): "correct" | "partial" | "incorrect";
export declare function questionGradeLabel(question: QuestionCredit): string;
export declare function gradeSummary(questions: QuestionCredit[]): string;
export declare function gradePointsNotice(grade: {
  score: number;
  questions: QuestionCredit[];
}): string;
