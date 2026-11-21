FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      fonts-dejavu-core python3 \
    && rm -rf /var/lib/apt/lists/*
COPY server.py /server.py
EXPOSE 9002
CMD ["python3", "-u", "/server.py"]
