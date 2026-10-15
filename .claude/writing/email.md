# Writing the application email

Read this before you call `draft_email`. The server refuses an email that does not follow this format, and tells you what to fix, so follow it exactly and it is accepted the first time. Facts only: every claim cites the facts it rests on, and every number must appear in them.

## What the server adds (do not write these)
- The **subject** (default: "Application: <job title>, <user's name>"). Leave `subject` out.
- The **signature**: the user's name and email. Never write a name, phone number or email address in a block.
- The **attachments**: the CV, and the cover letter when one exists.

## The blocks, in this order
1. **Greeting**, kind `boilerplate`, exactly `Dear Hiring Manager,` when the contact has no name, or `Dear <first name>,` when the contact you pass has a name (for example `Dear Jane,`). Any other greeting is refused.
2. **The opening**, kind `boilerplate`: `I'm applying for the <role> at <company>.` The body must start with it.
3. **The pitch**, one or two blocks, kind `claim`, each citing its `factIds`: who the user is and the one thing that fits this role. Years of experience may be written "3+ years" (at most the server's count from the dated roles; it is not counted as a number).
4. **The close**, kind `boilerplate`: say what is attached and end plainly. With a cover letter: `My CV and cover letter are attached. Happy to talk if it looks like a fit.` Without one: `My CV is attached. Happy to talk if it looks like a fit.`
5. **Sign-off**, kind `boilerplate`, exactly `Best regards,`

## The size depends on the cover letter
- **A cover letter is attached** (the usual case; the server attaches the latest one): the email is only a covering note. **Under 70 words** in the body, **one employer named at most**, **one number at most** besides the years, and it must say the CV and letter are attached. Do not retell the letter: it carries the detail.
- **No cover letter:** under 110 words, two employers at most, two numbers at most. Write it like the model message in `.claude/writing-guide.md`.

## Good example, with a cover letter (Globex)
```json
{
  "jobId": 26,
  "contactId": 12,
  "blocks": [
    { "text": "Dear Hiring Manager,", "factIds": [], "kind": "boilerplate" },
    { "text": "I'm applying for the Software Engineer role at Globex.", "factIds": [], "kind": "boilerplate" },
    { "text": "I'm a software engineer with 3+ years building backend APIs and web products in TypeScript, Node.js, React and PostgreSQL, and I lead backend work on a payments platform.", "factIds": [28, 30, 58, 9], "kind": "claim" },
    { "text": "My CV and cover letter are attached. Happy to talk if it looks like a fit.", "factIds": [], "kind": "boilerplate" },
    { "text": "Best regards,", "factIds": [], "kind": "boilerplate" }
  ]
}
```
It reads, after the server adds the signature:
> Dear Hiring Manager,
>
> I'm applying for the Software Engineer role at Globex. I'm a software engineer with 3+ years building backend APIs and web products in TypeScript, Node.js, React and PostgreSQL, and I lead backend work on a payments platform. My CV and cover letter are attached. Happy to talk if it looks like a fit.
>
> Best regards,
> Alex Morgan
> you@example.com

## Good example, no cover letter (Acme Labs)
> Dear Sam,
>
> I'm applying for the Software Engineer role at Acme Labs. At Contoso I found why our slowest reports were slow: a query builder was producing SQL that joined unrelated tables. I rebuilt it to stop that. At Initech I led a code-generation tool for mobile screens that cut build time by 40%. My CV is attached. Happy to talk if it looks like a fit.
>
> Best regards,

## Bad example, and what is wrong in it
> **Dear hiring team,** *(wrong greeting: it must be exactly "Dear Hiring Manager," or "Dear <first name>,")*
>
> I'm applying for the Software Engineer role at Globex. **At Fabrikam I built a full-stack e-commerce platform in TypeScript, Node.js, Next.js and React, and at Northwind I lead backend work on a payments platform. At Contoso I developed backend APIs that cut query time by more than 60 percent.** *(retells the cover letter: three employers; with a letter attached, name one at most)* My CV and cover letter are attached.
>
> **Best regards,** Alex Morgan **+351...** *(never write a name or phone: the server adds the name and email)*

## The hard rules the server enforces
- The first block is the exact greeting, the last block is exactly `Best regards,`.
- The body starts `I'm applying for the <role> at <company>.`
- Word limit (70 with a letter, 110 without), employer limit (1 or 2), number limit (1 or 2), and "attached" must appear when there is a letter.
- No sentence that repeats the posting ("The posting...", "You are building..."), no filler or stock lines, no sentence over 35 words, no first-person intro ("I'm Alex"), no claimed feelings.
- Every claim cites facts and each number appears in them.

## Before you save
Check: exact greeting, opening sentence, one employer, under 70 words with a letter, "attached", exact sign-off, no name or phone written.
