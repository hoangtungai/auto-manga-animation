# Manga Animator

Tải lên một trang truyện tranh → Claude Code phân tích và viết mô tả animation cho từng khung → sửa mô tả trên giao diện → HyperFrames dựng chuyển động và xuất MP4 để tải về.

## Chạy

```bash
npm install        # lần đầu
npm start          # mở http://localhost:3000
```

Yêu cầu: Node 22+, FFmpeg, và Claude Code CLI (`claude`) đã đăng nhập.

Biến môi trường tuỳ chọn:
- `PORT` (mặc định 3000)
- `CLAUDE_MODEL` — model cho Claude Code (vd `sonnet`, `opus`)
- `HF_WORKERS` — số worker Chrome khi render (mặc định 2)

## Chuyển động trong ảnh

Không cần tách khớp. Claude khai báo các bộ phận (tóc, vải, vũ khí, thân người, tay chân) dưới dạng vùng viên thuốc từ điểm A đến B, sửa được bằng cách kéo trên ảnh gốc; `lib/motion.js` dùng WebGL làm cong đúng các vùng đó nên giữ nguyên nét vẽ. Hiệu ứng **Gió** làm tóc và vải bay mạnh hơn theo hướng gió của cảnh; **Ánh sáng xanh** phủ màu và nhịp sáng.

Để chớp mắt, thêm ảnh vào ô nhắm mắt; ảnh này phải giống hệt ảnh gốc ngoài vùng mắt. FFmpeg tự tính vùng khác nhau thành `assets/blink-mask.png`, nên không cần chỉ vị trí mắt.

## Chế độ phim

Tải ảnh vào 3 ô: ảnh gốc, ảnh nhắm mắt và ảnh animation lệch chuyển động 5–10% so với ảnh gốc. FFmpeg (`minterpolate`) tạo các khung trung gian giữa hai tư thế vào `assets/poses/`, nhân vật cử động qua lại bằng các khung đó. Video lấp đầy khung hình, máy quay chạy trong shader nên cận cảnh vẫn nét, có cảnh **Cận → toàn cảnh**, chuyển cảnh **Lia nhanh**, **Zoom nhanh** và **Tia sáng**. Video luôn là 9:16, mỗi cảnh 2 giây. Chớp mắt ưu tiên cận cảnh, cách nhau ít nhất 5 giây và luôn rơi vào lúc nhân vật ở tư thế đầu.

Tuỳ chọn **Ngẫu nhiên đa dạng** làm mỗi lần tạo video có một bộ chuyển cảnh, cách quay và hiệu ứng khác nhau, gồm góc nghiêng, zoom giật, lia dọc, xoay nhanh, khung va chạm đảo màu, tách màu và hạt phim. Giao diện vẫn hiện kế hoạch gốc.

## Cách hoạt động

- `lib/claude.js` — gọi `claude -p` (headless) với công cụ `Read` để xem ảnh, trả về kế hoạch JSON theo schema: từng cảnh có vùng khung (bbox %), mô tả, chuyển động máy quay, hiệu ứng, chuyển cảnh, chữ tượng thanh, phụ đề.
- Khi bấm **Tạo video** (bật "Đồng bộ thông số theo mô tả"), Claude Code đọc lại mô tả đã sửa và chỉnh tham số cho khớp.
- `lib/builder.js` — biến kế hoạch thành `index.html` HyperFrames (GSAP, mọi ngẫu nhiên đều có seed nên render ổn định).
- `server.js` — Express API; mỗi lần upload là một project HyperFrames trong `jobs/<id>/`, render bằng `hyperframes render` ra `jobs/<id>/out.mp4`.

Có thể mở thư mục `jobs/<id>/` bằng HyperFrames desktop app hoặc `npx hyperframes preview` để chỉnh tiếp bằng tay.
