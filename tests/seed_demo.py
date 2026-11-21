"""Tạo vụ án DEMO (dữ liệu giả, không phải người thật) để xem Vụ án -> Thiết bị -> Tài liệu -> Sơ đồ quan hệ -> Hỏi đáp.
Chạy trên máy chủ khi app đang chạy:  python3 tests/seed_demo.py
Chạy lại: thiết bị đã có được bỏ qua, file trùng tên được lưu thành _2 (nên chỉ chạy một lần).
Toàn bộ tên, số điện thoại, IMEI, biển số đều bịa."""
import json, time, urllib.error, urllib.parse, urllib.request, uuid

B = "http://localhost:8000"
CASE = "DEMO - Ma túy Quận 7"
NOTE = "Dữ liệu giả lập để demo: 4 thiết bị thu giữ, danh bạ, cuộc gọi, tin nhắn, giao dịch, camera"

# Đối tượng (giả): Nam (chủ mưu), Lan (người yêu Nam), Hùng (đàn em), Tuấn (nguồn hàng), Minh (khách), Long (em họ Lan)
NAM, LAN, HUNG, TUAN, MINH, LONG = "0901234567", "0987654321", "0912345678", "0938111222", "0977666555", "0356789123"

DEVICES = {  # tên thiết bị: (loại, {đường dẫn tương đối: nội dung})
    "iPhone 13 của Nguyễn Văn Nam": ("phone", {
        "thong_tin_may.txt": "Thông tin máy\nModel: iPhone 13 (A2633)\nIMEI 356789012345678\n"
                             f"Số thuê bao SIM 1: {NAM}\nTài khoản iCloud: nam.nguyen88@gmail.com\n",
        "danh_ba.csv": "Tên,Số điện thoại,Email,Ghi chú\n"
                       f"Lan ❤,{LAN},lan.tran.95@gmail.com,\nHùng em,{HUNG},,đàn em\n"
                       f"Anh Tuấn hàng,{TUAN},tuan.kho@proton.me,\nMinh khách,{MINH},,\n",
        "cuoc_goi.csv": "Thời gian,Số,Hướng,Thời lượng (giây)\n"
                        f"2026-11-01 08:12,{TUAN},Gọi đi,312\n2026-11-01 08:40,{HUNG},Gọi đi,95\n"
                        f"2026-11-01 21:05,{LAN},Gọi đến,640\n2026-11-02 07:58,{TUAN},Gọi đến,128\n"
                        f"2026-11-02 18:30,{MINH},Gọi đến,45\n2026-11-03 06:15,{HUNG},Gọi đi,60\n",
        "Zalo/tin_nhan_zalo.csv": "Thời gian,Từ,Đến,Nội dung\n"
                                  f"2026-11-01 08:20,{TUAN},{NAM},Hàng về rồi 2 cục tối mai lấy\n"
                                  f"2026-11-01 08:45,{NAM},{HUNG},Mai 7h tối ra kho Phú Mỹ lấy đồ\n"
                                  f"2026-11-02 18:35,{MINH},{NAM},Anh ơi em lấy 5 chỉ như cũ\n"
                                  f"2026-11-02 19:02,{NAM},{MINH},Chuyển trước rồi Hùng mang qua\n",
        "giao_dich_momo.csv": "Thời gian,Từ SĐT,Đến SĐT,Số tiền (VND),Nội dung\n"
                              f"2026-11-01 09:10,{NAM},{TUAN},50000000,coc hang\n"
                              f"2026-11-02 19:10,{MINH},{NAM},12500000,tra tien\n"
                              f"2026-11-03 06:30,{NAM},{HUNG},3000000,tien cong\n",
    }),
    "Samsung A52 của Trần Thị Lan": ("phone", {
        "thong_tin_may.txt": f"Thông tin máy\nModel: Samsung Galaxy A52\nIMEI 352468013579246\nSố thuê bao SIM 1: {LAN}\n",
        "danh_ba.csv": f"Tên,Số điện thoại\nAnh Nam,{NAM}\nHùng bạn anh Nam,{HUNG}\nLong em họ,{LONG}\n",
        "tin_nhan_sms.csv": "Thời gian,Từ,Đến,Nội dung\n"
                            f"2026-11-01 21:20,{NAM},{LAN},Mai anh bận việc ở Phú Mỹ đừng gọi\n"
                            f"2026-11-03 10:02,{LAN},{LONG},Cất giùm chị cái túi đen nhé\n",
    }),
    "Laptop Dell của Lê Văn Hùng": ("laptop", {
        "so_sach/giao_dich_so_ghi_chep.csv": "Ngày,Người nhận,SĐT,Số lượng,Thành tiền\n"
                                             f"2026-11-01,Minh,{MINH},5 chỉ,12500000\n"
                                             "2026-11-02,Khách Q8,0388123456,2 chỉ,5000000\n",
        "ghi_chu.txt": "Lịch giao hàng: thứ 2, 4, 6.\nXe giao biển số 51F-123.45 (anh Nam).\n"
                       f"Liên hệ kho: {TUAN}.\nEmail báo cáo: hung.le.work@gmail.com\n",
    }),
    "Đầu thu camera kho Phú Mỹ": ("camera", {
        "nhat_ky_camera.csv": "Thời gian,Camera,Sự kiện,Biển số\n"
                              "2026-11-01 19:02,CAM-01 cổng,Xe vào,51F-123.45\n"
                              "2026-11-01 19:40,CAM-01 cổng,Xe ra,51F-123.45\n"
                              "2026-11-02 19:05,CAM-01 cổng,Xe vào,59X1-678.90\n",
    }),
}


def call(path, body=None, files=None):
    if files is not None:  # multipart bằng stdlib; filename giữ đường dẫn tương đối như khi chọn thư mục trên web
        bd = uuid.uuid4().hex
        parts = [f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in body.items()]
        parts += [f'--{bd}\r\nContent-Disposition: form-data; name="files"; filename="{n}"\r\n'
                  f'Content-Type: text/plain\r\n\r\n'.encode() + t.encode() + b"\r\n" for n, t in files.items()]
        data, ctype = b"".join(parts) + f"--{bd}--\r\n".encode(), f"multipart/form-data; boundary={bd}"
    else:
        data, ctype = (json.dumps(body).encode() if body else None), "application/json"
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(B + path, data, {"Content-Type": ctype}), timeout=120))
    except urllib.error.HTTPError as e:
        return {"HTTP": e.code, "detail": json.loads(e.read() or b"{}").get("detail")}


def wait():
    while call("/api/index/status").get("status") == "running":
        time.sleep(2)


print("vụ án:", call("/api/cases", {"name": CASE, "note": NOTE}).get("detail", "tạo mới"))
for dev, (typ, files) in DEVICES.items():
    print("thiết bị:", dev, "-", call("/api/devices", {"case": CASE, "name": dev, "type": typ}).get("detail", "tạo mới"))
    wait()  # server chỉ index một thư mục một lúc
    print("  tải lên:", call("/api/upload", {"collection": CASE, "device": dev}, files))
wait()
print("index:", call("/api/index/status"))
g = call("/api/graph?case=" + urllib.parse.quote(CASE))
assert "nodes" in g, g
print(f"sơ đồ: {len(g['nodes'])} đối tượng, {len(g['edges'])} liên kết")
people = {n["name"] for n in g["nodes"] if n.get("name")}
print("người trong danh bạ:", sorted(people))
assert len(people) >= 5 and any(e["rels"][0][0] == "Giao dịch" for e in g["edges"]), "thiếu người/giao dịch trong sơ đồ"
print("seed OK")
