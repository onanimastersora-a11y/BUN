# BUN

Lịch trình tuần, checklist (3 dạng: bảng, lộ trình, mindmap) và một bé chó/mèo pixel nhắc việc, giữ note mỗi ngày.

| Nền tảng | Dạng | Thú cưng | Nhắc việc |
|---|---|---|---|
| **Windows** | App cài đặt `BUN-Setup.exe` | Nổi trên desktop 24/24, tự hiện khi bật máy | Hoạt ảnh + nhạc chuông, kể cả khi đóng cửa sổ |
| **macOS** | App `BUN-mac.dmg` (tải từ web, không qua App Store) | Như Windows, hiện trên mọi màn hình (Space) | Như Windows |
| **iPhone** | Web app: mở `/app/` bằng Safari → Thêm vào MH chính | Ở góc màn hình app | Thông báo đẩy kể cả khi đóng app; khi đang mở app: hoạt ảnh + nhạc chuông; có thể thêm lịch tuần vào **báo thức Đồng hồ** qua Phím tắt ([web/SHORTCUT.md](web/SHORTCUT.md)) |

Tài khoản dùng chung trên mọi thiết bị và mọi thứ vẫn chạy khi **mất mạng**. Chỉ cần mạng để đăng nhập lần đầu trên thiết bị mới, đồng bộ, chat, thời tiết, chỉ số thị trường, nhạc chuông SoundCloud và thông báo trên iPhone.

## Đưa BUN lên mạng — 3 bước

### 1. Đưa code lên GitHub (để build và lưu file cài đặt miễn phí)

1. Tạo một repository mới trên GitHub, ví dụ `bun`.
2. Trong thư mục dự án:
   ```bash
   git init
   git add .
   git commit -m "BUN 1.0.0"
   git branch -M main
   git remote add origin https://github.com/TEN-GITHUB/bun.git
   git push -u origin main
   ```
3. Tạo bản phát hành:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   GitHub Actions (`.github/workflows/release.yml`) sẽ tự build `BUN-Setup.exe` (Windows) và `BUN-mac.dmg` (macOS) rồi đưa vào mục **Releases**. Mất khoảng 10 phút; xem tiến trình ở tab **Actions**.

Muốn build bản Mac ngay trên MacBook thay vì GitHub: chép thư mục dự án sang Mac, chạy `npm install` rồi `npm run dist:mac`, file nằm trong `release/`.

### 2. Trỏ trang web tới file cài đặt

Mở `web/site/index.html`, đổi `GITHUB_REPO = 'TEN-GITHUB/bun'` thành tên repository của bạn. Nút tải sẽ trỏ thẳng tới file, người dùng không phải thấy giao diện GitHub.

### 3. Đưa web + app iPhone + máy chủ thông báo lên Cloudflare (miễn phí)

Làm theo [web/DEPLOY.md](web/DEPLOY.md). Kết quả là một địa chỉ `https://bun-web.<tên>.workers.dev`:
- `/` — trang giới thiệu và nút tải
- `/app/` — app cho iPhone

## Hướng dẫn cài cho người dùng

- **Windows:** chạy `BUN-Setup.exe`. Nếu SmartScreen cảnh báo: *Thông tin thêm → Vẫn chạy*.
- **macOS:** mở `BUN-mac.dmg`, kéo BUN vào Applications. Lần đầu mở, macOS chặn vì app chưa có chữ ký Apple: vào *Cài đặt hệ thống → Quyền riêng tư & Bảo mật*, kéo xuống và bấm *Vẫn mở*. Nếu macOS báo "bị hỏng", mở Terminal và chạy `xattr -cr /Applications/BUN.app`.
- **iPhone (iOS 16.4+):** mở trang web bằng **Safari** → *Mở BUN trên iPhone* → *Chia sẻ* → *Thêm vào MH chính*. Mở BUN từ màn hình chính → Cài đặt → bật *Thông báo trên điện thoại*.

## Dành cho lập trình viên

Yêu cầu: Node.js 20+.

```bash
npm install
npm run dev        # Vite + Electron, tự reload khi sửa code
npm run web        # chỉ giao diện trong trình duyệt (http://localhost:5173)
npm run dist:win   # bản cài Windows -> release/BUN-Setup.exe
npm run dist:mac   # bản macOS -> release/BUN-mac.dmg (chạy trên Mac)
npm run build:web  # app iPhone -> web/public/app + trang giới thiệu -> web/public/index.html
npm run icons      # vẽ lại logo/icon (tools/make-icons.mjs)
npm run sounds     # tạo lại nhạc chuông có sẵn (tools/make-sounds.mjs)
npm run sprites -- cat   # xuất ảnh xem trước sprite
```

`BUN_USER_DATA=<thư mục>` dùng một bộ dữ liệu riêng khi chạy thử (ví dụ thử nhiều tài khoản).

### Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `electron/main.js` | Tiến trình chính (Windows + macOS): cửa sổ app, cửa sổ thú cưng trong suốt, khay hệ thống / menu bar, mở cùng máy, link `bun://`, vòng nhắc việc, lấy dữ liệu thị trường, file nhạc chuông |
| `src/core/backend.js` | Toàn bộ dữ liệu: tài khoản, bạn bè, chat, bảng, công việc (deadline, lặp tuần), quyền owner, note, cài đặt |
| `src/core/cloud.js`, `src/core/config.js` | Đồng bộ với máy chủ (địa chỉ máy chủ nằm trong `config.js`) |
| `src/renderer/` | Giao diện React dùng chung cho desktop và iPhone (tự chuyển sang bố cục dọc trên điện thoại) |
| `src/renderer/pet/` | Thú cưng: ngủ → vươn vai → đi nhún nhảy → chơi đồ chơi → ngồi, note, hoạt ảnh thông báo |
| `src/renderer/markets.js` | Thời tiết (Open-Meteo), chỉ số/cổ phiếu/tiền ảo/ngoại tệ (Yahoo Finance), vàng SJC (PNJ) |
| `src/renderer/ringtone.js` | Nhạc chuông: có sẵn, file của bạn, link SoundCloud |
| `src/renderer/push.js`, `tools/sw-template.js` | Thông báo đẩy và chạy offline cho bản iPhone |
| `src/core/reminders.js`, `web/worker/reminders.js` | Danh sách nhắc việc của mỗi điện thoại, do máy chủ giữ và tự cập nhật khi lịch đổi trên bất kỳ thiết bị nào |
| `src/renderer/alarm.js`, `web/SHORTCUT.md` | Đưa lịch tuần vào báo thức iPhone qua Phím tắt |
| `electron/updater.js`, `electron/mac-update.js` | App Windows + macOS tự cập nhật từ GitHub Releases |
| `src/sprites/` | Pixel art chó/mèo (lưới ký tự 48×40) |
| `web/` | Cloudflare Worker: trang giới thiệu, app iPhone, tài khoản + đồng bộ, trung gian Yahoo, gửi thông báo đẩy |
| `.github/workflows/release.yml` | Build tự động file cài Windows + macOS |

### Tự cập nhật

Từ bản 1.2, người dùng không phải tải bản mới nữa:

- **Windows:** app tự kiểm tra GitHub Releases, tự tải phần thay đổi (`electron-updater`).
- **macOS:** app chưa có chữ ký Apple nên không dùng được bộ cập nhật chuẩn. `electron/mac-update.js` tự tải `BUN-mac.zip`, kiểm tra mã băm rồi thay `BUN.app` sau khi app thoát.
- **iPhone:** chỉ cần deploy web; app nhận bản mới khi được mở lại.

App kiểm tra bản mới mỗi giờ. Bản mới được cài khi người dùng bấm **Cập nhật ngay**, khi thoát app, khi máy không được dùng trong 10 phút, hoặc ngay lập tức nếu BUN vừa tự mở cùng máy (trong 15 phút đầu) và chưa ai mở cửa sổ BUN. Cách phát hành bản mới: xem [web/DEPLOY.md](web/DEPLOY.md).

### Về nhạc chuông

Chọn được 3 nguồn: chuông có sẵn, **file nhạc của bạn** (MP3/M4A…, chạy cả offline) và **link SoundCloud**. Không dùng Spotify vì Spotify chỉ cho nghe thử 30 giây nếu không có Premium + SDK riêng; không dùng YouTube vì điều khoản YouTube yêu cầu trình phát phải hiển thị. Trên iPhone, nhạc chuông riêng chỉ phát khi app đang mở; khi app đóng, iPhone dùng âm thanh thông báo của máy (Apple không cho web app đổi âm thanh này).

### Tài khoản & đồng bộ

Từ bản 1.1, tài khoản nằm trên máy chủ (`web/worker/cloud.js`, một Durable Object của Cloudflare chạy cùng lớp `Backend` với app), nên một tài khoản dùng được trên Windows, Mac và iPhone.

- Mỗi thiết bị giữ một bản sao dữ liệu (`src/core/cloud.js`), nên app vẫn chạy khi mất mạng.
- Thay đổi được ghi ngay trên máy, xếp hàng, rồi gửi lên máy chủ khi có mạng. Máy chủ trả về dữ liệu mới nhất, gồm cả thay đổi từ thiết bị khác và tin nhắn của bạn bè (khoảng 20 giây/lần).
- Đăng nhập lần đầu trên một thiết bị mới cần có mạng. Tạo tài khoản khi mất mạng vẫn được: tài khoản tự đưa lên máy chủ khi có mạng trở lại.
- Tài khoản cũ chỉ có trên một máy: lần đầu mở bản 1.1, app hỏi lại code một lần để đưa tài khoản và dữ liệu lên máy chủ. Cùng tên và cùng code trên nhiều máy sẽ được gộp thành một tài khoản.
