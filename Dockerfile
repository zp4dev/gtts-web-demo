# gTTS web demo — backend (FastAPI) + frontend (static + proxy) trong một container.
#
#   docker build -t gtts-demo .
#   docker run --rm -p 3000:3000 -p 8000:8000 \
#       -v "$PWD/backend:/app/backend:ro" \
#       -v "$PWD/frontend:/app/frontend:ro" \
#       gtts-demo
#
#   → http://localhost:3000 (UI)   http://localhost:8000/docs (Swagger)
#
# Hai volume mount READ-ONLY: container không ghi được gì vào source trên host.
# Sửa file ở host → uvicorn --reload tự nạp lại; frontend chỉ cần F5.
# Bỏ hẳn hai -v cũng chạy được, vì source đã được COPY sẵn vào image.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/backend

WORKDIR /app

# watchfiles: không bắt buộc, nhưng thiếu nó uvicorn --reload rơi về StatReload
# (poll từng file, chậm và tốn CPU). Cài thêm ở đây để khỏi phải sửa requirements.txt.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt watchfiles

COPY backend/ ./backend/
COPY frontend/ ./frontend/

# main.py lưu mp3 vào 'cache' — đường dẫn TƯƠNG ĐỐI theo thư mục làm việc.
# Nên uvicorn chạy ở /app/run (ghi được) thay vì /app/backend (mount ro),
# và tìm module main qua PYTHONPATH. Nhờ vậy backend/ không cần quyền ghi.
RUN mkdir -p /app/run/cache
WORKDIR /app/run

EXPOSE 8000 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:3000/api/health',timeout=3)" || exit 1

# Hai tiến trình, một container: uvicorn ở 8000, frontend proxy ở 3000.
# `wait -n` cho container thoát ngay khi một trong hai chết, thay vì treo nửa vời.
CMD ["bash", "-c", "\
uvicorn main:app --reload --reload-dir /app/backend --host 0.0.0.0 --port 8000 & backend=$!; \
python /app/frontend/server.py --host 0.0.0.0 --port 3000 --backend http://127.0.0.1:8000 & frontend=$!; \
trap 'kill $backend $frontend 2>/dev/null' TERM INT; \
wait -n; \
kill $backend $frontend 2>/dev/null; \
wait"]
