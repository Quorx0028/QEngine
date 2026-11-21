import type { Scene } from '../Scene';
import type { WasmBridge } from '../wasm/WasmBridge';
import type { IRenderBackend, MaterialDesc, MeshGeometry } from './IRenderBackend';
import { composeShader } from './ShaderBlocks';

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
}

interface GpuProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface StoredMaterial {
  desc: MaterialDesc;
  program: GpuProgram;
}

const OUTLINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform float u_outlineWidth;
void main() {
  vec4 world = u_model * vec4(a_position + a_normal * u_outlineWidth, 1.0);
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
layout(location = 1) in vec4 a_posSize; // x, y, w, h
layout(location = 2) in vec4 a_rotZ;    // z, rot, unused, unused
layout(location = 3) in vec4 a_uvRect;  // u0, v0, u1, v1
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

  private nextMeshId = 1;
  private nextMaterialId = 1;
  private nextTextureId = 1;

  private outlineProgram: GpuProgram;
  private spriteProgram: GpuProgram;
  private spriteVao: WebGLVertexArrayObject;
  private spriteQuadVbo: WebGLBuffer;
  private spriteInstVbo: WebGLBuffer;
  private spriteInstScratch = new Float32Array(16 * 128);

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
    this.outlineProgram = this.compileProgram('__outline__', OUTLINE_VERT, OUTLINE_FRAG);
    this.spriteProgram = this.compileProgram('__sprite2d__', SPRITE_VERT, SPRITE_FRAG);

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

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    const id = this.nextMeshId++;
    this.meshes.set(id, { vao, vbo, ibo, indexCount: geom.indices.length });
    return id;
  }

  disposeMesh(meshId: number): void {
    const mesh = this.meshes.get(meshId);
    if (!mesh) return;
    this.gl.deleteVertexArray(mesh.vao);
    this.gl.deleteBuffer(mesh.vbo);
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

  renderFrame(bridge: WasmBridge, scene: Scene, aspect: number, timeSec: number): number {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(scene.fogColor[0], scene.fogColor[1], scene.fogColor[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { viewProj } = scene.computeCameraMatrices(aspect);
    let drawCalls = 0;

    if (scene.camera.mode === '3d') {
      drawCalls += this.render3DPass(bridge, scene, viewProj, timeSec);
    }
    drawCalls += this.render2DPass(bridge, viewProj);
    return drawCalls;
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

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    let drawCalls = 0;
    let lastProg: GpuProgram | null = null;

    for (let i = 0; i < cmds.length; i += 4) {
      const meshId = cmds[i];
      const matId = cmds[i + 1];
      const slot = cmds[i + 2];
      const mesh = this.meshes.get(meshId);
      const mat = this.materials.get(matId);
      if (!mesh || !mat) continue;

      const matOffset = slot * 16;
      if (matOffset + 16 > matrices.length) continue;
      this.modelScratch.set(matrices.subarray(matOffset, matOffset + 16));

      const desc = mat.desc;
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

      const prog = mat.program;
      if (prog !== lastProg) {
        gl.useProgram(prog.program);
        lastProg = prog;
        gl.uniformMatrix4fv(this.uLoc(prog, 'u_viewProj'), false, viewProj);
        gl.uniform3fv(this.uLoc(prog, 'u_cameraPos'), scene.camera.position);
        gl.uniform1f(this.uLoc(prog, 'u_time'), timeSec);
        gl.uniform3fv(this.uLoc(prog, 'u_lightDir'), scene.light.direction);
        gl.uniform3fv(this.uLoc(prog, 'u_lightColor'), scene.light.color);
        gl.uniform1f(this.uLoc(prog, 'u_lightIntensity'), scene.light.intensity);
        gl.uniform3fv(this.uLoc(prog, 'u_ambientColor'), scene.light.ambientColor);
        gl.uniform3fv(this.uLoc(prog, 'u_fogColor'), scene.fogColor);
        gl.uniform1f(this.uLoc(prog, 'u_fogDensity'), scene.fogDensity);
      }

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
      if (tex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(this.uLoc(prog, 'u_tex'), 0);
        gl.uniform1i(this.uLoc(prog, 'u_hasTexture'), 1);
      } else {
        gl.uniform1i(this.uLoc(prog, 'u_hasTexture'), 0);
      }

      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
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
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
        drawCalls++;
        lastProg = null;
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
        // a_posSize: x, y, w, h
        this.spriteInstScratch[dst] = items[src];
        this.spriteInstScratch[dst + 1] = items[src + 1];
        this.spriteInstScratch[dst + 2] = items[src + 3];
        this.spriteInstScratch[dst + 3] = items[src + 4];
        // a_rotZ: z, rot
        this.spriteInstScratch[dst + 4] = items[src + 2];
        this.spriteInstScratch[dst + 5] = items[src + 5];
        this.spriteInstScratch[dst + 6] = 0;
        this.spriteInstScratch[dst + 7] = 0;
        // a_uvRect
        this.spriteInstScratch[dst + 8] = items[src + 6];
        this.spriteInstScratch[dst + 9] = items[src + 7];
        this.spriteInstScratch[dst + 10] = items[src + 8];
        this.spriteInstScratch[dst + 11] = items[src + 9];
        // a_color
        this.spriteInstScratch[dst + 12] = items[src + 10];
        this.spriteInstScratch[dst + 13] = items[src + 11];
        this.spriteInstScratch[dst + 14] = items[src + 12];
        this.spriteInstScratch[dst + 15] = items[src + 13];
      }

      const tex = texId ? this.textures.get(texId) : undefined;
      if (tex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(this.uLoc(this.spriteProgram, 'u_tex'), 0);
        gl.uniform1i(this.uLoc(this.spriteProgram, 'u_hasTexture'), 1);
      } else {
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
    gl.deleteVertexArray(this.spriteVao);
    gl.deleteBuffer(this.spriteQuadVbo);
    gl.deleteBuffer(this.spriteInstVbo);
  }
}
