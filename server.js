import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildComposition, normalizePlan, CAMERA_MOVES, EFFECTS, FILM_SHOT_SECONDS, TRANSITIONS } from "./lib/builder.js";
import { runClaude, analyzePrompt, syncPrompt, planSchema } from "./lib/claude.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(ROOT, "jobs");
const HF_BIN = path.join(ROOT, "node_modules", ".bin", "hyperframes");
const GSAP = path.join(ROOT, "node_modules", "gsap", "dist", "gsap.min.js");
const MOTION_RUNTIME = path.join(ROOT, "lib", "motion.js");
const PORT = Number(process.env.PORT || 3000);

await fs.mkdir(JOBS_DIR, { recursive: true });

const jobs = new Map(); // id -> state (in memory; plan + video also on disk)
const jobDir = (id) => path.join(JOBS_DIR, id);

function state(id) {
  if (!jobs.has(id)) jobs.set(id, { id, stage: "idle", progress: 0, log: [], error: null });
  return jobs.get(id);
}
function log(job, line) {
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!clean) return;
  job.log.push(clean);
  if (job.log.length > 60) job.log.splice(0, job.log.length - 60);
}

function probeSize(file) {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], (err, out) => {
      try {
        const s = JSON.parse(out).streams[0];
        resolve({ width: s.width, height: s.height });
      } catch {
        resolve(null);
      }
    });
  });
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "buffer" }, (err, out, stderr) =>
      err ? reject(new Error(String(stderr).slice(-400) || err.message)) : resolve(out),
    );
  });
}

// Fits the closed-eye image to the source and bakes a soft mask of what differs (the eyes),
// so blinks need no eye coordinates and tolerate small unrelated differences elsewhere.
async function prepareBlink(dir, imageFile, closedPath, size) {
  const { width: W, height: H } = size;
  const closedFile = "assets/closed.png";
  const maskFile = "assets/blink-mask.png";
  const closedSize = await probeSize(closedPath);
  await ffmpeg(["-i", closedPath, "-vf", `scale=${W}:${H}:flags=lanczos,format=rgb24`, "-frames:v", "1", path.join(dir, closedFile)]);
  const sigma = Math.max(2, Math.round(Math.min(W, H) / 250));
  await ffmpeg([
    "-i", path.join(dir, imageFile), "-i", path.join(dir, closedFile),
    "-filter_complex",
    `[0:v]scale=${W}:${H},format=rgb24[a];[1:v]format=rgb24[b];[a][b]blend=all_mode=difference,format=gray,median=radius=1,` +
      `lut=c0='if(gt(val,28),255,0)',gblur=sigma=${sigma},lut=c0='if(gt(val,30),255,0)',gblur=sigma=${sigma / 2}`,
    "-frames:v", "1", path.join(dir, maskFile),
  ]);
  const tiny = await ffmpeg(["-i", path.join(dir, maskFile), "-vf", "scale=32:32:flags=area,format=gray", "-f", "rawvideo", "-"]);
  const coverage = tiny.reduce((sum, v) => sum + v, 0) / (255 * tiny.length);
  let notice = null;
  if (coverage < 0.0002) notice = "Ảnh mắt nhắm gần như giống ảnh gốc nên có thể không thấy chớp mắt.";
  else if (coverage > 0.15 || (closedSize && Math.abs(closedSize.width / closedSize.height - W / H) > 0.02 * (W / H)))
    notice = "Ảnh mắt nhắm khác ảnh gốc khá nhiều (lệch khung hoặc khác nét) nên lúc chớp mắt có thể bị giật hình. Tốt nhất hai ảnh chỉ khác nhau ở vùng mắt.";
  return { closedFile, maskFile, notice };
}

const POSE_STEPS = 13;
const MAX_POSE_SIDE = 1600;

