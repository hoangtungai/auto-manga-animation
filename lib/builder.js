// Turns an animation plan (from Claude, edited in the UI) into a HyperFrames project.
// Everything random is seeded and baked into the HTML, so every render is identical.

export const CAMERA_MOVES = ["push_in", "pull_out", "pan_left", "pan_right", "pan_up", "pan_down", "static", "reveal", "dive", "dutch", "crash_zoom", "scan"];
export const EFFECTS = [
  "focus_lines", "speed_lines", "impact_flash", "shake", "sparkle",
  "halftone", "vignette", "red_tint", "blue_light", "light_rays", "chromatic", "film_grain", "dust", "rain", "wind", "blink",
];
export const TRANSITIONS = ["cut", "fade", "flash", "slide", "ink_wipe", "whip", "punch", "spin", "impact"];
export const PART_TYPES = ["hair", "cloth", "weapon", "body", "limb"];
export const WIND_DIRS = ["left", "right"];
const MAX_PARTS = 8;
const FAST_CUTS = ["whip", "punch", "spin", "impact"];
export const FILM_SHOT_SECONDS = 2;
// Shots tighter than this share of the image height count as close-ups.
const CLOSE_UP_HEIGHT = 45;
// Blinks stay rare: at most one in this many seconds.
const BLINK_SPACING = 5;
// Warp canvases render above output size so camera zooms stay sharp.
const WARP_SCALE = 1.4;

const RESOLUTIONS = {
  landscape: [1920, 1080],
  portrait: [1080, 1920],
  square: [1080, 1080],
};

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : lo));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function normalizePlan(plan) {
  const shots = (plan?.shots || []).map((s, i) => {
    const b = s.bbox || {};
    const x = clamp(b.x, 0, 99);
    const y = clamp(b.y, 0, 99);
    return {
      description: String(s.description || ""),
      bbox: { x, y, w: clamp(b.w, 1, 100 - x), h: clamp(b.h, 1, 100 - y) },
      duration: clamp(s.duration ?? 3, 0.5, 12),
      camera: {
        move: CAMERA_MOVES.includes(s.camera?.move) ? s.camera.move : "push_in",
        amount: clamp(s.camera?.amount ?? 0.5, 0, 1),
      },
      effects: (s.effects || []).filter((e) => EFFECTS.includes(e)),
      motion: {
        windDir: WIND_DIRS.includes(s.motion?.windDir) ? s.motion.windDir : "right",
        parts: (s.motion?.parts || []).slice(0, MAX_PARTS).map(normalizePart),
      },
      transition: TRANSITIONS.includes(s.transition) ? s.transition : i === 0 ? "fade" : "cut",
      sfx: String(s.sfx || "").slice(0, 24),
      caption: String(s.caption || "").slice(0, 160),
    };
  });
  return { title: String(plan?.title || "Manga"), summary: String(plan?.summary || ""), shots };
}

function normalizePart(p) {
  return {
    type: PART_TYPES.includes(p.type) ? p.type : "hair",
    ax: clamp(p.ax, 0, 100),
    ay: clamp(p.ay, 0, 100),
    bx: clamp(p.bx, 0, 100),
    by: clamp(p.by, 0, 100),
    radius: clamp(p.radius ?? 6, 1, 40),
    strength: clamp(p.strength ?? 0.5, 0, 1),
  };
}

