#!/usr/bin/env python3
"""Generate sitemap.xml from HTML pages in the checked-out repository."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote, urljoin
from xml.etree import ElementTree as ET

BASE_URL = os.environ.get("BASE_URL", "").strip()
ROOT = Path.cwd()
OUTPUT = ROOT / "sitemap.xml"
EXCLUDED_DIRS = {".git", ".github", "node_modules"}
HTML_EXTENSIONS = {".html", ".htm"}
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def page_url(relative: Path) -> str:
    path = relative.as_posix()
    if path.lower() in {"index.html", "index.htm"}:
        path = ""
    elif path.lower().endswith(("/index.html", "/index.htm")):
        path = path.rsplit("/", 1)[0] + "/"
    else:
        path = quote(path, safe="/%:@-._~")
    return urljoin(BASE_URL.rstrip("/") + "/", path)


def discover_pages() -> list[str]:
    pages = {BASE_URL.rstrip("/") + "/"}
    for path in ROOT.rglob("*"):
        if not path.is_file() or path == OUTPUT:
            continue
        if any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if path.suffix.lower() not in HTML_EXTENSIONS:
            continue
        pages.add(page_url(path.relative_to(ROOT)))
    return sorted(pages)


def write_sitemap(urls: list[str]) -> None:
    ET.register_namespace("", NS)
    root = ET.Element(f"{{{NS}}}urlset")
    for url in urls:
        item = ET.SubElement(root, f"{{{NS}}}url")
        loc = ET.SubElement(item, f"{{{NS}}}loc")
        loc.text = url
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(OUTPUT, encoding="utf-8", xml_declaration=True)


def main() -> None:
    if not BASE_URL:
        raise SystemExit("SITEMAP_BASE_URL is not set. Add it as a repository secret.")
    if not BASE_URL.startswith(("http://", "https://")):
        raise SystemExit("BASE_URL must start with http:// or https://")
    write_sitemap(discover_pages())


if __name__ == "__main__":
    main()
