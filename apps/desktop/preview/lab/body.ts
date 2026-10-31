// The liquid body's renderer (PLX-1206): one WebGL canvas that draws rounded boxes as a signed
// distance field, joined by smooth-min so they merge and pinch apart like one liquid. The fill,
// the 1px border, and the shadow all come from the same distance, so the border always wraps the
// whole shape. Colors are the theme's, read again whenever the theme changes.

/** A rounded box, in the form's own coordinates (px from its top-left). */
export interface Box {
  x: number;
  y: number;
  hw: number;
  hh: number;
  r: number;
  /** How far, in px, it melts into the shapes before it. 0 is a hard union. */
  k: number;
  /**
   * body: the composer itself. free: a piece that's left the body, drawn with its own alpha.
   * ink0, ink1: marks drawn on the body, such as the waveform and the pill's buttons.
   */
  layer: "body" | "free" | "ink0" | "ink1";
}

export type Rgba = [number, number, number, number];

export interface Paint {
  fill: Rgba;
  border: Rgba;
  shadow: Rgba;
  /** offset y, spread, blur, in px, as `--shadow-composer` has them. */
  shadowShape: [number, number, number];
  ink0: Rgba;
  ink1: Rgba;
  /** The alpha of the free layer and of the whole body. */
  freeAlpha: number;
  alpha: number;
}

const maxBoxes = 48;
const layers = { body: 0, free: 1, ink0: 2, ink1: 3 } as const;

const vertex = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform float uDpr;
uniform vec2 uOrigin;
uniform int uN;
uniform vec4 uA[${maxBoxes}];
uniform vec4 uB[${maxBoxes}];
uniform vec4 uFill, uBorder, uShadow, uInk0, uInk1;
uniform vec3 uShadowShape;
uniform vec2 uAlpha;
out vec4 o;

float box(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
// Distance to each layer: body, free, ink0, ink1.
vec4 field(vec2 p) {
  vec4 d = vec4(1e5);
  for (int i = 0; i < ${maxBoxes}; i++) {
    if (i >= uN) break;
    vec4 a = uA[i];
    vec4 b = uB[i];
    if (a.z <= 0.01 || a.w <= 0.01) continue;
    float di = box(p - a.xy, a.zw, b.x);
    int l = int(b.z);
    if (l == 0) d.x = smin(d.x, di, b.y);
    else if (l == 1) d.y = smin(d.y, di, b.y);
    else if (l == 2) d.z = smin(d.z, di, b.y);
    else d.w = smin(d.w, di, b.y);
  }
  return d;
}
// A layer's fill with its 1px border inside the edge, premultiplied.
vec4 surface(float d) {
  float outer = clamp(0.5 - d * uDpr, 0.0, 1.0);
  float inner = clamp(0.5 - (d + 1.0) * uDpr, 0.0, 1.0);
  vec3 edge = mix(uFill.rgb, uBorder.rgb, uBorder.a);
  return vec4(uFill.rgb * inner + edge * (outer - inner), outer);
}
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
vec4 mark(float d, vec4 c) {
  float a = clamp(0.5 - d * uDpr, 0.0, 1.0) * c.a;
  return vec4(c.rgb * a, a);
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uSize.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 p = css - uOrigin;
  vec4 d = field(p);
  float ds = field(p - vec2(0.0, uShadowShape.x)).x;
  float spread = uShadowShape.y;
  float blur = uShadowShape.z;
  float s = uShadow.a * (1.0 - smoothstep(-spread - blur * 0.5, -spread + blur * 0.5, ds));
  vec4 c = vec4(uShadow.rgb * s, s);
  c = over(surface(d.x), c);
  c = over(mark(d.z, uInk0), c);
  c = over(mark(d.w, uInk1), c);
  c *= uAlpha.y;
  vec4 free = surface(d.y) * uAlpha.x;
  o = over(free, c);
}`;

/** Draws boxes on `canvas` each time `draw` is called. */
export class BodyRenderer {
  private gl: WebGL2RenderingContext;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private a = new Float32Array(maxBoxes * 4);
  private b = new Float32Array(maxBoxes * 4);

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error("lab: no WebGL2");
    this.gl = gl;
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? "lab: shader");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    for (const name of [
      "uSize",
      "uDpr",
      "uOrigin",
      "uN",
      "uA",
      "uB",
      "uFill",
      "uBorder",
      "uShadow",
      "uInk0",
      "uInk1",
      "uShadowShape",
      "uAlpha",
    ])
      this.u[name] = gl.getUniformLocation(program, name);
  }

  /** Draws `boxes` with the form's top-left at `origin` in the canvas's CSS px. */
  draw(boxes: Box[], paint: Paint, origin: [number, number]) {
    const { gl, canvas, u } = this;
    const dpr = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const n = Math.min(boxes.length, maxBoxes);
    for (let i = 0; i < n; i++) {
      const box = boxes[i]!;
      this.a.set([box.x, box.y, box.hw, box.hh], i * 4);
      this.b.set([box.r, box.k, layers[box.layer], 0], i * 4);
    }
    gl.uniform2f(u["uSize"]!, width, height);
    gl.uniform1f(u["uDpr"]!, dpr);
    gl.uniform2f(u["uOrigin"]!, origin[0], origin[1]);
    gl.uniform1i(u["uN"]!, n);
    gl.uniform4fv(u["uA"]!, this.a);
    gl.uniform4fv(u["uB"]!, this.b);
    gl.uniform4fv(u["uFill"]!, paint.fill);
    gl.uniform4fv(u["uBorder"]!, paint.border);
    gl.uniform4fv(u["uShadow"]!, paint.shadow);
    gl.uniform4fv(u["uInk0"]!, paint.ink0);
    gl.uniform4fv(u["uInk1"]!, paint.ink1);
    gl.uniform3fv(u["uShadowShape"]!, paint.shadowShape);
    gl.uniform2f(u["uAlpha"]!, paint.freeAlpha, paint.alpha);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;

/** Any CSS color, theme variables included, as 0–1 RGBA. */
export function rgba(css: string): Rgba {
  const el = document.createElement("i");
  el.style.color = css;
  document.body.append(el);
  const color = getComputedStyle(el).color;
  el.remove();
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r! / 255, g! / 255, b! / 255, a! / 255];
}

export const mix = (a: Rgba, b: Rgba, t: number): Rgba =>
  a.map((v, i) => v + (b[i]! - v) * t) as Rgba;
