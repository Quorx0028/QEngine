import { mat4LookAt, mat4Multiply, mat4Ortho, mat4Perspective, type Vec3Tuple } from '../math/Mat4';
import type { Scene } from '../Scene';
import type { WasmBridge } from '../wasm/WasmBridge';
import type {
  IRenderBackend,
  MaterialDesc,
  MeshGeometry,
  MeshSubmesh,
  RenderFrameMetrics,
} from './IRenderBackend';
import { composePostProcessShader, isPostProcessActive, type PostProcessConfig } from './PostProcess';
import { composeShader } from './ShaderBlocks';

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  smoothVbo: WebGLBuffer;
  jointsVbo?: WebGLBuffer;
  weightsVbo?: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  hasSkinning: boolean;
  submeshes?: MeshSubmesh[];
}

/** Averages face normals at shared positions so inverted-hull outlines never split at hard edges. */
export function computeSmoothNormals(vertices: Float32Array): Float32Array {
  const vCount = Math.floor(vertices.length / 8);
  const accum = new Map<string, [number, number, number]>();
  const keys = new Array<string>(vCount);

  for (let i = 0; i < vCount; i++) {
    const off = i * 8;
    const kx = Math.round(vertices[off] * 10000);
    const ky = Math.round(vertices[off + 1] * 10000);
    const kz = Math.round(vertices[off + 2] * 10000);
    const key = `${kx},${ky},${kz}`;
    keys[i] = key;
    const prev = accum.get(key);
    if (prev) {
      prev[0] += vertices[off + 3];
      prev[1] += vertices[off + 4];
      prev[2] += vertices[off + 5];
    } else {
      accum.set(key, [vertices[off + 3], vertices[off + 4], vertices[off + 5]]);
    }
  }

  const out = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    const sum = accum.get(keys[i])!;
    const len = Math.hypot(sum[0], sum[1], sum[2]) || 1;
    out[i * 3] = sum[0] / len;
    out[i * 3 + 1] = sum[1] / len;
    out[i * 3 + 2] = sum[2] / len;
  }
  return out;
}

interface GpuProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  globalsSamplersBound?: boolean;
}

interface StoredMaterial {
  desc: MaterialDesc;
  program: GpuProgram;
}

const SHADOW_RES = 2048;
const SPOT_SHADOW_RES = 1024;

const SHADOW_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 4) in vec4 a_joints;
layout(location = 5) in vec4 a_weights;
layout(location = 6) in vec4 a_instMat0;
layout(location = 7) in vec4 a_instMat1;
layout(location = 8) in vec4 a_instMat2;
layout(location = 9) in vec4 a_instMat3;
uniform mat4 u_model;
uniform mat4 u_lightViewProj;
uniform int u_skinned;
uniform int u_instanced;
uniform mat4 u_boneMatrices[64];
void main() {
  vec3 localPos = a_position;
  if (u_skinned == 1) {
    float wSum = a_weights.x + a_weights.y + a_weights.z + a_weights.w;
    if (wSum > 0.0001) {
      mat4 skinMat =
        a_weights.x * u_boneMatrices[clamp(int(a_joints.x + 0.5), 0, 63)] +
        a_weights.y * u_boneMatrices[clamp(int(a_joints.y + 0.5), 0, 63)] +
        a_weights.z * u_boneMatrices[clamp(int(a_joints.z + 0.5), 0, 63)] +
        a_weights.w * u_boneMatrices[clamp(int(a_joints.w + 0.5), 0, 63)];
      localPos = (skinMat * vec4(localPos, 1.0)).xyz;
    }
  }
  mat4 modelMat = (u_instanced == 1) ? mat4(a_instMat0, a_instMat1, a_instMat2, a_instMat3) : u_model;
  gl_Position = u_lightViewProj * modelMat * vec4(localPos, 1.0);
}
`;

const SHADOW_FRAG = `#version 300 es
precision highp float;
void main() {}
`;

const SKY_VERT = `#version 300 es
precision highp float;
out vec2 v_ndc;
void main() {
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_ndc = pos;
  gl_Position = vec4(pos, 0.9999, 1.0);
}
`;

const SKY_FRAG = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform vec3 u_camForward;
uniform vec3 u_camRight;
uniform vec3 u_camUp;
uniform float u_tanHalfFov;
uniform float u_aspect;
uniform vec3 u_skyTop;
uniform vec3 u_skyHorizon;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform int u_hdrOutput;
out vec4 fragColor;
void main() {
  vec3 dir = normalize(
    u_camForward +
    u_camRight * (v_ndc.x * u_aspect * u_tanHalfFov) +
    u_camUp * (v_ndc.y * u_tanHalfFov)
  );
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  float skyT = smoothstep(0.45, 0.95, h);
  vec3 topLin = pow(max(u_skyTop, vec3(0.0)), vec3(2.2));
  vec3 horLin = pow(max(u_skyHorizon, vec3(0.0)), vec3(2.2));
  vec3 col = mix(horLin, topLin, skyT);
  float sunAmt = max(dot(dir, normalize(u_lightDir)), 0.0);
  vec3 lLin = pow(max(u_lightColor, vec3(0.0)), vec3(2.2));
  float sunDisc = smoothstep(0.9992, 0.9997, sunAmt) * 4.2;
  float mieGlow = pow(sunAmt, 48.0) * 0.85 + pow(sunAmt, 7.0) * 0.22;
  col += lLin * (sunDisc + mieGlow);
  if (u_hdrOutput == 0) {
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
    float dither = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
    col = clamp(col + dither, 0.0, 1.0);
  }
  fragColor = vec4(col, 1.0);
}
`;

const OUTLINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 3) in vec3 a_smoothNormal;
layout(location = 4) in vec4 a_joints;
layout(location = 5) in vec4 a_weights;
layout(location = 6) in vec4 a_instMat0;
layout(location = 7) in vec4 a_instMat1;
layout(location = 8) in vec4 a_instMat2;
layout(location = 9) in vec4 a_instMat3;
uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform float u_outlineWidth;
uniform int u_skinned;
uniform int u_instanced;
uniform mat4 u_boneMatrices[64];
void main() {
  vec3 pos = a_position;
  vec3 nrm = a_smoothNormal;
  if (u_skinned == 1) {
    float wSum = a_weights.x + a_weights.y + a_weights.z + a_weights.w;
    if (wSum > 0.0001) {
      mat4 skinMat =
        a_weights.x * u_boneMatrices[clamp(int(a_joints.x + 0.5), 0, 63)] +
        a_weights.y * u_boneMatrices[clamp(int(a_joints.y + 0.5), 0, 63)] +
        a_weights.z * u_boneMatrices[clamp(int(a_joints.z + 0.5), 0, 63)] +
        a_weights.w * u_boneMatrices[clamp(int(a_joints.w + 0.5), 0, 63)];
      pos = (skinMat * vec4(pos, 1.0)).xyz;
      nrm = normalize(mat3(skinMat) * nrm);
    }
  }
  mat4 modelMat = (u_instanced == 1) ? mat4(a_instMat0, a_instMat1, a_instMat2, a_instMat3) : u_model;
  vec4 world = modelMat * vec4(pos + nrm * u_outlineWidth, 1.0);
  gl_Position = u_viewProj * world;
}
`;

const OUTLINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 u_outlineColor;
uniform int u_hdrOutput;
out vec4 fragColor;
void main() {
  vec3 c = (u_hdrOutput == 1) ? pow(max(u_outlineColor, vec3(0.0)), vec3(2.2)) : u_outlineColor;
  fragColor = vec4(c, 1.0);
}
`;

const SPRITE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_quadPos;
layout(location = 1) in vec4 a_posSize;
layout(location = 2) in vec4 a_rotZ;
layout(location = 3) in vec4 a_uvRect;
layout(location = 4) in vec4 a_color;

uniform mat4 u_viewProj;
out vec2 v_uv;
out vec4 v_color;

void main() {
  float c = cos(a_rotZ.y);
  float s = sin(a_rotZ.y);
  vec2 scaled = a_quadPos * a_posSize.zw;
  vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
  vec3 world = vec3(a_posSize.xy + rotated, a_rotZ.x);
  vec2 t = a_quadPos + 0.5;
  v_uv = mix(a_uvRect.xy, a_uvRect.zw, t);
  v_color = a_color;
  gl_Position = u_viewProj * vec4(world, 1.0);
}
`;

const SPRITE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
uniform int u_hasTexture;
uniform sampler2D u_tex;
uniform int u_hdrOutput;
out vec4 fragColor;
void main() {
  vec4 texel = u_hasTexture == 1 ? texture(u_tex, v_uv) : vec4(1.0);
  vec4 outCol = texel * v_color;
  if (outCol.a < 0.01) discard;
  if (u_hdrOutput == 1) {
    outCol.rgb = pow(max(outCol.rgb, vec3(0.0)), vec3(2.2));
  }
  fragColor = outCol;
}
`;