// Builds index.html. `img` = { src, width, height, closedSrc?, maskSrc?, frames? }.
// `frames` (the in-betweens from the first pose to the second) switches on film mode:
// shots fill the canvas and the camera moves inside the shader.
export function buildComposition(rawPlan, img, opts = {}) {
  const plan = normalizePlan(rawPlan);
  const auto = img.height > img.width * 1.15 ? "portrait" : img.width > img.height * 1.15 ? "landscape" : "square";
  const [W, H] = RESOLUTIONS[opts.resolution] || RESOLUTIONS[auto];
  const film = (img.frames?.length ?? 0) > 1;
  const rand = mulberry32(opts.seed ?? 1234);
  const shots = [...plan.shots];
  if (opts.intro) shots.unshift(fullPageShot("fade", 3, "push_in"));
  if (opts.outro) shots.push(fullPageShot("fade", 3, "pull_out"));
  if (!shots.length) shots.push(fullPageShot("fade", 4, "push_in"));

  if (film) {
    if (opts.vary) varyFilm(shots, rand);
    shots.forEach((s) => (s.bbox = coverBox(s.bbox, img, W / H)));
  }
  const blinkShots = film ? chooseBlinks(shots) : null;
  const cutDirs = shots.map(() => pick(CUT_DIRS, rand));
  const html = [];
  const js = [];
  const motionShots = [];
  let t = 0;
  const minSide = Math.min(W, H);

  shots.forEach((s, i) => {
    const id = `s${i}`;
    const d = s.duration;
    const t0 = r2(t);
    t += d;
    // Panel frame: fit the crop's aspect inside 88% of the canvas.
    const pw = (s.bbox.w / 100) * img.width;
    const ph = (s.bbox.h / 100) * img.height;
    const fit = film ? W / pw : Math.min((W * 0.88) / pw, (H * 0.88) / ph);
    const fw = Math.round(pw * fit);
    const fh = Math.round(ph * fit);
    const imgW = r2(img.width * fit);
    const imgH = r2(img.height * fit);
    const imgL = r2(-(s.bbox.x / 100) * img.width * fit);
    const imgT = r2(-(s.bbox.y / 100) * img.height * fit);
    const fx = new Set(s.effects);
    const blink = !!img.closedSrc && (film ? blinkShots.has(s) : fx.has("blink"));
    const warped = film || blink || s.motion.parts.length > 0;
    const period = film ? r2(Math.max(1.4, (2 - 0.6 * s.camera.amount) * (0.9 + rand() * 0.25))) : 0;
    if (warped) {
      const side = rand() < 0.5 ? -1 : 1;
      const [crop, cropTo] = film ? filmCamera(s, img, W / H) : [toCrop(s.bbox), toCrop(s.bbox)];
      const next = shots[i + 1]?.transition;
      const exitDir = next && cutDirs[i + 1];
      motionShots.push({
        canvas: `${id}-warp`,
        start: t0,
        duration: r2(d),
        crop,
        cropTo,
        handheld: film,
        period,
        snap: s.camera.move === "crash_zoom",
        // Non-blinking shots start mid-swing so the poses don't all pulse in step.
        poseOffset: film && !blink ? r2(rand() * period) : 0,
        roll: film && s.camera.move === "dutch" ? [r2(-side * 0.05), r2(side * 0.1)] : [0, 0],
        rgb: fx.has("chromatic") ? 0.008 : 0,
        grain: fx.has("film_grain") ? 0.07 : 0,
        rayOrigin: [r2(0.1 + rand() * 0.8), -0.25],
        rays: film && fx.has("light_rays") ? r2(0.4 + rand() * 0.25) : 0,
        rayColor: fx.has("blue_light") ? [0.45, 0.7, 1] : [1, 0.9, 0.7],
        enter: film && FAST_CUTS.includes(s.transition) ? { type: s.transition, x: -cutDirs[i][0], y: -cutDirs[i][1] } : null,
        exit: film && FAST_CUTS.includes(next) && next !== "impact" ? { type: next, x: exitDir[0], y: exitDir[1] } : null,
        windDir: s.motion.windDir === "left" ? -1 : 1,
        blinks: blink ? blinkTimes(d, rand, period) : [],
        parts: s.motion.parts.map((p) => partUniforms(p, img, fx.has("wind"), rand)),
      });
    }

    const parts = [];
    parts.push(`<div class="bg"></div>`);
    parts.push(
      `<div id="${id}-cam" class="cam" style="width:${fw}px;height:${fh}px;left:${(W - fw) / 2}px;top:${(H - fh) / 2}px">` +
        `<div class="frame${film ? " full" : ""}"><div id="${id}-inner" class="inner">` +
        `<img src="${img.src}" alt="" style="width:${imgW}px;height:${imgH}px;left:${imgL}px;top:${imgT}px">` +
        (warped ? `<canvas id="${id}-warp" class="warp" width="${Math.round(fw * (film ? 1 : WARP_SCALE))}" height="${Math.round(fh * (film ? 1 : WARP_SCALE))}"></canvas>` : "") +
        `</div>` +
        (fx.has("halftone") ? `<div id="${id}-tone" class="tone"></div>` : "") +
        (fx.has("red_tint") ? `<div id="${id}-red" class="red"></div>` : "") +
        (fx.has("blue_light") ? `<div id="${id}-blue" class="blue"></div><div id="${id}-glow" class="blue-glow"></div>` : "") +
        `</div></div>`,
    );

    // --- camera move inside the panel ---
    const a = s.camera.amount;
    const S = r2(1.12 + 0.2 * a);
    const shiftX = r2(((S - 1) / 2) * fw * 0.9);
    const shiftY = r2(((S - 1) / 2) * fh * 0.9);
    const camFrom = { push_in: [1, 0, 0], dive: [1, 0, 0], crash_zoom: [1, 0, 0], pull_out: [S, 0, 0], reveal: [S, 0, 0], dutch: [1.04, 0, 0], scan: [S, 0, shiftY], pan_left: [S, shiftX, 0], pan_right: [S, -shiftX, 0], pan_up: [S, 0, shiftY], pan_down: [S, 0, -shiftY], static: [1.04, 0, 0] }[s.camera.move];
    const camTo = { push_in: [S, 0, 0], dive: [S, 0, 0], crash_zoom: [S, 0, 0], pull_out: [1, 0, 0], reveal: [1, 0, 0], dutch: [1.06, 0, 0], scan: [S, 0, -shiftY], pan_left: [S, -shiftX, 0], pan_right: [S, shiftX, 0], pan_up: [S, 0, -shiftY], pan_down: [S, 0, shiftY], static: [1.06, 0, 0] }[s.camera.move];
    if (!film) js.push(
      `tl.fromTo("#${id}-inner",{scale:${camFrom[0]},x:${camFrom[1]},y:${camFrom[2]}},{scale:${camTo[0]},x:${camTo[1]},y:${camTo[2]},duration:${r2(d)},ease:"sine.inOut"},${t0});`,
    );
    // Whole frame breathes slightly so even static panels feel alive.
    if (!film) js.push(`tl.fromTo("#${id}-cam",{scale:0.985},{scale:1.015,duration:${r2(d)},ease:"none"},${t0});`);

    // --- transition in ---
    if (s.transition === "fade") {
      // The first frame doubles as the thumbnail, so never start the video fully black.
      js.push(`tl.fromTo("#${id}-wrap",{opacity:${i === 0 ? 0.4 : 0}},{opacity:1,duration:0.45,ease:"power2.out"},${t0});`);
    } else if (s.transition === "flash") {
      parts.push(`<div id="${id}-tflash" class="flash"></div>`);
      js.push(`tl.fromTo("#${id}-tflash",{opacity:1},{opacity:0,duration:0.35,ease:"power2.in"},${t0});`);
    } else if (s.transition === "slide") {
      js.push(`tl.fromTo("#${id}-cam",{x:${W}},{x:0,duration:0.5,ease:"power3.out"},${t0});`);
    } else if (s.transition === "ink_wipe") {
      parts.push(`<div id="${id}-wipe" class="wipe"><i></i></div>`);
      js.push(`tl.fromTo("#${id}-wipe",{x:0},{x:${-W * 1.4},duration:0.6,ease:"power3.inOut"},${t0});`);
    }

    // --- effects ---
    if (fx.has("focus_lines")) {
      const variants = [0, 1, 2].map((v) => focusLinesSvg(W, H, rand, `${id}-fl${v}`, v === 0 ? 1 : 0));
      parts.push(...variants);
      stepCycle(js, [0, 1, 2].map((v) => `#${id}-fl${v}`), t0, d, 0.09);
    }
    if (fx.has("speed_lines")) {
      const variants = [0, 1, 2].map((v) => speedLinesSvg(W, H, rand, `${id}-sl${v}`, v === 0 ? 1 : 0));
      parts.push(...variants);
      stepCycle(js, [0, 1, 2].map((v) => `#${id}-sl${v}`), t0, d, 0.07);
    }
    if (fx.has("impact_flash")) {
      parts.push(`<div id="${id}-iflash" class="flash"></div>`);
      const at = r2(t0 + Math.min(0.35, d * 0.15));
      js.push(`tl.fromTo("#${id}-iflash",{opacity:0},{opacity:0.95,duration:0.05},${at});`);
      js.push(`tl.to("#${id}-iflash",{opacity:0,duration:0.4,ease:"power2.out"},${r2(at + 0.06)});`);
    }
    if (fx.has("shake")) {
      const start = t0 + Math.min(0.35, d * 0.15);
      const n = 10;
      for (let k = 0; k < n; k++) {
        const m = (1 - k / n) * minSide * 0.022;
        js.push(
          `tl.to("#${id}-shake",{x:${r2((rand() - 0.5) * 2 * m)},y:${r2((rand() - 0.5) * 2 * m)},rotation:${r2((rand() - 0.5) * 1.2)},duration:0.05,ease:"none"},${r2(start + k * 0.05)});`,
        );
      }
      js.push(`tl.to("#${id}-shake",{x:0,y:0,rotation:0,duration:0.08},${r2(start + n * 0.05)});`);
    }
    if (fx.has("sparkle")) {
      for (let k = 0; k < 7; k++) {
        const sx = r2((W - fw) / 2 + rand() * fw);
        const sy = r2((H - fh) / 2 + rand() * fh);
        const sz = Math.round(minSide * (0.03 + rand() * 0.04));
        const at = r2(t0 + 0.2 + rand() * Math.max(0.2, d - 1));
        parts.push(
          `<svg id="${id}-sp${k}" class="spark" width="${sz}" height="${sz}" viewBox="-10 -10 20 20" style="left:${sx - sz / 2}px;top:${sy - sz / 2}px"><path d="M0-10L2-2 10 0 2 2 0 10-2 2-10 0-2-2Z" fill="#fff" stroke="#000" stroke-width="0.6"/></svg>`,
        );
        js.push(`tl.fromTo("#${id}-sp${k}",{scale:0,rotation:0,opacity:1},{scale:1,rotation:90,duration:0.35,ease:"back.out(3)"},${at});`);
        js.push(`tl.to("#${id}-sp${k}",{scale:0,opacity:0,duration:0.35,ease:"power2.in"},${r2(at + 0.45)});`);
      }
    }
    if (fx.has("halftone")) {
      js.push(`tl.fromTo("#${id}-tone",{opacity:0.05},{opacity:0.35,duration:${r2(d / 2)},yoyo:true,repeat:1,ease:"sine.inOut"},${t0});`);
    }
    if (fx.has("red_tint")) {
      js.push(`tl.fromTo("#${id}-red",{opacity:0},{opacity:0.55,duration:${r2(Math.min(0.6, d / 3))},ease:"power2.out"},${r2(t0 + 0.2)});`);
    }
    if (fx.has("blue_light")) {
      js.push(`tl.fromTo("#${id}-blue",{opacity:0},{opacity:0.6,duration:${r2(Math.min(0.6, d / 3))},ease:"power2.out"},${r2(t0 + 0.1)});`);
      const pulse = 0.9;
      js.push(`tl.fromTo("#${id}-glow",{opacity:0.25},{opacity:0.8,duration:${pulse},yoyo:true,repeat:${Math.max(1, Math.floor(d / pulse) - 1)},ease:"sine.inOut"},${t0});`);
    }
    if (fx.has("vignette")) {
      parts.push(`<div id="${id}-vig" class="vig"></div>`);
      js.push(`tl.fromTo("#${id}-vig",{opacity:0.5},{opacity:1,duration:${r2(d)},ease:"sine.inOut"},${t0});`);
    }
    if (fx.has("dust")) {
      for (let k = 0; k < 18; k++) {
        const px = r2(rand() * W);
        const py = r2(H * (0.3 + rand() * 0.7));
        const sz = Math.round(3 + rand() * 7);
        parts.push(`<div id="${id}-du${k}" class="dust" style="left:${px}px;top:${py}px;width:${sz}px;height:${sz}px"></div>`);
        js.push(
          `tl.fromTo("#${id}-du${k}",{y:0,x:0,opacity:0},{y:${r2(-H * (0.15 + rand() * 0.3))},x:${r2((rand() - 0.5) * 120)},opacity:${r2(0.4 + rand() * 0.5)},duration:${r2(d)},ease:"none"},${t0});`,
        );
      }
    }
    if (fx.has("rain")) {
      parts.push(rainSvg(W, H, rand, `${id}-rain`));
      js.push(`tl.fromTo("#${id}-rain",{y:${-H}},{y:0,duration:${r2(Math.max(0.6, d / 4))},repeat:3,ease:"none"},${t0});`);
    }

    if (fx.has("wind")) {
      const dir = s.motion.windDir === "left" ? -1 : 1;
      const pass = 1.2;
      parts.push(windSvg(W, H, rand, `${id}-wind`));
      js.push(`tl.fromTo("#${id}-wind",{x:${dir > 0 ? -W : 0}},{x:${dir > 0 ? 0 : -W},duration:${pass},repeat:${Math.ceil(d / pass)},ease:"none"},${t0});`);
    }

    // --- SFX onomatopoeia ---
    if (s.sfx) {
      const left = rand() < 0.5;
      const fs = Math.round(minSide * (s.sfx.length > 8 ? 0.11 : 0.16));
      const rot = r2((left ? -1 : 1) * (6 + rand() * 8));
      const pos = left ? `left:${Math.round(W * 0.07)}px` : `right:${Math.round(W * 0.07)}px`;
      parts.push(`<div id="${id}-sfx" class="sfx" style="${pos};top:${Math.round(H * 0.1)}px;font-size:${fs}px">${esc(s.sfx)}</div>`);
      const at = r2(t0 + Math.min(0.3, d * 0.12));
      js.push(`tl.fromTo("#${id}-sfx",{scale:2.6,opacity:0,rotation:${rot * 2}},{scale:1,opacity:1,rotation:${rot},duration:0.3,ease:"back.out(2.5)"},${at});`);
      const hold = r2(t0 + d - 0.35 - (at + 0.3));
      if (hold > 0.1) js.push(`tl.to("#${id}-sfx",{scale:1.08,duration:${hold},ease:"sine.inOut"},${r2(at + 0.3)});`);
      js.push(`tl.to("#${id}-sfx",{opacity:0,scale:1.25,duration:0.25,ease:"power2.in"},${r2(t0 + d - 0.35)});`);
    }

    // --- caption ---
    if (s.caption) {
      const fs = Math.round(minSide * 0.042);
      parts.push(`<div id="${id}-cap" class="cap" style="font-size:${fs}px;bottom:${Math.round(H * 0.08)}px">${esc(s.caption)}</div>`);
      js.push(`tl.fromTo("#${id}-cap",{opacity:0,y:20},{opacity:1,y:0,duration:0.35,ease:"power3.out"},${r2(t0 + 0.35)});`);
      js.push(`tl.to("#${id}-cap",{opacity:0,duration:0.25},${r2(t0 + d - 0.3)});`);
    }

    html.push(
      `<div id="${id}" class="clip shot" data-start="${t0}" data-duration="${r2(d)}" data-track-index="1" style="z-index:${i + 1}">` +
        `<div id="${id}-wrap" class="wrap"><div id="${id}-shake" class="shakebox">${parts.join("")}</div></div></div>`,
    );
  });

  const total = r2(t);
  return {
    total,
    width: W,
    height: H,
    html: pageTemplate({
      W, H, total, title: plan.title, body: html.join("\n"), script: js.join("\n"),
      motion: motionShots.length
        ? { src: img.src, closedSrc: img.closedSrc, maskSrc: img.maskSrc, frames: film ? img.frames : [img.src], aspect: +(img.width / img.height).toFixed(5), shots: motionShots }
        : null,
    }),
  };
}

