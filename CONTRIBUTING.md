# Contributing / ร่วมพัฒนา

ยินดีต้อนรับทุกคน — นักพัฒนา นักอุตุนิยมวิทยา นักออกแบบ และผู้ใช้งาน
Welcome! Meteorologists, developers and designers are all useful here.

## Ways to help

- **Verification data** – station observations, rain gauges, radar archives for calibrating the method.
- **Science** – better corrections (see `docs/DOWNSCALING.md` §8), new hazards.
- **Code** – issues labelled `good first issue`.
- **Design & copy** – Thai wording, accessibility, usability tests with real users.

## Development setup

```bash
# backend
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
ruff check app tests scripts && ruff format app tests scripts && pytest -q

# frontend
cd frontend && npm install
npm run typecheck && npm test && npm run build

# design tokens (after editing design-system/tokens/*.json)
node design-system/scripts/build-tokens.mjs
```

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Keep PRs focused; include tests for backend logic (`backend/tests`) and frontend utilities (`*.test.ts`).
3. Changing a physical constant? Explain the source/evidence in the PR and update `docs/DOWNSCALING.md`.
4. Changing thresholds or colours? Edit `design-system/tokens/*` only and commit the regenerated files.
5. UI changes: attach light + dark + mobile screenshots; Thai text first.
6. CI must be green.

## Code style

- Python: ruff (line length 120), type hints, NumPy vectorised code, no per-cell Python loops on the 2 km grid.
- TypeScript: strict mode, no UI framework; styles use semantic CSS variables from the tokens.
- Commit messages: imperative mood ("Add …", "Fix …").

## Code of conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Be kind and constructive. Report problems to the maintainers (see `SECURITY.md` for contact).
