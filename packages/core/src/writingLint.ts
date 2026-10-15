/**
 * Hard checks for the habits the writing guide bans in anything written in the user's name. They cannot judge whether a text is good;
 * they refuse the patterns that are wrong every time, so the agent has to rewrite instead of skipping the guide.
 */
export interface WritingIssue {
  rule: string;
  found: string;
  fix: string;
}

// "I'm Alex, a developer", "My name is...", "I am a full-stack engineer". "I'm applying for..." is fine: it is the model opening.
const OPENING = /^\s*(?:(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\b[^,\n]{0,40}[,\n]\s*)?(?:(?:I['’]m|I am)\s+(?:an?|the)\b|[Mm]y name is\b|(?:I['’]m|I am)\s+[A-Z][a-z]+\s*[.,])[^.!?\n]{0,60}/;
const STOCK = /\b(?:caught my (?:attention|eye)|talk through any of it|glad to talk through|is (?:a|an) (?:hard|difficult|fascinating|interesting|tough) problem|(?:is|are) (?:exactly |just )?the kind of|exactly (?:the|what|why)|(?:very |really )?(?:interested|excited|thrilled) (?:in|about|by)|look(?:ing)? forward to hearing)\b[^.!?\n]{0,30}/i;
const MAX_SENTENCE_WORDS = 35;
const FILLER = /\b(passionate|leverag(?:e|es|ed|ing)|toolkit|synergy|rockstar|ninja|cutting-edge|seamless(?:ly)?|robust|delve|game-changing|thrilled|excited to|great fit)\b/i;
const GAP = /\bI (?:have not|haven['’]t|have never|never) (?:yet )?(?:used|worked|done|tried)\b[^.!?\n]{0,50}|\bI (?:lack|have no experience)\b[^.!?\n]{0,50}/i;
const NARRATING = /\bI (?:see|noticed|saw) (?:that )?you (?:offer|sponsor|provide|support)\b[^.!?\n]{0,40}/i;
const WRITING_TO = /\bI(?:['’]m| am) writing to\b[^.!?\n]{0,40}/i;
const CHATBOT = /\bI hope this (?:email|message|note) finds you well\b|\bplease let me know if you(?:['’]d| would) like (?:any )?changes\b/i;

/** The issues in one text, each with what was found and how to fix it. Empty when the text is clean. */
export function lintWriting(text: string, opts: { opening?: boolean } = {}): WritingIssue[] {
  const issues: WritingIssue[] = [];
  const add = (rule: string, found: string, fix: string) => issues.push({ rule, found: found.trim().slice(0, 80), fix });
  const opening = opts.opening === false ? null : OPENING.exec(text);
  if (opening) add("opens with the user", opening[0], "Open with \"I'm applying for the <role> at <company>\", then the work, not with who the user is");
  const stock = STOCK.exec(text);
  if (stock) add("stock line", stock[0], "Say the plain thing instead, or leave it out; do not claim a feeling the user did not state");
  const longSentence = text.split(/(?<=[.!?])\s+/).find((x) => x.trim().split(/\s+/).length > MAX_SENTENCE_WORDS);
  if (longSentence) add("long sentence", `${longSentence.trim().split(/\s+/).length} words: ${longSentence.trim().slice(0, 40)}`, `Split it: keep each sentence under ${MAX_SENTENCE_WORDS} words, one idea each`);
  const writingTo = WRITING_TO.exec(text);
  if (writingTo) add("form-letter opening", writingTo[0], "Start with the point, not with the fact that you are writing");
  const filler = FILLER.exec(text);
  if (filler) add("filler word", filler[0], "Use the plain word, or say what it did");
  const gap = GAP.exec(text);
  if (gap) add("volunteers a gap", gap[0], "Leave out what the user has not done unless the question asks for it");
  const narrating = NARRATING.exec(text);
  if (narrating) add("narrates the application", narrating[0], "Say sponsorship once, flat and last (\"I'd need visa sponsorship.\"), without commenting on what they offer");
  const chatbot = CHATBOT.exec(text);
  if (chatbot) add("chatbot leftover", chatbot[0], "Cut it");
  const dashes = (text.match(/[—–]/g) ?? []).length;
  if (dashes > 1) add("too many dashes", `${dashes} dashes`, "Use full stops or commas; at most one dash in the whole text");
  return issues;
}

/** Throws one error that lists every issue in every text, so the agent can fix them all in one rewrite. */
export function assertWellWritten(texts: string[], where: string): void {
  const all = texts.flatMap((t, i) => lintWriting(t, { opening: i === 0 }).map((x) => ({ ...x, part: texts.length > 1 ? ` (part ${i + 1})` : "" })));
  if (!all.length) return;
  const list = all.map((x) => `- ${x.rule}${x.part}: "${x.found}". ${x.fix}`).join("\n");
  throw new Error(`${where} does not follow the writing guide (.claude/writing-guide.md; call get_writing_guide). Rewrite it and try again:\n${list}`);
}

/** The filler words only (for the CV summary, which has its own rules about the rest). */
export const fillerIn = (text: string): string | undefined => FILLER.exec(text)?.[0];