function fullPageShot(transition, duration, move) {
  return {
    description: "",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    duration,
    camera: { move, amount: 0.3 },
    effects: [],
    motion: { windDir: "right", parts: [] },
    transition,
    sfx: "",
    caption: "",
  };
}

// One blink per shot: a hard 4-frame swap, like limited animation; a crossfade would double-expose the eyes.
// In film mode it lands inside a pose rest (see poseAt in motion.js), clear of the fast cuts.
function blinkTimes(d, rand, period) {
  const at = period ? Math.floor(d / 2 / period) * period + 0.26 : d * (0.35 + rand() * 0.3);
  return [[r2(at), r2(at + 0.13)]];
}

const pick = (list, rand) => list[Math.floor(rand() * list.length)];
const CUT_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7]];


// Each render rolls its own mix of cuts and moves. The last shot keeps its reveal, and
// dutch angles stay rare because they lose their effect when overused.
function varyFilm(shots, rand) {
  let lastCut = null;
  let dutchUsed = false;
  shots.forEach((s, i) => {
    const last = i === shots.length - 1;
    if (i > 0 && FAST_CUTS.includes(s.transition)) {
      s.transition = pick(FAST_CUTS.filter((c) => c !== lastCut), rand);
      lastCut = s.transition;
    }
    if (!last && !["reveal", "dive"].includes(s.camera.move)) {
      const roll = rand();
      if (roll < 0.2 && !dutchUsed) {
        s.camera = { ...s.camera, move: "dutch" };
        dutchUsed = true;
      } else if (roll < 0.45) s.camera = { ...s.camera, move: "crash_zoom" };
      else if (roll < 0.55) s.camera = { ...s.camera, move: "scan" };
    }
    if (rand() < 0.35) s.effects = [...s.effects, "chromatic"];
    if (rand() < 0.3) s.effects = [...s.effects, "film_grain"];
  });
}

