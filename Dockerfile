# be: FastAPI + SQLite (files/chunks) + MongoDB (hồ sơ) + Pillow + ffmpeg (khung hình video). Giao diện build riêng ở web/Dockerfile (container fe).
FROM python:3.12-slim
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg adb libimobiledevice-utils usbmuxd && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ app/
ENV MF_DATA=/data PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
