"""Smoke test bộ lọc Đối tượng/Loại tệp trên app đang chạy: số đếm phải khớp danh sách server trả về.
Chạy: python3 tests/smoke_objs.py "<vụ án>" ["<thiết bị>"]"""
import json, sys, urllib.parse, urllib.request
B = "http://localhost:8000"
def get(path, **p):
    return json.load(urllib.request.urlopen(B + path + "?" + urllib.parse.urlencode({k: v for k, v in p.items() if v}), timeout=120))
col, dev = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
stats, objs = get("/api/files/stats", collection=col, device=dev), get("/api/files/objects", collection=col, device=dev)
media = stats["by"]["image"]["n"] + stats["by"]["video"]["n"]
assert objs["all"] == media, (objs["all"], media)
for k, n in objs.items():
    if k != "all":
        t = get("/api/files/browse", collection=col, device=dev, obj=k, limit=1)["total"]
        assert t == n, (k, t, n)
for k, v in stats["by"].items():
    assert get("/api/files/browse", collection=col, device=dev, store=k, limit=1)["total"] == v["n"], k
page = get("/api/files/browse", collection=col, device=dev, store="image", obj="person", limit=200)
assert all(f["kind"] == "image" for f in page["items"]) and len(page["items"]) == min(200, page["total"])
print("OK", col, dev or "(mọi thiết bị)", "ảnh+video", media, {k: v for k, v in objs.items() if k != "all"})
