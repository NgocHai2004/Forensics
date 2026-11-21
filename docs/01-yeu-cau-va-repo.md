# Hệ thống thu thập – phân tích – hỏi đáp dữ liệu số Android + Cloud
## Tài liệu làm rõ yêu cầu và khảo sát repo mã nguồn mở (2026-11-11)

Phạm vi pháp lý giả định: thiết bị và tài khoản được chủ sở hữu đồng ý hoặc có lệnh của cơ quan có thẩm quyền. Mọi bước thu thập phải ghi hash, log và không ghi đè dữ liệu gốc (chain of custody).

---

## 1. Làm rõ từng khối yêu cầu

### 1.1 Thu thập từ thiết bị Android (USB)

| Yêu cầu gốc | Thực tế kỹ thuật | Cần quyết định |
|---|---|---|
| Kết nối USB | ADB (cần bật USB debugging + chấp nhận RSA key trên máy) hoặc MTP (chỉ media) | Chấp nhận thao tác trên máy để bật debugging không? |
| Ảnh/video/âm thanh/tài liệu | `adb pull /sdcard` hoặc MTP, không cần root | — |
| Danh bạ, SMS, call log | `adb shell content query` qua content provider, hoặc `adb backup` (Android ≤ 11 còn hiệu lực), hoặc agent APK cài lên máy | Có cho phép cài agent APK lên máy không? |
| Thông tin thiết bị, app đã cài | `adb shell getprop`, `pm list packages`, `dumpsys`, bugreport | — |
| Dữ liệu app "được phép truy cập" | 3 mức: (a) logical không root: chỉ app có `allowBackup=true`, rất ít app nhắn tin; (b) kỹ thuật downgrade APK kiểu Avilla Forensics (Android ≤ 14, có thay đổi trạng thái máy); (c) root / Full File System | **Chọn mức tối thiểu. Mức (a) không lấy được DB WhatsApp/Zalo/Telegram/Signal.** |

### 1.2 Thu thập từ ứng dụng

| App | Nguồn dữ liệu khả thi | Repo có sẵn | Khoảng trống |
|---|---|---|---|
| WhatsApp | `msgstore.db` + `wa.db` trong `/data/data/com.whatsapp` (cần mức b/c), hoặc backup `.crypt15` + key | wa-crypt-tools (GPL-3), WhatsApp-Chat-Exporter (MIT), ALEAPP plugin | Cần key từ `/data` hoặc mật khẩu backup end-to-end |
| Signal | Backup file + passphrase 30 số do chủ máy cung cấp | signalbackup-tools (GPL-3, C++) | Không có passphrase thì không giải mã được |
| Telegram | `cache4.db` trong `/data/data/org.telegram.messenger` | ALEAPP telegramAndroid.py (duy nhất còn bảo trì) | Parser cũ dễ vỡ khi Telegram đổi schema; cloud chat không nằm trong cache |
| Facebook / Messenger | On-device `threads_db2` (ALEAPP, Autopsy) hoặc export "Download Your Information" từ tài khoản | ALEAPP, RLEAPP facebookArchive.py | Meta đổi format DYI định kỳ |
| Zalo | SQLite trong `/data/data/com.zing.zalo` (cần mức b/c) | **Không có parser mã nguồn mở nào** | Phải tự viết parser; cần mẫu DB thật để reverse schema |
| Khác (Viber, Line, Instagram, TikTok, Discord, WeChat...) | ALEAPP có ~100 plugin | ALEAPP (MIT) | — |

Metadata mục tiêu chung: thời gian gửi/nhận, người gửi, nhóm, trạng thái đọc, file đính kèm (hash + đường dẫn), tọa độ nếu có.

### 1.3 Thu thập Cloud