const VFX_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_quadPos;
layout(location = 1) in vec4 a_pPosSize;
layout(location = 2) in vec4 a_pCol;
layout(location = 3) in vec4 a_pVelStretch;

uniform mat4 u_viewProj;
uniform vec3 u_camRight;
uniform vec3 u_camUp;

out vec2 v_uv;
out vec4 v_color;

void main() {
  float size = a_pPosSize.w;
  vec3 worldPos = a_pPosSize.xyz;
  float stretch = a_pVelStretch.w;
  vec3 vel = a_pVelStretch.xyz;
  float speed = length(vel);
  if (stretch > 0.005 && speed > 0.25) {
    vec3 dir = vel / speed;
    vec3 camForward = cross(u_camRight, u_camUp);
    vec3 side = cross(dir, camForward);
    if (dot(side, side) < 0.001) side = u_camRight;
    else side = normalize(side);
    float lenScale = size * (1.0 + min(speed * stretch * 0.16, 4.5));
    worldPos += side * (a_quadPos.x * size * 0.55) + dir * (a_quadPos.y * lenScale);
  } else {
    worldPos += (u_camRight * a_quadPos.x + u_camUp * a_quadPos.y) * size;
  }
  v_uv = a_quadPos * 2.0;
  v_color = a_pCol;
  gl_Position = u_viewProj * vec4(worldPos, 1.0);
}
`;

const VFX_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
uniform int u_hdrOutput;
uniform int u_additive;
out vec4 fragColor;

void main() {
  float d = length(v_uv);
  if (d >= 1.0) discard;
  float soft = (u_additive == 1)
    ? pow(max(1.0 - d, 0.0), 2.2)
    : smoothstep(1.0, 0.15, d);
  vec3 col = (u_hdrOutput == 1) ? pow(max(v_color.rgb, vec3(0.0)), vec3(2.2)) : v_color.rgb;
  if (u_additive == 1) {
    col *= (1.0 + pow(max(1.0 - d, 0.0), 3.0) * 1.6);
  }
  float a = v_color.a * soft;
  if (a < 0.005) discard;
  fragColor = vec4(col, a);
}
`;

const LIGHT2D_VERT = `#version 300 es
precision highp float;
uniform vec2 u_camCenter;
uniform vec2 u_camHalfSize;
out vec2 v_worldPos;
void main() {
  vec2 ndc = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_worldPos = u_camCenter + ndc * u_camHalfSize;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const LIGHT2D_FRAG = `#version 300 es
precision highp float;
in vec2 v_worldPos;
uniform vec3 u_ambient2d;
uniform int u_light2dCount;
uniform vec2 u_light2dPos[16];
uniform vec3 u_light2dColor[16];
uniform float u_light2dRadius[16];
out vec4 fragColor;
void main() {
  vec3 acc = u_ambient2d;
  for (int i = 0; i < 16; i++) {
    if (i >= u_light2dCount) break;
    float r = max(u_light2dRadius[i], 0.05);
    float d = length(v_worldPos - u_light2dPos[i]);
    if (d < r) {
      float t = 1.0 - d / r;
      acc += u_light2dColor[i] * (t * t);
    }
  }
  fragColor = vec4(clamp(acc, 0.0, 2.0), 1.0);
}
`;

const DEBUG_LINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;
uniform mat4 u_viewProj;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

const DEBUG_LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}
`;

export class WebGL2Backend implements IRenderBackend {
  private readonly gl: WebGL2RenderingContext;
  private readonly meshes = new Map<number, GpuMesh>();
  private readonly materials = new Map<number, StoredMaterial>();
  private readonly textures = new Map<number, WebGLTexture>();
  private readonly programCache = new Map<string, GpuProgram>();
  private readonly modelScratch = new Float32Array(16);
  private readonly lightProjMat = new Float32Array(16);
  private readonly lightViewMat = new Float32Array(16);
  private readonly lightVpMat = new Float32Array(16);
  private readonly spotVpMat = new Float32Array(16);
  private readonly frameUboScratch = new Float32Array(160);
  private frameGlobalsUbo: WebGLBuffer;
  private uboBound = false;
  private readonly parallelCompileExt: { COMPLETION_STATUS_KHR: number } | null;
  private readonly boundTexByUnit = new Int32Array(8).fill(-1);
  private frameInstancedRuns = 0;
  private frameInstancedObjects = 0;
  private frameSkippedMatBinds = 0;
  private instVbo: WebGLBuffer;
  private instScratch = new Float32Array(16 * 512);
  private readonly bonePaletteScratch = new Float32Array(16 * 64);

  private nextMeshId = 1;
  private nextMaterialId = 1;
  private nextTextureId = 1;

  private shadowFbo: WebGLFramebuffer;
  private shadowDepthTex: WebGLTexture;
  private spotShadowFbo: WebGLFramebuffer;
  private spotShadowDepthTex: WebGLTexture;
  private spotShadowActive = false;
  private shadowProgram: GpuProgram;
  private skyProgram: GpuProgram;
  private skyVao: WebGLVertexArrayObject;
  private outlineProgram: GpuProgram;
  private spriteProgram: GpuProgram;
  private light2dProgram: GpuProgram;
  private debugLineProgram: GpuProgram;
  private debugLineVao: WebGLVertexArrayObject;
  private debugLineVbo: WebGLBuffer;
  private debugLineScratch = new Float32Array(7 * 2 * 1024);
  private spriteVao: WebGLVertexArrayObject;
  private spriteQuadVbo: WebGLBuffer;
  private spriteInstVbo: WebGLBuffer;
  private spriteInstScratch = new Float32Array(16 * 128);
  private vfxProgram: GpuProgram;
  private vfxVao: WebGLVertexArrayObject;
  private vfxInstVbo: WebGLBuffer;
  private readonly light2dPosScratch = new Float32Array(32);
  private readonly light2dColScratch = new Float32Array(48);
  private readonly light2dRadScratch = new Float32Array(16);

