const $ = (s, el = document) => el.querySelector(s);

const LABELS = {
  camera: {
    push_in: "Zoom vào", pull_out: "Zoom ra", pan_left: "Lia trái", pan_right: "Lia phải",
    pan_up: "Lia lên", pan_down: "Lia xuống", static: "Đứng yên", reveal: "Cận → toàn cảnh", dive: "Toàn → cận cảnh",
    dutch: "Nghiêng máy", crash_zoom: "Zoom giật", scan: "Lia dọc",
  },
  effects: {
    focus_lines: "Đường tập trung", speed_lines: "Đường tốc độ", impact_flash: "Loé va chạm", shake: "Rung khung",
    sparkle: "Lấp lánh", halftone: "Screentone", vignette: "Tối viền", red_tint: "Phủ đỏ", blue_light: "Ánh sáng xanh", light_rays: "Tia sáng", chromatic: "Tách màu", film_grain: "Hạt phim",
    dust: "Bụi sáng", rain: "Mưa", wind: "Gió", blink: "Chớp mắt",
  },
  transitions: { cut: "Cắt thẳng", fade: "Mờ dần", flash: "Loé trắng", slide: "Trượt vào", ink_wipe: "Màn mực quét", whip: "Lia nhanh", punch: "Zoom nhanh", spin: "Xoay nhanh", impact: "Va chạm đảo màu" },
  parts: { hair: "Tóc", cloth: "Vải, áo choàng", weapon: "Vũ khí", body: "Thân người", limb: "Tay, chân" },
  wind: { right: "Sang phải", left: "Sang trái" },
};
const PART_COLORS = { hair: "#0ea5e9", cloth: "#10b981", weapon: "#f59e0b", body: "#8b5cf6", limb: "#ec4899" };
const MAX_PARTS = 8;
const COLORS = ["#e8132b", "#1f6feb", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#0ea5e9", "#84cc16"];
const BUSY = ["analyzing", "queued", "syncing", "building", "rendering"];
const STAGE_TEXT = {
  queued: "Đang chờ tới lượt render…",
  syncing: "Claude Code đang đồng bộ thông số với mô tả…",
  building: "Đang dựng composition HyperFrames…",
  rendering: "HyperFrames đang render video…",
};

let job = null;
let plan = null;
let sel = 0;
let pollTimer = null;
let lastVideo = null;

// ---------- upload ----------
const picked = { open: null, closed: null, pose: null };

document.querySelectorAll(".slot").forEach((slot) => {
  const key = slot.dataset.slot;
  const input = $("input", slot);
  input.addEventListener("change", () => {
    setSlot(slot, input.files[0]);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) => slot.addEventListener(ev, (e) => { e.preventDefault(); slot.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => slot.addEventListener(ev, (e) => { e.preventDefault(); slot.classList.remove("over"); }));
  slot.addEventListener("drop", (e) => setSlot(slot, e.dataTransfer.files[0]));
  $(".slot-clear", slot).addEventListener("click", (e) => {
    e.preventDefault();
    picked[key] = null;
    showSlot(slot);
  });
});

function setSlot(slot, file) {
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return alertStatus("Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP.");
  picked[slot.dataset.slot] = file;
  showSlot(slot);
}

function showSlot(slot) {
  const file = picked[slot.dataset.slot];
  const img = $("img", slot);
  if (file) img.src = URL.createObjectURL(file);
  img.hidden = !file;
  $(".slot-empty", slot).hidden = !!file;
  $(".slot-clear", slot).hidden = !file;
  $("#pickStart").disabled = !picked.open;
}

$("#pickStart").addEventListener("click", () => picked.open && uploadFiles());

async function uploadFiles() {
  const fd = new FormData();
  fd.append("image", picked.open);
  if (picked.closed) fd.append("closed", picked.closed);
  if (picked.pose) fd.append("pose", picked.pose);
  $("#pickStart").disabled = true;
  $(".upload-title").textContent = "Đang tải lên…";
  try {
    const res = await fetch("/api/jobs", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    location.hash = data.id;
    applyJob(data, true);
  } catch (e) {
    $(".upload-title").textContent = "Tải ảnh lên";
    $("#pickStart").disabled = false;
    alert(e.message);
  }
}

$("#newBtn").addEventListener("click", () => {
  location.hash = "";
  location.reload();
});

// ---------- job state ----------
function applyJob(data, fresh = false) {
  const firstLoad = !job || job.id !== data.id;
  job = data;
  $("#uploadView").hidden = true;
  $("#editView").hidden = false;
  $("#actionBar").hidden = false;
  $("#newBtn").hidden = false;
  if (firstLoad) $("#srcImg").src = data.image;
  $("#notice").hidden = !data.notice;
  $("#notice").textContent = data.notice || "";

  const analyzing = data.stage === "analyzing";
  $("#analyzing").hidden = !analyzing;
  $("#planBody").hidden = analyzing || !data.plan;

  // Take the server's plan only when we don't have one being edited, or after a (re)analysis.
  if (data.plan && (!plan || fresh || job._takePlan)) {
    plan = structuredClone(data.plan);
    job._takePlan = false;
    sel = 0;
    renderPlan();
  }
  updateOutput();
  const busy = BUSY.includes(data.stage);
  $("#renderBtn").disabled = busy || !plan;
  $("#reanalyze").disabled = busy;
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(poll, 1500);
}

async function poll() {
  const wasAnalyzing = job.stage === "analyzing";
  const wasSyncing = BUSY.includes(job.stage);
  try {
    const res = await fetch(`/api/jobs/${job.id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // After analysis, or after a render that synced params, pull the server's plan.
    if (wasAnalyzing && data.stage !== "analyzing") job._takePlan = true;
    if (wasSyncing && !BUSY.includes(data.stage) && $("#optSync").checked && data.plan) job._takePlan = true;
    const take = job._takePlan;
    applyJob(data);
    if (take && data.plan) {
      plan = structuredClone(data.plan);
      renderPlan();
    }
  } catch {
    pollTimer = setTimeout(poll, 3000);
  }
}

function updateOutput() {
  const st = $("#status");
  const busy = BUSY.includes(job.stage) && job.stage !== "analyzing";
  $("#progress").hidden = !busy;
  $("#progress i").style.width = `${job.progress || 0}%`;
  $("#log").hidden = !busy && !job.error;
  $("#log").textContent = (job.log || []).join("\n");
  $("#log").scrollTop = 1e6;

  st.className = "status";
  if (job.error) {
    st.classList.add("err");
    st.textContent = "Lỗi: " + job.error;
  } else if (busy) {
    st.textContent = `${STAGE_TEXT[job.stage]} ${job.stage === "rendering" ? `${job.progress || 0}%` : ""}`;
  } else if (job.video) {
    st.classList.add("ok");
    st.textContent = `Xong! Video dài ${job.duration ? job.duration + " giây" : ""}.`;
  } else if (job.stage === "analyzing") {
    st.textContent = "Đang chờ Claude Code phân tích xong…";
  } else {
    st.textContent = "Sửa mô tả nếu muốn, rồi bấm “Tạo video”.";
  }

  const v = $("#video");
  const dl = $("#download");
  if (job.video && job.stage === "done") {
    if (lastVideo !== job.video) {
      v.src = job.video;
      lastVideo = job.video;
    }
    v.hidden = false;
    dl.hidden = false;
    dl.href = job.video.split("?")[0];
    dl.download = `${slug(plan?.title || "manga")}.mp4`;
  } else if (!job.video) {
    v.hidden = true;
    dl.hidden = true;
  }
}

function alertStatus(msg) {
  alert(msg);
}

// ---------- plan editor ----------
const shotsEl = $("#shots");
const tpl = $("#shotTpl");

$("#title").addEventListener("input", (e) => (plan.title = e.target.value));
$("#summary").addEventListener("input", (e) => (plan.summary = e.target.value));
$("#addShot").addEventListener("click", () => {
  plan.shots.push({
    description: "Mô tả chuyển động cho cảnh mới…",
    bbox: { x: 10, y: 10, w: 80, h: 40 },
    duration: 3,
    camera: { move: "push_in", amount: 0.5 },
    effects: [],
    motion: { windDir: "right", parts: [] },
    transition: "cut",
    sfx: "",
    caption: "",
  });
  sel = plan.shots.length - 1;
  renderPlan();
  shotsEl.lastElementChild.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#reanalyze").addEventListener("click", async () => {
  if (!confirm("Phân tích lại sẽ thay thế toàn bộ mô tả hiện tại. Tiếp tục?")) return;
  const res = await fetch(`/api/jobs/${job.id}/analyze`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  plan = null;
  applyJob(data);
});

function renderPlan() {
  $("#title").value = plan.title || "";
  $("#summary").value = plan.summary || "";
  shotsEl.innerHTML = "";
  plan.shots.forEach((s, i) => shotsEl.appendChild(shotCard(s, i)));
  renderBoxes();
  updateTotal();
}

function shotCard(s, i) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.style.setProperty("--c", COLORS[i % COLORS.length]);
  el.dataset.i = i;
  if (i === sel) el.classList.add("sel");
  $(".num", el).textContent = i + 1;
  const desc = $(".desc", el);
  desc.value = s.description;
  desc.addEventListener("input", () => (s.description = desc.value));
  el.addEventListener("focusin", () => select(i));
  $(".thumb", el).addEventListener("click", () => select(i));

  fillSelect($('[data-k="camera.move"]', el), LABELS.camera);
  fillSelect($('[data-k="transition"]', el), LABELS.transitions);
  fillSelect($('[data-k="motion.windDir"]', el), LABELS.wind);
  el.querySelectorAll("[data-k]").forEach((inp) => {
    inp.value = getPath(s, inp.dataset.k);
    inp.addEventListener("input", () => {
      const num = inp.type === "number" || inp.type === "range";
      setPath(s, inp.dataset.k, num ? parseFloat(inp.value) || 0 : inp.value);
      if (inp.dataset.k.startsWith("bbox")) renderBoxes();
      refreshCard(el, s);
      updateTotal();
    });
  });

  const fx = $(".fx", el);
  Object.entries(LABELS.effects).forEach(([k, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (s.effects.includes(k) ? " on" : "");
    b.textContent = label;
    if (k === "blink" && !job.hasClosedEyes) {
      b.disabled = true;
      b.title = "Cần tải lên ảnh mắt nhắm cùng ảnh chính";
    }
    b.addEventListener("click", () => {
      s.effects = s.effects.includes(k) ? s.effects.filter((e) => e !== k) : [...s.effects, k];
      b.classList.toggle("on");
      refreshCard(el, s);
    });
    fx.appendChild(b);
  });

  renderParts(el, s);
  $(".add-part", el).addEventListener("click", () => {
    if (s.motion.parts.length >= MAX_PARTS) return alert(`Mỗi cảnh có tối đa ${MAX_PARTS} bộ phận.`);
    const { x, y, w, h } = s.bbox;
    s.motion.parts.push({ type: "hair", ax: round(x + w * 0.4), ay: round(y + h * 0.3), bx: round(x + w * 0.6), by: round(y + h * 0.6), radius: 6, strength: 0.5 });
    select(i);
    renderParts(el, s);
    refreshCard(el, s);
    renderBoxes();
  });

  el.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "del") {
        if (plan.shots.length === 1) return alert("Cần ít nhất một cảnh.");
        plan.shots.splice(i, 1);
        sel = Math.min(sel, plan.shots.length - 1);
      } else {
        const j = act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= plan.shots.length) return;
        [plan.shots[i], plan.shots[j]] = [plan.shots[j], plan.shots[i]];
        sel = j;
      }
      renderPlan();
    }),
  );
  refreshCard(el, s);
  return el;
}

function renderParts(el, s) {
  const box = $(".parts", el);
  box.innerHTML = "";
  s.motion.parts.forEach((p, k) => {
    const row = document.createElement("div");
    row.className = "part";
    row.innerHTML = `
      <select title="Loại bộ phận"></select>
      <label>Độ mạnh <input data-f="strength" type="range" min="0" max="1" step="0.05" /></label>
      <label>Bán kính <input data-f="radius" type="range" min="1" max="40" step="0.5" /></label>
      <button type="button" title="Xoá">✕</button>`;
    const type = $("select", row);
    fillSelect(type, LABELS.parts);
    type.value = p.type;
    type.addEventListener("input", () => {
      p.type = type.value;
      renderBoxes();
    });
    row.querySelectorAll("[data-f]").forEach((inp) => {
      inp.value = p[inp.dataset.f];
      inp.addEventListener("input", () => {
        p[inp.dataset.f] = parseFloat(inp.value);
        renderBoxes();
      });
    });
    $("button", row).addEventListener("click", () => {
      s.motion.parts.splice(k, 1);
      renderParts(el, s);
      refreshCard(el, s);
      renderBoxes();
    });
    box.appendChild(row);
  });
}

function refreshCard(el, s) {
  const fxNames = s.effects.map((e) => LABELS.effects[e]).join(", ");
  $(".meta-line", el).textContent =
    `${s.duration}s · ${LABELS.camera[s.camera.move] || s.camera.move} · ${LABELS.transitions[s.transition] || s.transition}` +
    (fxNames ? ` · ${fxNames}` : "") + (s.motion.parts.length ? ` · ${s.motion.parts.length} bộ phận động` : "") +
    (s.sfx ? ` · “${s.sfx}”` : "");
  const t = $(".thumb", el);
  const b = s.bbox;
  t.style.backgroundImage = `url("${job.image}")`;
  t.style.backgroundSize = `${(100 / b.w) * 100}% ${(100 / b.h) * 100}%`;
  t.style.backgroundPosition = `${b.w >= 100 ? 0 : (b.x / (100 - b.w)) * 100}% ${b.h >= 100 ? 0 : (b.y / (100 - b.h)) * 100}%`;
}

function fillSelect(selEl, map) {
  selEl.innerHTML = Object.entries(map).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
}
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o) ?? "";
function setPath(o, p, v) {
  const ks = p.split(".");
  const last = ks.pop();
  ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v;
}

function select(i) {
  if (sel === i) return;
  sel = i;
  shotsEl.querySelectorAll(".shot").forEach((c) => c.classList.toggle("sel", +c.dataset.i === i));
  renderBoxes();
}

function updateTotal() {
  let t = plan.shots.reduce((a, s) => a + (+s.duration || 0), 0);
  if ($("#optIntro").checked) t += 3;
  if ($("#optOutro").checked) t += 3;
  $("#totalDur").textContent = `${plan.shots.length} cảnh · ~${Math.round(t * 10) / 10}s`;
}
$("#optIntro").addEventListener("change", updateTotal);
$("#optOutro").addEventListener("change", updateTotal);

// ---------- bbox overlay + drawing ----------
function renderBoxes() {
  const boxes = $("#boxes");
  boxes.innerHTML = "";
  if (!plan) return;
  plan.shots.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "box" + (i === sel ? " sel" : "");
    d.style.setProperty("--c", COLORS[i % COLORS.length]);
    Object.assign(d.style, { left: `${s.bbox.x}%`, top: `${s.bbox.y}%`, width: `${s.bbox.w}%`, height: `${s.bbox.h}%` });
    d.innerHTML = `<span>${i + 1}</span>`;
    d.addEventListener("mousedown", (e) => {
      if (i !== sel) {
        e.stopPropagation();
        select(i);
        shotsEl.children[i]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
    boxes.appendChild(d);
  });
  renderPartOverlay(boxes, plan.shots[sel]);
}

// Each part draws as a capsule from A to B; a round-capped line is exactly that shape.
function renderPartOverlay(boxes, s) {
  if (!s?.motion.parts.length) return;
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "part-layer");
  svg.setAttribute("viewBox", `0 0 ${job.width} ${job.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  s.motion.parts.forEach((p) => {
    const line = document.createElementNS(svgNs, "line");
    const at = { x1: (p.ax / 100) * job.width, y1: (p.ay / 100) * job.height, x2: (p.bx / 100) * job.width, y2: (p.by / 100) * job.height };
    Object.entries(at).forEach(([k, v]) => line.setAttribute(k, v));
    line.setAttribute("stroke", PART_COLORS[p.type]);
    line.setAttribute("stroke-width", ((p.radius / 100) * job.width * 2).toString());
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-opacity", "0.35");
    svg.appendChild(line);
  });
  boxes.appendChild(svg);
  s.motion.parts.forEach((p) => {
    ["a", "b"].forEach((end) => {
      const h = document.createElement("div");
      h.className = "part-handle";
      h.textContent = end.toUpperCase();
      h.style.setProperty("--c", PART_COLORS[p.type]);
      Object.assign(h.style, { left: `${p[`${end}x`]}%`, top: `${p[`${end}y`]}%` });
      h.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        partDrag = { p, end };
      });
      boxes.appendChild(h);
    });
  });
}

const wrap = $("#imgWrap");
const drawBox = $("#drawBox");
let drag = null;
let partDrag = null;
const pct = (e) => {
  const r = $("#srcImg").getBoundingClientRect();
  return {
    x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)),
    y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)),
  };
};
wrap.addEventListener("mousedown", (e) => {
  if (!plan || e.button !== 0) return;
  e.preventDefault();
  drag = pct(e);
  drawBox.hidden = false;
  Object.assign(drawBox.style, { left: `${drag.x}%`, top: `${drag.y}%`, width: 0, height: 0 });
});
window.addEventListener("mousemove", (e) => {
  if (partDrag) {
    const at = pct(e);
    partDrag.p[`${partDrag.end}x`] = round(at.x);
    partDrag.p[`${partDrag.end}y`] = round(at.y);
    return renderBoxes();
  }
  if (!drag) return;
  const p = pct(e);
  Object.assign(drawBox.style, {
    left: `${Math.min(drag.x, p.x)}%`, top: `${Math.min(drag.y, p.y)}%`,
    width: `${Math.abs(p.x - drag.x)}%`, height: `${Math.abs(p.y - drag.y)}%`,
  });
});
window.addEventListener("mouseup", (e) => {
  partDrag = null;
  if (!drag) return;
  const p = pct(e);
  const b = {
    x: round(Math.min(drag.x, p.x)), y: round(Math.min(drag.y, p.y)),
    w: round(Math.abs(p.x - drag.x)), h: round(Math.abs(p.y - drag.y)),
  };
  drag = null;
  drawBox.hidden = true;
  if (b.w < 3 || b.h < 3) return; // a click, not a drag
  const s = plan.shots[sel];
  s.bbox = b;
  const card = shotsEl.children[sel];
  card.querySelectorAll('[data-k^="bbox."]').forEach((inp) => (inp.value = getPath(s, inp.dataset.k)));
  refreshCard(card, s);
  renderBoxes();
});
const round = (n) => Math.round(n * 2) / 2;

// ---------- render ----------
$("#renderBtn").addEventListener("click", async () => {
  if (!plan) return;
  const body = {
    plan,
    options: {
      quality: $("#optQuality").value,
      intro: $("#optIntro").checked,
      outro: $("#optOutro").checked,
      sync: $("#optSync").checked,
      vary: $("#optVary").checked,
    },
  };
  $("#renderBtn").disabled = true;
  try {
    const res = await fetch(`/api/jobs/${job.id}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    applyJob(data);
  } catch (e) {
    alert(e.message);
    $("#renderBtn").disabled = false;
  }
});

const slug = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "manga";

// ---------- resume from URL ----------
const resumeId = location.hash.slice(1);
if (resumeId) {
  fetch(`/api/jobs/${resumeId}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d && applyJob(d, true));
}
