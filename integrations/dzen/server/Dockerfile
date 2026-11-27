FROM mcr.microsoft.com/playwright/python:v1.64.1-noble
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DZEN_AGENT_STATE_DIR=/state HOME=/state/home XDG_CACHE_HOME=/state/cache XDG_CONFIG_HOME=/state/config
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify x11-utils && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir playwright==1.64.1 \
    && install -d -m 0700 -o pwuser -g pwuser /state
COPY agent.py /app/agent.py
COPY server/server_agent.py /app/server_agent.py
RUN chmod 755 /app && chmod 644 /app/*.py
USER pwuser
CMD ["python", "/app/server_agent.py", "run"]
