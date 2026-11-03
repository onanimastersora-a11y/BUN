# Phím tắt "BUN Bao thuc" (báo thức iPhone)

Web app không tự reo chuông được: Apple chỉ cho app gốc đặt báo thức. Vì vậy BUN gửi lịch tuần sang một **Phím tắt** trên iPhone, và Phím tắt tạo báo thức thật trong app Đồng hồ, lặp lại mỗi tuần.

Phím tắt đã được chia sẻ tại https://www.icloud.com/shortcuts/5bd7ee2cde454b04abadc9098ae0bb43, nên người dùng chỉ cần bấm **Cài phím tắt** trong BUN. Các bước tạo tay dưới đây chỉ cần khi muốn làm lại phím tắt.

BUN gửi mỗi báo thức thành một dòng, theo dạng `thứ|giờ|tên` (1 là thứ Hai, 7 là Chủ nhật):

```
2|06:30|BUN: Thể 3
4|14:35|BUN: Tăng trưởng phát triển
```

## Tạo phím tắt

BUN **không có** trong danh sách ứng dụng của app Phím tắt, và điều đó không sao. Apple chỉ liệt kê app cài từ App Store, còn phím tắt này chỉ dùng tác vụ có sẵn của iPhone (**Tạo báo thức** thuộc app **Đồng hồ**).

Mở app **Phím tắt** → bấm **+** → đặt tên đúng là `BUN Bao thuc`. Thêm lần lượt các tác vụ sau (tìm theo tên trong ô tìm kiếm):

1. **Tách văn bản** (Split Text): tách **Đầu vào phím tắt** theo **Dòng mới**.
2. **Lặp lại với từng mục** (Repeat with Each): với **Văn bản đã tách** ở bước 1.

Các bước 3–9 nằm **bên trong** vòng lặp:

3. **Tách văn bản**: tách **Mục lặp lại** theo **Tùy chỉnh**, gõ ký tự `|`.
4. **Lấy mục từ danh sách** (Get Item from List): **Mục đầu tiên** của văn bản đã tách ở bước 3.
5. **Đặt biến** (Set Variable): tên `Thu`, giá trị là kết quả bước 4.
6. **Lấy mục từ danh sách**: **Mục tại chỉ số** `2`, từ văn bản đã tách ở bước 3.
7. **Đặt biến**: tên `Gio`, giá trị là kết quả bước 6.
8. **Lấy mục từ danh sách**: **Mục cuối cùng**, từ văn bản đã tách ở bước 3.
9. **Đặt biến**: tên `Ten`, giá trị là kết quả bước 8.

Rồi thêm 7 khối giống nhau, mỗi khối cho một thứ, vẫn bên trong vòng lặp:

10. **Nếu** (If): `Thu` **là** `1`.
11. Bên trong **Nếu**, thêm **Tạo báo thức** (Create Alarm):
    - **Thời gian:** giữ vào ô này rồi chọn biến `Gio`.
    - **Nhãn:** chọn biến `Ten`.
    - **Lặp lại:** chỉ chọn **Thứ Hai**.
12. Bỏ phần **Nếu không** (Otherwise) nếu có.
13. Giữ vào khối **Nếu** → **Nhân bản** 6 lần, rồi sửa số và ngày lặp lại:

| `Thu` là | Lặp lại |
|---|---|
| 1 | Thứ Hai |
| 2 | Thứ Ba |
| 3 | Thứ Tư |
| 4 | Thứ Năm |
| 5 | Thứ Sáu |
| 6 | Thứ Bảy |
| 7 | Chủ Nhật |

Mẹo: trước khi nhân bản, thử giữ vào ô **Lặp lại** xem có chọn được biến không. Nếu có, chỉ cần một **Tạo báo thức** với biến thứ. Khi đó BUN cần gửi tên thứ thay vì số, nên hãy báo lại để đổi.

## Thử

1. Mở BUN từ màn hình chính → **Cài đặt** → **Báo thức iPhone** → bấm **Tôi đã có phím tắt này**.
2. Tắt hết, chỉ để lại một việc, rồi bấm **Thêm 1 báo thức vào iPhone**.
3. Lần đầu, iPhone hỏi quyền cho Đồng hồ: chọn **Luôn cho phép**.
4. Mở app **Đồng hồ** → **Báo thức**: phải có `BUN: tên việc`, đúng giờ, đúng ngày lặp.
5. Quay lại BUN và bấm **Đã có**. BUN chỉ ghi nhận báo thức sau bước này.

Nếu iPhone báo không tìm thấy phím tắt, kiểm tra lại tên là đúng `BUN Bao thuc`, rồi bấm **Chưa có** trong BUN và thử lại.

## Cho mọi người cài bằng một lần bấm

1. Trong app **Phím tắt**, giữ vào `BUN Bao thuc` → **Chia sẻ** → **Sao chép liên kết iCloud**.
2. Dán link vào `ALARM_SHORTCUT_URL` trong [src/core/config.js](../src/core/config.js).
3. Build và deploy web. Mục **Báo thức iPhone** sẽ có nút **Cài phím tắt** thay cho phần hướng dẫn tạo tay.

Link iCloud giữ nguyên phím tắt tại thời điểm chia sẻ. Nếu sửa phím tắt, hãy chia sẻ lại rồi cập nhật `ALARM_SHORTCUT_URL`.

## Điều cần biết

- Phím tắt chỉ **thêm** được báo thức, không sửa được. Khi lịch đổi, BUN liệt kê các báo thức cũ để bạn tự xóa trong app Đồng hồ, rồi bấm thêm báo thức mới.
- BUN nhớ những báo thức đã thêm ngay trên iPhone đó, nên bấm lại không bị trùng. Xóa BUN khỏi màn hình chính thì BUN quên danh sách này.
- **Thêm lại từ đầu** sẽ tạo lại mọi báo thức, nên BUN yêu cầu xóa các báo thức cũ trong app Đồng hồ trước. Nếu không xóa, mỗi việc sẽ có 2 báo thức.
- Chỉ những việc bật **Lặp lại hằng tuần** mới có báo thức. Giờ reo là giờ bắt đầu trừ đi số phút nhắc trước trong Cài đặt.
