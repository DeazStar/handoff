/** How the agent asks for something only the user can give. */
export const QUESTION_MODES = ["batch", "chat", "cards"] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];

/** The kinds of question, so the way to ask can differ: a skill level is not a legal question. */
export const QUESTION_CATEGORIES = ["skill_levels", "preferences", "stories", "sensitive", "other"] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export const QUESTION_CATEGORY_TEXT: Record<QuestionCategory, string> = {
  skill_levels: "Skill levels a site asks for",
  preferences: "Preferences (equity, how firm my minimum salary is, company size)",
  stories: "Questions that need a personal story",
  sensitive: "Sensitive questions (demographics, legal, health)",
  other: "Anything else",
};
