"""Build a flat extension ZIP and a separate source/verification archive.

Collaboration logs and host configuration snapshots are intentionally excluded.
"""
from pathlib import Path
import json
import zipfile
import subprocess

root = Path(__file__).resolve().parent.parent
subprocess.run(["node", str(root / "tools/build-page-context.mjs")], check=True, cwd=root)
version = json.loads((root / "extension/manifest.json").read_text())["version"]
destination = root.parent / f"TraceLite-v{version}.zip"
source_destination = root.parent / f"TraceLite-v{version}-source.zip"
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
    for source in sorted((root / "extension").rglob("*")):
        if source.is_file() and "__pycache__" not in source.parts:
            archive.write(source, source.relative_to(root / "extension"))
files = [root / "README.md", root / "package.json"]
for folder in ("extension", "tests", "tools"):
    files.extend(p for p in (root / folder).rglob("*") if p.is_file() and "__pycache__" not in p.parts)
for name in ("chrome-smoke.txt", "chrome-upgrade-smoke.txt", "chrome-startup-smoke.txt", "chrome-reflection-smoke.json", "chrome-context-smoke.json", "chrome-timing-smoke.json", "chrome-timing-baseline.json", "chrome-host-access-smoke.json", "chrome-https-header-smoke.json", "chrome-https-header-runtime-hosts-smoke.json", "chrome-header-check-smoke.json", "chrome-early-permission-probe.json", "chrome-protection-smoke.json", "brave-protection-smoke.json", "chrome-cleanup-smoke.json", "cute-popup-smoke.json", "brave-cute-popup-smoke.json", "unit-tests.txt", "popup.png", "management.png", "header-check.png", "protection-management.png", "protection-popup.png", "brave-protection-management.png", "brave-protection-popup.png", "cleaning-panel.png", "cute-popup.png", "cute-popup-dark.png", "cute-settings.png", "brave-cute-popup.png", "brave-cute-popup-dark.png", "brave-cute-settings.png"):
    path = root / "verification" / name
    if path.exists():
        files.append(path)
with zipfile.ZipFile(source_destination, "w", zipfile.ZIP_DEFLATED) as archive:
    for source in sorted(files):
        archive.write(source, Path(root.name) / source.relative_to(root))
print(destination)
print(source_destination)
