# gTTS Web Demo

Giao diện web cho API text-to-speech (`POST /audio`) chạy bằng FastAPI + gTTS.

## Cấu trúc

```
backend/      FastAPI + gTTS  (POST /audio?text=...&lang=...)
frontend/     Giao diện web
  index.html  Trang demo
  styles.css  Giao diện tối, responsive
  app.js      Gọi API, quản lý audio + lịch sử
  server.py   Static server + proxy /api/* → localhost:8000
```

## Chạy

Cần **2 terminal**.

**1. Backend** (cổng 8000):

```bash
pip install -r requirements.txt
mkdir -p backend/cache
cd backend && uvicorn main:app --reload
```

Docs: <http://localhost:8000/docs>

**2. Frontend** (cổng 3000):

```bash
python frontend/server.py
```

Mở <http://localhost:3000>.

Tuỳ chọn: `python frontend/server.py --port 5173 --backend http://localhost:8000`

## Vì sao cần `server.py`?

Backend không bật CORS middleware, nên trình duyệt sẽ chặn request từ origin khác.
`server.py` phục vụ trang tĩnh **và** proxy `/api/*` sang backend, nên mọi request
đều cùng một origin — không cần sửa gì trong `backend/`.

| Đường dẫn frontend | Chuyển tới |
| --- | --- |
| `POST /api/audio?text=…&lang=…` | `POST localhost:8000/audio` |
| `GET /api/health` | kiểm tra `localhost:8000/openapi.json` (đèn trạng thái) |

## Tính năng

- 69 ngôn ngữ gTTS, ghi nhớ lựa chọn gần nhất (`localStorage`)
- Đếm từ, chặn gửi khi vượt giới hạn 150 từ của backend
- `Ctrl/Cmd + Enter` để tạo audio
- Trình phát tích hợp, tải MP3, lịch sử phiên (bấm để nghe lại)
- Đèn trạng thái API và hiển thị đúng lỗi backend trả về (400 / 422)
- Nút mẫu nhanh: Tiếng Việt, English, 日本語, Français

## Ghi chú về API

`POST /audio` nhận tham số **query** (không phải JSON body):

| Tham số | Bắt buộc | Mặc định | Ghi chú |
| --- | --- | --- | --- |
| `text` | có | — | > 150 **từ** → 400 |
| `lang` | không | `en` | mã ngôn ngữ gTTS, vd `vi`, `ja`, `fr-CA` |

Trả về `audio/mpeg`. File tạm trong `backend/cache/` được xoá sau khi phản hồi xong.
