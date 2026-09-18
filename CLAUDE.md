# AI Concepts Lab

Solo learning project: an interactive web app that teaches AI/ML concepts (neurons → LLMs → agents → harnesses) and is the vehicle for learning the full SDLC.

**Start here:** `docs/HANDOFF.md` (condensed brief), then `docs/06-roadmap.md` for the current milestone. Full design in `docs/01`–`07`.

Ground rules for implementation sessions:
- The stack and schema are decided (see `docs/01-architecture.md`, `docs/02-schema.md`). Deviations require an ADR in `docs/adr/`.
- Everything is TypeScript. Do not add dependencies outside the stack list without asking.
- Nothing outside `apps/api/src/model/` may reference Ollama; use the `ModelProvider` interface.
- `MODEL_PROVIDER=fake` in all tests and CI. Never call a real model from tests.
- Every milestone ends with tests added and CI green. Work on branch `mNN-<slug>`; do not commit directly to `main`.
- The learner is optimising for understanding, not speed: explain non-obvious choices in PR descriptions and code comments.
