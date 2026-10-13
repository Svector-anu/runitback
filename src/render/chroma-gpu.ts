import type { ChromaKeyPlan } from "#/engine/render";

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

/** Mirrors `keyPixel` in engine/render/chroma.ts constant for constant; the parity test compares the two. */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 key;
uniform vec2 unitKey;
uniform float threshold;
uniform float feather;
uniform float spill;
in vec2 uv;
out vec4 outColor;
void main() {
  vec4 c = texture(tex, uv);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float cb = dot(c.rgb, vec3(-0.168736, -0.331264, 0.5));
  float cr = dot(c.rgb, vec3(0.5, -0.418688, -0.081312));
  float scale = (max(c.r, max(c.g, c.b)) + 0.08) / 1.08;
  float d = length(vec2(cb, cr) / scale - key);
  float alpha = feather > 0.0 ? smoothstep(threshold, threshold + feather, d) : (d < threshold ? 0.0 : 1.0);
  float along = max(0.0, dot(vec2(cb, cr), unitKey));
  cb -= along * unitKey.x * spill;
  cr -= along * unitKey.y * spill;
  vec3 rgb = clamp(vec3(y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb), 0.0, 1.0);
  float a = c.a * alpha;
  outColor = vec4(rgb * a, a);
}`;

type GlCanvas = OffscreenCanvas | HTMLCanvasElement;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Chroma shader failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
  return shader;
}

/** WebGL2 chroma key. The output canvas holds the keyed layer (premultiplied); draw it back with `drawImage`. */
export class ChromaKeyGpu {
  private readonly uniforms: Record<"tex" | "key" | "unitKey" | "threshold" | "feather" | "spill", WebGLUniformLocation | null>;

  private constructor(readonly canvas: GlCanvas, private readonly gl: WebGL2RenderingContext, private readonly texture: WebGLTexture) {
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL2 could not create a program");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "pos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Chroma program failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    this.uniforms = { tex: at("tex"), key: at("key"), unitKey: at("unitKey"), threshold: at("threshold"), feather: at("feather"), spill: at("spill") };
  }

  /** Null when WebGL2 is unavailable or fails to initialise (software-only or locked-down environments). */
  static tryCreate(width: number, height: number): ChromaKeyGpu | null {
    try {
      const canvas: GlCanvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
      if (!gl) return null;
      const texture = gl.createTexture();
      if (!texture) return null;
      return new ChromaKeyGpu(canvas, gl, texture);
    } catch {
      return null;
    }
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  run(source: CanvasImageSource, plan: ChromaKeyPlan): void {
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uniforms.tex, 0);
    gl.uniform2f(this.uniforms.key, plan.keyCb, plan.keyCr);
    gl.uniform2f(this.uniforms.unitKey, plan.unitCb, plan.unitCr);
    gl.uniform1f(this.uniforms.threshold, plan.threshold);
    gl.uniform1f(this.uniforms.feather, plan.feather);
    gl.uniform1f(this.uniforms.spill, plan.spill);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
