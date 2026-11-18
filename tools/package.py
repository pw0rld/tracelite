"""Build reproducible Chrome and source ZIPs from tracked project files only."""
from argparse import ArgumentParser
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT_FILES = {"README.md", "package.json", ".gitignore", "LICENSE"}
SOURCE_DIRS = {"extension", "tests", "tools"}
ZIP_TIME = (2020, 1, 1, 0, 0, 0)


def safe_name(name):
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError(f"Unsafe archive path: {name!r}")
    if any(":" in part for part in path.parts):
        raise ValueError(f"Unsafe archive path: {name!r}")
    return path


def checked_path(name):
    path = safe_name(name)
    source = ROOT
    for part in path.parts:
        source = source / part
        if source.is_symlink():
            raise ValueError(f"Symlinks cannot be packaged: {name}")
    if not source.is_file() or ROOT not in source.resolve().parents:
        raise ValueError(f"Missing or escaped source file: {name}")
    return source


def source_allowed(name):
    path = safe_name(name)
    if name == "verification/.gitkeep":
        return True
    if any(part in {"__pycache__", "node_modules", ".git"} or part.startswith(".env") for part in path.parts):
        return False
    if path.suffix.lower() in {".pyc", ".pyo", ".zip", ".crx", ".pem", ".key", ".p12"}:
        return False
    return (name in SOURCE_ROOT_FILES or path.parts[0] in SOURCE_DIRS
            or (path.parts[:2] == ("docs", "images") and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".svg", ".webp"})
            or (path.parts[:2] == (".github", "workflows") and path.suffix in {".yml", ".yaml"}))


def source_files():
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
    files = sorted(set(name for name in names if name and source_allowed(name)))
    for name in files:
        checked_path(name)
    if "extension/manifest.json" not in files or "package.json" not in files:
        raise ValueError("Run from a Git checkout with the project files tracked")
    return files


def project_version():
    manifest = json.loads(checked_path("extension/manifest.json").read_text())
    package = json.loads(checked_path("package.json").read_text())
    version = manifest.get("version", "")
    if (not re.fullmatch(r"\d+(?:\.\d+){0,3}", version)
            or any(str(int(part)) != part or int(part) > 65535 for part in version.split("."))):
        raise ValueError("manifest.json must contain a valid Chrome version")
    if version != package.get("version"):
        raise ValueError("manifest.json and package.json versions must match")
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected a Manifest V3 extension")
    return version


def write_zip(destination, entries):
    if destination.is_symlink():
        raise ValueError(f"Refusing symlink output: {destination}")
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, source in sorted(entries):
            safe_name(name)
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def output_dir(value):
    directory = Path(value)
    if not directory.is_absolute():
        directory = ROOT / directory
    if directory.is_symlink():
        raise ValueError("Output directory cannot be a symlink")
    directory = directory.resolve()
    extension = ROOT / "extension"
    if directory == extension or extension in directory.parents:
        raise ValueError("Do not write build artifacts into extension/")
    return directory


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="dist", help="Output folder (default: project dist/)")
    args = parser.parse_args()
    files = source_files()  # Reject symlinks before the build writes generated modules.
    version = project_version()
    subprocess.run(["node", str(ROOT / "tools/build-page-context.mjs")], check=True, cwd=ROOT)
    files = source_files()
    directory = output_dir(args.output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    install = directory / f"TraceLite-v{version}.zip"
    source = directory / f"TraceLite-v{version}-source.zip"
    write_zip(install, [(name.removeprefix("extension/"), checked_path(name))
                        for name in files if name.startswith("extension/")])
    prefix = f"tracelite-v{version}/"
    write_zip(source, [(prefix + name, checked_path(name)) for name in files])
    checksums = directory / "SHA256SUMS.txt"
    if checksums.is_symlink():
        raise ValueError("Refusing symlink checksum output")
    checksums.write_text("".join(f"{sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
                                 for path in sorted((install, source))), encoding="utf-8")
    for path in (install, source, checksums):
        print(path)


if __name__ == "__main__":
    main()
