import { spawn } from "node:child_process";
import { CAMERA_MOVES, EFFECTS, PART_TYPES, TRANSITIONS, WIND_DIRS } from "./builder.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

const partSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: PART_TYPES },
    ax: { type: "number" },
    ay: { type: "number" },
    bx: { type: "number" },
    by: { type: "number" },
    radius: { type: "number" },
    strength: { type: "number" },
  },
  required: ["type", "ax", "ay", "bx", "by", "radius", "strength"],
};

const shotSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    bbox: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
      required: ["x", "y", "w", "h"],
    },
    duration: { type: "number" },
    camera: {
      type: "object",
      properties: { move: { type: "string", enum: CAMERA_MOVES }, amount: { type: "number" } },
      required: ["move", "amount"],
    },
    effects: { type: "array", items: { type: "string", enum: EFFECTS } },
    motion: {
      type: "object",
      properties: {
        windDir: { type: "string", enum: WIND_DIRS },
        parts: { type: "array", maxItems: 8, items: partSchema },
      },
      required: ["windDir", "parts"],
    },
    transition: { type: "string", enum: TRANSITIONS },
    sfx: { type: "string" },
    caption: { type: "string" },
  },
  required: ["description", "bbox", "duration", "camera", "effects", "motion", "transition", "sfx", "caption"],
};

export const planSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    shots: { type: "array", items: shotSchema },
  },
  required: ["title", "summary", "shots"],
};

const VOCAB = `
Từ vựng được phép (chỉ dùng đúng các giá trị này):
- camera.move: push_in (zoom vào), pull_out (zoom ra), pan_left, pan_right, pan_up, pan_down (lia máy), static (gần như đứng yên), reveal (từ cận cảnh kéo ra toàn cảnh), dive (từ toàn cảnh lao vào cận cảnh), dutch (nghiêng máy, dùng hiếm cho khoảnh khắc căng thẳng), crash_zoom (zoom giật cực nhanh vào chủ thể), scan (lia dọc từ dưới lên trên). camera.amount 0..1 = độ mạnh.
- effects: focus_lines (đường tập trung toả tròn kiểu manga), speed_lines (đường tốc độ ngang), impact_flash (loé trắng khi va chạm), shake (rung khung hình), sparkle (lấp lánh), halftone (lớp chấm screentone nhấp nháy), vignette (tối viền), red_tint (phủ đỏ giận dữ/nguy hiểm), blue_light (ánh sáng xanh huyền ảo, nhịp sáng nhẹ), light_rays (tia sáng không gian quét chậm, chỉ có ở chế độ phim), chromatic (tách màu RGB nhẹ), film_grain (hạt phim), dust (hạt bụi/ánh sáng bay lên), rain (mưa), wind (gió: tóc/vải bay mạnh hơn và có vệt gió), blink (nhân vật chớp mắt; chỉ dùng khi mắt nhân vật lộ rõ trong cảnh).
- motion.windDir: hướng gió, left hoặc right.
- motion.parts: tối đa 8 bộ phận chuyển động nhẹ trong cảnh, mỗi bộ phận là một vùng hình viên thuốc từ điểm A (ax,ay) đến điểm B (bx,by), toạ độ theo PHẦN TRĂM ảnh gốc, radius là bán kính theo % chiều rộng ảnh, strength 0..1 (mặc định 0.5):
  + hair: lọn/mảng tóc, A là chân tóc (đứng yên), B là ngọn tóc. Tóc dày thì tách vài vùng theo từng mảng. Không để vùng phủ lên mặt.
  + cloth: tà áo, áo choàng, khăn; A là chỗ đính vào người, B là mép tự do.
  + weapon: vũ khí/vật cầm tay, A là tay cầm (tâm lắc), B là mũi. Vùng ôm sát vật.
  + body: thân người thở nhẹ, A ở hông, B ở đầu.
  + limb: tay hoặc chân đung đưa nhẹ, A là khớp gốc (vai/hông), B là đầu mút (bàn tay/bàn chân). Vùng ôm sát chi, mỗi chi một vùng. Chân đang đứng trên đất thì strength tối đa 0.2 hoặc bỏ qua để bàn chân không trượt.
  Chỉ thêm vùng cho cảnh có nhân vật nhìn rõ và hợp với nội dung; cảnh không có gì lay động thì để parts rỗng. Đặt toạ độ thật chính xác vì vùng sai sẽ làm méo chỗ khác.
- transition (vào cảnh): cut, fade, flash (loé trắng), slide (trượt vào), ink_wipe (màn mực đen quét qua), whip (lia nhanh nhoè chuyển động), punch (zoom nhanh nhoè toả tâm), spin (xoay nhanh), impact (khung va chạm đảo đen trắng kèm rung). whip, punch, spin, impact chỉ có tác dụng ở chế độ phim.
- sfx: chữ tượng thanh lớn hiện trên màn hình (vd "BOOM!", "ドン", "VÚT"), để "" nếu không có.
- caption: phụ đề/lời thoại ngắn hiển thị dưới màn hình, để "" nếu không cần.
- duration: số giây của cảnh (1.5–8; chế độ phim luôn là 2).
- bbox: vùng khung truyện trên ảnh gốc theo PHẦN TRĂM (x,y là góc trên-trái, w,h là rộng/cao, 0..100).`;

