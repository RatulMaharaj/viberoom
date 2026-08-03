"""XMP sidecar interop: read ratings/labels/keywords/IPTC from `.xmp` files
written by Lightroom/Capture One/digiKam, and write a minimal XMP packet so
edits made here are visible to those tools.

Parsing is namespace-tolerant (matches on local names and attribute
suffixes) because real-world XMP varies wildly."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape

_LABELS = {"red", "yellow", "green", "blue", "purple"}


def xmp_candidates(image_path: Path) -> list[Path]:
    """Both common styles: IMG_1234.CR3.xmp and IMG_1234.xmp."""
    return [
        image_path.with_name(image_path.name + ".xmp"),
        image_path.with_suffix(".xmp"),
    ]


def find_xmp(image_path: Path) -> Path | None:
    for p in xmp_candidates(image_path):
        if p.exists():
            return p
    return None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text_items(el: ET.Element) -> list[str]:
    """All li text values under an rdf:Bag/Seq/Alt container element."""
    return [li.text.strip() for li in el.iter() if _local(li.tag) == "li" and li.text]


def read_xmp(path: Path) -> dict:
    """Parse an XMP file into viberoom-shaped metadata. Unknown/absent
    fields are simply omitted."""
    out: dict = {}
    try:
        root = ET.fromstring(path.read_text(errors="replace"))
    except (ET.ParseError, OSError):
        return out

    for el in root.iter():
        # values can be attributes on rdf:Description...
        for attr, val in el.attrib.items():
            name = _local(attr)
            if name == "Rating":
                try:
                    out["rating"] = max(0, min(5, int(float(val))))
                except ValueError:
                    pass
            elif name == "Label" and val.strip().lower() in _LABELS:
                out["label"] = val.strip().lower()
        # ...or child elements
        name = _local(el.tag)
        if name == "Rating" and el.text:
            try:
                out["rating"] = max(0, min(5, int(float(el.text))))
            except ValueError:
                pass
        elif name == "Label" and el.text and el.text.strip().lower() in _LABELS:
            out["label"] = el.text.strip().lower()
        elif name == "subject":
            kws = _text_items(el)
            if kws:
                out["keywords"] = kws
        elif name == "title":
            vals = _text_items(el) or ([el.text.strip()] if el.text and el.text.strip() else [])
            if vals:
                out["title"] = vals[0]
        elif name == "description":
            vals = _text_items(el) or ([el.text.strip()] if el.text and el.text.strip() else [])
            if vals:
                out["caption"] = vals[0]
        elif name == "rights":
            vals = _text_items(el) or ([el.text.strip()] if el.text and el.text.strip() else [])
            if vals:
                out["copyright"] = vals[0]
        elif name == "creator":
            vals = _text_items(el)
            if vals:
                out["creator"] = vals[0]
    return out


def write_xmp(
    path: Path,
    *,
    rating: int = 0,
    label: str | None = None,
    keywords: list[str] | None = None,
    title: str | None = None,
    caption: str | None = None,
    copyright: str | None = None,
    creator: str | None = None,
) -> Path:
    """Write a minimal, widely-readable XMP packet."""
    kw_items = "".join(
        f"\n     <rdf:li>{escape(k)}</rdf:li>" for k in (keywords or [])
    )
    parts = [f'   xmp:Rating="{int(rating)}"']
    if label:
        parts.append(f'   xmp:Label="{escape(label.capitalize())}"')
    body = ""
    if keywords:
        body += f"\n   <dc:subject>\n    <rdf:Bag>{kw_items}\n    </rdf:Bag>\n   </dc:subject>"
    for tag, val in (("title", title), ("description", caption), ("rights", copyright)):
        if val:
            body += (
                f"\n   <dc:{tag}>\n    <rdf:Alt>\n     "
                f'<rdf:li xml:lang="x-default">{escape(val)}</rdf:li>\n    </rdf:Alt>\n   </dc:{tag}>'
            )
    if creator:
        body += (
            f"\n   <dc:creator>\n    <rdf:Seq>\n     <rdf:li>{escape(creator)}</rdf:li>"
            f"\n    </rdf:Seq>\n   </dc:creator>"
        )
    packet = f"""<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="viberoom">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
{chr(10).join(parts)}>{body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""
    path.write_text(packet)
    return path
