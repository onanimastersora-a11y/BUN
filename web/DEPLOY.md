# Đưa BUN web lên mạng (Cloudflare, miễn phí)

Thư mục `web/` là một Cloudflare Worker. Nó làm 4 việc:

- Phát trang giới thiệu (`/`) và app iPhone (`/app/`).
- Lưu tài khoản và đồng bộ dữ liệu giữa các thiết bị (Durable Object `BunCloud`, có trong gói miễn phí).
- Lấy giá chứng khoán từ Yahoo Finance cho app.
- Gửi thông báo nhắc việc tới iPhone mỗi phút.

> **Đã deploy bản 1.0 rồi?** Làm phần [Cập nhật lên bản 1.1](#cập-nhật-lên-bản-11) ở cuối trang. **Đã có bản 1.1.0?** Chỉ cần làm phần [Cập nhật lên bản 1.1.1](#cập-nhật-lên-bản-111).

**Cần có:** Node.js 20 trở lên và một tài khoản Cloudflare miễn phí (đăng ký tại https://dash.cloudflare.com/sign-up).

Mở **PowerShell** (hoặc Terminal trong VS Code) tại thư mục dự án `APP BUN`, rồi làm lần lượt các bước dưới đây.

## 1. Cài đặt

```powershell
cd web
npm install
```

## 2. Đăng nhập Cloudflare

```powershell
npx wrangler login
```

Trình duyệt sẽ mở ra. Bấm **Allow**, rồi quay lại cửa sổ lệnh.

## 3. Tạo cơ sở dữ liệu

```powershell
npx wrangler d1 create bun
```

Lệnh sẽ in ra một dòng `database_id = "xxxxxxxx-xxxx-..."`.

- Nếu được hỏi có muốn Wrangler tự thêm vào cấu hình không, chọn **No** (`n`).
- Mở file `web/wrangler.toml`, tìm dòng `database_id = "00000000-0000-0000-0000-000000000000"`, thay dãy số 0 bằng id vừa nhận được, rồi lưu file.

## 4. Tạo bảng dữ liệu

```powershell
npm run db:init
```

Nếu được hỏi `Ok to proceed?`, gõ `y` rồi Enter.

## 5. Tạo khóa thông báo (VAPID)

```powershell
npm run vapid
```

Lệnh in ra 2 dòng: `VAPID_PUBLIC_KEY=...` và `VAPID_PRIVATE_KEY=...`.

1. **Khóa công khai:** mở `web/wrangler.toml` và dán vào dòng `VAPID_PUBLIC_KEY = "B...."` (giữ nguyên dấu ngoặc kép).
2. **Khóa bí mật:** chạy lệnh dưới đây, dán `VAPID_PRIVATE_KEY` khi được hỏi, rồi Enter:

   ```powershell
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```

   Nếu được hỏi có tạo Worker `bun-web` mới không, chọn **Yes**.
3. (Nên làm) Đổi `VAPID_SUBJECT` trong `wrangler.toml` thành email của bạn, ví dụ `VAPID_SUBJECT = "mailto:ban@gmail.com"`.

Khóa bí mật chỉ nằm trên Cloudflare: đừng dán vào file nào và đừng gửi cho ai. Chỉ tạo khóa **một lần**. Nếu sau này đổi khóa, mọi người phải bật lại thông báo trong app.

## 6. Build app iPhone

Quay về thư mục dự án rồi build:

```powershell
cd ..
npm run build:web
cd web
```

Sau bước này phải có 2 file `web/public/index.html` và `web/public/app/index.html`.

## 7. Đưa lên mạng

```powershell
npm run deploy
```

Lần đầu, Cloudflare có thể hỏi tên miền phụ `workers.dev`. Chọn một tên, ví dụ `bunapp`.

## 8. Dùng thử

Địa chỉ web sẽ là `https://bun-web.<tên-miền-phụ>.workers.dev`:

- `/`: trang giới thiệu.
- `/app/`: app iPhone. Mở bằng **Safari**, bấm **Chia sẻ** rồi **Thêm vào MH chính**. Mở app từ màn hình chính rồi bật thông báo (cần iOS 16.4 trở lên).
- Kiểm tra nhanh trên trình duyệt:
  - `/api/push/key` phải hiện `{"publicKey":"B..."}`.
  - `/api/yahoo/search?q=hpg` phải hiện dữ liệu cổ phiếu.

**Cập nhật sau này:** làm lại bước 6 và 7. Muốn xem nhật ký lỗi: Cloudflare Dashboard, vào **Workers & Pages**, chọn **bun-web**, mở **Logs**.

**Gắn tên miền riêng** (khi bạn đã có tên miền quản lý bằng Cloudflare):

1. Vào Dashboard, chọn **Workers & Pages**, rồi **bun-web**.
2. Mở **Settings**, vào **Domains & Routes**, bấm **Add**, chọn **Custom domain**.
3. Nhập tên miền, ví dụ `bun.tenmiencuaban.com`.

Lưu ý: app đã "Thêm vào MH chính" từ địa chỉ cũ sẽ không tự chuyển sang địa chỉ mới. Phải thêm lại từ địa chỉ mới và bật lại thông báo.

## Giới hạn của gói miễn phí

- **File tĩnh** (trang web, app): miễn phí, không giới hạn lượt xem. Tối đa 20.000 file, mỗi file tối đa 25 MiB.
- **Worker** (các đường dẫn `/api/...`): 100.000 lượt/ngày. Vượt mức thì `/api/...` trả lỗi 429 tới hết ngày (giờ UTC), còn trang web vẫn chạy.
- **Thông báo:** mỗi lần chạy chỉ được 10 ms CPU, nên mỗi phút gửi tối đa 15 thông báo. Phần còn lại gửi vào phút sau. Thông báo trễ quá 30 phút sẽ bị bỏ qua.
- **D1:** 5 GB dung lượng, 5 triệu dòng đọc/ngày, 100.000 dòng ghi/ngày (BUN dùng rất ít).
- **Cron:** tối đa 5 lịch chạy cho mỗi tài khoản (BUN dùng 1, chạy mỗi phút).
- **Bộ nhớ đệm Yahoo** (60 giây cho biểu đồ, 1 ngày cho tìm kiếm) chỉ có tác dụng khi dùng tên miền riêng. Trên `workers.dev`, mỗi lần gọi đều hỏi thẳng Yahoo: vẫn chạy được nhưng dễ bị Yahoo giới hạn hơn.

## Gặp lỗi?

| Hiện tượng | Cách sửa |
|---|---|
| `VAPID_PUBLIC_KEY is not configured` | Làm lại bước 5, rồi `npm run deploy`. |
| Gửi thử thông báo báo `status: 403` hoặc `401` | Khóa bí mật không khớp khóa công khai. Chạy lại `npx wrangler secret put VAPID_PRIVATE_KEY` với đúng khóa. |
| Deploy báo lỗi `database_id` | Kiểm tra lại bước 3. |
| `npm run deploy` báo thiếu thư mục `public` | Làm bước 6 trước. |

## Cập nhật lên bản 1.1

Bản 1.1 thêm tài khoản dùng chung trên mọi thiết bị. Làm lần lượt, trong thư mục dự án `APP BUN`:

1. Build lại app iPhone và trang web:

   ```powershell
   npm run build:web
   ```

2. Đưa lên Cloudflare. Lần đầu, Cloudflare tự tạo nơi lưu tài khoản (Durable Object `BunCloud`):

   ```powershell
   cd web
   npm run deploy
   cd ..
   ```

3. Kiểm tra khóa thông báo: mở `https://bun-web.sorandbun.workers.dev/api/push/health`.
   - Nếu thấy `"keys":"ok"` thì xong bước này.
   - Nếu thấy `does not match`, `missing` hoặc `cannot build`, nghĩa là khóa bí mật trên Cloudflare không khớp khóa công khai. Làm lại cả cặp khóa:
     1. `cd web` rồi `npm run vapid`.
     2. Dán khóa công khai mới vào `VAPID_PUBLIC_KEY` trong `web/wrangler.toml`.
     3. Chạy `npx wrangler secret put VAPID_PRIVATE_KEY`, rồi dán **chỉ phần khóa**, không kèm chữ `VAPID_PRIVATE_KEY=`.
     4. `npm run deploy`, rồi mở lại địa chỉ `/api/push/health` để kiểm tra.
     5. Trên iPhone: vào Cài đặt của BUN, tắt rồi bật lại **Thông báo trên điện thoại**.

4. Cài lại app trên iPhone:
   1. Xóa biểu tượng BUN cũ trên màn hình chính.
   2. Mở bằng **Safari**: `https://bun-web.sorandbun.workers.dev/app/`.
   3. Bấm **Chia sẻ**, rồi **Thêm vào MH chính**.
   4. Mở BUN từ màn hình chính.

5. Build lại app Windows và Mac. Lưu code lên GitHub rồi tạo phiên bản mới; GitHub Actions sẽ tự build `BUN-Setup.exe` và `BUN-mac.dmg`:

   ```powershell
   git add -A
   git commit -m "BUN 1.1.0"
   git push
   git tag v1.1.0
   git push origin v1.1.0
   ```

   Sau khoảng 10 phút, tải bản mới từ trang web và cài đè lên bản cũ.

**Lần đầu mở bản 1.1:** nếu trên máy đã có tài khoản cũ (tạo trước khi có máy chủ), BUN sẽ hỏi lại **code một lần** để đưa tài khoản và các bảng, việc, note lên máy chủ. Tài khoản cùng tên và cùng code trên các máy khác nhau sẽ được gộp thành một.

## Cập nhật lên bản 1.1.1

Bản 1.1.0 không đồng bộ được tài khoản: nút **Đồng bộ** báo "Có lỗi xảy ra", và tạo tài khoản mới cũng lỗi. Nguyên nhân: Cloudflare chỉ cho băm code tối đa 100.000 vòng, còn bản 1.1.0 dùng 120.000. Bản 1.1.1 dùng 100.000 vòng cho mọi code mới; code cũ trên máy vẫn dùng được.

1. Đưa máy chủ mới lên Cloudflare (sửa lỗi ngay cho mọi thiết bị):

   ```powershell
   npm run build:web
   cd web
   npm run deploy
   cd ..
   ```

2. iPhone: đóng hẳn BUN rồi mở lại 1–2 lần để lấy bản mới. Không cần cài lại.

3. Windows và Mac: tạo bản cài mới.

   ```powershell
   git add -A
   git commit -m "BUN 1.1.1"
   git push
   git tag v1.1.1
   git push origin v1.1.1
   ```

   Sau khoảng 10 phút, tải bản mới từ trang web và cài đè lên bản cũ.

4. Bấm **Đồng bộ** và nhập code. Nên cài bản 1.1.1 trước khi bấm: bản 1.1.1 giữ nguyên ID của bạn (ví dụ `Mì#4127`). Bản 1.1.0 vẫn đồng bộ được, nhưng ID sẽ đổi sang số khác.
