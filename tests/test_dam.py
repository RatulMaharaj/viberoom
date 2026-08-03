"""DAM tests: import workflow, stacks/duplicates, collections, XMP/IPTC,
multi-folder catalog."""

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from viberoom.main import app


def _make_jpegs(folder, names, seed=7, size=(64, 96)):
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    for name in names:
        arr = rng.integers(0, 255, (*size, 3), dtype=np.uint8)
        Image.fromarray(arr).save(folder / name)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import viberoom.config as config
    import viberoom.presets as presets

    monkeypatch.setattr(config, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(presets, "PRESETS_DIR", tmp_path / "presets")
    lib = tmp_path / "photos"
    _make_jpegs(lib, ["a.jpg", "b.jpg", "c.jpg"])
    with TestClient(app) as c:
        r = c.post("/api/v1/library", json={"path": str(lib)})
        assert r.status_code == 200 and r.json()["total"] == 3
        yield c, lib, tmp_path


def _ids(c):
    return [i["id"] for i in c.get("/api/v1/images").json()["images"]]


# ---------- import (#13) ----------

def test_import_copies_and_applies_metadata(client):
    c, lib, tmp = client
    card = tmp / "card"
    _make_jpegs(card, ["IMG_1.jpg", "IMG_2.jpg"], seed=99)
    c.put("/api/v1/presets/import-base", json={"patch": {"tone": {"contrast": 12}}})

    r = c.post("/api/v1/import", json={
        "source": str(card), "rename": "shoot/{name}{ext}",
        "rating": 2, "keywords": ["ingest"], "preset": "import-base",
    })
    body = r.json()
    assert body["imported"] == 2 and body["library_total"] == 5
    assert all(f.startswith("shoot/") for f in body["files"])
    # metadata applied
    imgs = c.get("/api/v1/images", params={"keyword": "ingest"}).json()
    assert imgs["total"] == 2
    iid = imgs["images"][0]["id"]
    assert imgs["images"][0]["rating"] == 2
    assert c.get(f"/api/v1/images/{iid}/recipe").json()["tone"]["contrast"] == 12
    # originals still on the card (copy, not move)
    assert (card / "IMG_1.jpg").exists()


def test_import_dedupes_by_content(client):
    c, lib, tmp = client
    card = tmp / "card2"
    card.mkdir()
    # copy an existing library file under a different name
    (card / "copy-of-a.jpg").write_bytes((lib / "a.jpg").read_bytes())
    _make_jpegs(card, ["fresh.jpg"], seed=123)
    r = c.post("/api/v1/import", json={"source": str(card)})
    body = r.json()
    assert body["imported"] == 1 and body["skipped_duplicates"] == 1


def test_import_backup(client):
    c, _, tmp = client
    card = tmp / "card3"
    _make_jpegs(card, ["x.jpg"], seed=5)
    backup = tmp / "backup"
    c.post("/api/v1/import", json={"source": str(card), "backup_dir": str(backup)})
    assert (backup / "x.jpg").exists()


# ---------- stacks & duplicates (#17) ----------

def test_manual_stack_and_collapse(client):
    c, _, _ = client
    ids = _ids(c)
    r = c.post("/api/v1/stacks", json={"image_ids": ids[:2]})
    assert r.json()["leader"] == ids[0]
    collapsed = c.get("/api/v1/images", params={"stacks": "collapse"}).json()
    assert collapsed["total"] == 2  # leader + unstacked third image
    c.delete(f"/api/v1/stacks/{ids[0]}")
    assert c.get("/api/v1/images", params={"stacks": "collapse"}).json()["total"] == 3


def test_auto_stack_raw_jpeg_pairs(client, tmp_path):
    c, lib, _ = client
    # fake a RAW+JPEG pair: same stem, .dng is a raw extension by suffix
    (lib / "pair.dng").write_bytes((lib / "a.jpg").read_bytes())
    (lib / "pair.jpg").write_bytes((lib / "b.jpg").read_bytes())
    c.post("/api/v1/library/scan")
    r = c.post("/api/v1/stacks/auto", json={"raw_jpeg": True})
    assert r.json()["stacks"] >= 1
    stacked = [g for g in r.json()["groups"] if len(g["members"]) == 2]
    assert stacked


def test_duplicates_found(client):
    c, lib, _ = client
    (lib / "dupe.jpg").write_bytes((lib / "a.jpg").read_bytes())
    c.post("/api/v1/library/scan")
    r = c.get("/api/v1/duplicates", params={"threshold": 2})
    groups = r.json()["groups"]
    assert any(len(g) == 2 for g in groups)


# ---------- collections (#15) ----------

def test_static_collection(client):
    c, _, _ = client
    ids = _ids(c)
    c.put("/api/v1/collections/faves", json={"type": "static", "ids": ids[:2]})
    r = c.get("/api/v1/images", params={"collection": "faves"})
    assert r.json()["total"] == 2
    c.post("/api/v1/collections/faves/images", json={"remove": [ids[0]]})
    assert c.get("/api/v1/images", params={"collection": "faves"}).json()["total"] == 1
    c.delete("/api/v1/collections/faves")
    assert c.get("/api/v1/images", params={"collection": "faves"}).status_code == 404


def test_smart_collection(client):
    c, _, _ = client
    ids = _ids(c)
    c.put(f"/api/v1/images/{ids[0]}/rating", json={"rating": 5})
    c.put("/api/v1/collections/best", json={"type": "smart", "query": {"rating_gte": 4}})
    assert c.get("/api/v1/images", params={"collection": "best"}).json()["total"] == 1
    # live: rating another image grows the collection
    c.put(f"/api/v1/images/{ids[1]}/rating", json={"rating": 4})
    assert c.get("/api/v1/images", params={"collection": "best"}).json()["total"] == 2


def test_smart_collection_rejects_unknown_keys(client):
    c, _, _ = client
    r = c.put("/api/v1/collections/bad", json={"type": "smart", "query": {"nope": 1}})
    assert r.status_code == 422


# ---------- XMP / IPTC (#16) ----------

def test_xmp_read_on_scan(client):
    c, lib, _ = client
    (lib / "d.jpg").write_bytes((lib / "a.jpg").read_bytes())
    (lib / "d.jpg.xmp").write_text("""<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4" xmp:Label="Blue">
   <dc:subject><rdf:Bag><rdf:li>alps</rdf:li><rdf:li>hiking</rdf:li></rdf:Bag></dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>""")
    c.post("/api/v1/library/scan")
    img = c.get("/api/v1/images", params={"q": "d.jpg"}).json()["images"][0]
    assert img["rating"] == 4 and img["label"] == "blue"
    assert sorted(img["keywords"]) == ["alps", "hiking"]


def test_iptc_roundtrip_and_xmp_write(client):
    c, lib, _ = client
    iid = _ids(c)[0]
    c.put(f"/api/v1/images/{iid}/iptc", json={"title": "Dawn", "copyright": "© Ratul"})
    assert c.get(f"/api/v1/images/{iid}/iptc").json()["title"] == "Dawn"

    r = c.post(f"/api/v1/images/{iid}/xmp/write")
    xmp_path = r.json()["path"]
    from viberoom.xmp import read_xmp
    from pathlib import Path
    data = read_xmp(Path(xmp_path))
    assert data["title"] == "Dawn" and data["copyright"] == "© Ratul"

    # and it embeds into JPEG exports as EXIF (ASCII-typed tag, so unicode
    # like © degrades there — XMP above carries the exact value)
    ex = c.post(f"/api/v1/images/{iid}/export", json={"max_dimension": 64})
    with Image.open(ex.json()["path"]) as im:
        assert im.getexif()[33432].endswith("Ratul")


# ---------- multi-folder catalog (#14) ----------

def test_extra_root_scanned_and_usable(client):
    c, _, tmp = client
    other = tmp / "other-drive"
    _make_jpegs(other, ["ext1.jpg", "ext2.jpg"], seed=42)
    r = c.post("/api/v1/library/roots", json={"path": str(other)})
    assert r.json()["total"] == 5
    assert str(other) in r.json()["extra"]

    img = c.get("/api/v1/images", params={"q": "ext1"}).json()["images"][0]
    # full API works on extra-root images
    assert c.put(f"/api/v1/images/{img['id']}/rating", json={"rating": 3}).status_code == 200
    pv = c.get(f"/api/v1/images/{img['id']}/preview", params={"size": 256})
    assert pv.status_code == 200
    # sidecar written next to the extra-root file
    assert (other / "ext1.jpg.vibe.json").exists()

    # removing the root prunes its images
    r = c.request("DELETE", "/api/v1/library/roots", params={"path": str(other)})
    assert r.json()["total"] == 3


# ---------- catalog DB: WAL, per-thread connections, transactions ----------

def test_wal_enabled_and_files_land_next_to_the_db(tmp_path):
    from viberoom.catalog.db import CatalogDB

    db = CatalogDB(tmp_path / "catalog.db")
    assert db.query("PRAGMA journal_mode")[0][0] == "wal"
    assert db.query("PRAGMA synchronous")[0][0] == 1  # NORMAL
    db.execute("INSERT INTO images (id, rel_path, filename, ext, is_raw, filesize, mtime)"
               " VALUES ('a','a.jpg','a.jpg','.jpg',0,1,1.0)")
    assert (tmp_path / "catalog.db-wal").exists()
    db.close()


def test_second_open_of_the_same_library_sees_the_same_rows(tmp_path):
    from viberoom.catalog.db import CatalogDB

    a = CatalogDB(tmp_path / "catalog.db")
    a.execute("INSERT INTO images (id, rel_path, filename, ext, is_raw, filesize, mtime)"
              " VALUES ('a','a.jpg','a.jpg','.jpg',0,1,1.0)")
    b = CatalogDB(tmp_path / "catalog.db")  # re-open must not fail or lose data
    assert len(b.query("SELECT id FROM images")) == 1
    a.close()
    b.close()


def test_transaction_batches_and_rolls_back(tmp_path):
    from viberoom.catalog.db import CatalogDB

    db = CatalogDB(tmp_path / "catalog.db")
    with db.transaction():
        for i in range(5):
            db.execute("INSERT INTO images (id, rel_path, filename, ext, is_raw, filesize,"
                       " mtime) VALUES (?,?,?,'.jpg',0,1,1.0)", (str(i), f"{i}.jpg", f"{i}.jpg"))
    assert len(db.query("SELECT id FROM images")) == 5
    with pytest.raises(RuntimeError):
        with db.transaction():
            db.execute("UPDATE images SET rating=3")
            raise RuntimeError("boom")
    assert all(r["rating"] == 0 for r in db.query("SELECT rating FROM images"))
    db.close()


def test_reader_thread_not_blocked_by_an_open_write_transaction(tmp_path):
    """WAL + a connection per thread: a reader gets its snapshot immediately
    instead of waiting behind the writer."""
    import threading

    from viberoom.catalog.db import CatalogDB

    db = CatalogDB(tmp_path / "catalog.db")
    db.execute("INSERT INTO images (id, rel_path, filename, ext, is_raw, filesize, mtime)"
               " VALUES ('a','a.jpg','a.jpg','.jpg',0,1,1.0)")
    seen, done = [], threading.Event()

    def reader():
        seen.append(db.query("SELECT rating FROM images WHERE id='a'")[0]["rating"])
        done.set()

    with db.transaction():
        db.execute("UPDATE images SET rating=5 WHERE id='a'")
        t = threading.Thread(target=reader)
        t.start()
        assert done.wait(5), "reader blocked behind the open write transaction"
        t.join()
    assert seen == [0]  # pre-commit snapshot, not a lock timeout
    assert db.query("SELECT rating FROM images WHERE id='a'")[0]["rating"] == 5
    db.close()


def test_rowcount_survives_thread_local_cursors(client):
    """stacks.unstack reads cur.rowcount off the cursor db.execute returns."""
    c, _, _ = client
    ids = [im["id"] for im in c.get("/api/v1/images").json()["images"]][:2]
    leader = c.post("/api/v1/stacks", json={"image_ids": ids}).json()["leader"]
    assert c.request("DELETE", f"/api/v1/stacks/{leader}").json()["unstacked"] == 2


def test_duplicate_clustering_matches_the_naive_pairwise_scan():
    """The LSH/numpy clusterer must agree with comparing every pair by hand."""
    import random

    from viberoom.catalog.stacks import _cluster_hashes

    rng = random.Random(11)
    hashes = []
    for i in range(400):
        if hashes and rng.random() < 0.1:  # seed near-duplicates around the threshold
            v = int(hashes[rng.randrange(len(hashes))][1], 16)
            for _ in range(rng.randrange(0, 8)):
                v ^= 1 << rng.randrange(64)
        else:
            v = rng.getrandbits(64)
        hashes.append((f"id{i:04d}", f"{v:016x}"))

    def reference(threshold):
        parent = {iid: iid for iid, _ in hashes}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i, (id_a, ha) in enumerate(hashes):
            for id_b, hb in hashes[i + 1:]:
                if bin(int(ha, 16) ^ int(hb, 16)).count("1") <= threshold:
                    parent[find(id_b)] = find(id_a)
        groups = {}
        for iid, _ in hashes:
            groups.setdefault(find(iid), []).append(iid)
        return sorted(sorted(g) for g in groups.values() if len(g) > 1)

    for threshold in (0, 1, 5, 7, 10):  # 8+ leaves the pigeonhole regime
        assert _cluster_hashes(hashes, threshold) == reference(threshold)
    assert _cluster_hashes(hashes[:1], 5) == []


def test_batched_metadata_matches_per_file_reads(tmp_path):
    from viberoom.catalog import metadata

    _make_jpegs(tmp_path, ["x.jpg", "y.jpg"])
    paths = [tmp_path / "x.jpg", tmp_path / "y.jpg"]
    assert metadata.read_metadata_batch(paths) == {p: metadata.read_metadata(p) for p in paths}


def test_metadata_falls_back_when_exiftool_fails(tmp_path, monkeypatch):
    """A broken/missing exiftool must not cost us exifread+Pillow results."""
    from viberoom.catalog import metadata

    _make_jpegs(tmp_path, ["z.jpg"])
    p = tmp_path / "z.jpg"
    monkeypatch.setattr(metadata, "_EXIFTOOL", str(tmp_path / "no-such-exiftool"))
    w, h, _ = metadata.read_metadata_batch([p])[p]
    with Image.open(p) as im:
        assert (w, h) == im.size


def test_scan_counts_survive_batched_writes(tmp_path):
    """Batching the upserts must not disturb added/updated/removed or the
    mtime-based warm-rescan skip."""
    from viberoom.catalog.db import CatalogDB
    from viberoom.catalog.scanner import scan
    from viberoom.config import Library

    lib_root = tmp_path / "lib"
    _make_jpegs(lib_root, [f"i{i}.jpg" for i in range(12)])
    db = CatalogDB(tmp_path / "catalog.db")
    library = Library(root=lib_root)
    assert scan(library, db) == {"total": 12, "added": 12, "updated": 0, "removed": 0}
    assert scan(library, db) == {"total": 12, "added": 0, "updated": 0, "removed": 0}
    (lib_root / "i0.jpg").unlink()
    _make_jpegs(lib_root, ["new.jpg"], seed=99)
    assert scan(library, db) == {"total": 12, "added": 1, "updated": 0, "removed": 1}
    assert scan(library, db, full=True)["updated"] == 12
    assert len(db.query("SELECT id FROM images")) == 12
    db.close()
