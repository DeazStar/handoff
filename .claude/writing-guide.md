# Writing guide: anything written in the user's name

Read this before you write an email, a cover letter, a message to a founder or a recruiter, or any free-text answer on a form. The user's own `writingStyle` (from `get_preferences`) comes first; where it says nothing, follow this. The facts rule never changes: every claim rests on a saved fact, and no number, tool, employer or result is added.

## Which file to read
- **A short message to a founder or recruiter, or a free-text form answer:** this file (the model message below).
- **An application email:** `.claude/writing/email.md`.
- **The CV summary and headline:** `.claude/writing/cv-summary.md`.
- **A cover letter:** `.claude/writing/cover-letter.md`.
`get_writing_guide` returns this file together with the one for the kind of text you are writing.

## The model message: write like this
This is the voice the user likes. Match its shape, its plainness and its length, with the facts of the job at hand:

> Hi Sam, I'm applying for the Software Engineer role at Acme Labs. At Contoso I found why our slowest reports were slow: a query builder was producing SQL that joined unrelated tables. I rebuilt it to stop that. At Initech I led a code-generation tool for mobile screens that cut build time by 40%, and I also build full-stack products in TypeScript, Next.js and React. Happy to talk if it looks like a fit.

What makes it work, and what to copy:
1. **First sentence: greeting, then "I'm applying for the <role> at <company>."** Plain and direct. Do not open with a clever line about the company, and never claim what "caught my attention" or "excited" you: the user did not say it, so you may not.
2. **Then two or three short, concrete sentences**, each one a thing the user did and what came of it, in the words of their facts. One clause of technical detail at most ("a query builder was producing SQL that joined unrelated tables"), then say what was done. No library internals, no second paragraph of how.
3. **Choose the experience that fits this role**, not the whole CV. One or two jobs, one "I also..." line for a second strength if it helps.
4. **Close short and plain**: "Happy to talk if it looks like a fit." Not "talk through any of it", not "I look forward to hearing from you".
5. **60 to 100 words.** Contractions are fine ("I'm", "I'd"). No dashes joining clauses.

## How it should read
- **Write to one person**, like a short note from a capable colleague, not a profile summary.
- **One idea per sentence.** Mostly under 20 words, never over 30. If a sentence has three commas, split it.
- **Say two things well, not six things quickly.** Do not list tools in a row ("A, B, C and D"): name the ones the role asks for.
- **Connect a fact to the role through what was done**, not through how much the user wants it.
- **If the user has given a real reason for wanting the job, use it in their words.** Otherwise leave the reason out. The user can add one true sentence themselves.
- **For a cover letter** (long form) you may open with what the company is building, when the posting gives a specific reason. Emails and messages use the model above.

## What to leave out
- **Do not volunteer gaps.** If the posting asks for AWS and the user has none, do not write "I have not used AWS". Do not claim it either. Answer a gap only when the form's question asks for it directly, and then say it plainly with the nearest real experience.
- **Do not narrate the application.** Not "I see you offer visa sponsorship". Say sponsorship only if the form and the user's profile do not already cover it. Then say it once, plainly, as its own sentence **before** the closing line ("I'd need visa sponsorship."), never as the last thing the reader sees. If the posting says the company sponsors, one plain line is enough.
- **No filler words or stock lines:** passionate, leverage, toolkit, synergy, excited to, "caught my attention", "is a hard problem, and...", "is the kind of role", "exactly the", "talk through any of it", "I believe I would be a great fit", "dynamic", "rockstar".
- **No flattery** of the company beyond one true, specific observation.
- **No claims of feeling.** Show interest by being specific.

## Length
- Message to a founder or in a short box: 60 to 100 words.
- Application email: 3 short paragraphs, under 170 words.
- Cover letter: as `cover.md` says.
- A form's own character limit always wins.

## Before you save or send it to the user
Read it once as if aloud. If it sounds like a list, a brochure or a form letter, rewrite it. Check every number and name against the facts. Then check that the first sentence names the role and company, and that nothing claims a feeling the user did not state.

## Editing pass: do this on every draft before you save it
The checks below are the patterns that make writing sound machine-made. They come from the public "Signs of AI writing" list that the open-source `humanizer` skill is built on, cut down to what matters for short application text and put in our own words. Go through the draft once, mark every hit, rewrite, then check the facts again.

1. **"Not X, but Y" and "more than just X".** Say the real thing directly.
2. **Three of everything.** "Fast, reliable and scalable", "APIs, auth and deployment": keep the one or two that matter.
3. **Dramatic one-liners and fragments** used as a closer ("Simple. Fast. Done."), and staged run-ups ("Here is the thing:"). Cut them.
4. **Dashes joining clauses.** Use a full stop or a comma. At most one dash in the whole text.
5. **Inflated words:** crucial, pivotal, vital, robust, seamless, cutting-edge, innovative, leverage, delve, landscape, journey, testament, tapestry, "plays a key role", "stands as". Use the plain word or say what it did.
6. **Tacked-on "-ing" phrases** that claim importance ("...ensuring a seamless experience", "...highlighting the need for"). Delete the phrase or give the real result.
7. **Sales language and vague praise of them** ("your impressive mission", "your groundbreaking work"). Keep one true, specific observation instead.
8. **Avoiding "is", "has", "does".** Not "serves as" or "boasts": write "is" and "has".
9. **Passive voice and missing people.** Not "queries were optimised": "I optimised the queries".
10. **Repeated openings.** If three sentences start with "I", change at least one so the rhythm varies.
11. **Chatbot leftovers:** "Certainly!", "I hope this finds you well", "Great question", "Let me know if you'd like changes", and explanations of the text itself.
12. **Formatting inside a message:** bold, bullet points and headings in an email, a cover letter or a form box. Plain sentences only, unless the form itself asks for a list.

**Do not overcorrect.** Plain, voiceless writing is just as obvious as padded writing. Keep the user's own voice where the `writingStyle` setting or a sample of their writing gives one: match its sentence length, formality and choice of words. A real, specific detail is worth more than a tidy sentence.

**The editing pass never changes the facts.** Do not add a fact, number, tool, name or result, and do not drop a claim the text needs. Making a claim stronger ("helped" to "led") counts as adding one. If removing a pattern would leave a sentence with nothing in it, cut the sentence.

### Order of work
1. Write the draft following "How it should read" above.
2. Run the editing pass: mark, rewrite, then read it aloud once.
3. Check every number and name against the facts, and check that it opens with them, not with the user.

## The CV and the cover letter have their own files
Their shape, rules and examples are in `.claude/writing/cv-summary.md` and `.claude/writing/cover-letter.md`. The editing pass above applies to both, but never at the cost of a keyword the posting asks for and the user really has.