// Bakes the in-betweens from the source to the second pose. minterpolate needs extra frames of
// context, so each pose is held twice and frames at 1s..2s of the 12 fps output are the ones kept.
async function preparePose(dir, imageFile, posePath, size) {
  const { width: W, height: H } = size;
  const scale = Math.min(1, MAX_POSE_SIDE / Math.max(W, H));
  const fw = Math.round((W * scale) / 2) * 2;
  const fh = Math.round((H * scale) / 2) * 2;
  const tmp = path.join(dir, "assets", "pose-tmp");
  const poses = path.join(dir, "assets", "poses");
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(poses, { recursive: true });
  const fit = `scale=${fw}:${fh}:flags=lanczos,format=rgb24`;
  const poseSize = await probeSize(posePath);
  await ffmpeg(["-i", path.join(dir, imageFile), "-vf", fit, "-frames:v", "1", path.join(tmp, "a.png")]);
  await ffmpeg(["-i", posePath, "-vf", fit, "-frames:v", "1", path.join(tmp, "b.png")]);
  for (const [i, f] of ["a", "a", "b", "b", "b"].entries()) await fs.copyFile(path.join(tmp, `${f}.png`), path.join(tmp, `in${i}.png`));
  await ffmpeg([
    "-framerate", "1", "-i", path.join(tmp, "in%d.png"),
    "-vf", "minterpolate=fps=12:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:vsbmc=1:search_param=64:scd=none,format=rgb24",
    path.join(tmp, "out%02d.png"),
  ]);
  const frames = [];
  for (let i = 0; i < POSE_STEPS; i++) {
    const name = `assets/poses/${i}.png`;
    await fs.rename(path.join(tmp, `out${String(i + 13).padStart(2, "0")}.png`), path.join(dir, name));
    frames.push(name);
  }
  await fs.rm(tmp, { recursive: true, force: true });
  const skewed = poseSize && Math.abs(poseSize.width / poseSize.height - W / H) > 0.02 * (W / H);
  return { poseFrames: frames, notice: skewed ? "Ảnh chuyển động khác tỉ lệ với ảnh gốc nên đã bị kéo cho khớp, chuyển động có thể méo." : null };
}

// Renders run one at a time: each Chrome worker needs RAM.
let renderQueue = Promise.resolve();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/files", express.static(JOBS_DIR, { index: false, dotfiles: "deny" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});

app.get("/api/vocab", (_req, res) => res.json({ cameraMoves: CAMERA_MOVES, effects: EFFECTS, transitions: TRANSITIONS }));

app.post("/api/jobs", upload.fields([{ name: "image", maxCount: 1 }, { name: "closed", maxCount: 1 }, { name: "pose", maxCount: 1 }]), async (req, res) => {
  const file = req.files?.image?.[0];
  const closed = req.files?.closed?.[0];
  const pose = req.files?.pose?.[0];
  if (!file) return res.status(400).json({ error: "Hãy chọn một file ảnh (PNG, JPG, WEBP)." });
  const id = crypto.randomBytes(6).toString("hex");
  const dir = jobDir(id);
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" }[file.mimetype];
  const imageFile = `assets/source.${ext}`;
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, imageFile), file.buffer);
  await fs.copyFile(GSAP, path.join(dir, "assets", "gsap.min.js"));
  await fs.writeFile(
    path.join(dir, "hyperframes.json"),
    JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2),
  );
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ id, name: `manga-${id}`, createdAt: new Date().toISOString() }, null, 2));

  const size = (await probeSize(path.join(dir, imageFile))) || { width: Number(req.body.width) || 1000, height: Number(req.body.height) || 1400 };
  const info = { imageFile, ...size, name: file.originalname };
  if (closed) {
    const tmp = path.join(dir, "assets", "closed-upload");
    await fs.writeFile(tmp, closed.buffer);
    try {
      Object.assign(info, await prepareBlink(dir, imageFile, tmp, size));
    } catch (e) {
      info.notice = `Không xử lý được ảnh mắt nhắm nên video sẽ không chớp mắt: ${e.message}`;
    }
    await fs.rm(tmp, { force: true });
  }
  if (pose) {
    const tmp = path.join(dir, "assets", "pose-upload");
    await fs.writeFile(tmp, pose.buffer);
    try {
      const { poseFrames, notice } = await preparePose(dir, imageFile, tmp, size);
      info.poseFrames = poseFrames;
      info.notice = [info.notice, notice].filter(Boolean).join(" ") || null;
    } catch (e) {
      info.notice = [info.notice, `Không xử lý được ảnh chuyển động nên video sẽ dùng chế độ thường: ${e.message}`].filter(Boolean).join(" ");
    }
    await fs.rm(tmp, { force: true });
  }
  const job = state(id);
  Object.assign(job, info);
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(info));
  analyze(job);
  res.json(publicState(job));
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Không tìm thấy job." });
  res.json(publicState(job));
});

