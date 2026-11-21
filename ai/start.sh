#!/bin/bash
# Một dịch vụ chết -> container thoát -> Docker (restart: unless-stopped) dựng lại cả hai.
trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT
python /convert.py &
python /asr.py &
wait -n
echo "một dịch vụ ai đã dừng (mã $?), thoát để Docker khởi động lại" >&2
kill $(jobs -p) 2>/dev/null
exit 1