// Blinks go to close-ups first and keep their distance, so most shots have none.
function chooseBlinks(shots) {
  const wanted = shots.filter((s) => s.effects.includes("blink"));
  const close = wanted.filter((s) => s.bbox.h <= CLOSE_UP_HEIGHT);
  const chosen = new Set();
  let at = 0;
  let lastBlink = -Infinity;
  for (const s of shots) {
    if ((close.length ? close : wanted).includes(s) && at - lastBlink >= BLINK_SPACING) {
      chosen.add(s);
      lastBlink = at;
    }
    at += s.duration;
  }
  return chosen;
}

const toCrop = (b) => [b.x, b.y, b.w, b.h].map((n) => +(n / 100).toFixed(5));

// Grows a box to the output aspect around its centre, staying inside the image. Percentages.
function coverBox(b, img, aspect) {
  let w = Math.max((b.w / 100) * img.width, (b.h / 100) * img.height * aspect);
  w = Math.min(w, img.width, img.height * aspect);
  const h = w / aspect;
  const cx = ((b.x + b.w / 2) / 100) * img.width;
  const cy = ((b.y + b.h / 2) / 100) * img.height;
  const x = clamp(cx - w / 2, 0, img.width - w);
  const y = clamp(cy - h / 2, 0, img.height - h);
  return { x: (x / img.width) * 100, y: (y / img.height) * 100, w: (w / img.width) * 100, h: (h / img.height) * 100 };
}