app.post("/api/jobs/:id/analyze", async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Không tìm thấy job." });
  if (busy(job)) return res.status(409).json({ error: "Job đang chạy." });
  analyze(job);
  res.json(publicState(job));
});

app.post("/api/jobs/:id/render", async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Không tìm thấy job." });
  if (busy(job)) return res.status(409).json({ error: "Job đang chạy." });
  const { plan, options = {} } = req.body || {};
  if (!plan?.shots?.length) return res.status(400).json({ error: "Kế hoạch animation chưa có cảnh nào." });
  job.plan = normalizePlan(plan);
  await fs.writeFile(path.join(jobDir(job.id), "plan.json"), JSON.stringify(job.plan, null, 2));
  Object.assign(job, { stage: "queued", progress: 0, error: null, video: null, log: [] });
  renderQueue = renderQueue.then(() => render(job, options)).catch(() => {});
  res.json(publicState(job));
});

function busy(job) {
  return ["analyzing", "queued", "syncing", "building", "rendering"].includes(job.stage);
}

async function loadJob(id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  const dir = jobDir(id);
  if (!existsSync(path.join(dir, "job.json"))) return null;
  const job = state(id);
  Object.assign(job, JSON.parse(await fs.readFile(path.join(dir, "job.json"), "utf8")));
  if (existsSync(path.join(dir, "plan.json"))) {
    job.plan = JSON.parse(await fs.readFile(path.join(dir, "plan.json"), "utf8"));
    job.stage = "ready";
  }
  if (existsSync(path.join(dir, "out.mp4"))) {
    job.video = `/files/${id}/out.mp4`;
    job.stage = "done";
  }
  return job;
}

function publicState(job) {
  return {
    id: job.id,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    log: job.log.slice(-12),
    image: job.imageFile ? `/files/${job.id}/${job.imageFile}` : null,
    width: job.width,
    height: job.height,
    name: job.name,
    hasClosedEyes: !!job.closedFile,
    hasPose: !!job.poseFrames,
    notice: job.notice || null,
    plan: job.plan || null,
    video: job.video ? `${job.video}?v=${job.videoVersion || 0}` : null,
    duration: job.duration || null,
    cost: job.cost || 0,
  };
}

async function analyze(job) {
  Object.assign(job, { stage: "analyzing", progress: 0, error: null, log: [] });
  log(job, "Claude Code đang đọc và phân tích trang truyện…");
  try {
    const { data, cost } = await runClaude(analyzePrompt(job.imageFile, job.width, job.height, !!job.closedFile, !!job.poseFrames), {
      cwd: jobDir(job.id),
      schema: planSchema,
      allowRead: true,
      onLog: (l) => log(job, l),
    });
    job.plan = normalizePlan(data);
    if (job.poseFrames) job.plan.shots.forEach((s) => (s.duration = FILM_SHOT_SECONDS));
    job.cost = (job.cost || 0) + (cost || 0);
    await fs.writeFile(path.join(jobDir(job.id), "plan.json"), JSON.stringify(job.plan, null, 2));
    log(job, `Đã tạo ${job.plan.shots.length} cảnh.`);
    job.stage = "ready";
  } catch (e) {
    job.error = e.message;
    job.stage = job.plan ? "ready" : "error";
  }
}

