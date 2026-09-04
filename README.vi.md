<div align="right">

[English](README.md) | **Tiếng Việt**

</div>

# English Learning Chat

Ứng dụng di động học tiếng Anh thông qua hội thoại AI tự nhiên, được xây dựng dưới dạng trải nghiệm chat kiểu ChatGPT với các tính năng dành riêng cho người học ngôn ngữ.

## Tải xuống (Download)

📦 **Tải file APK:** [eLearning-v1.0.0-arm64-v8a.apk](https://github.com/ManhTuongNguyen/eLearning/releases/download/v1.0.0/eLearning-release.apk)

> ⚠️ **Cảnh báo tương thích thiết bị:** file APK này chỉ dành cho thiết bị **arm64-v8a**. Nó sẽ không cài đặt được trên thiết bị/giả lập ARM 32-bit (`armeabi-v7a`), `x86` hoặc `x86_64`. Hầu hết điện thoại Android hiện đại (từ 2016 trở đi) đều dùng arm64-v8a — hãy kiểm tra kiến trúc CPU của thiết bị trước khi tải. Nếu thiết bị của bạn dùng kiến trúc khác, bạn cần [tự build ứng dụng](#chạy-mobile).

## Phát triển (Development)

Dự án này được hoàn thành từ đầu đến cuối bởi một **Autonomous Agent Loop** (Loop Engineering): [opencode](https://opencode.ai) chạy model `ox-alpha` (GLM 5.3 flash) đã thực thi toàn bộ backlog mà không cần prompt từng bước từ con người. Một shell loop gọi lại agent liên tục; chính agent quyết định việc tiếp theo cần làm bằng cách đọc các state file được track. Phần này tài liệu hóa toàn bộ flow để bạn có thể replicate trên bất kỳ dự án nào — và cách chạy, test và sử dụng những gì loop đã xây dựng.

### Điều hướng dự án

| File | Vai trò |
| --- | --- |
| [`ROADMAP.md`](ROADMAP.md) | Mục tiêu sản phẩm và kiến trúc — trạng thái đích |
| [`SPEC.md`](SPEC.md) | Backlog thực thi được — danh sách task có thứ tự kèm acceptance criteria |
| [`STATE.md`](STATE.md) | Trạng thái thực thi live của loop — agent đang ở đâu |
| [`prompts/PROMPT_LOOP_TASKS.md`](prompts/PROMPT_LOOP_TASKS.md) | Prompt duy nhất mà loop feed cho agent mỗi cycle |
| [`run-loop.sh`](run-loop.sh) | Driver `while (true)` giữ cho agent chạy liên tục |

### Cách hoạt động — agentic loop

Một workflow Loop Engineering không cần prompting gián đoạn hoạt động giống một REPL khép kín (Read-Eval-Print Loop):

1. **Read** — agent đọc `STATE.md` để biết mình đang ở đâu, đọc `SPEC.md` để chọn task tiếp theo, và tra `ROADMAP.md` khi cần định hướng.
2. **Execute** — nó thực hiện công việc: viết code, chạy test, sửa lỗi.
3. **Eval** — nó đánh giá kết quả thực thi: test pass hay fail?
4. **Update State** — nó ghi thông tin mới nhất trở lại `STATE.md` và đánh dấu task hoàn thành trong `SPEC.md`.
5. **Repeat** — loop ngoài `while (true)` tiếp tục gọi agent với cùng một lệnh gốc: *"Read STATE.md and perform the next step."*

```text
while true:                        # run-loop.sh
    Read     → STATE.md, SPEC.md, ROADMAP.md   # where am I? what is next?
    Execute  → code, tests, fixes
    Eval     → quality gates pass?
    Update   → STATE.md + SPEC.md + git commit
    Repeat   → until SPEC.md has no uncompleted task left
```

### Vì sao nó hoạt động — fault tolerance

Đặc điểm nổi bật nhất của mô hình này là **fault tolerance**. Nếu agent crash, API quota cạn, hoặc process bị ngắt đột ngột, bạn chỉ cần restart loop: agent đọc lại `STATE.md` và tiếp tục công việc đúng chỗ nó dừng — không mất context, không phải làm lại từ đầu. `run-loop.sh` tự động hóa điều này cho các lỗi tạm thời: agent exit với code khác 0 sẽ được log và retry sau 30 giây.

Các đặc điểm khác:

- **Zero intermittent prompting** — một prompt tĩnh điều phối hàng trăm task; con người đặt mục tiêu, không phải từng bước.
- **Context persistence** — `STATE.md` mang execution context xuyên suốt các cycle, sống sót qua crash và context-window reset.
- **Self-verifying progress** — mỗi task đều có acceptance criteria và quality gates; loop không thể đánh dấu hoàn thành khi test còn fail.
- **Auditability** — git commit theo từng task (`feat: complete TASK-XXX`), checkbox trong `SPEC.md` và timestamp trong `STATE.md` tạo thành một execution trail hoàn chỉnh.
- **Agent-agnostic** — protocol chỉ là các file cộng với một prompt; bất kỳ CLI coding agent nào cũng có thể thay thế opencode mà không phải đổi loop.
- **Incremental delivery** — repository có thể ship ở bất kỳ ranh giới phase nào, không chỉ ở cuối.

### Kết quả — những gì loop đã tạo ra

Loop đã thực thi `TASK-001` → `TASK-120` và tạo ra một ứng dụng hoàn chỉnh, chạy được: mọi tính năng trong README này — cả server lẫn serverless mode, JWT auth, SSE streaming, conversation memory, vocabulary pipeline với Celery enrichment, Anki export, TTS — đều được implement, test và audit mà không cần một prompt thủ công nào.

Audit MVP `TASK-120` khép lại đã xác minh toàn bộ 24 yêu cầu MVP trong `ROADMAP.md` và mọi quality gate. Kết quả chính xác được ghi trong `STATE.md` tại commit `bb70fdc` (`feat: complete TASK-120`) — checkout commit đó để xem toàn bộ audit log:

| Suite | Kết quả |
| --- | --- |
| Backend tests — `uv run pytest` | **1040 passed** (+293 subtests) |
| Backend lint/format — `ruff check`, `ruff format --check` | sạch (125 files) |
| Backend system checks — `python manage.py check` | không có vấn đề |
| Mobile tests — `pnpm test` | **614 passed** trên 50 Jest suites |
| Mobile lint — `pnpm lint` | sạch |
| Mobile typecheck — `pnpm typecheck` (strict) | sạch |
| `docker compose up --build` | stack khởi động healthy |
| Android build — `assembleDebug` | thành công |

### Flow từ zero đến hoàn thành

#### Bước 1 — Generate `ROADMAP.md` và `SPEC.md` với một AI khác

Dùng một AI session riêng (model reasoning mạnh) để soạn hai file planning, sau đó thêm link điều hướng đến chúng trong README của dự án (bảng ở trên đảm nhận vai trò này trong repository này):

- `ROADMAP.md` — mục tiêu dự án: product scope, kiến trúc, các mode, ràng buộc, và quy tắc rằng agent không được cần thêm quyết định của con người cho các lựa chọn kỹ thuật thông thường. Xem [`ROADMAP.md`](ROADMAP.md).
- `SPEC.md` — backlog thực thi được: chia roadmap thành danh sách task có thứ tự, mỗi task có marker ``Status: `[ ]` `` và acceptance criteria rõ ràng. Mở đầu bằng preamble "Instructions for the Autonomous Coding Agent" để backlog tự mô tả được. Xem [`SPEC.md`](SPEC.md).

> **Review cả hai file từng dòng trước khi chạy loop — đây là checkpoint của con người quan trọng nhất trong toàn bộ flow.** Agent không bao giờ hỏi bạn bất cứ điều gì: mọi thứ các file này nói về tech stack, ngôn ngữ, framework, package manager và version, thư viện và dependency, cấu trúc thư mục, coding convention và quality gates sẽ trở thành dự án cuối cùng, đúng nguyên văn như đã viết. Một quyết định sai ở đây (database sai, package không còn được maintain, cấu trúc đi ngược deployment target của bạn) sẽ được xây dựng trung thực qua hàng trăm task và rất tốn kém để hoàn tác về sau. Iterate với AI cho đến khi mọi lựa chọn kỹ thuật đều là thứ bạn thực sự muốn, rồi freeze các file.

#### Bước 2 — Khởi tạo `STATE.md`

Bộ nhớ của loop. Tạo nó trước lần chạy đầu với task đầu tiên đã được break down sẵn (agent viết lại nó mỗi cycle; bạn chỉ cần chỉnh nó để gỡ blocker):

```markdown
# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 0 — Foundation

## Current Active Task
- **Task ID**: TASK-001 — Initialize repository structure
- **Sub-steps**:
  - [ ] Create folder structure (backend, mobile, docker, docs)
  - [ ] Initialize .gitignore and .env.example
  - [ ] Create root README.md
- **Status**: IN_PROGRESS

## Unhandled Errors
- (Only record errors or context BLOCKING the current Task. Leave blank if none)
```

#### Bước 3 — Viết loop prompt và `run-loop.sh`

Prompt là chỉ dẫn duy nhất agent nhận mỗi cycle — [`prompts/PROMPT_LOOP_TASKS.md`](prompts/PROMPT_LOOP_TASKS.md):

```markdown
Execution Rules:
1. READ 'STATE.md' FIRST to recall previous execution context, active sub-steps, or unhandled errors.
2. READ 'ROADMAP.md' ONLY to understand high-level phase trajectory and context.
3. READ 'SPEC.md' to find the FIRST uncompleted task (marked Status: `[ ]`).
4. If 'STATE.md' has NO active sub-steps, BREAK DOWN the selected task from SPEC.md into small sub-steps inside 'STATE.md' under '## Current Active Task'.
5. Execute the current sub-step and run test/quality checks (Ruff, pytest, pnpm, etc.).
6. IMMEDIATELY UPDATE 'STATE.md': Mark the completed sub-step as [x] right after finishing it before moving to the next sub-step.
7. Fix any errors or test failures encountered.
8. ONLY WHEN ALL sub-steps and acceptance criteria pass:
   - Change Status: `[ ]` to Status: `[x]` in 'SPEC.md'.
   - UPDATE 'STATE.md': Advance 'Current Phase' in Metadata, and SET '## Current Active Task' strictly to this exact text:
     - **Task ID**:
     - **Sub-steps**:
     - [ ]
     - **Status**: Empty
   - Commit code changes to git with message 'feat: complete TASK-XXX'.
```

Driver script — viết `run-loop.sh` và cấp quyền thực thi (`chmod +x run-loop.sh`):

```bash
#!/bin/bash

trap "echo -e '\n🛑 Loop execution stopped by user.'; exit" INT TERM

echo "🚀 Starting Autonomous Loop Engineering with STATE tracking..."

while true; do
  REMAINING_TASKS=$(grep -c "Status: \`\[ \]\`" SPEC.md)

  if [ "$REMAINING_TASKS" -eq 0 ]; then
    echo "=================================================================="
    echo "🎉 ALL TASKS COMPLETED IN SPEC.md!"
    echo "🏁 Autonomous Loop is exiting successfully."
    echo "=================================================================="
    break
  fi

  echo "=================================================================="
  echo "🔄 Starting Loop Cycle at: $(date) | Remaining Tasks: $REMAINING_TASKS"
  echo "=================================================================="

  opencode run "$(cat prompts/PROMPT_LOOP_TASKS.md)" --dangerously-skip-permissions

  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️ Agent exited with code $EXIT_CODE (Network/Token limit). Retrying in 30 seconds..."
    sleep 30
  else
    echo "✅ Cycle step completed. Moving to next in 5 seconds..."
    sleep 5
  fi
done
```

`grep` target và prompt file là hai knob duy nhất — trỏ chúng vào bất kỳ backlog nào để tái sử dụng loop (repository này drive feedback backlog sau hoàn thành trong `POST_COMPLETION_FEEDBACK_V1.md` theo cùng một cách).

##### An toàn — `--dangerously-skip-permissions`

Dự án này chạy loop với flag `--dangerously-skip-permissions` của opencode. Không có nó, agent sẽ dừng lại và hỏi xác nhận trước mỗi shell command hay ghi file — điều này phá vỡ một loop chạy không người trông coi. Flag đánh đổi permission gates lấy autonomy, vì vậy hãy làm theo các best practices sau:

- **Chạy trong sandbox.** Thực thi loop trong container, VM hoặc devcontainer biệt lập với chỉ thư mục dự án được mount, để một lệnh sai không thể gây hại gì ngoài repository.
- **Dùng git branch riêng và commit thường xuyên.** Loop commit sau mỗi task, cho phép rollback theo từng task qua `git revert` / `git reset`; push lên remote để backup ngoài máy.
- **Giới hạn credentials.** Chỉ giữ các key mà loop cần trong `.env` — tốt nhất là một LLM API key riêng có giới hạn chi tiêu. Không bao giờ commit secrets, và coi `.env` là agent có thể đọc.
- **Giới hạn blast radius.** Chạy test với database tạm thời (như pytest setup của repo này), tránh cấp Docker socket trừ khi thực sự cần, và pin version của dependency.
- **Giám sát, không babysit.** Kiểm tra `git log`, `STATE.md` và bộ đếm task còn lại định kỳ. `Ctrl+C` dừng loop sạch sẽ bất cứ lúc nào; restart và nó tiếp tục từ `STATE.md`.

#### Bước 4 — Cấu hình model

Dự án này cấu hình model qua `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.schema.json",
  "model": "9router/ox-alpha"
}
```

`ox-alpha` (GLM 5.3 flash) là model đã hoàn thành repository này. Điều chỉnh cấu hình theo agent của bạn:

- **opencode** — đặt `model` thành id `provider/model` của bạn và authenticate provider (xem [tài liệu cấu hình opencode](https://opencode.ai/docs/config/)).
- **Agent khác** (Claude Code, Codex CLI, Aider, …) — dùng cơ chế config riêng của tool đó và thay dòng `opencode run …` trong `run-loop.sh` bằng lệnh headless/non-interactive tương đương. Cơ chế loop (`STATE.md` / `SPEC.md` / prompt) là agent-agnostic.

Chọn model tuân thủ đáng tin cậy các execution rules và chạy được test. Loop gọi nó hàng trăm lần, nên tốc độ và chi phí rất quan trọng — một model nhanh như GLM 5.3 flash là lựa chọn phù hợp.

#### Bước 5 — Chạy loop đến khi dự án hoàn thành

```bash
./run-loop.sh
```

Mỗi cycle agent đọc `STATE.md`, chọn task chưa hoàn thành tiếp theo trong `SPEC.md`, implement nó, chạy quality gates, cập nhật `STATE.md`, đánh dấu task `[x]` trong `SPEC.md` và commit. Shell loop tiếp tục gọi lại agent cho đến khi `grep` không còn tìm thấy marker ``Status: `[ ]` `` nào trong `SPEC.md`, rồi exit — dự án hoàn thành. Theo dõi tiến độ qua `git log`, `STATE.md` và bộ đếm task còn lại được in mỗi cycle.

#### Yêu cầu của loop — prompt phải khớp `SPEC.md`

Để loop chạy được không người trông coi, prompt trong `prompts/PROMPT_LOOP_TASKS.md` phải khớp với `SPEC.md` một cách chính xác:

- **Status marker phải khớp.** Rule 3 của prompt và bộ đếm task của script đều phụ thuộc vào convention ``Status: `[ ]` `` — nếu đổi marker hoặc tên file, hãy cập nhật prompt và script cùng lúc.
- **Task ID và phase phải ổn định.** Prompt advance "Current Phase" và commit `feat: complete TASK-XXX`, nên `SPEC.md` phải dùng id `TASK-XXX` nhất quán được nhóm theo phase.
- **Task phải đủ nhỏ cho một cycle.** Một task mỗi lần gọi agent, với acceptance criteria có thể verify bằng automated test và quality gates.
- **Quality gates phải non-interactive.** `pytest`, `ruff`, `pnpm test`, … phải chạy không cần prompt, TTY hay interactive login.
- **`ROADMAP.md` là context, không phải backlog.** Agent chỉ đọc nó để định hướng; mọi requirement có thể hành động phải nằm trong một task của `SPEC.md`.
- **Git repo đã init và `.env` bị ignore.** Loop commit sau mỗi task, nên hãy bắt đầu từ repository sạch với secrets bị loại bởi `.gitignore`.

### Chạy backend

Option A — tất cả trong Docker (khuyến nghị cho lần chạy đầu):

```bash
docker compose up --build
```

Điều này khởi động `postgres` (PostgreSQL 17), `redis` (Redis 8), `backend` (Django — áp migrations và serve tại `http://localhost:8000`) và `worker` (Celery), với health checks kiểm soát thứ tự khởi động. Hostname nội mạng (`postgres`, `redis`) được inject tự động; `.env` của bạn vẫn cung cấp credentials.

Option B — Python thuần với data services trong Docker:

```bash
docker compose up -d postgres redis
cd backend
uv sync                           # tạo .venv, cài locked dependencies
uv run python manage.py migrate
uv run python manage.py runserver # http://localhost:8000
```

Ở terminal thứ hai, chạy Celery worker (vocabulary enrichment, conversation summarization):

```bash
cd backend
uv run celery -A config worker --loglevel=info
```

Debug local hoàn toàn không cần Docker: đặt `DB_ENGINE=sqlite3` trong `.env` (hoặc truyền theo từng lệnh). Health endpoint `GET /api/v1/health/` báo trạng thái infrastructure.

### Chạy mobile

```bash
cd mobile
pnpm install
pnpm start          # Metro dev server (giữ đang chạy)
pnpm android        # build debug APK, cài và launch trên device/emulator đã kết nối
```

Cần JDK 17+ (`JAVA_HOME`) và Android SDK (`ANDROID_HOME`); với emulator, khả năng kết nối Metro được `run-android` xử lý tự động (`adb reverse tcp:8081 tcp:8081`). App nhắm tới New Architecture (`newArchEnabled=true`) và Hermes. Debug build load JS từ Metro; production bundle được tạo bằng `cd android && ./gradlew assembleRelease`. Xem [`mobile/README.md`](mobile/README.md) để biết chi tiết về local SQLite storage, application modes và secure key storage.

### Chạy test

Backend — pytest + pytest-django với database biệt lập (`test_elearning`, xem `POSTGRES_TEST_DB`); nó được tạo và xóa theo từng lần chạy và không bao giờ đụng vào development database. Khởi động Postgres trước (`docker compose up -d postgres redis`):

```bash
cd backend
uv run pytest
```

Khi không có Docker services, fallback sang SQLite (một vài test DB-fidelity bị loại):

```bash
DB_ENGINE=sqlite3 uv run pytest
```

Chạy tất cả backend quality gates cùng lúc, kiểu CI, từ thư mục gốc repository:

```bash
make quality
```

Từng gate riêng lẻ:

```bash
cd backend
uv run ruff check .             # lint
uv run ruff format --check .    # check formatting (apply: uv run ruff format .)
uv run pytest                   # test (pytest + pytest-django)
uv run python manage.py check   # Django system checks
```

Mobile — Jest với React Native Testing Library (không cần device):

```bash
cd mobile
pnpm test           # jest
pnpm typecheck      # tsc --noEmit (strict mode)
pnpm lint           # eslint
```

### User model

Authentication dùng custom user model (`AUTH_USER_MODEL = "accounts.User"`,
`accounts.User` kế thừa `AbstractUser` của Django). Cả `username` lẫn `email`
đều unique; password dùng hashing chuẩn của Django. Setting này được đưa vào
trước khi bất kỳ migration phụ thuộc nào tồn tại, nên không cần data migration.

### Authentication API

Authentication dựa trên JWT qua `djangorestframework-simplejwt`. DRF defaults
là deny-unauthenticated: mọi endpoint đều yêu cầu bearer token trừ khi
explicitly opt-out (`register`, `login`, `refresh`, `health`).

```text
POST /api/v1/auth/register/   {username, email, password} → 201
POST /api/v1/auth/login/      {username | email, password} → {access, refresh, user}
POST /api/v1/auth/logout/     Bearer + {refresh} → blacklists refresh token đó
POST /api/v1/auth/refresh/    {refresh} → {access}
GET  /api/v1/auth/me/         Bearer token → current user
```

Login chấp nhận hoặc username hoặc địa chỉ email. Token lifetime đến từ
`JWT_ACCESS_TOKEN_MINUTES` và `JWT_REFRESH_TOKEN_DAYS` trong `.env`.

Logout yêu cầu request đã authenticate và vĩnh viễn blacklist refresh token
được cung cấp (simplejwt `token_blacklist`); refresh với token đó sau đó sẽ
fail với 401. Các session khác không bị ảnh hưởng. Access token còn hạn vẫn
valid cho đến khi hết hạn ngắn của chính nó — không có access-token denylist.

### LLM streaming API

```text
POST /api/v1/llm/stream/      Bearer + {messages: [{role, content}], temperature?} → text/event-stream
```

Stream completion dưới dạng Server-Sent Events. Các frame map onto các
application event đã chuẩn hóa; mỗi stream kết thúc bằng đúng một terminal frame:

```text
event: start       data: {"model": "..."}
event: delta       data: {"text": "..."}
event: completed   data: {"text": "...", "model": "...", "delta_count": N}
event: error       data: {"error": "...", "retryable": true|false}
```

Model chain phía server (primary model cộng các fallback đã cấu hình) luôn
quyết định model nào serve request — client không thể pin model. Response
mang `Cache-Control: no-cache` và `X-Accel-Buffering: no` để intermediaries
không buffer stream.

### Cấu hình LLM model

Model ở server-mode được cấu hình hoàn toàn qua environment; không có tên
model nào bị hard-code trong application code.

```text
LLM_PROVIDER                 provider integration: openrouter | gemini | openai | ninerouter | openai-compatible (mặc định openrouter)
<PROVIDER>_API_KEY           key phía server của provider đã chọn (bắt buộc trong production, không bao giờ gửi cho client)
<PROVIDER>_BASE_URL          API root của provider (tùy chọn; mọi provider đều có default trừ openai-compatible)
LLM_PRIMARY_MODEL            model được thử đầu tiên (một id từ catalog của provider đã cấu hình)
LLM_FALLBACK_MODELS          các fallback phân tách bằng dấu phẩy, được thử theo thứ tự
LLM_REQUEST_TIMEOUT_SECONDS  HTTP timeout cho mỗi request (> 0)
```

Đổi provider là một thay đổi cấu hình (`LLM_PROVIDER`), không bao giờ là thay
đổi code (`backend/llm/registry.py`). Chain có thứ tự (`LLM_PRIMARY_MODEL`
theo sau bởi `LLM_FALLBACK_MODELS`) được assemble bởi `backend/llm/config.py`
(`load_model_configuration()`), cái strip tên và loại bỏ entry trống/trùng
lặp. Chỉ các failure retryable (timeout, transport error, provider
availability) mới chuyển sang model tiếp theo; cấu hình invalid sẽ raise
`ImproperlyConfigured` nêu tên biến gây lỗi lúc startup. Model id tuân theo
catalog của provider đã cấu hình (với OpenRouter: `vendor/model`, được liệt
kê tại https://openrouter.ai/api/v1/models).

### Tự động kiểm tra ngữ pháp

Một trợ giúp học tập opt-in (mặc định tắt) được xây trên improvement
pipeline. Khi được bật trong Settings → Grammar, mỗi tin nhắn user gửi đi sẽ
được kiểm tra bằng cùng một LLM call tạo ra bản sửa "Improve my English", ở
cả hai mode:

- **Server mode** — app gọi `POST /api/v1/sessions/{id}/messages/{mid}/improve/` cho message row đã được persist.
- **Serverless mode** — việc kiểm tra giống hệt chạy trên thiết bị qua key provider của chính user (không liên quan đến backend).

Response mang theo phân loại `severity`: `none` (đã đúng), `minor` (lỗi nhỏ)
hoặc `critical` (lỗi làm sai lệch ý nghĩa). Tin nhắn đúng không hiển thị gì;
`minor` hiển thị badge cảnh báo nhỏ và `critical` hiển thị badge lỗi dưới
tin nhắn của user. Nhấn vào badge mở improvement sheet với kết quả đã fetch
sẵn — bản gốc, bản gợi ý sửa và giải thích — nên việc xem gợi ý không tốn
thêm API call nào. Toggle có cảnh báo rằng bật tính năng này tốn thêm một AI
request (và token) cho mỗi tin nhắn gửi đi, và lịch sử hội thoại đã load
không bao giờ được kiểm tra hồi tố: chỉ những tin nhắn gửi đi khi tính năng
đang bật mới được kiểm tra.

Kết quả cải thiện được **lưu trữ vĩnh viễn ở cả hai phía**: backend lưu mỗi
kết quả vào message row (endpoint improve là idempotent — gọi lại cho cùng
một tin nhắn trả về gợi ý đã lưu mà không gọi LLM, và message list nhúng
kết quả này), còn serverless mode lưu vào SQLite local (schema v2). Badge và
gợi ý do đó vẫn còn sau khi reload hoặc khởi động lại app với chi phí
provider bằng 0. Reply trò chuyện của tutor không bao giờ chứa chú thích
meta về việc mô hình hóa hay sửa ngữ pháp — system prompt giới hạn mỗi reply
chỉ trong nội dung tin nhắn hội thoại.

## Tính năng

- Chủ đề hội thoại và hội thoại mẫu do AI tạo
- Luyện hội thoại tự nhiên với streaming AI response
- Profile học tiếng Anh (CEFR levels A1–C2 + AUTO)
- Lịch sử hội thoại với long-term memory qua rolling summaries
- Gợi ý reply và sửa lỗi "Improve my English" theo yêu cầu
- Tự động kiểm tra ngữ pháp (opt-in): tin nhắn gửi đi được phân loại (đúng / lỗi nhỏ / lỗi nghiêm trọng) và gắn badge — nhấn badge xem bản sửa đã fetch sẵn, không tốn thêm API call
- Lưu vocabulary qua text selection với enrichment bất đồng bộ
- Export CSV tương thích Anki
- Text-to-speech (Android native)
- Hai mode biệt lập: **Server mode** (đã authenticate) và **Serverless mode** chạy local
- Hỗ trợ đa LLM provider (OpenRouter, Google Gemini, OpenAI, 9Router, OpenAI-compatible) với model fallback có thứ tự

## Kiến trúc

```text
Server mode:
React Native → HTTPS → Django REST API → PostgreSQL / Redis / Celery → LLM provider (được chọn bởi `LLM_PROVIDER`)

Serverless mode:
React Native → Local SQLite + LLM provider trực tiếp (provider và key do user chọn)
```

| Thư mục | Mục đích |
| --- | --- |
| `backend/` | Django 6.x REST API, Celery workers, abstraction LLM provider |
| `mobile/` | Ứng dụng React Native (TypeScript) |
| `docker/` | Định nghĩa Docker image backend (được root `docker-compose.yml` tham chiếu) |
| `docs/` | Ghi chú kiến trúc và tài liệu |

Bản walkthrough chi tiết của hệ thống — các mode, abstraction LLM provider,
streaming, conversation memory, Celery và flow vocabulary enrichment —
nằm trong [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Tài liệu tham chiếu
REST API server-mode — endpoints, hành vi request/response, SSE frames và
error format chuẩn — nằm trong [`docs/API.md`](docs/API.md).

## Technology Stack

**Backend:** Python · Django 6.x · Django REST Framework · PostgreSQL · Redis · Celery · SSE streaming · pytest · uv · Ruff · python-decouple · Docker Compose

**Frontend:** React Native (New Architecture) · TypeScript · pnpm · React Navigation · NativeWind · Reanimated · Jest · React Native Testing Library

## Yêu cầu môi trường (Prerequisites)

| Tool | Version | Dùng cho | Ghi chú |
| --- | --- | --- | --- |
| [uv](https://docs.astral.sh/uv/) | latest | Quản lý Python/venv + dependency cho backend | Cài: `curl -LsSf https://astral.sh/uv/install.sh \| sh` (Windows: `powershell -c "irm https://astral.sh/uv/install.ps1 \| iex"`). uv tự provision cả Python interpreter. |
| Node.js | >= 20 | Runtime build mobile | |
| [pnpm](https://pnpm.io/) | latest | Package manager mobile | Bật qua `corepack enable pnpm` (có sẵn với Node 20+). Mobile app cần `node-linker=hoisted`, đã được cấu hình sẵn trong `mobile/.npmrc`. |
| Docker + Compose | 24+ | Các services PostgreSQL, Redis, backend và Celery worker | Bất kỳ bản cài nào hỗ trợ Compose v2 (`docker compose version`). |
| JDK | 17+ | Android Gradle builds | Đặt `JAVA_HOME`. |
| Android SDK | recent API level | Build/cài lên device hoặc emulator | Đặt `ANDROID_HOME` (vd. `~/Android/Sdk`); dễ nhất qua [Android Studio](https://developer.android.com/studio). |

Backend cũng cần một PostgreSQL server và Redis instance để đạt độ trung thực
đầy đủ — cả hai đều được Docker Compose cung cấp (xem [Chạy backend](#chạy-backend)).

## Cấu hình environment

Copy file environment mẫu ở thư mục gốc repository và điền giá trị thật — không bao giờ commit `.env`:

```bash
cp .env.example .env
```

`.env.example` tài liệu hóa mọi biến. Những biến quan trọng nhất:

| Biến | Mục đích |
| --- | --- |
| `DJANGO_SECRET_KEY` | Django signing key; generate bằng `python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"` |
| `DJANGO_DEBUG` / `DJANGO_ALLOWED_HOSTS` | Server mode; các biến bắt buộc ở production được enforce lúc startup khi `DJANGO_DEBUG=False` |
| `POSTGRES_*` | Database credentials dùng bởi Django, Docker Compose và pytest |
| `DB_ENGINE` | `postgresql` (mặc định) hoặc `sqlite3` để quick start không cần Docker |
| `REDIS_URL` / `CELERY_*` | Kết nối Redis và Celery broker/result backends |
| `LLM_PROVIDER` | Provider integration phía server: `openrouter` (mặc định), `gemini`, `openai`, `ninerouter`, `openai-compatible` |
| `<PROVIDER>_API_KEY` / `<PROVIDER>_BASE_URL` | Credentials của provider đã chọn (vd. `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) — không bao giờ gửi cho mobile app |
| `LLM_PRIMARY_MODEL` / `LLM_FALLBACK_MODELS` | Model chain server-mode (xem [Cấu hình LLM model](#cấu-hình-llm-model)) |
| `JWT_*` | Access/refresh token lifetimes |

Mobile app có file environment riêng — copy `mobile/.env.example` thành `mobile/.env` và đặt `API_BASE_URL` (backend base URL; `http://10.0.2.2:8000` trên Android emulator). Các file theo mode (`.env.development` / `.env.test` / `.env.production`) override nó theo build type, giá trị được inline lúc build, và thiếu `API_BASE_URL` sẽ làm fail bundle. Cấu hình provider serverless (provider, API key, primary/fallback models) được cấu hình trong app (Settings → provider settings; key được lưu trong secure device storage).