| Dịch vụ | Cách khả thi (có ủy quyền chủ tài khoản) | Repo |
|---|---|---|
| Google Drive | OAuth user consent → API hoặc rclone | rclone (MIT), google-api-python-client (Apache-2) |
| Google Photos | **API không còn cho đọc toàn thư viện (2025)** → bắt buộc Google Takeout | GooglePhotosTakeoutHelper, RLEAPP takeout* |
| Gmail | Gmail API OAuth | GYB got-your-back (Apache-2) |
| Google Contacts, Calendar | People API / Calendar API hoặc Takeout (vCard, ICS, stdlib đọc được) | google-api-python-client |
| OneDrive | Microsoft Graph OAuth | rclone, msgraph-sdk-python (MIT) |
| Dropbox | Dropbox API v2 OAuth | rclone, dropbox-sdk-python (MIT) |
| Backup app trên cloud (WhatsApp trên Drive) | Cần tài khoản + key | whapa whagodri (không có license, chỉ tham khảo) |

Cần quyết định: ai đăng nhập và cấp OAuth (chủ tài khoản trực tiếp, hay điều tra viên dùng thiết bị của chủ), token lưu ở đâu, thời hạn thu hồi.

### 1.4 Phân tích dữ liệu

Chuẩn hóa mọi nguồn về một bảng sự kiện chung:

```
event(id, case_id, source{device|app|cloud}, app, type{message|call|sms|photo|file|email|calendar|location|login},
      ts_utc, tz, actor, counterpart, group_id, content_text, attachments[], lat, lon, raw_ref, hash)
```

| Loại phân tích | Kỹ thuật | Repo / model |
|---|---|---|
| Ảnh | caption + tag, OCR, hash trùng lặp, EXIF/GPS | Florence-2 (MIT), open_clip, PaddleOCR / EasyOCR (hỗ trợ tiếng Việt), imagehash, exiftool (GPL, gọi subprocess) |
| Khuôn mặt | detect + cluster | deepface (MIT). Model insightface chỉ cho nghiên cứu phi thương mại |
| Video | cắt cảnh, keyframe → xử lý như ảnh; vPDQ hash | PySceneDetect (BSD-3), ThreatExchange pdq/vpdq |
| Âm thanh | ASR tiếng Việt, diarization | faster-whisper + PhoWhisper (BSD-3), whisperX |
| Tin nhắn / liên lạc | thống kê tần suất, mạng liên lạc, NER người/địa điểm | underthesea (Apache-2), PhoBERT (kiểm tra license weights: repo MIT, HF card ghi AGPL) |
| Timeline | sort theo `ts_utc`, lọc theo nguồn/người | Bảng event ở trên; tùy chọn xuất sang Timesketch/Plaso (Apache-2) |
| Liên kết thiết bị–app–cloud | khớp theo số điện thoại, email, hash file, tên tài khoản | tự viết (logic nghiệp vụ, không có repo sẵn) |

### 1.5 AI hỏi đáp

| Yêu cầu | Cách làm | Repo |
|---|---|---|
| Tìm kiếm ngôn ngữ tự nhiên | embedding + vector search trên `event.content_text` và caption/OCR/ASR | LlamaIndex (MIT) hoặc Haystack (Apache-2); pgvector hoặc Qdrant |
| Hỏi đáp trên dữ liệu | RAG có filter theo case_id, thời gian, người | như trên + Ollama (MIT) chạy offline |
| Mối liên hệ người–sự kiện–địa điểm–thời gian | graph: node = person/place/event, edge = message/call/co-location | bắt đầu bằng bảng quan hệ trong Postgres; Graphiti (Apache-2) + Neo4j (GPL Community) khi cần |
| Tổng hợp báo cáo | LLM tóm tắt theo template + trích dẫn event id | Timesketch có `llm_summarize` tham khảo |

**Không có dự án mã nguồn mở nào gộp đủ thu thập + phân tích + AI hỏi đáp cho mobile.** Phần phải tự xây là lớp "keo": chuẩn hóa artifact, lưu trữ, graph quan hệ, RAG tiếng Việt, parser Zalo.

---

## 2. Yêu cầu phi chức năng cần bổ sung vào đề bài