function tighten(b, img, aspect) {
  if (b.w * b.h < 2500) return b;
  return coverBox({ x: b.x + b.w * 0.25, y: b.y + b.h * 0.25, w: b.w * 0.5, h: b.h * 0.5 }, img, aspect);
}

// The start and end crop of a film shot. reveal and dive travel between the shot's box and the widest view.
function filmCamera(s, img, aspect) {
  // A reveal needs somewhere to start from, even when the box already spans the image.
  const close = s.camera.move === "reveal" || s.camera.move === "dive" ? tighten(s.bbox, img, aspect) : s.bbox;
  const wide = coverBox({ ...close, x: close.x + close.w / 2 - 50, y: close.y + close.h / 2 - 50, w: 100, h: 100 }, img, aspect);
  const zoom = (f, dx = 0, dy = 0) =>
    coverBox({ x: close.x + (close.w * (1 - f)) / 2 + dx * close.w, y: close.y + (close.h * (1 - f)) / 2 + dy * close.h, w: close.w * f, h: close.h * f }, img, aspect);
  const push = 1 - 0.18 * s.camera.amount;
  const drift = 0.05 + 0.08 * s.camera.amount;
  const cx = close.x + close.w / 2 - 50;
  const band = (cy) => coverBox({ x: cx + 25, y: cy - 25, w: 50, h: 50 }, img, aspect);
  const [from, to] = {
    dutch: [zoom(0.85), zoom(0.78)],
    crash_zoom: [zoom(1 + 0.8 * s.camera.amount), zoom(0.8)],
    scan: [band(75), band(25)],
    reveal: [close, wide],
    dive: [wide, close],
    push_in: [close, zoom(push)],
    pull_out: [zoom(push), close],
    pan_left: [zoom(push, drift), zoom(push, -drift)],
    pan_right: [zoom(push, -drift), zoom(push, drift)],
    pan_up: [zoom(push, 0, drift), zoom(push, 0, -drift)],
    pan_down: [zoom(push, 0, -drift), zoom(push, 0, drift)],
    static: [close, zoom(0.97)],
  }[s.camera.move];
  return [toCrop(from), toCrop(to)];
}

