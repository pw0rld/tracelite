"""Check ZIP integrity, tracked-file boundaries, runtime references and checksums."""
from argparse import ArgumentParser
from fnmatch import fnmatchcase
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import PurePosixPath
import posixpath
import re
import stat
from urllib.parse import unquote, urlsplit
import zipfile

from package import checked_path, output_dir, project_version, safe_name, source_allowed, source_files


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_zip(path):
    require(not path.is_symlink(), f"Archive cannot be a symlink: {path.name}")
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, f"CRC check failed: {path.name}")
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(name.casefold() for name in names)), f"Duplicate archive paths: {path.name}")
        for entry in entries:
            safe_name(entry.filename)
            require(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16),
                    f"Only regular files may be packaged: {entry.filename}")
        return {name: archive.read(name) for name in names}


class RuntimeHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag in {"script", "img", "iframe", "source"} and attrs.get("src"):
            self.references.append(attrs["src"])
        if tag in {"link", "use"} and attrs.get("href"):
            self.references.append(attrs["href"])


def check_runtime(files, manifest):
    def reference(value, current="manifest.json", wildcard=False):
        require(isinstance(value, str), f"Non-string runtime reference in {current}")
        if not value or value.startswith("#"):
            return
        if current.endswith(".css") and re.match(r"data:(?:image/(?:png|svg\+xml|webp|gif)|font/[^;,]+)[;,]", value):
            return  # Bundled CSS icons/fonts do not make an external request.
        url = urlsplit(value)
        require(not url.scheme and not url.netloc, f"External runtime reference in {current}: {value}")
        path = unquote(url.path)
        require("\\" not in path, f"Invalid runtime path in {current}: {value}")
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(current), path))
        safe_name(joined)
        exists = any(fnmatchcase(name, joined) for name in files) if wildcard else joined in files
        require(exists, f"Missing runtime file in {current}: {value}")

    background = manifest.get("background", {})
    if background.get("service_worker"):
        reference(background["service_worker"])
    for icon in manifest.get("icons", {}).values():
        reference(icon)
    for key in ("action", "browser_action", "page_action"):
        action = manifest.get(key, {})
        if action.get("default_popup"):
            reference(action["default_popup"])
        icons = action.get("default_icon", {})
        for icon in icons.values() if isinstance(icons, dict) else [icons]:
            reference(icon)
    for script in manifest.get("content_scripts", []):
        for path in script.get("js", []) + script.get("css", []):
            reference(path)
    for group in manifest.get("web_accessible_resources", []):
        for path in group.get("resources", []):
            reference(path, wildcard=True)
    for path in manifest.get("sandbox", {}).get("pages", []):
        reference(path)
    for key in ("options_page", "devtools_page"):
        if manifest.get(key):
            reference(manifest[key])
    for key, field in (("options_ui", "page"), ("side_panel", "default_path")):
        if manifest.get(key, {}).get(field):
            reference(manifest[key][field])
    for rule in manifest.get("declarative_net_request", {}).get("rule_resources", []):
        reference(rule["path"])

    for name, contents in files.items():
        suffix = PurePosixPath(name).suffix
        if suffix not in {".html", ".css", ".js"}:
            continue
        text = contents.decode("utf-8")
        if suffix == ".html":
            parser = RuntimeHTML()
            parser.feed(text)
            for value in parser.references:
                reference(value, name)
        elif suffix == ".css":
            for value in re.findall(r"url\(\s*['\"]?([^'\"\s)]+)", text):
                reference(value, name)
            for value in re.findall(r"@import\s+['\"]([^'\"]+)", text):
                reference(value, name)
        else:
            # Local MV3 modules use ordinary relative imports. Literal dynamic
            # imports are checked too; computed registries are checked below.
            imports = re.findall(r"^\s*(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['\"]([^'\"]+)", text, re.MULTILINE)
            imports += re.findall(r"\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", text)
            for value in imports:
                require(value.startswith("."), f"Only bundled relative imports are supported: {name}: {value}")
                reference(value, name)
            for value in re.findall(r"\b(?:chrome\.)?runtime\.getURL\(\s*['\"]([^'\"]*)['\"]\s*\)", text):
                reference(value)
            for array in re.findall(r"\b(?:js|css)\s*:\s*\[([^\]]*)\]", text):
                for value in re.findall(r"['\"]([^'\"]+)['\"]", array):
                    reference(value)

    # Fixed MAIN scripts are selected using profile IDs rather than imports.
    profiles = files["region-config.js"].decode("utf-8").split("];", 1)[0]
    for profile in re.findall(r"\bid\s*:\s*['\"]([^'\"]+)['\"]", profiles):
        if profile != "native":
            reference(f"early/{profile}.js")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", help="Build folder (default: project dist/)")
    parser.add_argument("--output-dir", help="Alternative spelling of the build folder")
    args = parser.parse_args()
    require(not (args.directory and args.output_dir), "Specify the build folder only once")
    directory = output_dir(args.output_dir or args.directory or "dist")
    version = project_version()
    expected = {f"TraceLite-v{version}.zip", f"TraceLite-v{version}-source.zip", "SHA256SUMS.txt"}
    require({path.name for path in directory.iterdir()} == expected, "Unexpected or missing build artifacts")
    checksum_path = directory / "SHA256SUMS.txt"
    require(not checksum_path.is_symlink(), "Checksum file cannot be a symlink")
    checksums = checksum_path.read_text(encoding="utf-8").splitlines()
    require(len(checksums) == 2, "Expected exactly two ZIP checksums")
    checksum_names = set()
    for line in checksums:
        match = re.fullmatch(r"([0-9a-f]{64})  (TraceLite-v[0-9.]+(?:-source)?\.zip)", line)
        require(match is not None, "Malformed checksum entry")
        digest, name = match.groups()
        require(name in expected and name not in checksum_names, "Unexpected or duplicate checksum entry")
        require(sha256((directory / name).read_bytes()).hexdigest() == digest, f"SHA256 mismatch: {name}")
        checksum_names.add(name)
    require(checksum_names == expected - {"SHA256SUMS.txt"}, "Missing ZIP checksum")

    tracked = source_files()
    install = read_zip(directory / f"TraceLite-v{version}.zip")
    expected_install = {name.removeprefix("extension/"): checked_path(name).read_bytes()
                        for name in tracked if name.startswith("extension/")}
    require(install == expected_install, "Install ZIP differs from tracked extension files")
    allowed = {".js", ".json", ".html", ".css", ".png", ".svg", ".woff", ".woff2"}
    require(all(PurePosixPath(name).suffix in allowed and not any(part.startswith(".") for part in PurePosixPath(name).parts)
                for name in install), "Unexpected file type in install ZIP")
    manifest = json.loads(install.get("manifest.json", b"{}"))
    require(manifest.get("manifest_version") == 3 and manifest.get("version") == version,
            "Missing root manifest.json or wrong extension version")
    check_runtime(install, manifest)

    source = read_zip(directory / f"TraceLite-v{version}-source.zip")
    prefix = f"tracelite-v{version}/"
    expected_source = {prefix + name: checked_path(name).read_bytes() for name in tracked}
    require(source == expected_source, "Source ZIP differs from allowed tracked source files")
    require(all(name.startswith(prefix) and source_allowed(name[len(prefix):]) for name in source), "Unexpected source archive file")
    require({name for name in source if name.startswith(prefix + "verification/")} <= {prefix + "verification/.gitkeep"},
            "Local verification records must never enter a release")
    print(json.dumps({"version": version, "install_files": len(install), "source_files": len(source),
                      "crc_sha256_runtime_references": "passed", "local_records_excluded": True}))


if __name__ == "__main__":
    main()