- Triển khai offline / on-prem (dữ liệu điều tra không gửi ra LLM cloud).
- Tính toàn vẹn chứng cứ: hash SHA-256 mọi file thu, log mọi thao tác, dữ liệu gốc read-only.
- Đa người dùng, phân quyền theo vụ án, audit log.
- Tiếng Việt ở mọi tầng: OCR, ASR, NER, embedding, LLM.
- Báo cáo xuất PDF/DOCX có trích dẫn nguồn (event id, hash file).
- License: tránh nhúng code GPL/AGPL vào lõi nếu sản phẩm đóng; gọi qua subprocess/service.

---

## 3. Câu hỏi cần chủ dự án trả lời trước khi code

1. Dải phiên bản Android mục tiêu? (quyết định `adb backup` còn dùng được không)
2. Cho phép root / downgrade APK / cài agent lên máy không? Nếu không, chấp nhận không lấy được DB WhatsApp/Zalo/Telegram/Signal on-device.
3. Dữ liệu app lấy từ máy hay từ export tài khoản (DYI, Takeout) do chủ tài khoản tự tải?
4. Có mẫu DB Zalo thật để viết parser không?
5. LLM chạy local (Ollama, cần GPU) hay được phép dùng API cloud?
6. Nhận diện khuôn mặt có bắt buộc không? (vướng license model)
7. Quy mô: bao nhiêu vụ / thiết bị / TB dữ liệu đồng thời? (quyết định pgvector hay Qdrant, Postgres hay Neo4j)
8. Đầu ra bắt buộc: web app, desktop, hay CLI + báo cáo?

---

## 4. Stack đề xuất tối thiểu cho v1 (Ponytail)

| Tầng | Chọn | Lý do |
|---|---|---|
| Ngôn ngữ | Python 3.12, monorepo | ALEAPP, LlamaIndex, OCR/ASR đều Python |
| Thu thập thiết bị | androidqf (binary) + script `adb shell content query` | đã có, MVT License cho phép dùng có đồng ý |
| Parser app | ALEAPP làm thư viện + wa-crypt-tools + signalbackup-tools (subprocess) + parser Zalo tự viết | MIT lõi, GPL cách ly |
| Cloud | rclone (Drive/OneDrive/Dropbox) + GYB (Gmail) + Takeout parser | một binary lo 3 cloud |
| Lưu trữ | PostgreSQL + pgvector, file store theo hash | một DB cho event, vector, quan hệ |
| Media | PaddleOCR, Florence-2, faster-whisper + PhoWhisper, exiftool, imagehash | offline, license sạch |
| AI | LlamaIndex + Ollama (Qwen/Gemma đa ngữ) | offline, MIT |
| Giao diện | web (FastAPI + 1 trang HTML) | thêm sau khi pipeline chạy |

Bỏ qua ở v1, thêm khi cần: Timesketch/OpenRelik (khi cần cộng tác nhiều điều tra viên), Neo4j/Graphiti (khi truy vấn graph nhiều bước), Qdrant (khi > vài chục triệu vector), nhận diện mặt (khi có license).

---

## 5. Bảng repo đầy đủ (đã xác minh qua GitHub API ngày 2026-11-11)

### 5.1 Thu thập thiết bị
| Repo | Ngôn ngữ | License | Hoạt động | Phạm vi | Lưu ý |
|---|---|---|---|---|---|
| github.com/mvt-project/androidqf | Go | MVT 1.1 | 2026 | Collector ADB: device info, packages+APK, adb backup, logcat, bugreport, files; hash + mã hóa archive | Không parse content provider |
| github.com/mvt-project/mvt | Python | MVT 1.1 | 2026 | Phân tích archive androidqf/adb backup, IOC | Thiên về phát hiện spyware |
| github.com/AvillaDaniel/AvillaForensics | C# | GPL | 2026 | GUI: logical, App Full Extraction không root (Android ≤14), WhatsApp decrypt | Windows, tiếng Bồ, khó tái dùng |
| github.com/abrignoni/ALEAPP | Python | MIT | 2026 | Parser contacts, calllog, sms, packages + ~100 app | Chỉ parse |
| github.com/sleuthkit/autopsy | Java | Apache-2 | 2026 | Android Analyzer | Desktop nặng |
| github.com/den4uk/andriller | Python | MIT | 2022 | adb backup cũ, decoder app | Chết từ 2022 |
| github.com/nowsecure/android-forensics | Java | — | 2015 | AFLogical content provider → CSV | Archived, tham khảo cách query |

