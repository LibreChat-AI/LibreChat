FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NMB_DATA_DIR=/data
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Optional NER model (PERSON/LOCATION/ORG). Build with:
#   docker build --build-arg SPACY_MODEL=en_core_web_sm .
# and set NMB_SPACY_MODEL=en_core_web_sm. Default is a blank pipeline
# (pattern recognisers only), which needs no model download.
ARG SPACY_MODEL=
RUN if [ -n "$SPACY_MODEL" ]; then python -m spacy download "$SPACY_MODEL"; fi
COPY app ./app
COPY config ./config
RUN useradd -r -u 10001 nmb && mkdir /data && chown nmb /data
USER nmb
EXPOSE 8088
VOLUME ["/data"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8088"]
