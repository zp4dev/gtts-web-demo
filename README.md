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
Dockerfile    Chạy cả backend + frontend trong một container
compose.yaml  Cùng nội dung đó, chạy bằng `docker compose up`
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

## Chạy bằng Docker (một container, cả hai service)

```bash
docker build -t gtts-demo .
docker run --rm -p 3000:3000 -p 8000:8000 \
    -v "$PWD/backend:/app/backend:ro" \
    -v "$PWD/frontend:/app/frontend:ro" \
    gtts-demo
```

Mở <http://localhost:3000> (UI) và <http://localhost:8000/docs> (Swagger).

- Backend chạy `uvicorn main:app --reload`, frontend chạy `server.py` — cùng một container.
- Hai volume mount **read-only**: container không ghi được vào source trên host.
  Sửa file ở host → uvicorn tự reload; frontend chỉ cần F5. Bỏ hai `-v` thì vẫn chạy
  bằng source đã COPY trong image.
- `main.py` lưu mp3 vào `cache` — đường dẫn **tương đối theo thư mục làm việc**. Container
  chạy uvicorn ở `/app/run` (ghi được) và nạp module qua `PYTHONPATH=/app/backend`,
  nên `backend/` không cần quyền ghi.
- Ctrl-C dừng cả hai; container cũng tự thoát nếu một trong hai tiến trình chết.

### Docker Compose (gọn hơn)

`compose.yaml` gói sẵn toàn bộ lệnh `docker run` ở trên:

```bash
docker compose up --build      # build + chạy, log hiện thẳng ra terminal
```

Mở <http://localhost:3000>. Ctrl-C để dừng.

Các lệnh hay dùng:

```bash
docker compose up -d --build   # chạy nền
docker compose logs -f         # xem log khi chạy nền
docker compose ps              # trạng thái container
docker compose down            # dừng và xoá container
docker compose up --build --force-recreate   # build lại từ đầu sau khi sửa Dockerfile
```

Sửa code trong `backend/` hoặc `frontend/` thì **không cần build lại** — hai thư mục
được mount read-only vào container, uvicorn tự reload còn frontend chỉ cần F5.
Chỉ build lại khi đổi `Dockerfile` hoặc `requirements.txt`.

Đổi cổng thì sửa vế trái trong `compose.yaml`, ví dụ `"5173:3000"` để UI chạy ở cổng 5173.

> Compose v2 là plugin của Docker CLI (`docker compose`, có dấu cách). Nếu máy báo
> `unknown command: docker compose` thì chưa cài plugin — tên gói tuỳ nguồn cài Docker:
>
> | Nguồn Docker | Lệnh cài |
> | --- | --- |
> | Gói `docker.io` của Ubuntu/Debian | `sudo apt install docker-compose-v2` |
> | Repo chính thức của Docker (`docker-ce`) | `sudo apt install docker-compose-plugin` |
> | macOS | Docker Desktop có sẵn, không cần cài |
>
> Kiểm tra nguồn đang dùng: `dpkg -l \| grep -E "docker.io\|docker-ce"`.
> Cài xong chạy `docker compose version` để xác nhận.

### Lỗi permission khi chạy Docker

**Linux — `permission denied ... /var/run/docker.sock`**

```
permission denied while trying to connect to the Docker daemon socket
at unix:///var/run/docker.sock

# bản Docker mới (>= 28) in ra câu hơi khác, cùng một nguyên nhân:
permission denied while trying to connect to the docker API
at unix:///var/run/docker.sock
```

Socket `/var/run/docker.sock` thuộc group `docker`, user của bạn chưa nằm trong group đó.
Kiểm tra bằng `id -nG | grep docker` (không in ra gì nghĩa là chưa có).

Cách xử lý — chọn 1 trong 3:

1. **Thêm user vào group `docker`** (tiện nhất cho máy dev):

   ```bash
   sudo usermod -aG docker $USER
   newgrp docker      # áp dụng cho terminal hiện tại
   ```

   Đăng xuất/đăng nhập lại (hoặc reboot) để có hiệu lực ở mọi terminal.
   ⚠️ Group `docker` tương đương quyền root — chỉ làm trên máy cá nhân.

2. **Chạy tạm bằng `sudo`** (không đổi cấu hình hệ thống):

   ```bash
   sudo docker build -t gtts-demo .
   sudo docker run --rm -p 3000:3000 -p 8000:8000 \
       -v "$PWD/backend:/app/backend:ro" \
       -v "$PWD/frontend:/app/frontend:ro" \
       gtts-demo
   ```

   Nếu sau đó lệnh `docker` thường báo lỗi quyền trên `~/.docker`, do `sudo` tạo file
   thuộc root: `sudo chown -R $USER:$USER ~/.docker`

3. **Dùng rootless Docker** (an toàn nhất, không cần root):

   ```bash
   dockerd-rootless-setuptool.sh install
   export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
   ```

**Linux — `Cannot connect to the Docker daemon. Is the docker daemon running?`**

Daemon chưa chạy, không phải lỗi quyền:

```bash
sudo systemctl start docker
sudo systemctl enable docker    # tự chạy khi khởi động máy
```

**macOS — `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`**

macOS không có group `docker`, nên hầu như không gặp lỗi quyền socket — thường chỉ là
Docker Desktop chưa chạy. Mở app Docker Desktop và đợi icon cá voi báo *running*, hoặc:

```bash
open -a Docker            # Docker Desktop
colima start              # nếu dùng Colima thay Docker Desktop
```

**macOS — `Mounts denied` / `path is not shared from the host`**

Docker Desktop chỉ mount được thư mục nằm trong danh sách file sharing:
**Settings → Resources → File sharing** → thêm thư mục chứa project (mặc định đã có
`/Users`, nên project nằm ngoài `/Users`, ví dụ `/opt` hay ổ ngoài, sẽ bị chặn) →
*Apply & restart*.

**Cả hai hệ — file mount vào container bị `Permission denied` lúc đọc**

Hai mount trong lệnh trên là read-only (`:ro`), container chỉ cần quyền **đọc**. Nếu
`backend/` hoặc `frontend/` trên host bị chmod quá chặt thì mở lại quyền đọc:

```bash
chmod -R a+rX backend frontend
```

Không cần cấp quyền ghi: container ghi mp3 tạm vào `/app/run/cache` bên trong image.

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