async function render(job, options) {
  const dir = jobDir(job.id);
  try {
    if (options.sync) {
      job.stage = "syncing";
      log(job, "Claude Code đang đồng bộ tham số chuyển động với mô tả đã sửa…");
      try {
        const { data, cost } = await runClaude(syncPrompt(job.plan, !!job.closedFile), { cwd: dir, schema: planSchema, onLog: (l) => log(job, l) });
        const synced = normalizePlan(data);
        // Keep the user's crops and wording; take Claude's motion parameters.
        if (synced.shots.length === job.plan.shots.length) {
          job.plan.shots = job.plan.shots.map((s, i) => ({
            ...synced.shots[i],
            bbox: s.bbox,
            description: s.description,
            duration: job.poseFrames ? s.duration : synced.shots[i].duration,
            motion: { ...synced.shots[i].motion, parts: s.motion.parts },
          }));
          job.cost = (job.cost || 0) + (cost || 0);
          await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(job.plan, null, 2));
          log(job, "Đã đồng bộ tham số.");
        } else log(job, "Bỏ qua đồng bộ (số cảnh không khớp), dùng tham số hiện tại.");
      } catch (e) {
        log(job, `Bỏ qua đồng bộ: ${e.message}`);
      }
    }

    job.stage = "building";
    log(job, "Dựng composition HyperFrames…");
    await fs.copyFile(MOTION_RUNTIME, path.join(dir, "assets", "motion.js"));
    const comp = buildComposition(job.plan, { src: job.imageFile, width: job.width, height: job.height, closedSrc: job.closedFile, maskSrc: job.maskFile, frames: job.poseFrames }, {
      resolution: "portrait",
      intro: !!options.intro,
      outro: !!options.outro,
      vary: options.vary !== false,
      // A fresh seed gives each render its own mix; the HTML bakes it, so that render stays reproducible.
      seed: crypto.randomBytes(4).readUInt32LE(0),
    });
    await fs.writeFile(path.join(dir, "index.html"), comp.html);
    job.duration = comp.total;

    job.stage = "rendering";
    log(job, `Render ${comp.total}s video ${comp.width}x${comp.height} bằng HyperFrames…`);
    const quality = ["draft", "looks", "delivery"].includes(options.quality) ? options.quality : "looks";
    const tmpOut = path.join(dir, "out.tmp.mp4");
    await runHF(job, ["render", "--quality", quality, "--workers", process.env.HF_WORKERS || "2", "--skill", "hyperframes", "--output", tmpOut], dir);
    if (!existsSync(tmpOut)) throw new Error("HyperFrames không tạo ra file video.");
    await fs.rename(tmpOut, path.join(dir, "out.mp4"));
    job.video = `/files/${job.id}/out.mp4`;
    job.videoVersion = Date.now();
    job.progress = 100;
    job.stage = "done";
    log(job, "Hoàn tất!");
  } catch (e) {
    job.error = e.message;
    job.stage = "ready";
  }
}

function runHF(job, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(HF_BIN, args, { cwd, env: { ...process.env, FORCE_COLOR: "0", CI: "1" } });
    let tail = "";
    const onData = (d) => {
      const s = String(d);
      tail = (tail + s).slice(-3000);
      for (const line of s.split(/[\r\n]+/)) {
        const m = line.match(/"pct":(\d+(?:\.\d+)?)/) || line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
        if (m) job.progress = Math.min(99, Math.max(job.progress, Math.round(+m[1])));
        if (/^@hf-progress|\[Render:trace\]|Framey/.test(line.trim())) continue;
        log(job, line.replace(/[█░]+/g, "").trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`HyperFrames render lỗi (exit ${code}): ${tail.slice(-600)}`))));
  });
}

app.listen(PORT, () => console.log(`Manga Animator chạy tại http://localhost:${PORT}`));