// Converts a part from image percentages to shader units (image height = 1).
function partUniforms(p, img, windy, rand) {
  const aspect = img.width / img.height;
  const pt = (x, y) => [(x / 100) * aspect, y / 100];
  const soft = p.type === "hair" || p.type === "cloth";
  const base = { hair: 0.05, cloth: 0.035, weapon: 0.035, body: 0.04, limb: 0.05 }[p.type];
  const amp = base * p.strength * (soft && windy ? 1.6 : 1);
  return {
    seg: [...pt(p.ax, p.ay), ...pt(p.bx, p.by)].map((n) => +n.toFixed(5)),
    part: [PART_TYPES.indexOf(p.type), +amp.toFixed(5), +(((p.radius / 100) * aspect).toFixed(5)), r2(rand() * Math.PI * 2)],
  };
}

// Shows one variant at a time, swapping every `step` seconds (manga line flicker).
function stepCycle(js, ids, t0, d, step) {
  const n = Math.floor(d / step);
  for (let k = 0; k < n; k++) {
    const at = r2(t0 + k * step);
    ids.forEach((sel, v) => js.push(`tl.set("${sel}",{opacity:${v === k % ids.length ? 0.9 : 0}},${at});`));
  }
}

function focusLinesSvg(W, H, rand, id, op) {
  const cx = W / 2, cy = H / 2;
  const R = Math.hypot(W, H);
  const inner = Math.min(W, H) * 0.3;
  let d = "";
  for (let k = 0; k < 140; k++) {
    const ang = rand() * Math.PI * 2;
    const spread = 0.004 + rand() * 0.01;
    const r0 = inner * (0.85 + rand() * 0.7);
    const p = (a, r) => `${r2(cx + Math.cos(a) * r)} ${r2(cy + Math.sin(a) * r)}`;
    d += `M${p(ang, r0)}L${p(ang - spread, R)}L${p(ang + spread, R)}Z`;
  }
  return `<svg id="${id}" class="fx" style="opacity:${op}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="#000"/></svg>`;
}

