# Chạy trong container: docker exec -w /srv mf-be python3 /tmp/smoke_src.py
from app.main import _src

B = "/data/uploads/C/D/"
assert _src(B + "_ios_files/AppDomain-vn.com.vng.zingalo/Documents/a.jpg") == "Zalo"
assert _src(B + "_ios_files/AppDomainGroup-group.com.facebook.Messenger/x.jpg") == "Messenger"
assert _src(B + "_ios_files/CameraRollDomain/Media/DCIM/1.HEIC") == "Camera / Ảnh"
assert _src(B + "_ios_files/MediaDomain/Library/SMS/Attachments/a.jpg") == "Tin nhắn iMessage"
assert _src(B + "_ios_files/HomeDomain/Library/x.db") == "Hệ thống iOS"
assert _src(B + "_ios_files/AppDomain-com.shopee.vn/a.png") == "com.shopee.vn"
assert _src(B + "sdcard/Android/media/com.zing.zalo/a.jpg") == "Zalo"
assert _src(B + "sdcard/Android/data/com.miui.cloudbackup/a.xml") == "com.miui.cloudbackup"
assert _src(B + "sdcard/DCIM/Camera/a.jpg") == "Camera / Ảnh"
assert _src(B + "sdcard/Download/a.pdf") == "Tải về"
assert _src(B + "sdcard/Pictures/Screenshots/a.png") == "Pictures"
assert _src(B + "sim.txt") == "Khác"
assert _src(B + "_chat/zalo/zalo_A_1_2.txt") == "Zalo"
assert _src(B + "_records/danh_ba.txt") == "Danh bạ & Cuộc gọi"
assert _src(B + "_records/ghi_chu/ghi_chu_1_a.txt") == "Ghi chú"
assert _src(B + "_disk_files/p1/DCIM/100CANON/a.jpg") == "Camera / Ảnh"
assert _src(B + "_disk_files/p2/$OrphanFiles/x.doc") == "Tệp đã xoá"
assert _src(B + "_disk_files/p1/Tài liệu/a.pdf") == "Tài liệu"
assert _src(B + "_disk_files/p1/keep.txt") == "Thư mục gốc"
print("smoke_src OK")
