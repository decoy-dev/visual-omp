# visual-omp voice

This guide is adapted from the reference voice guide (`~/Documents/cardsite-tbd/docs/VOICE.md` and its `docs/context/feedback_*` banned-pattern files). It applies to every user-facing string: UI copy (i18n JSON), README, CHANGELOG, release notes, docs and commit messages.

Use these patterns when drafting. Revising generic copy only to remove banned wording does not establish the intended voice.

## Register

Use a formal register and pragmatic substance. Write complete sentences with professional vocabulary and no slang; contractions are fine. Make the writing direct through its substance while maintaining a professional prose style. Avoid the style of a chat message.

## Patterns

1. Sequence the reasoning, then state the conclusion. Use transitions such as "The catch is", "which is where" and "so" when they clarify the reasoning.
2. State where a fact comes from and mark what is unconfirmed. Never assert past what the code does.
3. State the value with confidence once the reasoning supports it.
4. Tie every fact to a consequence by saying what the feature does for the reader.
5. Acknowledge the competing consideration, then state the position. Transitions such as "That being said" and "The catch is ... though" can introduce the position.
6. Use at most one dry, measured aside. Keep it professional and avoid jokes.

Match the length to the surface. UI strings are short: a button is verb + object ("Start chat here", "Sign in again"), a tooltip is one plain sentence, and an empty state is a heading plus at most one sentence. Conventional dialog actions ("Close", "Cancel", "Done", "Sign in", "Try again") are acceptable where the dialog or row already names the object.

## Banned patterns

Rewrite the sentence when one of these appears; replacing a single word is not enough.

- Do not use em dashes, en dashes or double hyphens as prose punctuation. Use a comma, colon, period or parentheses, and use a hyphen for ranges. Literal command flags, code syntax and quoted examples of banned wording are exempt.
- Avoid "X, not Y", "not just X, but Y", "it's not X, it's Y" and a trailing "even X". Avoid parallel anaphora ("Every X. Every Y."), triads of fragments ("Plan. Build. Ship.") and slogan cadence.
- Do not place all-caps or bracketed eyebrow labels above headings (`[ PROJECTS ]`, `[ 1 OF 5 ]`). Use a label only when it names something the heading does not.
- Do not promise more than the code does. Confirm the behavior in code before describing it.
- Avoid figurative stand-ins for mechanics ("lands", "lives in", "under the hood", "the plumbing", "sits", "pick up", "surface" as a verb). Name the actor and the action.
- Avoid AI stock phrases: "the math", "the numbers", "the story", "signals", "real", "actually", "genuinely", "properly", "seamless", "worth noting", "quietly", "the tell", "reads as", "does the heavy lifting", "earns its keep", "table stakes", "here's the thing", "Translation:" and "Full stop." Avoid the marketing family as well (elevate, unleash, supercharge, empower, streamline, effortless, magic, next-gen, game-changer).
- Do not use exclamation marks in UI or success messages, "Oops", or cutesy filler ("Thought it through", "Let's go").
- Use sentence case for headings and buttons, never Title Case.
- Do not use sentence fragments as standalone lines in release notes and docs.
- Keep user-facing copy brand-first ("visual-omp", with "decoy" as publisher) and free of founder or personal biography.
