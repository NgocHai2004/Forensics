FROM python:3.12-slim
# av<16: faster-whisper 1.2.0 passes metadata_errors, removed in PyAV 16
# ponytail: CUDA/cuDNN come from pip wheels instead of a 5 GB nvidia/cuda base image
RUN pip install --no-cache-dir faster-whisper==1.2.0 ctranslate2==4.6.0 requests "av<16" nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib \
    HF_HOME=/data/models/whisper PYTHONUNBUFFERED=1
COPY server.py /server.py
EXPOSE 9001
HEALTHCHECK --interval=30s --start-period=600s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:9001/health')"
CMD ["python", "/server.py"]
