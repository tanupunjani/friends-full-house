from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
worker = (root / "build/worker.mjs").read_text()
assert "export default" in worker and "async fetch(request, env)" in worker
assert (root / "drizzle/0000_rooms.sql").exists()
assert '"/questions.json":' not in worker
assert "__DEFAULT_BANK__" not in worker and "__STATIC_ASSETS__" not in worker
for secret_pattern in (
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    r"(?i)\b(?:ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_]{20,}\b",
    r"(?i)(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*['\"][^'\"]{8,}['\"]",
):
    assert not re.search(secret_pattern, worker), "possible credential material in Worker artifact"
print("Worker artifact is complete; answer data stays out of public static routes and no private asset markers were found.")
