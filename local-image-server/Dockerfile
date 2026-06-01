FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOCAL_IMAGE_HOST=0.0.0.0 \
    LOCAL_IMAGE_PORT=18080
COPY local-image-server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY local-image-server/ ./
EXPOSE 18080
CMD ["python", "app.py"]
