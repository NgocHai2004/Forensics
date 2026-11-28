# be: Rust mf-fast (quét + hash + text chunking song song) + FastAPI + SQLite (files/chunks) + MongoDB (hồ sơ)
FROM rust:1 AS rust-build
WORKDIR /build
COPY rust/mf-fast/ ./
RUN cargo build --release

FROM python:3.12-slim
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg adb libimobiledevice-utils usbmuxd sleuthkit && rm -rf /var/lib/apt/lists/*
COPY --from=rust-build /build/target/release/mf-fast /usr/local/bin/mf-fast
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ app/
ENV MF_DATA=/data PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
