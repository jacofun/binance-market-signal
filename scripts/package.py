"""Package compiled application only. No runtime dependencies or secrets."""
import json
import os
from pathlib import Path
import re
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
dest = root / "dist/binance-market-signal.zip"
dest.parent.mkdir(exist_ok=True)
commit = os.environ.get("GITHUB_SHA", "development")
if commit != "development" and not re.fullmatch(r"[a-f0-9]{40}", commit):
    raise SystemExit("Invalid source commit")
paths = [root / name for name in ("bootstrap", "server.js", "index.js", "package.json")]
paths += sorted((root / "build").glob("*.js"))
if not (root / "build/server.js").is_file():
    raise SystemExit("Run npm run build first")
with ZipFile(dest, "w", ZIP_DEFLATED) as archive:
    for path in paths:
        name = path.relative_to(root).as_posix()
        if name == "build/version.js":
            archive.writestr(name, f"export const SOURCE_COMMIT = {json.dumps(commit)};\n")
        else:
            archive.write(path, name)
print(f"Packaged {dest.name}: {dest.stat().st_size} bytes; source {commit}")