function speedLinesSvg(W, H, rand, id, op) {
  let d = "";
  for (let k = 0; k < 70; k++) {
    const y = rand() * H;
    const x = rand() * W - W * 0.2;
    const len = W * (0.15 + rand() * 0.45);
    const th = 1 + rand() * 4;
    d += `M${r2(x)} ${r2(y)}h${r2(len)}l${r2(-len * 0.02)} ${r2(th)}h${r2(-len * 0.96)}Z`;
  }
  return `<svg id="${id}" class="fx" style="opacity:${op}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="#fff" stroke="#000" stroke-width="0.8"/></svg>`;
}

function rainSvg(W, H, rand, id) {
  let d = "";
  for (let k = 0; k < 160; k++) {
    const x = rand() * W * 1.2;
    const y = rand() * H * 2;
    const len = 30 + rand() * 60;
    d += `M${r2(x)} ${r2(y)}l${r2(-len * 0.25)} ${r2(len)}`;
  }
  return `<svg id="${id}" class="fx" width="${W}" height="${H * 2}" viewBox="0 0 ${W} ${H * 2}" style="top:${-H}px"><path d="${d}" stroke="rgba(220,235,255,.55)" stroke-width="2" fill="none"/></svg>`;
}

// Two canvas widths of faint streaks: sliding by one width repeats seamlessly.
function windSvg(W, H, rand, id) {
  const curves = [];
  for (let k = 0; k < 11; k++) {
    const x = rand() * W;
    const y = rand() * H;
    const len = W * (0.12 + rand() * 0.2);
    const bend = (rand() - 0.5) * H * 0.05;
    curves.push(`M${r2(x)} ${r2(y)}q${r2(len / 2)} ${r2(bend)} ${r2(len)} 0`, `M${r2(x + W)} ${r2(y)}q${r2(len / 2)} ${r2(bend)} ${r2(len)} 0`);
  }
  return `<svg id="${id}" class="fx" width="${W * 2}" height="${H}" viewBox="0 0 ${W * 2} ${H}"><path d="${curves.join("")}" stroke="rgba(170,205,235,.5)" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`;
}

