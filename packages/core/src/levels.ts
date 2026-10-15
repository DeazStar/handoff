/** The levels a job or a person can be: the one list everything uses, in order from least to most senior. */
export const SENIORITY_LEVELS = ["intern", "junior", "mid", "senior", "lead", "staff_plus"] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const SENIORITY_LABELS: Record<Seniority, string> = { intern: "Intern", junior: "Junior", mid: "Mid", senior: "Senior", lead: "Lead", staff_plus: "Staff and above" };

// Words people type for the same level.
const ALIASES: Record<string, Seniority> = {
  internship: "intern", trainee: "intern", student: "intern",
  entry: "junior", "entry level": "junior", "entry-level": "junior", jr: "junior", graduate: "junior",
  middle: "mid", medium: "mid", intermediate: "mid", "mid level": "mid", "mid-level": "mid", midlevel: "mid",
  sr: "senior", "senior level": "senior",
  manager: "lead", "team lead": "lead", "tech lead": "lead",
  staff: "staff_plus", "staff+": "staff_plus", "staff and above": "staff_plus", principal: "staff_plus", distinguished: "staff_plus", architect: "staff_plus",
};

/** A level from what was typed, or undefined when it is not one of the six. */
export function normalizeSeniority(raw: string): Seniority | undefined {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if ((SENIORITY_LEVELS as readonly string[]).includes(t)) return t as Seniority;
  return ALIASES[t];
}

/**
 * How a job's level sits against the levels the user wants. match: it is one of them. stretch: one step away from the nearest.
 * mismatch: two or more steps away. Not said (no wanted levels, or the posting's level is unknown): undefined.
 */
export function levelFit(jobLevel: Seniority | undefined, wanted: readonly string[]): "match" | "stretch" | "mismatch" | undefined {
  const want = wanted.map(normalizeSeniority).filter((x): x is Seniority => !!x);
  if (!jobLevel || !want.length) return undefined;
  const at = SENIORITY_LEVELS.indexOf(jobLevel);
  const gap = Math.min(...want.map((w) => Math.abs(SENIORITY_LEVELS.indexOf(w) - at)));
  return gap === 0 ? "match" : gap === 1 ? "stretch" : "mismatch";
}
