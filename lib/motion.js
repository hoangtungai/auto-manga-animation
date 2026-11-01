// Runs inside the rendered page. Warps the source image on a canvas (hair, cloth, weapon,
// body, limbs) and swaps in the closed-eye image for blinks. Each frame is a pure function of the
// seek time, and one shared WebGL context paints every shot's 2D canvas. Film shots also
// run the camera here: the crop is resampled each frame, so close-ups stay sharp.
(() => {
  const cfg = window.__motion;
  const MAX_PARTS = 8;
  const TRANSITION_TIME = 0.22;

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vPos;
    void main() {
      vPos = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  const FRAG = `
    precision highp float;
    varying vec2 vPos;
    uniform sampler2D uOpen, uClosed, uMask;
    uniform vec4 uCrop;
    uniform float uTime, uAspect, uBlink, uWindDir, uGust, uZoom, uRays, uRoll, uInvert, uRgb, uGrain;
    uniform vec2 uBlur, uRayOrigin;
    uniform vec3 uRayColor;
    uniform int uCount;
    uniform vec4 uSeg[${MAX_PARTS}];  // ax, ay, bx, by
    uniform vec4 uPart[${MAX_PARTS}]; // kind, amplitude, radius, phase

    vec2 rot(vec2 v, float a) {
      float c = cos(a), s = sin(a);
      return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
    }

    vec3 sampleImage(vec2 q) {
      vec3 c = texture2D(uOpen, q).rgb;
      if (uBlink > 0.5) c = mix(c, texture2D(uClosed, q).rgb, texture2D(uMask, q).r);
      return c;
    }

    vec3 splitImage(vec2 q, vec2 center) {
      if (uRgb <= 0.0) return sampleImage(q);
      vec2 shift = (q - center) * uRgb;
      return vec3(sampleImage(q + shift).r, sampleImage(q).g, sampleImage(q - shift).b);
    }

    void main() {
      vec2 uv = uCrop.xy + vPos * uCrop.zw;
      vec2 scale = vec2(uAspect, 1.0);
      vec2 middle = (uCrop.xy + uCrop.zw * 0.5) * scale;
      vec2 p = middle + rot(uv * scale - middle, uRoll);
      vec2 offset = vec2(0.0);

      for (int i = 0; i < ${MAX_PARTS}; i++) {
        if (i >= uCount) break;
        vec2 a = uSeg[i].xy;
        vec2 ab = uSeg[i].zw - a;
        float len = max(length(ab), 0.0001);
        vec2 dir = ab / len;
        float s = clamp(dot(p - a, dir) / len, 0.0, 1.0);
        float dist = length(p - (a + dir * s * len));
        float kind = uPart[i].x, amp = uPart[i].y, radius = uPart[i].z, phase = uPart[i].w;
        float m = 1.0 - smoothstep(radius * 0.55, radius, dist);

        if (kind < 1.5) {
          // Hair and cloth: pinned at A, a wave travels to the free end at B.
          float tip = s * s * (3.0 - 2.0 * s);
          float ph = s * 5.0 - uTime * (kind < 0.5 ? 2.4 : 1.7) + phase;
          float wave = sin(ph) + 0.45 * sin(ph * 2.3 + 1.7);
          vec2 nor = vec2(-dir.y, dir.x);
          offset += m * tip * amp * len * (nor * wave * (0.7 + 0.3 * uGust) + vec2(uWindDir, 0.0) * 0.6 * uGust);
        } else if (kind < 2.5) {
          // Weapon: rigid rock around the grip at A.
          float ang = amp * (sin(uTime * 1.3 + phase) + 0.4 * sin(uTime * 2.9 + phase * 2.0));
          offset += m * (rot(p - a, ang) - (p - a));
        } else if (kind < 3.5) {
          // Body: slow lean around A plus breathing along the axis.
          float ang = amp * 0.35 * sin(uTime * 0.9 + phase);
          offset += m * (rot(p - a, ang) - (p - a) + dir * s * len * amp * 0.6 * sin(uTime * 1.8 + phase));
        } else {
          // Limb: swings from the joint at A and bends more toward B, like an elbow or knee.
          float ang = amp * (sin(uTime * 1.1 + phase) + 0.35 * sin(uTime * 2.3 + phase * 1.7));
          offset += m * (rot(p - a, ang * (0.35 + 0.65 * s)) - (p - a));
        }
      }

      vec2 q = (p - offset) / vec2(uAspect, 1.0);
      vec3 color;
      vec2 center = uCrop.xy + uCrop.zw * 0.5;
      if (uZoom > 0.0 || dot(uBlur, uBlur) > 0.0) {
        color = vec3(0.0);
        for (int i = 0; i < 12; i++) {
          float f = float(i) / 11.0 - 0.5;
          color += sampleImage(q + uBlur * f + (q - center) * uZoom * f);
        }
        color /= 12.0;
      } else {
        color = splitImage(q, center);
      }

      if (uRays > 0.0) {
        // Slow beams fanning from above the frame, screened over the image.
        vec2 d = vPos - uRayOrigin;
        float angle = atan(d.y, d.x);
        float beam = (0.5 + 0.5 * sin(angle * 9.0 + uTime * 0.35)) * (0.5 + 0.5 * sin(angle * 23.0 - uTime * 0.6 + 1.0));
        beam *= beam * (1.0 - smoothstep(0.1, 1.5, length(d)));
        color = 1.0 - (1.0 - color) * (1.0 - uRayColor * beam * uRays);
      }
      if (uInvert > 0.5) color = vec3(step(dot(color, vec3(0.3, 0.59, 0.11)), 0.45));
      if (uGrain > 0.0) color += uGrain * (fract(sin(dot(vPos + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453) - 0.5);
      gl_FragColor = vec4(color, 1.0);
    }`;

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => im.decode().then(() => resolve(im), () => resolve(im));
      im.onerror = () => reject(new Error(`Cannot load ${src}`));
      im.src = src;
    });

  function compile(gl) {
    const program = gl.createProgram();
    [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]].forEach(([type, src]) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    });
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    return program;
  }

  function texture(gl, unit, image, mipmap) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  async function setup() {
    const [closed, mask, ...frames] = await Promise.all(
      [cfg.closedSrc || cfg.src, cfg.maskSrc || cfg.src, ...cfg.frames].map(loadImage),
    );
    const glCanvas = document.createElement("canvas");
    const gl2 = glCanvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    const gl = gl2 || glCanvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL is unavailable");

    const program = compile(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    texture(gl, 1, closed, !!gl2);
    texture(gl, 2, mask, false);
    // Pose frames skip mipmaps: there are many of them, and the crop rarely shrinks them.
    const textures = frames.map((frame) => texture(gl, 0, frame, !!gl2 && frames.length === 1));

    const u = {};
    ["uOpen", "uClosed", "uMask", "uCrop", "uTime", "uAspect", "uBlink", "uWindDir", "uGust", "uCount", "uSeg", "uPart", "uZoom", "uRays", "uBlur", "uRayColor", "uRayOrigin", "uRoll", "uInvert", "uRgb", "uGrain"].forEach(
      (name) => (u[name] = gl.getUniformLocation(program, name)),
    );
    gl.uniform1i(u.uOpen, 0);
    gl.uniform1i(u.uClosed, 1);
    gl.uniform1i(u.uMask, 2);
    gl.uniform1f(u.uAspect, cfg.aspect);

    const shots = cfg.shots.map((s) => {
      const canvas = document.getElementById(s.canvas);
      return { ...s, ctx: canvas.getContext("2d"), width: canvas.width, height: canvas.height };
    });
    return { gl, glCanvas, u, shots, textures };
  }

  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

  // Rest in the first pose, ease to the second and back. Blinks are placed inside the rest,
  // because the closed-eye image only lines up with the first pose.
  function poseAt(t, period) {
    if (!period) return 0;
    const x = (t % period) / period;
    if (x < 0.28) return 0;
    if (x < 0.61) return easeInOut((x - 0.28) / 0.33);
    if (x < 0.67) return 1;
    return 1 - easeInOut((x - 0.67) / 0.33);
  }

  // crash_zoom slams in during the first third, then creeps; everything else eases.
  function travel(shot, t) {
    const x = t / shot.duration;
    if (shot.snap) return x < 0.3 ? 0.92 * (1 - (1 - x / 0.3) ** 3) : 0.92 + 0.08 * ((x - 0.3) / 0.7);
    return easeInOut(x);
  }

  function camera(shot, t) {
    const k = travel(shot, t);
    const crop = shot.crop.map((from, i) => from + (shot.cropTo[i] - from) * k);
    const view = { crop, blur: [0, 0], zoom: 0, roll: shot.roll[0] + (shot.roll[1] - shot.roll[0]) * k, invert: 0, rgb: shot.rgb };
    if (shot.handheld) {
      crop[0] += crop[2] * 0.004 * Math.sin(t * 1.7 + 0.4);
      crop[1] += crop[3] * 0.004 * Math.sin(t * 1.3);
    }
    const apply = (move, amount) => {
      const e = amount * amount;
      view.rgb += e * 0.03;
      if (move.type === "whip") {
        crop[0] += move.x * e * crop[2] * 0.6;
        crop[1] += move.y * e * crop[3] * 0.6;
        view.blur = [move.x * e * crop[2] * 0.5, move.y * e * crop[3] * 0.5];
      } else if (move.type === "spin") {
        view.roll += (move.x || move.y) * e * 0.7;
        view.zoom = e * 0.25;
      } else if (move.type === "impact") {
        // One or two inverted frames on the hit, then a shake that settles.
        view.invert = amount > 0.55 ? 1 : 0;
        crop[0] += crop[2] * 0.03 * e * Math.sin(t * 95);
        crop[1] += crop[3] * 0.03 * e * Math.cos(t * 77);
      } else if (move.type === "punch") {
        const scale = 1 - e * 0.35;
        crop[0] += (crop[2] * (1 - scale)) / 2;
        crop[1] += (crop[3] * (1 - scale)) / 2;
        crop[2] *= scale;
        crop[3] *= scale;
        view.zoom = e * 0.3;
      }
    };
    if (shot.enter && t < TRANSITION_TIME) apply(shot.enter, 1 - t / TRANSITION_TIME);
    if (shot.exit && t > shot.duration - TRANSITION_TIME) apply(shot.exit, 1 - (shot.duration - t) / TRANSITION_TIME);
    return view;
  }

  function draw({ gl, glCanvas, u, shots, textures }, time) {
    const shot = shots.find((s) => time >= s.start && time < s.start + s.duration);
    if (!shot) return;
    const t = time - shot.start;
    if (glCanvas.width !== shot.width || glCanvas.height !== shot.height) {
      glCanvas.width = shot.width;
      glCanvas.height = shot.height;
      gl.viewport(0, 0, shot.width, shot.height);
    }
    const view = camera(shot, t);
    // Step between frames: blending neighbours would double every line in a close-up.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[Math.round(poseAt(t + shot.poseOffset, shot.period) * (textures.length - 1))]);
    gl.uniform4fv(u.uCrop, view.crop);
    gl.uniform2fv(u.uBlur, view.blur);
    gl.uniform1f(u.uZoom, view.zoom);
    gl.uniform1f(u.uRoll, view.roll);
    gl.uniform1f(u.uInvert, view.invert);
    gl.uniform1f(u.uRgb, view.rgb);
    gl.uniform1f(u.uGrain, shot.grain);
    gl.uniform2fv(u.uRayOrigin, shot.rayOrigin);
    gl.uniform1f(u.uRays, shot.rays);
    gl.uniform3fv(u.uRayColor, shot.rayColor);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uBlink, shot.blinks.some(([from, to]) => t >= from && t < to) ? 1 : 0);
    gl.uniform1f(u.uWindDir, shot.windDir);
    gl.uniform1f(u.uGust, 0.5 + 0.5 * Math.sin(t * 0.7 + 0.6) * Math.sin(t * 1.9));
    gl.uniform1i(u.uCount, shot.parts.length);
    if (shot.parts.length) {
      gl.uniform4fv(u.uSeg, shot.parts.flatMap((p) => p.seg));
      gl.uniform4fv(u.uPart, shot.parts.flatMap((p) => p.part));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    shot.ctx.drawImage(glCanvas, 0, 0);
  }

  // Without WebGL the plain <img> under each canvas still shows, just without this motion.
  const ready = setup().catch((e) => {
    console.warn("[motion]", e);
    return null;
  });
  window.__hf = window.__hf || {};
  window.__hf.buildReady = window.__hf.buildReady || {};
  window.__hf.buildReady.motion = ready;

  window.addEventListener("hf-seek", (e) => {
    const time = e.detail.time;
    e.detail.waitUntil?.(ready.then((state) => state && draw(state, time)));
  });
  ready.then((state) => state && draw(state, 0));
})();
