"""Smoke test trên app đang chạy (localhost:8000): index lại Vụ án 102 rồi hỏi 7 câu đa định dạng. Chạy: python3 tests/smoke_ask.py"""
import json, time, urllib.request
B = "http://localhost:8000"
def call(path, body=None, timeout=600):
    req = urllib.request.Request(B + path, json.dumps(body).encode() if body else None, {"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        return {"HTTP": e.code, "body": e.read()[:300].decode()}
call("/api/index", {"folder": "/data/uploads/Vụ án 102", "collection": "Vụ án 102"}); time.sleep(2)
while call("/api/index/status").get("status") == "running": time.sleep(3)
print("rescan 102:", call("/api/index/status"))
COL = "Mẫu đa định dạng"
for q, col in [("Ai hẹn gặp ai, lúc mấy giờ, ở đâu?", COL), ("Biển số xe xuất hiện trong video là gì?", COL),
               ("IMEI điện thoại bị thu giữ là bao nhiêu?", COL), ("Có những giao dịch chuyển tiền nào, bao nhiêu tiền?", COL),
               ("Nội dung các slide trình chiếu là gì?", COL), ("Có bao nhiêu file video trong vụ án?", COL),
               ("Số điện thoại của Lan là gì?", "Vụ án 102")]:
    t = time.time(); d = call("/api/ask", {"question": q, "collection": col})
    print("\nQ:", q, "| %.0fs" % (time.time() - t))
    print("A:", d["answer"][:350].replace("\n", " ") if "answer" in d else d)
    print("SOURCES:", [(x["id"], x["name"], x.get("loc")) for x in d.get("sources", [])])
