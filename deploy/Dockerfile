# Single-container deployment: planner API + demo page + self-test harness.
#   docker build -f deploy/Dockerfile -t aegis-agent .
#   docker run -p 8077:8077 aegis-agent
FROM python:3.11-slim

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/
COPY demo/ demo/
COPY tools/ tools/
COPY extension/ extension/

ENV PORT=8077 AEGIS_PLANNER=heuristic
EXPOSE 8077
HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/v1/health')"

CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT}"]
