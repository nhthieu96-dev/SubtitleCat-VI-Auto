# SubtitleCat VI Auto — Stremio Addon (Cloudflare Worker)

Addon Stremio tự động:

1. Tra tên phim/tập phim qua **Cinemeta** từ IMDB id (Stremio chỉ gửi id, không gửi
   tên phim).
2. Tìm các trang trên `subtitlecat.com` có thể khớp (subtitlecat không có ô tìm
   kiếm server-side thật, nên addon tìm qua DuckDuckGo/Bing).
3. **Fuzzy-match**: so điểm tương đồng (Dice coefficient trên bigram) giữa tiêu đề
   thật của từng trang ứng viên với tên phim cần tìm, cộng điểm nếu số season/episode
   khớp (với series) — chọn trang khớp nhất, không chỉ lấy kết quả đầu tiên như bản
   trước.
4. Nếu trang đó **đã có sẵn** phụ đề Tiếng Việt → trả link tải thẳng.
5. Nếu **chưa có** (trang chỉ ghi "Translate") → tự động tải một bản phụ đề gốc
   (ưu tiên English, rồi các ngôn ngữ phổ biến khác), **tự dịch toàn bộ sang Tiếng
   Việt** bằng Google Translate (endpoint không cần API key), lưu vào Cloudflare KV
   và phục vụ qua chính route `/srt/...` của Worker này.

Toàn bộ chạy trên **Cloudflare Workers** (serverless, miễn phí ở mức dùng cá nhân),
không cần VPS, không phụ thuộc thư viện ngoài (cheerio/axios) — chỉ dùng `fetch` và
regex thuần để nhẹ và tương thích 100% với môi trường Worker.

## Cài đặt & Deploy

### 1. Cài Wrangler (CLI của Cloudflare)

```bash
npm install
```

### 2. Đăng nhập Cloudflare

```bash
npx wrangler login
```

### 3. Tạo KV Namespace (nơi lưu cache + phụ đề đã dịch)

```bash
npx wrangler kv namespace create SUBCAT_KV
```

Lệnh trên in ra kết quả dạng:

```
{ binding = "SUBCAT_KV", id = "abcd1234..." }
```

Mở file `wrangler.toml`, thay `YOUR_KV_ID_HERE` bằng `id` vừa nhận được:

```toml
[[kv_namespaces]]
binding = "SUBCAT_KV"
id = "abcd1234..."
```

### 4. Deploy

```bash
npx wrangler deploy
```

Sau khi deploy xong, Wrangler in ra URL dạng:

```
https://subtitlecat-vi.<your-subdomain>.workers.dev
```

### 5. Cài vào Stremio

Mở Stremio → **Addons** → dán vào ô tìm kiếm/paste URL:

```
https://subtitlecat-vi.<your-subdomain>.workers.dev/manifest.json
```

Nhấn cài đặt. Xong — mở phim/tập phim nào có trên IMDB, addon sẽ tự tìm và (nếu
cần) tự dịch phụ đề Tiếng Việt.

## Cấu hình trong `wrangler.toml`

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MIN_MATCH_SCORE` | Điểm tương đồng tối thiểu (0..1) để chấp nhận 1 trang subtitlecat là đúng phim | `0.35` |
| `DECISION_TTL_SECONDS` | Thời gian cache kết quả tìm được (giây) | `43200` (12h) |
| `SUBTITLE_TTL_SECONDS` | Thời gian lưu file phụ đề đã tự dịch trong KV (giây) | `2592000` (30 ngày) |

Tăng `MIN_MATCH_SCORE` nếu thấy addon match nhầm phim; giảm xuống nếu addon quá
"kén" và bỏ sót phim đúng nhưng tên hơi khác.

## Giới hạn cần biết

- **Tốc độ dịch**: phim dài (~1000-1500 dòng thoại) được dịch theo từng lô song
  song (batch), nhưng vẫn phụ thuộc thời gian phản hồi của Google Translate. Lần
  đầu yêu cầu 1 phim có thể mất vài giây đến vài chục giây; các lần sau được phục
  vụ từ cache (KV) nên gần như tức thì.
- **Google Translate không key**: dùng endpoint công khai `translate.googleapis.com`
  (không cần API key, nhiều dự án mã nguồn mở khác cũng dùng), nhưng Google có thể
  giới hạn tốc độ nếu gọi quá dồn dập — code đã có delay + xử lý song song có kiểm
  soát (concurrency = 4) để giảm rủi ro bị chặn.
- **Chất lượng dịch**: là dịch máy (Google Translate), không phải bản dịch người
  làm, nên sẽ không tự nhiên bằng phụ đề Việt do người dịch tay tải lên sẵn.
- **Fuzzy match không tuyệt đối**: với phim tên quá chung chung hoặc ít phổ biến,
  vẫn có thể match sai hoặc không tìm ra. Có thể chỉnh `MIN_MATCH_SCORE` hoặc sửa
  hàm `scoreCandidate` / `buildSearchQueries` trong `src/worker.js`.
- **Giới hạn Cloudflare Workers free plan**: số lượng subrequest mỗi request có
  giới hạn (khoảng 50 trên free plan). Với phim rất dài, nếu vượt giới hạn này,
  addon sẽ trả về bản dịch từng phần bị lỗi/rỗng — nên cân nhắc nâng plan Workers
  (Paid) nếu dùng nhiều, plan trả phí cho phép tới 1000 subrequest/request.

## Kiểm tra thủ công sau khi deploy

```bash
curl "https://<your-worker>.workers.dev/manifest.json"
curl "https://<your-worker>.workers.dev/subtitles/movie/tt0758758.json"
```

(Thay `tt0758758` bằng IMDB id bất kỳ để test.)
