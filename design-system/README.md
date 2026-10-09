# Design system tokens

Source of truth for colour, typography, spacing and **weather scales/thresholds**
used by both the web app and the backend. Format: [W3C Design Tokens (DTCG)](https://tr.designtokens.org/format/).

```bash
node scripts/build-tokens.mjs          # regenerate dist/ and the copies in frontend/ and backend/
node scripts/build-tokens.mjs --check  # CI: fail if generated files are stale
```

- `tokens/primitive.json` – raw values
- `tokens/semantic.json` – roles; dark mode in `$extensions["th.weather.modes"].dark`
- `tokens/weather.json` – map colour scales and alert categories

See `docs/DESIGN.md` for the rules and rationale.