### 5.2 Parser ứng dụng
| Repo | Ngôn ngữ | License | Hoạt động | Phạm vi | Lưu ý |
|---|---|---|---|---|---|
| github.com/ElDavoo/wa-crypt-tools | Python | GPL-3 | 2026 | Giải mã crypt12/14/15 | Cần key |
| github.com/KnugiHK/WhatsApp-Chat-Exporter | Python | MIT | 2026 | msgstore.db → HTML/JSON | Schema đổi theo version |
| github.com/B16f00t/whapa | Python | không | 2026 | Parser, cipher, Drive backup | Không license |
| github.com/bepaald/signalbackup-tools | C++ | GPL-3 | 2026 | Giải mã + export Signal backup | Cần passphrase |
| github.com/mossblaser/signal_for_android_decryption | Python | GPL-3 | 2025 | Decrypt Signal tối giản | Tham khảo nhúng |
| github.com/RealityNet/teleparser | Python | MIT | 2020 | cache4.db Telegram | Cũ |
| github.com/abrignoni/RLEAPP | Python | MIT | 2026 | Facebook DYI, Takeout, Instagram, TikTok export | Format đổi định kỳ |
| github.com/akhil-dara/WAInsight | Python | MIT | 2026 | Phân tích WhatsApp DB, media recovery, pHash | Chỉ WhatsApp |
| github.com/cle15102005/android-instant-messaging-apps-forensic | Python | không | 2026 | Đồ án sinh viên có nhắc Zalo | 0 sao, tham khảo |

### 5.3 Cloud
| Repo | Ngôn ngữ | License | Hoạt động | Phạm vi | Lưu ý |
|---|---|---|---|---|---|
| github.com/rclone/rclone | Go | MIT | 2026 | Drive, Photos (hạn chế), OneDrive, Dropbox, lsjson, hash | Không Gmail/Contacts/Calendar |
| github.com/googleapis/google-api-python-client | Python | Apache-2 | 2026 | Gmail, Drive, People, Calendar API | Tự viết paging |
| github.com/GAM-team/got-your-back | Python | Apache-2 | 2026 | Backup Gmail đầy đủ, incremental | CLI |
| github.com/purarue/google_takeout_parser | Python | MIT | 2026 | Takeout: activity, location, Chrome | Không mbox/Drive/vCard/ICS (dùng stdlib) |
| github.com/TheLastGimbus/GooglePhotosTakeoutHelper | Dart | Apache-2 | 2025 | Gộp JSON metadata Photos Takeout | — |
| github.com/gilesknap/gphotos-sync | Python | Apache-2 | archived | Photos API | Google bỏ scope 2025 |
| github.com/microsoftgraph/msgraph-sdk-python | Python | MIT | 2026 | OneDrive, Outlook | Cần Entra app |
| github.com/dropbox/dropbox-sdk-python | Python | MIT | 2026 | Dropbox API v2 | — |

### 5.4 Timeline / nền tảng
| Repo | Ngôn ngữ | License | Hoạt động | Phạm vi | Lưu ý |
|---|---|---|---|---|---|
| github.com/google/timesketch | Python | Apache-2 | 2026 | Timeline cộng tác, LLM summarize/NL2Q (Ollama) | LLM experimental, không parser mobile |
| github.com/log2timeline/plaso | Python | Apache-2 | 2026 | Super-timeline | Không parser app Android |
| github.com/openrelik/openrelik | Python | Apache-2 | 2026 | DFIR platform Google, libs/ai-common đa provider | Trẻ, không worker mobile |
| github.com/dfir-iris/iris-web | Python | LGPL-3 | 2026 | Quản lý vụ án, IOC | Không parse, không AI |
| github.com/jacobecontreras/suiteDFIR | Python | Apache-2 | 2026 | Acquisition + ALEAPP/iLEAPP + timeline | Beta, không AI |
| github.com/sarvagnasrao/Intelligent-Digital-Forensic-AI-Assistant | Python | không | 2026 | RAG Ollama + Qdrant + graph + OCR/Whisper + chain of custody | Không license, kiến trúc tham khảo |
| github.com/FlipForensics/AIFT | Python | AGPL-3 | 2026 | AI triage disk image, MCP | Không mobile, AGPL |