const FILM_BRIEF = `
Đây là CHẾ ĐỘ PHIM: ảnh là một minh hoạ duy nhất, người dùng có thêm ảnh tư thế lệch nên nhân vật đã tự chuyển động thật. Không chia theo khung truyện, mà đạo diễn một đoạn phim 6–8 cảnh ngắn như trailer anime:
- Mở bằng các cận cảnh chi tiết (mắt, gương mặt, bàn tay, vũ khí, tóc bay), rồi mở dần sang trung cảnh, kết bằng cảnh camera.move = reveal kéo ra toàn cảnh. Video dọc 9:16 cho short, mọi cảnh dài đúng 2 giây.
- bbox là vùng cận cảnh của chủ thể, đặt sát và chính xác; nên chọn vùng cao và rộng theo tỉ lệ khung phim.
- Chuyển cảnh hầu hết dùng whip, punch, spin hoặc impact để nhịp nhanh; thỉnh thoảng flash ở điểm nhấn.
- Chỉ đặt effect blink ở cận cảnh thấy rõ mắt, không đặt ở trung cảnh hay toàn cảnh.
- Mọi cảnh đều có light_rays và dust để có ánh sáng không gian; cảnh có tóc hoặc vải có wind. blue_light dùng cho toàn phim nếu hợp không khí ảnh.
- camera.amount càng cao nhân vật cử động càng nhanh. Không dùng focus_lines, speed_lines, halftone, sfx hay caption trừ khi thật cần.
`;

export function analyzePrompt(imageFile, width, height, hasClosedEyes = false, hasPose = false) {
  return `Bạn là đạo diễn motion-comic. Hãy dùng công cụ Read để xem ảnh truyện tranh tại "./${imageFile}" (kích thước ${width}x${height}px).

${hasPose ? FILM_BRIEF : ""}
Nhiệm vụ:
1. Xác định từng khung (panel) theo đúng thứ tự đọc của truyện (manga Nhật: phải→trái, trên→xuống; comic phương Tây/webtoon: trái→phải). Nếu ảnh chỉ là một hình đơn, hãy chia thành 2–4 cảnh tập trung vào các chi tiết quan trọng.
2. Với mỗi khung, ước lượng bbox thật chính xác bao trọn viền khung (theo phần trăm của ảnh).
3. Viết mô tả animation bằng tiếng Việt cho từng cảnh: chuyện gì xảy ra, máy quay di chuyển ra sao, hiệu ứng gì, cảm xúc gì. Mô tả phải khớp với các tham số bạn chọn.
4. Chọn tham số chuyển động phù hợp với nội dung (cảnh hành động: speed_lines/focus_lines/shake/impact_flash; cảnh cảm xúc: push_in chậm, dust, sparkle, vignette...).
${hasClosedEyes ? "   Người dùng đã cung cấp ảnh mắt nhắm: hãy thêm effect blink cho các cảnh thấy rõ mắt nhân vật; ở chế độ phim chỉ cận cảnh, và chương trình sẽ tự giãn cách." : "   Không có ảnh mắt nhắm: KHÔNG dùng effect blink."}
5. Với mỗi cảnh có nhân vật, khai báo motion.parts cho tóc, vải, vũ khí, thân người, tay chân để hình sống động nhẹ.
6. caption: dịch/ghi lại lời thoại chính của khung sang tiếng Việt nếu có (ngắn gọn), hoặc "".
7. title: tên ngắn cho đoạn phim; summary: tóm tắt toàn trang 1–2 câu.
${VOCAB}

Chỉ trả về dữ liệu có cấu trúc theo schema.`;
}

export function syncPrompt(plan, hasClosedEyes = false) {
  return `Bạn là đạo diễn motion-comic. Dưới đây là kế hoạch animation cho một trang truyện. Người dùng có thể đã sửa phần "description" của một số cảnh.
Hãy cập nhật các tham số (camera, effects, motion.windDir, transition, duration, sfx, caption) của MỖI cảnh để khớp chính xác với "description" của cảnh đó.
Giữ nguyên bbox, description, motion.parts, số lượng và thứ tự cảnh. Nếu tham số đã khớp thì giữ nguyên.
${hasClosedEyes ? "" : "Không có ảnh mắt nhắm nên KHÔNG dùng effect blink.\n"}${VOCAB}

Kế hoạch hiện tại (JSON):
${JSON.stringify(plan, null, 2)}

Chỉ trả về dữ liệu có cấu trúc theo schema.`;
}

// Runs `claude -p` headless and resolves with the structured output.
export function runClaude(prompt, { cwd, schema, allowRead = false, onLog }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema)];
    if (allowRead) args.push("--allowedTools", "Read");
    else args.push("--tools", "");
    if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
    const child = spawn(CLAUDE_BIN, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      onLog?.(String(d));
    });
    child.on("error", (e) => reject(new Error(`Không chạy được Claude Code (${CLAUDE_BIN}): ${e.message}`)));
    child.on("close", (code) => {
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new Error(`Claude Code trả về dữ liệu không hợp lệ (exit ${code}): ${(err || out).slice(-800)}`));
      }
      if (res.is_error) return reject(new Error(`Claude Code lỗi: ${res.result || res.subtype}`));
      let data = res.structured_output;
      if (!data && typeof res.result === "string") {
        const m = res.result.match(/\{[\s\S]*\}/);
        if (m) try { data = JSON.parse(m[0]); } catch {}
      }
      if (!data) return reject(new Error("Claude Code không trả về kế hoạch animation."));
      resolve({ data, cost: res.total_cost_usd });
    });
  });
}
