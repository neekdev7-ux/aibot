# Testing

## Frontend — syntax check every module

`package.json` sets `{"type": "module"}` so `node --check` validates the
ES modules correctly.

```bash
for f in js/*.js; do node --check "$f" || echo "FAIL $f"; done
```

**Passing:** all 18 files check clean with no output (verified 2026-11-19:
18/18 OK, Node v24).

## Backend — compile every module

```bash
python3 -m py_compile $(find backend -name '*.py') && echo OK
```

**Passing:** prints `OK`, no tracebacks (verified 2026-11-19: all 22
`.py` files compile, Python 3.12).

## Backend — pytest suite

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate   # if needed
pip install -r requirements.txt                       # includes pytest
python3 -m pytest tests/ -q
```

**Passing:** `49 passed` (verified 2026-11-19, pytest 9.2.0). The suite
covers indicators, scoring weights/classes, structure detection, and the
trade-lock state machine:

| File | Covers |
|---|---|
| `tests/test_indicators.py` | ATR / EMA / RSI / VWAP / ADX |
| `tests/test_scoring.py` | Weights sum to 100, score classes, level construction |
| `tests/test_structure.py` | Swings, BOS/CHoCH, sweeps |
| `tests/test_trade_lock.py` | State transitions, locked levels, TP1 partial, cooldown, recovery |

## Backend — FastAPI TestClient smoke

Boots the real app (in-memory trade store when Postgres is down, WS
ingest disabled) and hits the key endpoints:

```python
# /tmp/smoke.py — run from backend/ with PYTHONPATH=.
import os
os.environ["WS_ENABLED"] = "false"
os.environ["DATABASE_URL"] = "postgresql+asyncpg://niva:bad@localhost:1/niva_quant"
from fastapi.testclient import TestClient
from app.main import app

with TestClient(app) as c:
    assert c.get("/health").status_code == 200
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/scanner").status_code == 200
    assert c.get("/api/signals").status_code == 200
    assert c.get("/api/trades").status_code == 200
    assert c.get("/api/analytics").status_code == 200
    assert c.get("/api/trades/nonexistent").status_code == 404
    assert c.get("/api/admin/settings").status_code == 200
```

```bash
PYTHONPATH=. python /tmp/smoke.py
```

**Passing:** all assertions hold. `/api/health` honestly reports
`status: "degraded"` with per-component `error` detail when Postgres/Redis
are down — that is the expected honest behaviour, not a failure
(verified 2026-11-19: all 8 checks passed, 20 paths in OpenAPI).

## Frontend — element-ID cross-check

Every `getElementById` / `querySelector('#…')` reference in `js/app.js`
and `js/ui.js` must exist in `index.html`:

```bash
python3 - <<'EOF'
import re, glob
html = open('index.html').read()
ids = set(re.findall(r'id="([^"]+)"', html))
refs = {}
for f in glob.glob('js/*.js'):
    for m in re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", open(f).read()):
        refs.setdefault(m, []).append(f)
missing = sorted(i for i in refs if i not in ids)
print("referenced:", len(refs), "missing:", missing or "none")
EOF
```

**Passing:** `missing: none` (verified 2026-11-19: 20 referenced IDs, all
present in `index.html`'s 88 IDs).

## Live Binance smoke test

Checks which Binance hosts this environment can actually reach. The
frontend uses `/fapi/v1/*` on `data-api.binance.vision` then
`fapi.binance.com`; the spot endpoint is a control proving outbound
Binance access works at all.

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://data-api.binance.vision/fapi/v1/ticker/24hr?symbol=BTCUSDT"
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://data-api.binance.vision/fapi/v1/exchangeInfo"
curl -s "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT"
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT"
```

**Results from the author's environment (2026-11-19):**

| Endpoint | Status | Meaning |
|---|---|---|
| vision `/fapi/v1/ticker/24hr` | **404** | Vision serves spot only — it 404s all `/fapi` paths |
| vision `/fapi/v1/exchangeInfo` | **404** | Same |
| vision `/api/v3/ticker/price` | **200** | Spot control works — `{"symbol":"BTCUSDT","price":"64076.60000000"}` |
| fapi.binance.com `/fapi/v1/ticker/24hr` | **451** | Geo-blocked from this environment |
| fapi.binance.com `/fapi/v1/exchangeInfo` | **451** | Same |

This is an **environment limitation, not a code failure**: the app is
designed to fail honestly here (logged errors, 502s, empty state — never
fabricated data). In an unrestricted network the same commands return 200
with real futures data. Re-run this smoke test from any new deploy target
before expecting live signals.

## Docker Compose validation

```bash
docker compose config -q     # if docker is installed
# otherwise, at minimum:
python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"
```

**Passing:** config validates, services are `db`, `redis`, `api`
(verified 2026-11-19 via YAML parse — docker was not installed in the
verifying environment, so `docker compose config` itself was not run).

## Honesty greps

Run after any change that touches copy or scoring:

```bash
# No TODO/FIXME stubs in core paths
grep -rn -i -E 'TODO|FIXME' js/ backend/ index.html styles.css
# "70%" may appear ONLY as the honest research-target line
grep -rn '70%' js/ backend/ index.html
# Scoring weights consistent in both implementations
grep -n 'structure: 15' js/config.js            # 15/20/15/15/10/10/10/5
grep -n '"structure": 15' backend/app/signals.py
```

**Passing (verified 2026-11-19):** zero TODO/FIXME; exactly two `70%`
occurrences in code, both the honest framing ("70% win rate is an unvalidated
research target, not a claim." in `index.html`, and the same wording in
`backend/app/signals.py`'s docstring); the docs repeat that same honest
framing in `README.md` and in this file's grep instructions — no other
accuracy claim exists anywhere; weights identical in frontend and
backend (backend asserts the sum is 100).

## Known untested-live items

These were **not** verified end-to-end live and should be checked before
relying on them in production:

- **Browser end-to-end** — no live browser run was done; the UI was
  verified by static checks only (syntax, ID cross-check). Open
  `index.html` in a real browser and run a scan.
- **Live Postgres/Redis** — the compose stack was validated by YAML parse
  only (docker not installed in the verifying environment). Run
  `docker compose up` on a host with Docker and check `/api/health`.
- **Live WS ingest** — the Binance WS connection (`fstream.binance.com`)
  was not tested live; the smoke test disabled it.
- **Live `/fapi` from geo-restricted clouds** — confirmed unreachable
  (451/404) from the author's environment; re-verify from your deploy
  target (see the smoke test above).
- **Backtest endpoint end-to-end** — the backtest engine is unit-tested,
  but `POST /api/backtest` was not exercised against live klines.