### 5.5 Phân tích media
| Repo / model | License | Hoạt động | Phạm vi | Lưu ý |
|---|---|---|---|---|
| github.com/mlfoundations/open_clip | custom permissive | 2026 | embedding ảnh-text, zero-shot tag | chọn checkpoint đa ngữ |
| hf.co/microsoft/Florence-2-large | MIT | 2025 | caption, OCR, detect | caption tiếng Anh |
| github.com/PaddlePaddle/PaddleOCR | Apache-2 | 2026 | OCR có tiếng Việt | runtime Paddle |
| github.com/JaidedAI/EasyOCR | Apache-2 | 2025 | OCR 80 ngôn ngữ | chậm hơn |
| github.com/pbcquoc/vietocr | Apache-2 | 2025 | recognizer tiếng Việt | cần detector |
| github.com/serengil/deepface | MIT | 2026 | face detect/cluster | license theo backend |
| github.com/deepinsight/insightface | code MIT, model non-commercial | 2026 | face | **không dùng model thương mại** |
| github.com/SYSTRAN/faster-whisper, ggml-org/whisper.cpp | MIT | 2026 | ASR offline | thay weights PhoWhisper |
| hf.co/vinai/PhoWhisper-large | BSD-3 | 2024 | ASR tiếng Việt | convert CTranslate2 |
| github.com/m-bain/whisperX | BSD-2 | 2026 | timestamp + diarization | pyannote gated |
| github.com/Breakthrough/PySceneDetect | BSD-3 | 2026 | scene/keyframe | — |
| github.com/exiftool/exiftool | GPL/Artistic | 2026 | metadata | subprocess |
| github.com/JohannesBuchner/imagehash | BSD-2 | 2026 | pHash | — |
| github.com/meta/ThreatExchange (pdq, vpdq) | theo thư mục | 2026 | hash ảnh/video | build native |

### 5.6 RAG / graph / NLP tiếng Việt
| Repo | License | Hoạt động | Phạm vi | Lưu ý |
|---|---|---|---|---|
| github.com/run-llama/llama_index | MIT | 2026 | RAG, property graph | — |
| github.com/deepset-ai/haystack | Apache-2 | 2026 | pipeline RAG on-prem | — |
| github.com/infiniflow/ragflow | Apache-2 | 2026 | RAG app trọn gói + GraphRAG | nặng (Elasticsearch) |
| github.com/pgvector/pgvector | PostgreSQL | 2026 | vector trong Postgres | — |
| github.com/qdrant/qdrant | Apache-2 | 2026 | vector DB filter payload | service riêng |
| github.com/lancedb/lancedb, chroma-core/chroma | Apache-2 | 2026 | vector nhúng file | — |
| github.com/getzep/graphiti | Apache-2 | 2026 | knowledge graph theo thời gian | cần Neo4j/FalkorDB + LLM |
| github.com/neo4j/neo4j | GPL-3 Community | 2026 | graph DB | GPL |
| github.com/HKUDS/LightRAG | MIT | 2026 | graph+vector RAG, Ollama | chất lượng phụ thuộc LLM local |
| github.com/kuzudb/kuzu | MIT | archived 2025 | graph nhúng | **không dùng** |
| github.com/undertheseanlp/underthesea | Apache-2 | 2026 | word-seg, NER tiếng Việt | NER trung bình |
| github.com/VinAIResearch/PhoBERT | MIT code / AGPL model card | 2026 | BERT tiếng Việt | làm rõ license weights |
| github.com/ollama/ollama | MIT | 2026 | serve LLM local | — |
| github.com/studiawan/llm-forensic-timeline, NetherlandsForensicInstitute/DFRWS-EU-2024-LLM4DF-Workshop | MIT / Apache-2 | 2024–2026 | phương pháp đánh giá LLM trên timeline | tham khảo |
