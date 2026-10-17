"""Read and verify a release ZIP, then extract only into a new isolated test root."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

archive, destination = map(Path, sys.argv[1:3])
project = Path(__file__).resolve().parents[2]
destination = destination.resolve()
if not destination.is_relative_to((project / "tmp" / "tests").resolve()):
    raise ValueError("Extraction must remain inside isolated project tests")
destination.mkdir(parents=True, exist_ok=False)
with zipfile.ZipFile(archive) as bundle:
    names = [row.filename.replace("\\", "/") for row in bundle.infolist()]
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError("Duplicate ZIP paths")
    roots = set()
    for name in names:
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or ":" in name:
            raise ValueError("Unsafe ZIP path")
        roots.add(relative.parts[0])
    if len(roots) != 1:
        raise ValueError("A release archive must contain one product directory")
    prefix = next(iter(roots))
    manifest = json.loads(bundle.read(prefix + "/package-manifest.json"))
    expected = {prefix + "/" + row["path"]: row for row in manifest["files"]}
    actual = {name for name in names if not name.endswith("/")}
    if actual != set(expected) | {prefix + "/package-manifest.json"}:
        raise ValueError("ZIP content differs from release manifest")
    for name, row in expected.items():
        data = bundle.read(name)
        if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("ZIP checksum mismatch")
    for row, name in zip(bundle.infolist(), names):
        target = destination.joinpath(*PurePosixPath(name).parts)
        if not target.resolve().is_relative_to(destination):
            raise ValueError("ZIP target escapes test root")
        if row.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(row))
report = {"archive": str(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
          "verifiedFiles": len(expected), "extractedDirectory": str(destination / prefix), "zipChecksumsMatched": True}
print(json.dumps(report, ensure_ascii=False))
