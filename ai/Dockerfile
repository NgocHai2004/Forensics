# ai: asr (faster-whisper, GPU) :9001 + convert (LibreOffice headless) :9002 trong một container.
FROM python:3.12-slim
# av<16: faster-whisper 1.2.0 passes metadata_errors, removed in PyAV 16
# CUDA/cuDNN từ pip wheel thay vì base image nvidia/cuda 5 GB; giữ đúng lệnh cũ của asr để dùng lại cache build
RUN pip install --no-cache-dir faster-whisper==1.2.0 ctranslate2==4.6.0 requests "av<16" nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib \
    HF_HOME=/data/models/whisper PYTHONUNBUFFERED=1
COPY asr/server.py /asr.py
COPY convert/server.py /convert.py
COPY ai/start.sh /start.sh
EXPOSE 9001 9002
# healthy chỉ khi cả hai dịch vụ trả lời; whisper large-v3 nạp lâu nên start-period dài
HEALTHCHECK --interval=30s --start-period=600s CMD python -c "import urllib.request as u;u.urlopen('http://127.0.0.1:9001/health');u.urlopen('http://127.0.0.1:9002/health')"
CMD ["bash", "/start.sh"]
