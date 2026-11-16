#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ASSET_NAMES = ("host.html", "tv.html", "app.js", "engine.js", "style.css", "classic-theme.css")


def main():
    questions = json.loads((ROOT / "questions.json").read_text())
    assets = {}
    for name in ASSET_NAMES:
        content = (ROOT / name).read_text()
        if name.endswith(".html"):
            content = content.replace('<body data-view=', '<body data-network="remote" data-view=')
        assets["/" + name] = content

    worker = (ROOT / "worker/index.js").read_text()
    worker = worker.replace("__DEFAULT_BANK__", json.dumps(questions, ensure_ascii=False, separators=(",", ":")))
    worker = worker.replace("__STATIC_ASSETS__", json.dumps(assets, ensure_ascii=False, separators=(",", ":")))
    BUILD.mkdir(parents=True, exist_ok=True)
    (BUILD / "worker.mjs").write_text(worker)
    print(f"Built optional Worker artifact with {len(questions)} fictional prompts and {len(assets)} text assets.")


if __name__ == "__main__":
    main()
