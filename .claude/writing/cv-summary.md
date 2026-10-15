# Writing the CV summary

Read this before you write the `summary` and the `headline` of a CV. The facts rule never changes: every sentence cites the facts it rests on, and you add no skill, tool, number or title that no fact supports. The server refuses a summary that breaks the hard rules at the end of this file.

## The shape: three sentences, one slot each
1. **Who and stack.** `[Level] Software Engineer with [N+ years | internships | projects] building [kind of systems] in [stack].`
2. **Strengths.** `Experienced in [strength], [strength] and [strength].`
3. **Known for.** `Known for [a trait] in [environment].`

### What goes in each slot
- **Level:** only a word the user's own job titles carry ("Lead" if a title says Lead). Otherwise leave it out. Never guess "Senior" or "Mid".
- **Years:** write "N+ years" with N at most `experience.years` from `get_cv_material`. Never do the arithmetic yourself. If the user has under a year, say internships or projects instead.
- **Kind of systems:** a general phrase ("backend APIs and web products"), never a product type or industry ("e-commerce", "healthcare", "AI tooling").
- **Stack:** three to five skills the posting asks for that the user really has, strongest first, in the posting's own words. Never list a skill the user lacks, even if the posting wants it.
- **Strengths:** two or three skills or abilities the facts back and this job needs ("REST API design, authentication and database design", "CI/CD and Docker deployments"). They are abilities, not results.
- **Trait:** one thing the user is known for that a fact supports ("owning backend systems from design to deployment", "optimizing database performance"). Do not claim a trait with no fact behind it: no "cutting costs" unless a fact says so.
- **Environment:** "remote" or "startup" only if a saved fact says so. Leave it out otherwise.
- **Headline** (under the name): the role label of sentence 1, such as "Backend Software Engineer" or "Full-Stack Software Engineer", matched to the job. Same level rule as above.

## Good examples
**Backend-leaning role:**
> Software Engineer with 3+ years building backend APIs and web products in TypeScript, Node.js, React and PostgreSQL. Experienced in REST API design, authentication and database design, and in CI/CD and Docker deployments. Known for owning backend systems from design to deployment in remote startup teams.

**Full-stack product role:**
> Full-stack Software Engineer with 3+ years building web products in TypeScript, Node.js, React, Next.js and PostgreSQL. Experienced in REST API design, authentication and database design, and in building features from the API to the interface. Known for owning backend systems from design through deployment and for optimizing performance from the database to the interface in remote startup teams.

## Bad examples, and why
- *"Rebuilt the generated queries behind a reporting platform around SQL window functions, removing the Cartesian join."* A result with technical internals, copied from a bullet. The summary is about the person, and the server refuses it (a number, and a repeat of a bullet).
- *"Has built e-commerce, distributed systems and AI data tooling."* A list of three product types: vague breadth with no outcome. What was built belongs in the experience section.
- *"Cross-stack engineer..."* Nobody searches for that. Use the standard word the posting uses ("full-stack").
- *"I lead backend work on a payments platform..."* First person. A CV summary has none.
- *"Passionate engineer with robust experience..."* Filler. Say what the user did.
- *"Known for cutting costs..."* when no fact says it: an invented trait.

## The hard rules the server enforces
- At most three sentences, each under 30 words.
- No "I", "my" or "me".
- No numbers except the years of experience, and the years cannot exceed the server's own count.
- No filler words (passionate, robust, seamless, leverage...).
- No sentence that repeats a bullet from the experience or projects sections.
- Every sentence cites facts; every claim rests on them.

## Before you save
Read it aloud. It should sound like a short introduction of a person to a recruiter, with the posting's real keywords in it. If any slot is filled from your own idea and not from a fact, take it out.