function pageTemplate({ W, H, total, title, body, script, motion }) {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(title)}</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0d0d10; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #0d0d10; }
      .shot, .wrap, .shakebox { position: absolute; inset: 0; }
      .bg {
        position: absolute; inset: 0;
        background:
          radial-gradient(circle, rgba(255,255,255,.07) 1.6px, transparent 2px) 0 0 / 14px 14px,
          radial-gradient(ellipse at center, #26262c 0%, #0d0d10 75%);
      }
      .cam { position: absolute; }
      .frame { position: absolute; inset: 0; overflow: hidden; background: #fff; outline: 6px solid #000; box-shadow: 0 0 0 10px #f4f1ea, 0 30px 80px rgba(0,0,0,.6); }
      .frame.full { outline: none; box-shadow: none; background: #000; }
      .inner { position: absolute; inset: 0; }
      .inner img { position: absolute; max-width: none; }
      .tone { position: absolute; inset: 0; opacity: 0; mix-blend-mode: multiply;
        background: radial-gradient(circle, #000 1.4px, transparent 1.8px) 0 0 / 8px 8px; }
      .red { position: absolute; inset: 0; opacity: 0; mix-blend-mode: multiply; background: radial-gradient(ellipse at center, #ff7a6b, #a3001b); }
      .blue { position: absolute; inset: 0; opacity: 0; mix-blend-mode: multiply; background: radial-gradient(ellipse at center, #a9d4ff, #1747c9); }
      .blue-glow { position: absolute; inset: 0; opacity: 0; mix-blend-mode: screen; background: radial-gradient(ellipse at center, rgba(60,150,255,.75), rgba(20,60,200,.15) 70%); }
      .warp { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
      .fx { position: absolute; left: 0; top: 0; pointer-events: none; }
      .flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
      .wipe { position: absolute; top: -10%; left: -20%; width: 140%; height: 120%; }
      .wipe i { position: absolute; inset: 0; background: #000; transform: skewX(-12deg); }
      .vig { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.85) 100%); }
      .spark { position: absolute; }
      .dust { position: absolute; border-radius: 50%; background: #fff6d8; box-shadow: 0 0 10px #fff6d8; opacity: 0; }
      .sfx { position: absolute; font-family: "Archivo Black", "Noto Sans JP", sans-serif; font-weight: 900; color: #fff; line-height: 1;
        -webkit-text-stroke: 0.09em #000; paint-order: stroke fill; text-shadow: 0.07em 0.07em 0 #e8132b; letter-spacing: 0.02em; opacity: 0; white-space: nowrap; }
      .cap { position: absolute; left: 0; right: 0; margin: 0 auto; width: fit-content; max-width: 80%; text-align: center; font-family: "Roboto", "Noto Sans JP", sans-serif; font-weight: 700;
        color: #111; background: #fff; border: 4px solid #000; border-radius: 28px; padding: 0.45em 0.9em; line-height: 1.3; opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}">
${body}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${script}
      window.__timelines["main"] = tl;
    </script>${motion ? `
    <script>window.__motion = ${JSON.stringify(motion)};</script>
    <script src="assets/motion.js"></script>` : ""}
  </body>
</html>
`;
}
