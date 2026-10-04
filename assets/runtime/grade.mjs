/** Shared grading rules. This module has no DOM dependencies. */
export function questionCredit(question) {
  const { pointsEarned, pointsPossible } = question;
  if (pointsEarned === undefined && pointsPossible === undefined) {
    return { earned: question.correct ? 1 : 0, possible: 1 };
  }
  if (
    !Number.isFinite(pointsEarned) ||
    !Number.isFinite(pointsPossible) ||
    pointsPossible <= 0 ||
    pointsEarned < 0 ||
    pointsEarned > pointsPossible
  ) {
    throw new Error(`Invalid points for question ${question.questionId}.`);
  }
  if (question.correct !== (pointsEarned === pointsPossible)) {
    throw new Error(`Question ${question.questionId}: correct must mean full credit.`);
  }
  return { earned: pointsEarned, possible: pointsPossible };
}

export function gradeScore(questions) {
  if (questions.length === 0) throw new Error("Grade every submitted question.");
  let earned = 0;
  let possible = 0;
  for (const question of questions) {
    if (typeof question.correct !== "boolean")
      throw new Error(`Question ${question.questionId} needs a boolean correct value.`);
    const credit = questionCredit(question);
    earned += credit.earned;
    possible += credit.possible;
  }
  if (!Number.isFinite(earned) || !Number.isFinite(possible))
    throw new Error("Total question points must be finite.");
  return (earned / possible) * 100;
}

export function validateGrade(score, questions, questionIds) {
  const ids = questions.map((q) => q.questionId);
  if (new Set(ids).size !== ids.length) throw new Error("Grade each question exactly once.");
  if (ids.length !== questionIds.length || questionIds.some((id) => !ids.includes(id))) {
    throw new Error("Grade every submitted question. Use only submitted question ids.");
  }
  const expected = gradeScore(questions);
  if (
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100 ||
    (Math.abs(score - expected) > 1e-9 && score !== Math.round(expected))
  ) {
    throw new Error(
      `Score must match question points: ${expected.toFixed(2)}%. Supply per-question points for partial credit.`,
    );
  }
  return expected;
}

export function questionOutcome(question) {
  const { earned, possible } = questionCredit(question);
  return earned === possible ? "correct" : earned > 0 ? "partial" : "incorrect";
}

export function questionGradeLabel(question) {
  const outcome = questionOutcome(question);
  const points =
    question.pointsPossible === undefined
      ? ""
      : ` (${question.pointsEarned}/${question.pointsPossible} points)`;
  return (
    (outcome === "correct" ? "Correct" : outcome === "partial" ? "Partial credit" : "Incorrect") +
    points
  );
}

export function gradeSummary(questions) {
  const count = (outcome) => questions.filter((q) => questionOutcome(q) === outcome).length;
  const partial = count("partial");
  return (
    `${count("correct")} of ${questions.length} fully correct` +
    (partial ? ` · ${partial} partial credit` : "")
  );
}

/** Explain a historical score whose question points were never stored. */
export function gradePointsNotice(grade) {
  if (grade.questions.some((q) => q.pointsEarned !== undefined || q.pointsPossible !== undefined))
    return "";
  return Math.abs(grade.score - gradeScore(grade.questions)) > 0.5
    ? "This saved score has no per-question points. Its partial credit or weights cannot be shown."
    : "";
}
