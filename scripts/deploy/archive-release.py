"""Create a new manifest-verified release ZIP without overwriting prior releases."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

directory, archive = map(lambda value: Path(value).resolve(), sys.argv[1:3])
project = Path(__file__).resolve().parents[2]
if directory.parent != project / "dist" or archive.parent != project / "dist":
    raise ValueError("Release output must stay in this project's dist directory")
manifest = json.loads((directory / "package-manifest.json").read_text(encoding="utf-8"))
expected = {row["path"]: row for row in manifest["files"]}
actual = {str(item.relative_to(directory)).replace("\\", "/") for item in directory.rglob("*") if item.is_file()}
if actual != set(expected) | {"package-manifest.json"}:
    raise ValueError("Release directory differs from manifest")
for name, row in expected.items():
    data = (directory / name).read_bytes()
    if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
        raise ValueError("Release checksum differs: " + name)
with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
    for name in sorted(actual):
        bundle.write(directory / name, directory.name + "/" + name)
print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                  "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                  "files": len(expected)}, ensure_ascii=False))
