# Project guidance

## TypeSafe / JEV work

- For TypeSafe or JEV changes in this project, read `.agents/skills/typesafe-ai/SKILL.md` and the relevant current official documentation before editing.
- Keep prompts explicit: define state fields, evidence precedence, positive/negative criteria, exclusions, uncertainty behavior, and representative edge cases. Do not rely on question IDs being visible to JEV.
- Separate independent lifecycle, candidate-selection, authorization/precondition, progress, and completion-evidence judgments. Questions in one request cannot see each other's answers.
- Code owns routing, validation, budgets, cancellation, and state freshness. Confidence is not permission; Noul has no separate confidence.
- Preserve unrelated working-tree changes. Test with mocked judgments by default; do not send private histories to real APIs or spend API credits merely to run regression tests.
