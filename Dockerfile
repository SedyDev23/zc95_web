# ZC95 Web Manager in a container.
#
#   docker compose up -d --build        (see docker-compose.yml)
#
# Settings (the ZC95 IP and chosen folder) live in the /data volume, Lua scripts in /scripts.
# The container only needs to reach the ZC95 on your network; no special network mode is needed.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ZC95_WEB_HOST=0.0.0.0 \
    ZC95_WEB_PORT=8080 \
    ZC95_DATA_DIR=/data \
    ZC95_SCRIPTS_ROOT=/scripts

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./
COPY lib ./lib
COPY static ./static
COPY scripts/examples ./examples
COPY docker/entrypoint.sh /usr/local/bin/zc95-entrypoint
COPY docker/healthcheck.py ./

# Run as an unprivileged user (uid 1000); the volumes are created owned by it
RUN chmod +x /usr/local/bin/zc95-entrypoint \
 && useradd --system --uid 1000 --home-dir /data --shell /usr/sbin/nologin zc95 \
 && mkdir -p /data /scripts \
 && chown zc95:zc95 /data /scripts
USER zc95

VOLUME ["/data", "/scripts"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "/app/healthcheck.py"]

ENTRYPOINT ["zc95-entrypoint"]
# exec form, so python gets SIGTERM on "docker stop" and stops any running pattern before exiting
CMD ["python", "/app/app.py"]
