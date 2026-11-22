import { mat4LookAt, mat4Multiply, mat4Ortho, type Vec3Tuple } from '../math/Mat4';
import type { Scene } from '../Scene';
import type { WasmBridge } from '../wasm/WasmBridge';
import type { IRenderBackend, MaterialDesc, MeshGeometry, MeshSubmesh } from './IRenderBackend';
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
}

interface StoredMaterial {
  desc: MaterialDesc;
  program: GpuProgram;
}

const SHADOW_RES = 2048;

const SHADOW_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 4) in uvec4 a_joints;
layout(location = 5) in vec4 a_weights;
uniform mat4 u_model;
uniform mat4 u_lightViewProj;
uniform int u_skinned;
uniform mat4 u_boneMatrices[64];
void main() {
  vec3 localPos = a_position;
  if (u_skinned == 1) {
    float wSum = a_weights.x + a_weights.y + a_weights.z + a_weights.w;
    if (wSum > 0.0001) {
      mat4 skinMat =
        a_weights.x * u_boneMatrices[min(a_joints.x, 63u)] +
        a_weights.y * u_boneMatrices[min(a_joints.y, 63u)] +
        a_weights.z * u_boneMatrices[min(a_joints.z, 63u)] +
        a_weights.w * u_boneMatrices[min(a_joints.w, 63u)];
      localPos = (skinMat * vec4(localPos, 1.0)).xyz;
    }
  }
  gl_Position = u_lightViewProj * u_model * vec4(localPos, 1.0);
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
out vec4 fragColor;
void main() {
  vec3 dir = normalize(
    u_camForward +
    u_camRight * (v_ndc.x * u_aspect * u_tanHalfFov) +
    u_camUp * (v_ndc.y * u_tanHalfFov)
  );
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  float skyT = smoothstep(0.45, 0.95, h);
  vec3 col = mix(u_skyHorizon, u_skyTop, skyT);
  float sunAmt = max(dot(dir, normalize(u_lightDir)), 0.0);
  col += u_lightColor * (pow(sunAmt, 48.0) * 0.65 + pow(sunAmt, 6.0) * 0.14);
  fragColor = vec4(col, 1.0);
}
`;

const OUTLINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 3) in vec3 a_smoothNormal;
layout(location = 4) in uvec4 a_joints;
layout(location = 5) in vec4 a_weights;
uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform float u_outlineWidth;
uniform int u_skinned;
uniform mat4 u_boneMatrices[64];
void main() {
  vec3 pos = a_position;
  vec3 nrm = a_smoothNormal;
  if (u_skinned == 1) {
    float wSum = a_weights.x + a_weights.y + a_weights.z + a_weights.w;
    if (wSum > 0.0001) {
      mat4 skinMat =
        a_weights.x * u_boneMatrices[min(a_joints.x, 63u)] +
        a_weights.y * u_boneMatrices[min(a_joints.y, 63u)] +
        a_weights.z * u_boneMatrices[min(a_joints.z, 63u)] +
        a_weights.w * u_boneMatrices[min(a_joints.w, 63u)];
      pos = (skinMat * vec4(pos, 1.0)).xyz;
      nrm = normalize(mat3(skinMat) * nrm);
    }
  }
  vec4 world = u_model * vec4(pos + nrm * u_outlineWidth, 1.0);
  gl_Position = u_viewProj * world;
}
`;

const OUTLINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 u_outlineColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_outlineColor, 1.0);
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
out vec4 fragColor;
void main() {
  vec4 texel = u_hasTexture == 1 ? texture(u_tex, v_uv) : vec4(1.0);
  vec4 outCol = texel * v_color;
  if (outCol.a < 0.01) discard;
  fragColor = outCol;
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
  private readonly ptPosScratch = new Float32Array(12);
  private readonly ptColScratch = new Float32Array(12);
  private readonly ptRadScratch = new Float32Array(4);

  private nextMeshId = 1;
  private nextMaterialId = 1;
  private nextTextureId = 1;

  private shadowFbo: WebGLFramebuffer;
  private shadowDepthTex: WebGLTexture;
  private shadowProgram: GpuProgram;
  private skyProgram: GpuProgram;
  private skyVao: WebGLVertexArrayObject;
  private outlineProgram: GpuProgram;
  private spriteProgram: GpuProgram;
  private spriteVao: WebGLVertexArrayObject;
  private spriteQuadVbo: WebGLBuffer;
  private spriteInstVbo: WebGLBuffer;
  private spriteInstScratch = new Float32Array(16 * 128);

  private ppBrightProgram: GpuProgram;
  private ppBlurProgram: GpuProgram;
  private ppCompositeProgram: GpuProgram;
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
    this.shadowProgram = this.compileProgram('__shadow__', SHADOW_VERT, SHADOW_FRAG);
    this.skyProgram = this.compileProgram('__sky__', SKY_VERT, SKY_FRAG);
    this.outlineProgram = this.compileProgram('__outline__', OUTLINE_VERT, OUTLINE_FRAG);
    this.spriteProgram = this.compileProgram('__sprite2d__', SPRITE_VERT, SPRITE_FRAG);

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

    // Shadow depth FBO
    const sFbo = gl.createFramebuffer()!;
    const sTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, sTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      SHADOW_RES,
      SHADOW_RES,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.shadowFbo = sFbo;
    this.shadowDepthTex = sTex;

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
    const gpuProg: GpuProgram = { program: prog, uniforms: new Map() };
    this.programCache.set(key, gpuProg);
    return gpuProg;
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
      gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_SHORT, 8, 0);

      weightsVbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, weightsVbo);
      gl.bufferData(gl.ARRAY_BUFFER, geom.weights, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 16, 0);
      hasSkinning = true;
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
    let drawCalls = 0;

    if (scene.camera.mode === '3d' && scene.shadowsEnabled) {
      drawCalls += this.renderShadowPass(bridge, scene);
    }

    const usePp = isPostProcessActive(scene.postProcess);
    if (usePp) {
      this.ensurePostProcessFbos(canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(scene.fogColor[0], scene.fogColor[1], scene.fogColor[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { viewProj } = scene.computeCameraMatrices(aspect);

    if (scene.camera.mode === '3d') {
      drawCalls += this.renderSkyPass(scene, aspect);
      drawCalls += this.render3DPass(bridge, scene, viewProj, timeSec);
    }
    drawCalls += this.render2DPass(bridge, viewProj);

    if (usePp) {
      drawCalls += this.renderPostProcess(canvas.width, canvas.height, scene.postProcess, timeSec);
    }
    return drawCalls;
  }

  private renderPostProcess(w: number, h: number, pp: PostProcessConfig, timeSec: number): number {
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

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_RES, SHADOW_RES);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    gl.useProgram(this.shadowProgram.program);
    gl.uniformMatrix4fv(this.uLoc(this.shadowProgram, 'u_lightViewProj'), false, this.lightVpMat);
    const paletteOffsets = bridge.getPaletteOffsetsView();
    const bonePalettes = bridge.getBonePalettesView();

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
      this.modelScratch.set(matrices.subarray(matOffset, matOffset + 16));
      gl.uniformMatrix4fv(this.uLoc(this.shadowProgram, 'u_model'), false, this.modelScratch);
      this.uploadSkinningUniforms(this.shadowProgram, mesh, slot, paletteOffsets, bonePalettes);
      gl.bindVertexArray(mesh.vao);
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
    if (mesh.hasSkinning && pOff >= 0 && pOff + 1024 <= bonePalettes.length) {
      gl.uniform1i(this.uLoc(prog, 'u_skinned'), 1);
      gl.uniformMatrix4fv(
        this.uLoc(prog, 'u_boneMatrices[0]'),
        false,
        bonePalettes.subarray(pOff, pOff + 1024)
      );
    } else {
      gl.uniform1i(this.uLoc(prog, 'u_skinned'), 0);
    }
  }

  private bindPassGlobals(
    prog: GpuProgram,
    scene: Scene,
    viewProj: Float32Array,
    timeSec: number,
    ptCount: number
  ): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.uLoc(prog, 'u_viewProj'), false, viewProj);
    gl.uniformMatrix4fv(this.uLoc(prog, 'u_lightViewProj'), false, this.lightVpMat);
    gl.uniform3fv(this.uLoc(prog, 'u_cameraPos'), scene.camera.position);
    gl.uniform1f(this.uLoc(prog, 'u_time'), timeSec);
    gl.uniform3fv(this.uLoc(prog, 'u_lightDir'), scene.light.direction);
    gl.uniform3fv(this.uLoc(prog, 'u_lightColor'), scene.light.color);
    gl.uniform1f(this.uLoc(prog, 'u_lightIntensity'), scene.light.intensity);
    gl.uniform3fv(this.uLoc(prog, 'u_ambientColor'), scene.light.ambientColor);
    gl.uniform3fv(this.uLoc(prog, 'u_fogColor'), scene.fogColor);
    gl.uniform1f(this.uLoc(prog, 'u_fogDensity'), scene.fogDensity);
    gl.uniform1i(this.uLoc(prog, 'u_shadowsEnabled'), scene.shadowsEnabled ? 1 : 0);
    gl.uniform1i(this.uLoc(prog, 'u_shadowMap'), 1);
    gl.uniform1i(this.uLoc(prog, 'u_pointLightCount'), ptCount);
    if (ptCount > 0) {
      gl.uniform3fv(this.uLoc(prog, 'u_pointPos[0]'), this.ptPosScratch);
      gl.uniform3fv(this.uLoc(prog, 'u_pointColor[0]'), this.ptColScratch);
      gl.uniform1fv(this.uLoc(prog, 'u_pointRadius[0]'), this.ptRadScratch);
    }
  }

  private applyMaterialUniforms(prog: GpuProgram, desc: MaterialDesc): void {
    const gl = this.gl;
    const u = desc.uniforms;
    gl.uniformMatrix4fv(this.uLoc(prog, 'u_model'), false, this.modelScratch);
    gl.uniform4fv(this.uLoc(prog, 'u_baseColor'), u.baseColor);
    gl.uniform3fv(this.uLoc(prog, 'u_shadowTint'), u.shadowTint);
    gl.uniform3fv(this.uLoc(prog, 'u_rimColor'), u.rimColor);
    gl.uniform3fv(this.uLoc(prog, 'u_glowColor'), u.glowColor);
    gl.uniform3fv(this.uLoc(prog, 'u_edgeColor'), u.edgeColor);
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

    const tex = desc.textureId ? this.textures.get(desc.textureId) : undefined;
    gl.activeTexture(gl.TEXTURE0);
    if (tex) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.uLoc(prog, 'u_tex'), 0);
      gl.uniform1i(this.uLoc(prog, 'u_hasTexture'), 1);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.dummyWhiteTex);
      gl.uniform1i(this.uLoc(prog, 'u_tex'), 0);
      gl.uniform1i(this.uLoc(prog, 'u_hasTexture'), 0);
    }
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

    // Pack up to 4 point lights
    const ptCount = Math.min(scene.pointLights.length, 4);
    for (let i = 0; i < ptCount; i++) {
      const pl = scene.pointLights[i];
      this.ptPosScratch[i * 3] = pl.position[0];
      this.ptPosScratch[i * 3 + 1] = pl.position[1];
      this.ptPosScratch[i * 3 + 2] = pl.position[2];
      this.ptColScratch[i * 3] = pl.color[0] * pl.intensity;
      this.ptColScratch[i * 3 + 1] = pl.color[1] * pl.intensity;
      this.ptColScratch[i * 3 + 2] = pl.color[2] * pl.intensity;
      this.ptRadScratch[i] = pl.radius;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowDepthTex);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    let drawCalls = 0;
    let lastProg: GpuProgram | null = null;

    for (let i = 0; i < cmds.length; i += 4) {
      const meshId = cmds[i];
      const defaultMatId = cmds[i + 1];
      const slot = cmds[i + 2];
      const mesh = this.meshes.get(meshId);
      const defaultMat = this.materials.get(defaultMatId);
      if (!mesh || !defaultMat) continue;

      const matOffset = slot * 16;
      if (matOffset + 16 > matrices.length) continue;
      this.modelScratch.set(matrices.subarray(matOffset, matOffset + 16));

      gl.bindVertexArray(mesh.vao);
      const submeshes = mesh.submeshes && mesh.submeshes.length > 0
        ? mesh.submeshes
        : [{ indexOffset: 0, indexCount: mesh.indexCount, materialId: defaultMatId }];

      for (const sm of submeshes) {
        const activeMat = (sm.materialId ? this.materials.get(sm.materialId) : undefined) ?? defaultMat;
        const desc = activeMat.desc;
        if (desc.transparent) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
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
          this.bindPassGlobals(prog, scene, viewProj, timeSec, ptCount);
        }

        this.applyMaterialUniforms(prog, desc);
        this.uploadSkinningUniforms(prog, mesh, slot, paletteOffsets, bonePalettes);
        gl.drawElements(gl.TRIANGLES, sm.indexCount, gl.UNSIGNED_INT, sm.indexOffset * 4);
        drawCalls++;

        if (desc.outlineWidth && desc.outlineWidth > 0 && !desc.transparent) {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.FRONT);
          gl.useProgram(this.outlineProgram.program);
          gl.uniformMatrix4fv(this.uLoc(this.outlineProgram, 'u_viewProj'), false, viewProj);
          gl.uniformMatrix4fv(this.uLoc(this.outlineProgram, 'u_model'), false, this.modelScratch);
          gl.uniform1f(this.uLoc(this.outlineProgram, 'u_outlineWidth'), desc.outlineWidth);
          gl.uniform3fv(
            this.uLoc(this.outlineProgram, 'u_outlineColor'),
            desc.outlineColor ?? [0.06, 0.05, 0.1]
          );
          this.uploadSkinningUniforms(this.outlineProgram, mesh, slot, paletteOffsets, bonePalettes);
          gl.drawElements(gl.TRIANGLES, sm.indexCount, gl.UNSIGNED_INT, sm.indexOffset * 4);
          drawCalls++;
          lastProg = null;
        }
      }
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    return drawCalls;
  }

  private render2DPass(bridge: WasmBridge, viewProj: Float32Array): number {
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
    gl.deleteTexture(this.dummyBlackTex);
    gl.deleteTexture(this.dummyWhiteTex);
    this.disposePostProcessFbos();
    gl.deleteVertexArray(this.skyVao);
    gl.deleteVertexArray(this.spriteVao);
    gl.deleteBuffer(this.spriteQuadVbo);
    gl.deleteBuffer(this.spriteInstVbo);
  }
}