  private ppBrightProgram: GpuProgram;
  private ppBlurProgram: GpuProgram;
  private ppCompositeProgram: GpuProgram;
  private supportsFloatFbo = false;
  private hdrActive = false;
  private ppWidth = 0;
  private ppHeight = 0;
  private sceneFbo: WebGLFramebuffer | null = null;
  private sceneColorTex: WebGLTexture | null = null;
  private sceneDepthTex: WebGLTexture | null = null;
  private bloomFboA: WebGLFramebuffer | null = null;
  private bloomTexA: WebGLTexture | null = null;
  private bloomFboB: WebGLFramebuffer | null = null;
  private bloomTexB: WebGLTexture | null = null;
  private dummyBlackTex: WebGLTexture;
  private dummyWhiteTex: WebGLTexture;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('WebGL2 context is unavailable on this browser/device');
    }
    this.gl = gl;
    this.supportsFloatFbo = Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.parallelCompileExt = gl.getExtension('KHR_parallel_shader_compile') as {
      COMPLETION_STATUS_KHR: number;
    } | null;
    this.frameGlobalsUbo = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameGlobalsUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.frameUboScratch.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameGlobalsUbo);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    this.uboBound = true;
    this.shadowProgram = this.compileProgram('__shadow__', SHADOW_VERT, SHADOW_FRAG);
    this.skyProgram = this.compileProgram('__sky__', SKY_VERT, SKY_FRAG);
    this.outlineProgram = this.compileProgram('__outline__', OUTLINE_VERT, OUTLINE_FRAG);
    this.spriteProgram = this.compileProgram('__sprite2d__', SPRITE_VERT, SPRITE_FRAG);
    this.vfxProgram = this.compileProgram('__vfx__', VFX_VERT, VFX_FRAG);
    this.light2dProgram = this.compileProgram('__light2d__', LIGHT2D_VERT, LIGHT2D_FRAG);
    this.debugLineProgram = this.compileProgram('__debug_lines__', DEBUG_LINE_VERT, DEBUG_LINE_FRAG);
    this.debugLineVao = gl.createVertexArray()!;
    this.debugLineVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.debugLineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.debugLineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.debugLineScratch, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);

    const ppSrc = composePostProcessShader();
    this.ppBrightProgram = this.compileProgram('__pp_bright__', ppSrc.vertexSource, ppSrc.brightFragmentSource);
    this.ppBlurProgram = this.compileProgram('__pp_blur__', ppSrc.vertexSource, ppSrc.blurFragmentSource);
    this.ppCompositeProgram = this.compileProgram('__pp_comp__', ppSrc.vertexSource, ppSrc.fragmentSource);

    const blackTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.dummyBlackTex = blackTex;

    const whiteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.dummyWhiteTex = whiteTex;

    const sDepth = this.createDepthFbo(SHADOW_RES);
    this.shadowFbo = sDepth.fbo;
    this.shadowDepthTex = sDepth.tex;

    const spotDepth = this.createDepthFbo(SPOT_SHADOW_RES);
    this.spotShadowFbo = spotDepth.fbo;
    this.spotShadowDepthTex = spotDepth.tex;

    this.instVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instScratch, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.skyVao = gl.createVertexArray()!;

    const vao = gl.createVertexArray()!;
    const quadVbo = gl.createBuffer()!;
    const instVbo = gl.createBuffer()!;
    this.spriteVao = vao;
    this.spriteQuadVbo = quadVbo;
    this.spriteInstVbo = instVbo;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteInstScratch.byteLength, gl.DYNAMIC_DRAW);
    const stride = 16 * 4;
    for (let loc = 1; loc <= 4; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, (loc - 1) * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    this.vfxVao = gl.createVertexArray()!;
    this.vfxInstVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vfxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vfxInstVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 48 * 512, gl.DYNAMIC_DRAW);
    for (let loc = 1; loc <= 3; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 48, (loc - 1) * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  private createDepthFbo(res: number): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, res, res, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, tex };
  }

  private compileProgram(key: string, vsSrc: string, fsSrc: string): GpuProgram {
    const existing = this.programCache.get(key);
    if (existing) return existing;
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Shader link failed (${key}): ${log}`);
    }
    const blockIdx = gl.getUniformBlockIndex(prog, 'FrameGlobals');
    if (blockIdx !== gl.INVALID_INDEX) {
      gl.uniformBlockBinding(prog, blockIdx, 0);
    }
    const gpuProg: GpuProgram = { program: prog, uniforms: new Map() };
    this.programCache.set(key, gpuProg);
    return gpuProg;
  }

  /** Pre-compiles shader variants in a parallel link wave so runtime spawns avoid compile hitches. */
  warmupMaterials(descs: MaterialDesc[]): number {
    const gl = this.gl;
    // Queue all compiles + links before querying link status so KHR_parallel_shader_compile runs in parallel.
    const _hasParallel = Boolean(this.parallelCompileExt);
    void _hasParallel;
    const pending: Array<{
      key: string;
      prog: WebGLProgram;
      vs: WebGLShader;
      fs: WebGLShader;
    }> = [];
    const seen = new Set<string>();

    for (const desc of descs) {
      const composed = composeShader({
        blocks: desc.blocks,
        customVertexSnippet: desc.customVertexSnippet,
        customFragmentSnippet: desc.customFragmentSnippet,
      });
      if (this.programCache.has(composed.cacheKey) || seen.has(composed.cacheKey)) {
        continue;
      }
      seen.add(composed.cacheKey);
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, composed.vertexSource);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, composed.fragmentSource);
      gl.compileShader(fs);
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      pending.push({ key: composed.cacheKey, prog, vs, fs });
    }

    for (const item of pending) {
      if (!gl.getShaderParameter(item.vs, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(item.vs);
        gl.deleteShader(item.vs);
        gl.deleteShader(item.fs);
        gl.deleteProgram(item.prog);
        throw new Error(`GLSL vertex warmup error (${item.key}): ${log}`);
      }
      if (!gl.getShaderParameter(item.fs, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(item.fs);
        gl.deleteShader(item.vs);
        gl.deleteShader(item.fs);
        gl.deleteProgram(item.prog);
        throw new Error(`GLSL fragment warmup error (${item.key}): ${log}`);
      }
      gl.deleteShader(item.vs);
      gl.deleteShader(item.fs);
      if (!gl.getProgramParameter(item.prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(item.prog);
        gl.deleteProgram(item.prog);
        throw new Error(`Shader warmup link failed (${item.key}): ${log}`);
      }
      const blockIdx = gl.getUniformBlockIndex(item.prog, 'FrameGlobals');
      if (blockIdx !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(item.prog, blockIdx, 0);
      }
      this.programCache.set(item.key, { program: item.prog, uniforms: new Map() });
    }
    return pending.length;
  }

  getRenderMetrics(): RenderFrameMetrics {
    return {
      instancedRuns: this.frameInstancedRuns,
      instancedObjects: this.frameInstancedObjects,
      skippedMaterialBinds: this.frameSkippedMatBinds,
      shaderCount: this.programCache.size,
      uboBound: this.uboBound,
    };
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`GLSL compile error: ${log}\n${source}`);
    }
    return shader;
  }

  private uLoc(prog: GpuProgram, name: string): WebGLUniformLocation | null {
    if (!prog.uniforms.has(name)) {
      prog.uniforms.set(name, this.gl.getUniformLocation(prog.program, name));
    }
    return prog.uniforms.get(name) ?? null;
  }

  createMesh(geom: MeshGeometry): number {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    const smoothVbo = gl.createBuffer()!;
    const ibo = gl.createBuffer()!;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geom.vertices, gl.STATIC_DRAW);

    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);

    const smoothNormals = computeSmoothNormals(geom.vertices);
    gl.bindBuffer(gl.ARRAY_BUFFER, smoothVbo);
    gl.bufferData(gl.ARRAY_BUFFER, smoothNormals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 12, 0);

    const vCount = Math.floor(geom.vertices.length / 8);
    let jointsVbo: WebGLBuffer | undefined;
    let weightsVbo: WebGLBuffer | undefined;
    let hasSkinning = false;
    if (geom.joints && geom.weights && geom.joints.length >= vCount * 4 && geom.weights.length >= vCount * 4) {
      jointsVbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, jointsVbo);
      gl.bufferData(gl.ARRAY_BUFFER, geom.joints, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 4, gl.UNSIGNED_SHORT, false, 8, 0);

      weightsVbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, weightsVbo);
      gl.bufferData(gl.ARRAY_BUFFER, geom.weights, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 16, 0);
      hasSkinning = true;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
    for (let loc = 6; loc <= 9; loc++) {
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, (loc - 6) * 16);
      gl.vertexAttribDivisor(loc, 1);
      gl.disableVertexAttribArray(loc);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    const id = this.nextMeshId++;
    this.meshes.set(id, {
      vao,
      vbo,
      smoothVbo,
      jointsVbo,
      weightsVbo,
      ibo,
      indexCount: geom.indices.length,
      hasSkinning,
      submeshes: geom.submeshes,
    });
    return id;
  }

  updateMeshVertices(meshId: number, vertices: Float32Array): void {
    const mesh = this.meshes.get(meshId);
    if (!mesh) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  disposeMesh(meshId: number): void {
    const mesh = this.meshes.get(meshId);
    if (!mesh) return;
    this.gl.deleteVertexArray(mesh.vao);
    this.gl.deleteBuffer(mesh.vbo);
    this.gl.deleteBuffer(mesh.smoothVbo);
    if (mesh.jointsVbo) this.gl.deleteBuffer(mesh.jointsVbo);
    if (mesh.weightsVbo) this.gl.deleteBuffer(mesh.weightsVbo);
    this.gl.deleteBuffer(mesh.ibo);
    this.meshes.delete(meshId);
  }

  createMaterial(desc: MaterialDesc): number {
    const composed = composeShader({
      blocks: desc.blocks,
      customVertexSnippet: desc.customVertexSnippet,
      customFragmentSnippet: desc.customFragmentSnippet,
    });
    const program = this.compileProgram(composed.cacheKey, composed.vertexSource, composed.fragmentSource);
    const id = this.nextMaterialId++;
    this.materials.set(id, {
      desc: {
        ...desc,
        blocks: [...desc.blocks],
        uniforms: { ...desc.uniforms },
      },
      program,
    });
    return id;
  }

  updateMaterial(materialId: number, patch: Partial<MaterialDesc>): void {
    const mat = this.materials.get(materialId);
    if (!mat) return;
    const nextDesc: MaterialDesc = {
      ...mat.desc,
      ...patch,
      blocks: patch.blocks ? [...patch.blocks] : mat.desc.blocks,
      uniforms: patch.uniforms ? { ...mat.desc.uniforms, ...patch.uniforms } : mat.desc.uniforms,
    };
    const composed = composeShader({
      blocks: nextDesc.blocks,
      customVertexSnippet: nextDesc.customVertexSnippet,
      customFragmentSnippet: nextDesc.customFragmentSnippet,
    });
    mat.program = this.compileProgram(composed.cacheKey, composed.vertexSource, composed.fragmentSource);
    mat.desc = nextDesc;
  }

  disposeMaterial(materialId: number): void {
    this.materials.delete(materialId);
  }

  createTexture(width: number, height: number, pixels: Uint8Array, pixelated = false): number {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (pixelated) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const id = this.nextTextureId++;
    this.textures.set(id, tex);
    return id;
  }

  disposeTexture(textureId: number): void {
    const tex = this.textures.get(textureId);
    if (!tex) return;
    this.gl.deleteTexture(tex);
    this.textures.delete(textureId);
  }

  private ensurePostProcessFbos(w: number, h: number): void {
    if (this.ppWidth === w && this.ppHeight === h && this.sceneFbo) return;
    this.disposePostProcessFbos();
    const gl = this.gl;
    this.ppWidth = w;
    this.ppHeight = h;

    const makeColorTex = (tw: number, th: number) => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.supportsFloatFbo) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };

    const sColor = makeColorTex(w, h);
    const sDepth = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, sDepth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const sFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sDepth, 0);

    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    const bTexA = makeColorTex(hw, hh);
    const bFboA = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bFboA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bTexA, 0);

    const bTexB = makeColorTex(hw, hh);
    const bFboB = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bFboB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bTexB, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.sceneFbo = sFbo;
    this.sceneColorTex = sColor;
    this.sceneDepthTex = sDepth;
    this.bloomFboA = bFboA;
    this.bloomTexA = bTexA;
    this.bloomFboB = bFboB;
    this.bloomTexB = bTexB;
  }

  private disposePostProcessFbos(): void {
    const gl = this.gl;
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.sceneColorTex) gl.deleteTexture(this.sceneColorTex);
    if (this.sceneDepthTex) gl.deleteTexture(this.sceneDepthTex);
    if (this.bloomFboA) gl.deleteFramebuffer(this.bloomFboA);
    if (this.bloomTexA) gl.deleteTexture(this.bloomTexA);
    if (this.bloomFboB) gl.deleteFramebuffer(this.bloomFboB);
    if (this.bloomTexB) gl.deleteTexture(this.bloomTexB);
    this.sceneFbo = null;
    this.sceneColorTex = null;
    this.sceneDepthTex = null;
    this.bloomFboA = null;
    this.bloomTexA = null;
    this.bloomFboB = null;
    this.bloomTexB = null;
  }

  renderFrame(bridge: WasmBridge, scene: Scene, aspect: number, timeSec: number): number {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    this.frameInstancedRuns = 0;
    this.frameInstancedObjects = 0;
    this.frameSkippedMatBinds = 0;
    let drawCalls = 0;

    if (scene.camera.mode === '3d' && scene.shadowsEnabled) {
      drawCalls += this.renderShadowPass(bridge, scene);
      drawCalls += this.renderSpotShadowPass(bridge, scene);
    } else {
      this.spotShadowActive = false;
    }

    const uwDepth = scene.camera.mode === '3d' ? scene.getUnderwaterDepth(scene.camera.position) : 0;
    const underwaterFactor = uwDepth > 0 ? Math.min(1, 0.55 + uwDepth * 0.45) : 0;
    const usePp = isPostProcessActive(scene.postProcess) || underwaterFactor > 0.001;
    this.hdrActive = usePp && this.supportsFloatFbo;
    if (usePp) {
      this.ensurePostProcessFbos(canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    if (this.hdrActive) {
      gl.clearColor(
        Math.pow(Math.max(scene.fogColor[0], 0), 2.2),
        Math.pow(Math.max(scene.fogColor[1], 0), 2.2),
        Math.pow(Math.max(scene.fogColor[2], 0), 2.2),
        1.0
      );
    } else {
      gl.clearColor(scene.fogColor[0], scene.fogColor[1], scene.fogColor[2], 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { viewProj } = scene.computeCameraMatrices(aspect);

    if (scene.camera.mode === '3d') {
      drawCalls += this.renderSkyPass(scene, aspect);
      drawCalls += this.render3DPass(bridge, scene, viewProj, timeSec);
    }
    drawCalls += this.render2DPass(bridge, scene, viewProj, aspect);
    drawCalls += this.renderGpuParticlesPass(bridge, scene, viewProj);
    if (scene.debugPhysics && scene.camera.mode === '3d') {
      drawCalls += this.renderDebugLinesPass(scene, viewProj);
    }

    if (usePp) {
      drawCalls += this.renderPostProcess(canvas.width, canvas.height, scene.postProcess, timeSec, underwaterFactor);
    }
    return drawCalls;
  }

  private renderDebugLinesPass(scene: Scene, viewProj: Float32Array): number {
    const raw = scene.getPhysicsDebugLines();
    if (raw.length < 10) return 0;
    const segCount = Math.floor(raw.length / 10);
    const neededFloats = segCount * 14;
    if (this.debugLineScratch.length < neededFloats) {
      this.debugLineScratch = new Float32Array(Math.max(neededFloats, this.debugLineScratch.length * 2));
    }
    const buf = this.debugLineScratch;
    let w = 0;
    for (let i = 0; i < segCount * 10; i += 10) {
      const r = raw[i + 6];
      const g = raw[i + 7];
      const b = raw[i + 8];
      const a = raw[i + 9];
      buf[w++] = raw[i];
      buf[w++] = raw[i + 1];
      buf[w++] = raw[i + 2];
      buf[w++] = r;
      buf[w++] = g;
      buf[w++] = b;
      buf[w++] = a;
      buf[w++] = raw[i + 3];
      buf[w++] = raw[i + 4];
      buf[w++] = raw[i + 5];
      buf[w++] = r;
      buf[w++] = g;
      buf[w++] = b;
      buf[w++] = a;
    }
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.debugLineProgram.program);
    gl.uniformMatrix4fv(this.uLoc(this.debugLineProgram, 'u_viewProj'), false, viewProj);
    gl.bindVertexArray(this.debugLineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.debugLineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, w), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, segCount * 2);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    return 1;
  }

  private renderPostProcess(
    w: number,
    h: number,
    pp: PostProcessConfig,
    timeSec: number,
    underwaterFactor = 0
  ): number {
    const gl = this.gl;
    let calls = 0;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.skyVao);

    let bloomTexToBind = this.dummyBlackTex;
    if (pp.bloomIntensity > 0.001 && this.bloomFboA && this.bloomFboB && this.bloomTexA && this.bloomTexB) {
      const hw = Math.max(1, Math.floor(w / 2));
      const hh = Math.max(1, Math.floor(h / 2));
      gl.viewport(0, 0, hw, hh);

      // Extract bright areas
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboA);
      gl.useProgram(this.ppBrightProgram.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneColorTex);
      gl.uniform1i(this.uLoc(this.ppBrightProgram, 'u_sceneTex'), 0);
      gl.uniform1f(this.uLoc(this.ppBrightProgram, 'u_bloomThreshold'), pp.bloomThreshold);
      gl.uniform1i(this.uLoc(this.ppBrightProgram, 'u_hdrInput'), this.hdrActive ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      calls++;

      // Horizontal blur -> B
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboB);
      gl.useProgram(this.ppBlurProgram.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTexA);
      gl.uniform1i(this.uLoc(this.ppBlurProgram, 'u_tex'), 0);
      gl.uniform2f(this.uLoc(this.ppBlurProgram, 'u_dir'), 1.0, 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      calls++;

      // Vertical blur -> A
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTexB);
      gl.uniform2f(this.uLoc(this.ppBlurProgram, 'u_dir'), 0.0, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      calls++;

      bloomTexToBind = this.bloomTexA;
    }

    // Final composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.ppCompositeProgram.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneColorTex);
    gl.uniform1i(this.uLoc(this.ppCompositeProgram, 'u_sceneTex'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneDepthTex);
    gl.uniform1i(this.uLoc(this.ppCompositeProgram, 'u_depthTex'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bloomTexToBind);
    gl.uniform1i(this.uLoc(this.ppCompositeProgram, 'u_bloomTex'), 2);

    gl.uniform2f(this.uLoc(this.ppCompositeProgram, 'u_resolution'), w, h);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_time'), timeSec);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_bloomIntensity'), pp.bloomIntensity);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_screenOutline'), pp.screenOutline);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_ssao'), pp.ssao);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_pixelSize'), pp.pixelSize);
    gl.uniform1i(this.uLoc(this.ppCompositeProgram, 'u_crt'), pp.crt ? 1 : 0);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_chromatic'), pp.chromaticAberration);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_vignette'), pp.vignette);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_grain'), pp.filmGrain);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_wave'), pp.waveStrength);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_saturation'), pp.saturation);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_noir'), pp.noir);
    gl.uniform1i(this.uLoc(this.ppCompositeProgram, 'u_hdrInput'), this.hdrActive ? 1 : 0);
    gl.uniform1f(this.uLoc(this.ppCompositeProgram, 'u_underwater'), underwaterFactor);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    calls++;

    // Unbind FBO textures so next frame's FBO attachments never trigger WebGL2 feedback loops
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindVertexArray(null);
    gl.depthMask(true);
    return calls;
  }

  private renderSkyPass(scene: Scene, aspect: number): number {
    const gl = this.gl;
    const camPos = scene.camera.position;
    const camTgt = scene.camera.target;
    let fx = camTgt[0] - camPos[0];
    let fy = camTgt[1] - camPos[1];
    let fz = camTgt[2] - camPos[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;

    // right = normalize(forward x up)
    const up = scene.camera.up;
    let rx = fy * up[2] - fz * up[1];
    let ry = fz * up[0] - fx * up[2];
    let rz = fx * up[1] - fy * up[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;

    // camUp = right x forward
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.skyProgram.program);
    gl.uniform3f(this.uLoc(this.skyProgram, 'u_camForward'), fx, fy, fz);
    gl.uniform3f(this.uLoc(this.skyProgram, 'u_camRight'), rx, ry, rz);
    gl.uniform3f(this.uLoc(this.skyProgram, 'u_camUp'), ux, uy, uz);
    gl.uniform1f(
      this.uLoc(this.skyProgram, 'u_tanHalfFov'),
      Math.tan(((scene.camera.fovDeg * Math.PI) / 180) * 0.5)
    );
    gl.uniform1f(this.uLoc(this.skyProgram, 'u_aspect'), aspect);
    gl.uniform3fv(this.uLoc(this.skyProgram, 'u_skyTop'), scene.skyTopColor);
    gl.uniform3fv(this.uLoc(this.skyProgram, 'u_skyHorizon'), scene.skyHorizonColor);
    gl.uniform3fv(this.uLoc(this.skyProgram, 'u_lightDir'), scene.light.direction);
    gl.uniform3fv(this.uLoc(this.skyProgram, 'u_lightColor'), scene.light.color);
    gl.uniform1i(this.uLoc(this.skyProgram, 'u_hdrOutput'), this.hdrActive ? 1 : 0);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    return 1;
  }

  private renderShadowPass(bridge: WasmBridge, scene: Scene): number {
    const gl = this.gl;
    const cmds = bridge.getRender3DView();
    if (cmds.length === 0) return 0;
    const matrices = bridge.getWorldMatricesView();

    const ld = scene.light.direction;
    const len = Math.hypot(ld[0], ld[1], ld[2]) || 1;
    const dir: Vec3Tuple = [ld[0] / len, ld[1] / len, ld[2] / len];

    // Snap shadow center to texel grid around camera target to eliminate shimmer
    const halfSize = 26;
    const texelWorld = (halfSize * 2) / SHADOW_RES;
    const cx = Math.round(scene.camera.target[0] / texelWorld) * texelWorld;
    const cz = Math.round(scene.camera.target[2] / texelWorld) * texelWorld;
    const center: Vec3Tuple = [cx, 0, cz];
    const lightEye: Vec3Tuple = [center[0] + dir[0] * 36, center[1] + dir[1] * 36, center[2] + dir[2] * 36];

    mat4Ortho(-halfSize, halfSize, -halfSize, halfSize, 1.0, 90.0, this.lightProjMat);
    mat4LookAt(lightEye, center, [0, 1, 0], this.lightViewMat);
    mat4Multiply(this.lightProjMat, this.lightViewMat, this.lightVpMat);

    // Ensure shadowDepthTex is not bound to any texture unit before attaching shadowFbo
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return this.renderDepthPass(this.shadowFbo, SHADOW_RES, this.lightVpMat, bridge);
  }

  private renderSpotShadowPass(bridge: WasmBridge, scene: Scene): number {
    const gl = this.gl;
    this.spotShadowActive = false;
    if (scene.spotLights.length === 0) return 0;
    const spot = scene.spotLights[0];
    if (spot.castsShadow === false) return 0;

    const dl = spot.direction;
    const dLen = Math.hypot(dl[0], dl[1], dl[2]) || 1;
    const dir: Vec3Tuple = [dl[0] / dLen, dl[1] / dLen, dl[2] / dLen];
    const up: Vec3Tuple = Math.abs(dir[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    const outerRad = ((spot.outerConeDeg ?? 35) * 2 * Math.PI) / 180;
    const target: Vec3Tuple = [
      spot.position[0] + dir[0],
      spot.position[1] + dir[1],
      spot.position[2] + dir[2],
    ];
    mat4Perspective(Math.max(outerRad, 0.25), 1.0, 0.25, Math.max(spot.range, 2), this.lightProjMat);
    mat4LookAt(spot.position, target, up, this.lightViewMat);
    mat4Multiply(this.lightProjMat, this.lightViewMat, this.spotVpMat);
    this.spotShadowActive = true;

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return this.renderDepthPass(this.spotShadowFbo, SPOT_SHADOW_RES, this.spotVpMat, bridge);
  }

  private collectInstanceRun(
    cmds: Uint32Array,
    startIdx: number,
    meshId: number,
    matId: number,
    matrices: Float32Array
  ): number {
    let run = 0;
    for (let j = startIdx; j < cmds.length; j += 4) {
      if (cmds[j] !== meshId || cmds[j + 1] !== matId) break;
      const mOff = cmds[j + 2] * 16;
      if (mOff + 16 > matrices.length) break;
      const dst = run * 16;
      if (dst + 16 > this.instScratch.length) {
        const grown = new Float32Array(this.instScratch.length * 2);
        grown.set(this.instScratch);
        this.instScratch = grown;
      }
      this.instScratch.set(matrices.subarray(mOff, mOff + 16), dst);
      run++;
    }
    return run;
  }

  private setInstancingEnabled(enabled: boolean, runCount: number): void {
    const gl = this.gl;
    if (enabled) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.instScratch.subarray(0, runCount * 16), gl.DYNAMIC_DRAW);
      for (let loc = 6; loc <= 9; loc++) gl.enableVertexAttribArray(loc);
    } else {
      for (let loc = 6; loc <= 9; loc++) gl.disableVertexAttribArray(loc);
    }
  }

  private renderDepthPass(
    fbo: WebGLFramebuffer,
    res: number,
    vpMat: Float32Array,
    bridge: WasmBridge
  ): number {
    const gl = this.gl;
    const cmds = bridge.getRender3DView();
    const matrices = bridge.getWorldMatricesView();
    const paletteOffsets = bridge.getPaletteOffsetsView();
    const bonePalettes = bridge.getBonePalettesView();

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, res, res);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    gl.useProgram(this.shadowProgram.program);
    gl.uniformMatrix4fv(this.uLoc(this.shadowProgram, 'u_lightViewProj'), false, vpMat);

    let drawCalls = 0;
    for (let i = 0; i < cmds.length; i += 4) {
      const meshId = cmds[i];
      const matId = cmds[i + 1];
      const slot = cmds[i + 2];
      const mesh = this.meshes.get(meshId);
      const mat = this.materials.get(matId);
      if (!mesh || !mat || mat.desc.transparent) continue;

      const matOffset = slot * 16;
      if (matOffset + 16 > matrices.length) continue;

      gl.bindVertexArray(mesh.vao);
      if (!mesh.hasSkinning) {
        const run = this.collectInstanceRun(cmds, i, meshId, matId, matrices);
        if (run >= 2) {
          gl.uniform1i(this.uLoc(this.shadowProgram, 'u_skinned'), 0);
          gl.uniform1i(this.uLoc(this.shadowProgram, 'u_instanced'), 1);
          this.setInstancingEnabled(true, run);
          gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, run);
          this.setInstancingEnabled(false, 0);
          drawCalls++;
          i += (run - 1) * 4;
          continue;
        }
      }

      gl.uniform1i(this.uLoc(this.shadowProgram, 'u_instanced'), 0);
      this.modelScratch.set(matrices.subarray(matOffset, matOffset + 16));
      gl.uniformMatrix4fv(this.uLoc(this.shadowProgram, 'u_model'), false, this.modelScratch);
      this.uploadSkinningUniforms(this.shadowProgram, mesh, slot, paletteOffsets, bonePalettes);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
      drawCalls++;
    }

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return drawCalls;
  }

  private uploadSkinningUniforms(
    prog: GpuProgram,
    mesh: GpuMesh,
    slot: number,
    paletteOffsets: Int32Array,
    bonePalettes: Float32Array
  ): void {
    const gl = this.gl;
    const pOff = slot < paletteOffsets.length ? paletteOffsets[slot] : -1;
    if (mesh.hasSkinning && pOff >= 0 && pOff < bonePalettes.length) {
      const avail = Math.min(1024, bonePalettes.length - pOff);
      this.bonePaletteScratch.fill(0);
      for (let b = 0; b < 64; b++) {
        this.bonePaletteScratch[b * 16] = 1;
        this.bonePaletteScratch[b * 16 + 5] = 1;
        this.bonePaletteScratch[b * 16 + 10] = 1;
        this.bonePaletteScratch[b * 16 + 15] = 1;
      }
      this.bonePaletteScratch.set(bonePalettes.subarray(pOff, pOff + avail), 0);
      gl.uniform1i(this.uLoc(prog, 'u_skinned'), 1);
      gl.uniformMatrix4fv(this.uLoc(prog, 'u_boneMatrices[0]'), false, this.bonePaletteScratch);
    } else {
      gl.uniform1i(this.uLoc(prog, 'u_skinned'), 0);
    }
  }

  private uploadFrameGlobalsUbo(
    scene: Scene,
    viewProj: Float32Array,
    timeSec: number,
    ptCount: number,
    spotCount: number
  ): void {
    const gl = this.gl;
    const u = this.frameUboScratch;
    u.set(viewProj, 0);
    u.set(this.lightVpMat, 16);
    u.set(this.spotVpMat, 32);

    const cam = scene.camera.position;
    u[48] = cam[0];
    u[49] = cam[1];
    u[50] = cam[2];
    u[51] = timeSec;

    const ld = scene.light.direction;
    u[52] = ld[0];
    u[53] = ld[1];
    u[54] = ld[2];
    u[55] = scene.light.intensity;

    const lc = scene.light.color;
    u[56] = lc[0];
    u[57] = lc[1];
    u[58] = lc[2];
    u[59] = scene.shadowsEnabled ? 1 : 0;

    const ac = scene.light.ambientColor;
    u[60] = ac[0];
    u[61] = ac[1];
    u[62] = ac[2];
    u[63] = this.hdrActive ? 1 : 0;

    const fc = scene.fogColor;
    u[64] = fc[0];
    u[65] = fc[1];
    u[66] = fc[2];
    u[67] = scene.fogDensity;

    const st = scene.skyTopColor;
    u[68] = st[0];
    u[69] = st[1];
    u[70] = st[2];
    u[71] = this.spotShadowActive ? 1 : 0;

    const sh = scene.skyHorizonColor;
    u[72] = sh[0];
    u[73] = sh[1];
    u[74] = sh[2];
    u[75] = 0;

    u[76] = ptCount;
    u[77] = spotCount;
    u[78] = 0;
    u[79] = 0;

    for (let i = 0; i < ptCount; i++) {
      const pl = scene.pointLights[i];
      const pBase = 80 + i * 4;
      u[pBase] = pl.position[0];
      u[pBase + 1] = pl.position[1];
      u[pBase + 2] = pl.position[2];
      u[pBase + 3] = pl.radius;
      const cBase = 96 + i * 4;
      u[cBase] = pl.color[0] * pl.intensity;
      u[cBase + 1] = pl.color[1] * pl.intensity;
      u[cBase + 2] = pl.color[2] * pl.intensity;
      u[cBase + 3] = 0;
    }

    for (let i = 0; i < spotCount; i++) {
      const sp = scene.spotLights[i];
      const pBase = 112 + i * 4;
      u[pBase] = sp.position[0];
      u[pBase + 1] = sp.position[1];
      u[pBase + 2] = sp.position[2];
      u[pBase + 3] = sp.range;
      const dBase = 128 + i * 4;
      u[dBase] = sp.direction[0];
      u[dBase + 1] = sp.direction[1];
      u[dBase + 2] = sp.direction[2];
      u[dBase + 3] = Math.cos(((sp.innerConeDeg ?? 20) * Math.PI) / 180);
      const cBase = 144 + i * 4;
      u[cBase] = sp.color[0] * sp.intensity;
      u[cBase + 1] = sp.color[1] * sp.intensity;
      u[cBase + 2] = sp.color[2] * sp.intensity;
      u[cBase + 3] = Math.cos(((sp.outerConeDeg ?? 35) * Math.PI) / 180);
    }

    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameGlobalsUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  }

  private bindPassGlobalsSamplers(prog: GpuProgram): void {
    if (prog.globalsSamplersBound) return;
    const gl = this.gl;
    gl.uniform1i(this.uLoc(prog, 'u_shadowMap'), 1);
    gl.uniform1i(this.uLoc(prog, 'u_spotShadowMap'), 5);
    prog.globalsSamplersBound = true;
  }

  private bindOptionalTex(
    prog: GpuProgram,
    unit: number,
    texId: number | undefined,
    samplerName: string,
    flagName: string,
    fallback: WebGLTexture,
    fallbackKey: number
  ): void {
    const gl = this.gl;
    const tex = texId ? this.textures.get(texId) : undefined;
    const key = tex ? (texId as number) : fallbackKey;
    if (this.boundTexByUnit[unit] !== key) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex ?? fallback);
      this.boundTexByUnit[unit] = key;
    }
    gl.uniform1i(this.uLoc(prog, samplerName), unit);
    gl.uniform1i(this.uLoc(prog, flagName), tex ? 1 : 0);
  }

  private applyMaterialUniforms(prog: GpuProgram, desc: MaterialDesc, skipMaterialState = false): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.uLoc(prog, 'u_model'), false, this.modelScratch);
    if (skipMaterialState) {
      this.frameSkippedMatBinds++;
      return;
    }
    const u = desc.uniforms;
    gl.uniform4fv(this.uLoc(prog, 'u_baseColor'), u.baseColor);
    gl.uniform3fv(this.uLoc(prog, 'u_shadowTint'), u.shadowTint);
    gl.uniform3fv(this.uLoc(prog, 'u_rimColor'), u.rimColor);
    gl.uniform3fv(this.uLoc(prog, 'u_glowColor'), u.glowColor);
    gl.uniform3fv(this.uLoc(prog, 'u_edgeColor'), u.edgeColor);
    gl.uniform3fv(this.uLoc(prog, 'u_emissiveColor'), desc.emissiveColor ?? [0, 0, 0]);
    gl.uniform1f(this.uLoc(prog, 'u_metallic'), u.metallic);
    gl.uniform1f(this.uLoc(prog, 'u_roughness'), u.roughness);
    gl.uniform1f(this.uLoc(prog, 'u_celSteps'), u.celSteps);
    gl.uniform1f(this.uLoc(prog, 'u_rimPower'), u.rimPower);
    gl.uniform1f(this.uLoc(prog, 'u_fresnelPower'), u.fresnelPower);
    gl.uniform1f(this.uLoc(prog, 'u_waveAmp'), u.waveAmp);
    gl.uniform1f(this.uLoc(prog, 'u_waveFreq'), u.waveFreq);
    gl.uniform1f(this.uLoc(prog, 'u_dissolve'), u.dissolve);
    gl.uniform1f(this.uLoc(prog, 'u_ditherStrength'), u.ditherStrength);
    gl.uniform1f(this.uLoc(prog, 'u_gridScale'), u.gridScale);
    gl.uniform1f(this.uLoc(prog, 'u_clearcoat'), u.clearcoat ?? 0);
    gl.uniform1f(this.uLoc(prog, 'u_clearcoatRoughness'), u.clearcoatRoughness ?? 0.14);
    gl.uniform1f(this.uLoc(prog, 'u_subsurface'), u.subsurface ?? 0);
    gl.uniform1f(this.uLoc(prog, 'u_bumpScale'), u.bumpScale ?? 0.04);
    gl.uniform1f(this.uLoc(prog, 'u_waterStyle'), u.waterStyle ?? 0);
    gl.uniform1f(this.uLoc(prog, 'u_waterFoam'), u.waterFoam ?? 0.65);
    gl.uniform1f(this.uLoc(prog, 'u_waterChoppiness'), u.waterChoppiness ?? 0.58);
    gl.uniform1f(this.uLoc(prog, 'u_waterClarity'), u.waterClarity ?? 0.62);
    const uvScale = u.uvScale ?? [1, 1];
    gl.uniform2f(this.uLoc(prog, 'u_uvScale'), uvScale[0], uvScale[1]);

    this.bindOptionalTex(prog, 0, desc.textureId, 'u_tex', 'u_hasTexture', this.dummyWhiteTex, -2);
    this.bindOptionalTex(prog, 2, desc.normalMapId, 'u_normalMap', 'u_hasNormalMap', this.dummyBlackTex, -3);
    this.bindOptionalTex(
      prog,
      3,
      desc.metallicRoughnessMapId,
      'u_metallicRoughnessMap',
      'u_hasMetallicRoughnessMap',
      this.dummyWhiteTex,
      -2
    );
    this.bindOptionalTex(prog, 4, desc.emissiveMapId, 'u_emissiveMap', 'u_hasEmissiveMap', this.dummyBlackTex, -3);
  }

  private render3DPass(
    bridge: WasmBridge,
    scene: Scene,
    viewProj: Float32Array,
    timeSec: number
  ): number {
    const gl = this.gl;
    const cmds = bridge.getRender3DView();
    if (cmds.length === 0) return 0;
    const matrices = bridge.getWorldMatricesView();
    const paletteOffsets = bridge.getPaletteOffsetsView();
    const bonePalettes = bridge.getBonePalettesView();

    const ptCount = Math.min(scene.pointLights.length, 4);
    const spotCount = Math.min(scene.spotLights.length, 4);
    this.uploadFrameGlobalsUbo(scene, viewProj, timeSec, ptCount, spotCount);
    this.boundTexByUnit.fill(-1);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowDepthTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.spotShadowDepthTex);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    let drawCalls = 0;
    let lastProg: GpuProgram | null = null;
    let lastMatId = -1;

    for (let i = 0; i < cmds.length; i += 4) {
      const meshId = cmds[i];
      const defaultMatId = cmds[i + 1];
      const slot = cmds[i + 2];
      const mesh = this.meshes.get(meshId);
      const defaultMat = this.materials.get(defaultMatId);
      if (!mesh || !defaultMat) continue;

      const matOffset = slot * 16;
      if (matOffset + 16 > matrices.length) continue;

      gl.bindVertexArray(mesh.vao);
      const submeshes = mesh.submeshes && mesh.submeshes.length > 0
        ? mesh.submeshes
        : [{ indexOffset: 0, indexCount: mesh.indexCount, materialId: defaultMatId }];

      // Fast-path 3D hardware instancing (supports outlined meshes too!)
      const firstMatId = submeshes[0].materialId ?? defaultMatId;
      const firstDesc = ((submeshes[0].materialId ? this.materials.get(submeshes[0].materialId) : undefined) ?? defaultMat).desc;
      if (submeshes.length === 1 && !mesh.hasSkinning && !firstDesc.transparent) {
        const run = this.collectInstanceRun(cmds, i, meshId, defaultMatId, matrices);
        if (run >= 2) {
          const activeMat = (submeshes[0].materialId ? this.materials.get(submeshes[0].materialId) : undefined) ?? defaultMat;
          gl.disable(gl.BLEND);
          gl.depthMask(true);
          if (activeMat.desc.doubleSided) gl.disable(gl.CULL_FACE);
          else {
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
          }
          const prog = activeMat.program;
          if (prog !== lastProg) {
            gl.useProgram(prog.program);
            lastProg = prog;
            lastMatId = -1;
            this.bindPassGlobalsSamplers(prog);
          }
          this.modelScratch.set(this.instScratch.subarray(0, 16));
          this.applyMaterialUniforms(prog, activeMat.desc, firstMatId === lastMatId);
          lastMatId = firstMatId;
          gl.uniform1i(this.uLoc(prog, 'u_skinned'), 0);
          gl.uniform1i(this.uLoc(prog, 'u_instanced'), 1);
          this.setInstancingEnabled(true, run);
          gl.drawElementsInstanced(
            gl.TRIANGLES,
            submeshes[0].indexCount,
            gl.UNSIGNED_INT,
            submeshes[0].indexOffset * 4,
            run
          );
          drawCalls++;
          this.frameInstancedRuns++;
          this.frameInstancedObjects += run;

          if (activeMat.desc.outlineWidth && activeMat.desc.outlineWidth > 0) {
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.FRONT);
            gl.useProgram(this.outlineProgram.program);
            gl.uniform1i(this.uLoc(this.outlineProgram, 'u_hdrOutput'), this.hdrActive ? 1 : 0);
            gl.uniformMatrix4fv(this.uLoc(this.outlineProgram, 'u_viewProj'), false, viewProj);
            gl.uniform1f(this.uLoc(this.outlineProgram, 'u_outlineWidth'), activeMat.desc.outlineWidth);
            gl.uniform3fv(
              this.uLoc(this.outlineProgram, 'u_outlineColor'),
              activeMat.desc.outlineColor ?? [0.06, 0.05, 0.1]
            );
            gl.uniform1i(this.uLoc(this.outlineProgram, 'u_skinned'), 0);
            gl.uniform1i(this.uLoc(this.outlineProgram, 'u_instanced'), 1);
            gl.drawElementsInstanced(
              gl.TRIANGLES,
              submeshes[0].indexCount,
              gl.UNSIGNED_INT,
              submeshes[0].indexOffset * 4,
              run
            );
            gl.uniform1i(this.uLoc(this.outlineProgram, 'u_instanced'), 0);
            drawCalls++;
            lastProg = null;
          } else {
            gl.uniform1i(this.uLoc(prog, 'u_instanced'), 0);
          }

          this.setInstancingEnabled(false, 0);
          i += (run - 1) * 4;
          continue;
        }
      }

      this.modelScratch.set(matrices.subarray(matOffset, matOffset + 16));

      for (const sm of submeshes) {
        const activeMatId = sm.materialId ?? defaultMatId;
        const activeMat = (sm.materialId ? this.materials.get(sm.materialId) : undefined) ?? defaultMat;
        const desc = activeMat.desc;
        if (desc.transparent) {
          gl.enable(gl.BLEND);
          if (desc.blendMode === 'additive') {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          } else {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          }
          gl.depthMask(desc.depthWrite === true);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(desc.depthWrite !== false);
        }
        if (desc.polygonOffset) {
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(-2, -2);
        } else {
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }

        if (desc.doubleSided) {
          gl.disable(gl.CULL_FACE);
        } else {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.BACK);
        }

        const prog = activeMat.program;
        if (prog !== lastProg) {
          gl.useProgram(prog.program);
          lastProg = prog;
          lastMatId = -1;
          this.bindPassGlobalsSamplers(prog);
        }

        gl.uniform1i(this.uLoc(prog, 'u_instanced'), 0);
        this.applyMaterialUniforms(prog, desc, activeMatId === lastMatId);
        lastMatId = activeMatId;
        this.uploadSkinningUniforms(prog, mesh, slot, paletteOffsets, bonePalettes);
        gl.drawElements(gl.TRIANGLES, sm.indexCount, gl.UNSIGNED_INT, sm.indexOffset * 4);
        drawCalls++;

        if (desc.outlineWidth && desc.outlineWidth > 0 && !desc.transparent) {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.FRONT);
          gl.useProgram(this.outlineProgram.program);
          gl.uniform1i(this.uLoc(this.outlineProgram, 'u_hdrOutput'), this.hdrActive ? 1 : 0);
          gl.uniformMatrix4fv(this.uLoc(this.outlineProgram, 'u_viewProj'), false, viewProj);
          gl.uniformMatrix4fv(this.uLoc(this.outlineProgram, 'u_model'), false, this.modelScratch);
          gl.uniform1f(this.uLoc(this.outlineProgram, 'u_outlineWidth'), desc.outlineWidth);
          gl.uniform3fv(
            this.uLoc(this.outlineProgram, 'u_outlineColor'),
            desc.outlineColor ?? [0.06, 0.05, 0.1]
          );
          gl.uniform1i(this.uLoc(this.outlineProgram, 'u_instanced'), 0);
          this.uploadSkinningUniforms(this.outlineProgram, mesh, slot, paletteOffsets, bonePalettes);
          gl.drawElements(gl.TRIANGLES, sm.indexCount, gl.UNSIGNED_INT, sm.indexOffset * 4);
          drawCalls++;
          lastProg = null;
        }
      }
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    return drawCalls;
  }

  private renderGpuParticlesPass(bridge: WasmBridge, scene: Scene, viewProj: Float32Array): number {
    const alphaData = bridge.getParticlesAlphaView();
    const addData = bridge.getParticlesAddView();
    if (alphaData.length === 0 && addData.length === 0) return 0;

    const gl = this.gl;
    let calls = 0;

    let rx = 1;
    let ry = 0;
    let rz = 0;
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (scene.camera.mode === '3d') {
      const p = scene.camera.position;
      const t = scene.camera.target;
      let fx = t[0] - p[0];
      let fy = t[1] - p[1];
      let fz = t[2] - p[2];
      const fLen = Math.hypot(fx, fy, fz) || 1;
      fx /= fLen;
      fy /= fLen;
      fz /= fLen;
      const up = scene.camera.up;
      rx = fy * up[2] - fz * up[1];
      ry = fz * up[0] - fx * up[2];
      rz = fx * up[1] - fy * up[0];
      const rLen = Math.hypot(rx, ry, rz) || 1;
      rx /= rLen;
      ry /= rLen;
      rz /= rLen;
      ux = ry * fz - rz * fy;
      uy = rz * fx - rx * fz;
      uz = rx * fy - ry * fx;
    }

    gl.useProgram(this.vfxProgram.program);
    gl.uniformMatrix4fv(this.uLoc(this.vfxProgram, 'u_viewProj'), false, viewProj);
    gl.uniform3f(this.uLoc(this.vfxProgram, 'u_camRight'), rx, ry, rz);
    gl.uniform3f(this.uLoc(this.vfxProgram, 'u_camUp'), ux, uy, uz);
    gl.uniform1i(this.uLoc(this.vfxProgram, 'u_hdrOutput'), this.hdrActive ? 1 : 0);

    gl.bindVertexArray(this.vfxVao);
    if (scene.camera.mode === '3d') {
      gl.enable(gl.DEPTH_TEST);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);

    if (alphaData.length >= 12) {
      const count = Math.floor(alphaData.length / 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vfxInstVbo);
      gl.bufferData(gl.ARRAY_BUFFER, alphaData, gl.DYNAMIC_DRAW);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(this.uLoc(this.vfxProgram, 'u_additive'), 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      calls++;
    }

    if (addData.length >= 12) {
      const count = Math.floor(addData.length / 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vfxInstVbo);
      gl.bufferData(gl.ARRAY_BUFFER, addData, gl.DYNAMIC_DRAW);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniform1i(this.uLoc(this.vfxProgram, 'u_additive'), 1);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      calls++;
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    return calls;
  }

  private render2DPass(
    bridge: WasmBridge,
    scene: Scene,
    viewProj: Float32Array,
    aspect: number
  ): number {
    const gl = this.gl;
    const items = bridge.getRender2DView();
    const texIds = bridge.getRender2DTexView();
    const count = texIds.length;
    if (count === 0) return 0;

    if (this.spriteInstScratch.length < count * 16) {
      this.spriteInstScratch = new Float32Array(count * 16);
    }

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.spriteProgram.program);
    gl.uniform1i(this.uLoc(this.spriteProgram, 'u_hdrOutput'), this.hdrActive ? 1 : 0);
    gl.uniformMatrix4fv(this.uLoc(this.spriteProgram, 'u_viewProj'), false, viewProj);
    gl.bindVertexArray(this.spriteVao);

    let drawCalls = 0;
    let batchStart = 0;
    while (batchStart < count) {
      const texId = texIds[batchStart];
      let batchEnd = batchStart + 1;
      while (batchEnd < count && texIds[batchEnd] === texId) {
        batchEnd++;
      }
      const batchLen = batchEnd - batchStart;
      for (let k = 0; k < batchLen; k++) {
        const src = (batchStart + k) * 14;
        const dst = k * 16;
        this.spriteInstScratch[dst] = items[src];
        this.spriteInstScratch[dst + 1] = items[src + 1];
        this.spriteInstScratch[dst + 2] = items[src + 3];
        this.spriteInstScratch[dst + 3] = items[src + 4];
        this.spriteInstScratch[dst + 4] = items[src + 2];
        this.spriteInstScratch[dst + 5] = items[src + 5];
        this.spriteInstScratch[dst + 6] = 0;
        this.spriteInstScratch[dst + 7] = 0;
        this.spriteInstScratch[dst + 8] = items[src + 6];
        this.spriteInstScratch[dst + 9] = items[src + 7];
        this.spriteInstScratch[dst + 10] = items[src + 8];
        this.spriteInstScratch[dst + 11] = items[src + 9];
        this.spriteInstScratch[dst + 12] = items[src + 10];
        this.spriteInstScratch[dst + 13] = items[src + 11];
        this.spriteInstScratch[dst + 14] = items[src + 12];
        this.spriteInstScratch[dst + 15] = items[src + 13];
      }

      const tex = texId ? this.textures.get(texId) : undefined;
      gl.activeTexture(gl.TEXTURE0);
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(this.uLoc(this.spriteProgram, 'u_tex'), 0);
        gl.uniform1i(this.uLoc(this.spriteProgram, 'u_hasTexture'), 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.dummyWhiteTex);
        gl.uniform1i(this.uLoc(this.spriteProgram, 'u_tex'), 0);
        gl.uniform1i(this.uLoc(this.spriteProgram, 'u_hasTexture'), 0);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteInstVbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.spriteInstScratch.subarray(0, batchLen * 16),
        gl.DYNAMIC_DRAW
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batchLen);
      drawCalls++;
      batchStart = batchEnd;
    }

    const amb = scene.lights2d.ambientColor;
    const isLit2D =
      scene.camera.mode === '2d' &&
      (amb[0] < 0.99 || amb[1] < 0.99 || amb[2] < 0.99 || scene.lights2d.lights.length > 0);
    if (isLit2D) {
      const lCount = Math.min(scene.lights2d.lights.length, 16);
      for (let i = 0; i < lCount; i++) {
        const l = scene.lights2d.lights[i];
        const inten = l.intensity ?? 1.0;
        this.light2dPosScratch[i * 2] = l.position[0];
        this.light2dPosScratch[i * 2 + 1] = l.position[1];
        this.light2dColScratch[i * 3] = l.color[0] * inten;
        this.light2dColScratch[i * 3 + 1] = l.color[1] * inten;
        this.light2dColScratch[i * 3 + 2] = l.color[2] * inten;
        this.light2dRadScratch[i] = l.radius;
      }
      const halfH = (scene.camera.orthoHeight / Math.max(scene.camera.zoom, 0.1)) * 0.5;
      const halfW = halfH * Math.max(aspect, 0.001);
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      gl.useProgram(this.light2dProgram.program);
      gl.uniform2f(
        this.uLoc(this.light2dProgram, 'u_camCenter'),
        scene.camera.position[0],
        scene.camera.position[1]
      );
      gl.uniform2f(this.uLoc(this.light2dProgram, 'u_camHalfSize'), halfW, halfH);
      gl.uniform3fv(this.uLoc(this.light2dProgram, 'u_ambient2d'), amb);
      gl.uniform1i(this.uLoc(this.light2dProgram, 'u_light2dCount'), lCount);
      if (lCount > 0) {
        gl.uniform2fv(this.uLoc(this.light2dProgram, 'u_light2dPos[0]'), this.light2dPosScratch);
        gl.uniform3fv(this.uLoc(this.light2dProgram, 'u_light2dColor[0]'), this.light2dColScratch);
        gl.uniform1fv(this.uLoc(this.light2dProgram, 'u_light2dRadius[0]'), this.light2dRadScratch);
      }
      gl.bindVertexArray(this.skyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawCalls++;
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    return drawCalls;
  }

  dispose(): void {
    const gl = this.gl;
    for (const id of Array.from(this.meshes.keys())) this.disposeMesh(id);
    for (const id of Array.from(this.textures.keys())) this.disposeTexture(id);
    this.materials.clear();
    for (const prog of this.programCache.values()) {
      gl.deleteProgram(prog.program);
    }
    this.programCache.clear();
    gl.deleteFramebuffer(this.shadowFbo);
    gl.deleteTexture(this.shadowDepthTex);
    gl.deleteFramebuffer(this.spotShadowFbo);
    gl.deleteTexture(this.spotShadowDepthTex);
    gl.deleteBuffer(this.instVbo);
    gl.deleteBuffer(this.frameGlobalsUbo);
    gl.deleteTexture(this.dummyBlackTex);
    gl.deleteTexture(this.dummyWhiteTex);
    this.disposePostProcessFbos();
    gl.deleteVertexArray(this.skyVao);
    gl.deleteVertexArray(this.spriteVao);
    gl.deleteBuffer(this.spriteQuadVbo);
    gl.deleteBuffer(this.spriteInstVbo);
    gl.deleteVertexArray(this.vfxVao);
    gl.deleteBuffer(this.vfxInstVbo);
    gl.deleteVertexArray(this.debugLineVao);
    gl.deleteBuffer(this.debugLineVbo);
  }
}
