export type PostProcessPresetName =
  | 'none'
  | 'animeWorld'
  | 'retroPS1'
  | 'crtHorror'
  | 'dreamWave'
  | 'noir'
  | 'ultraRealism';

export const POST_PROCESS_PRESET_NAMES: readonly PostProcessPresetName[] = [
  'none',
  'animeWorld',
  'retroPS1',
  'crtHorror',
  'dreamWave',
  'noir',
  'ultraRealism',
] as const;

export interface PostProcessConfig {
  enabled: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  screenOutline: number;
  ssao: number;
  pixelSize: number;
  crt: boolean;
  chromaticAberration: number;
  vignette: number;
  filmGrain: number;
  waveStrength: number;
  saturation: number;
  noir: number;
}

export function createPostProcessPreset(name: PostProcessPresetName): PostProcessConfig {
  switch (name) {
    case 'none':
      return {
        enabled: false,
        bloomIntensity: 0,
        bloomThreshold: 0.72,
        screenOutline: 0,
        ssao: 0,
        pixelSize: 1,
        crt: false,
        chromaticAberration: 0,
        vignette: 0,
        filmGrain: 0,
        waveStrength: 0,
        saturation: 1,
        noir: 0,
      };
    case 'animeWorld':
      return {
        enabled: true,
        bloomIntensity: 0.45,
        bloomThreshold: 0.74,
        screenOutline: 0.75,
        ssao: 0,
        pixelSize: 1,
        crt: false,
        chromaticAberration: 0.001,
        vignette: 0.16,
        filmGrain: 0,
        waveStrength: 0,
        saturation: 1.24,
        noir: 0,
      };
    case 'retroPS1':
      return {
        enabled: true,
        bloomIntensity: 0.15,
        bloomThreshold: 0.78,
        screenOutline: 0,
        ssao: 0,
        pixelSize: 4,
        crt: false,
        chromaticAberration: 0.0015,
        vignette: 0.28,
        filmGrain: 0.04,
        waveStrength: 0,
        saturation: 0.95,
        noir: 0,
      };
    case 'crtHorror':
      return {
        enabled: true,
        bloomIntensity: 0.55,
        bloomThreshold: 0.65,
        screenOutline: 0,
        ssao: 0.3,
        pixelSize: 2,
        crt: true,
        chromaticAberration: 0.0045,
        vignette: 0.55,
        filmGrain: 0.09,
        waveStrength: 0,
        saturation: 0.85,
        noir: 0,
      };
    case 'dreamWave':
      return {
        enabled: true,
        bloomIntensity: 0.65,
        bloomThreshold: 0.68,
        screenOutline: 0,
        ssao: 0,
        pixelSize: 1,
        crt: false,
        chromaticAberration: 0.003,
        vignette: 0.25,
        filmGrain: 0,
        waveStrength: 0.008,
        saturation: 1.18,
        noir: 0,
      };
    case 'noir':
      return {
        enabled: true,
        bloomIntensity: 0.22,
        bloomThreshold: 0.75,
        screenOutline: 0.35,
        ssao: 0.45,
        pixelSize: 1,
        crt: false,
        chromaticAberration: 0,
        vignette: 0.52,
        filmGrain: 0.1,
        waveStrength: 0,
        saturation: 0,
        noir: 1,
      };
    case 'ultraRealism':
      return {
        enabled: true,
        bloomIntensity: 0.26,
        bloomThreshold: 0.78,
        screenOutline: 0,
        ssao: 0.72,
        pixelSize: 1,
        crt: false,
        chromaticAberration: 0.0005,
        vignette: 0.24,
        filmGrain: 0.02,
        waveStrength: 0,
        saturation: 1.07,
        noir: 0,
      };
  }
}

export function isPostProcessActive(cfg: PostProcessConfig): boolean {
  if (!cfg.enabled) return false;
  return (
    cfg.bloomIntensity > 0.001 ||
    cfg.screenOutline > 0.001 ||
    cfg.ssao > 0.001 ||
    cfg.pixelSize > 1.01 ||
    cfg.crt ||
    cfg.chromaticAberration > 0.0001 ||
    cfg.vignette > 0.001 ||
    cfg.filmGrain > 0.001 ||
    cfg.waveStrength > 0.0001 ||
    Math.abs(cfg.saturation - 1) > 0.01 ||
    cfg.noir > 0.01
  );
}

export function composePostProcessShader(): {
  vertexSource: string;
  brightFragmentSource: string;
  blurFragmentSource: string;
  fragmentSource: string;
} {
  const vertexSource = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

  const brightFragmentSource = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_sceneTex;
uniform float u_bloomThreshold;
out vec4 fragColor;
void main() {
  vec3 c = texture(u_sceneTex, v_uv).rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(u_bloomThreshold - 0.12, u_bloomThreshold + 0.15, luma);
  fragColor = vec4(c * w, 1.0);
}
`;

  const blurFragmentSource = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
out vec4 fragColor;
void main() {
  vec2 texel = 1.0 / vec2(textureSize(u_tex, 0));
  vec3 acc = texture(u_tex, v_uv).rgb * 0.227027;
  acc += texture(u_tex, v_uv + u_dir * texel * 1.3846).rgb * 0.316216;
  acc += texture(u_tex, v_uv - u_dir * texel * 1.3846).rgb * 0.316216;
  acc += texture(u_tex, v_uv + u_dir * texel * 3.2307).rgb * 0.070270;
  acc += texture(u_tex, v_uv - u_dir * texel * 3.2307).rgb * 0.070270;
  fragColor = vec4(acc, 1.0);
}
`;

  const fragmentSource = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform sampler2D u_sceneTex;
uniform sampler2D u_depthTex;
uniform sampler2D u_bloomTex;
uniform vec2 u_resolution;
uniform float u_time;

uniform float u_bloomIntensity;
uniform float u_screenOutline;
uniform float u_ssao;
uniform float u_pixelSize;
uniform int u_crt;
uniform float u_chromatic;
uniform float u_vignette;
uniform float u_grain;
uniform float u_wave;
uniform float u_saturation;
uniform float u_noir;

out vec4 fragColor;

float linearDepth(vec2 uv) {
  float d = texture(u_depthTex, uv).r;
  float z = d * 2.0 - 1.0;
  float near = 0.1;
  float far = 250.0;
  return (2.0 * near * far) / max(far + near - z * (far - near), 0.0001);
}

void main() {
  vec2 uv = v_uv;

  // CRT barrel curvature
  if (u_crt == 1) {
    vec2 cc = uv - 0.5;
    float r2 = dot(cc, cc);
    uv = 0.5 + cc * (1.0 + r2 * 0.14);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
  }

  // Dream / underwater wave distortion
  if (u_wave > 0.0001) {
    uv.x += sin(uv.y * 22.0 + u_time * 3.2) * u_wave;
    uv.y += cos(uv.x * 18.0 + u_time * 2.6) * u_wave * 0.7;
  }

  // Retro pixelation snap across entire screen
  if (u_pixelSize > 1.01) {
    vec2 grid = max(u_resolution / u_pixelSize, vec2(16.0));
    uv = floor(uv * grid) / grid;
  }

  // Chromatic aberration
  vec3 col;
  if (u_chromatic > 0.0001) {
    vec2 dir = (uv - 0.5) * u_chromatic * 2.0;
    col.r = texture(u_sceneTex, clamp(uv + dir, 0.0, 1.0)).r;
    col.g = texture(u_sceneTex, uv).g;
    col.b = texture(u_sceneTex, clamp(uv - dir, 0.0, 1.0)).b;
  } else {
    col = texture(u_sceneTex, uv).rgb;
  }

  // Bloom glow
  if (u_bloomIntensity > 0.001) {
    col += texture(u_bloomTex, uv).rgb * u_bloomIntensity;
  }

  // Screen-space ambient occlusion (contact shadows & crevice darkening)
  if (u_ssao > 0.001) {
    float dC = linearDepth(uv);
    if (dC < 160.0) {
      vec2 px = 1.0 / u_resolution;
      float radPx = clamp(24.0 / max(dC, 1.0), 3.0, 14.0);
      float occ = 0.0;
      vec2 taps[8];
      taps[0] = vec2(1.0, 0.0);
      taps[1] = vec2(-1.0, 0.0);
      taps[2] = vec2(0.0, 1.0);
      taps[3] = vec2(0.0, -1.0);
      taps[4] = vec2(0.707, 0.707);
      taps[5] = vec2(-0.707, 0.707);
      taps[6] = vec2(0.707, -0.707);
      taps[7] = vec2(-0.707, -0.707);
      for (int i = 0; i < 8; i++) {
        vec2 sUv = clamp(uv + taps[i] * px * radPx, 0.001, 0.999);
        float dS = linearDepth(sUv);
        float diff = dC - dS;
        float range = smoothstep(1.2, 0.05, abs(diff));
        occ += step(0.04, diff) * range;
      }
      float ao = 1.0 - (occ / 8.0) * u_ssao * 0.62;
      col *= clamp(ao, 0.38, 1.0);
    }
  }

  // Screen-space depth/luma Sobel outline across whole world
  if (u_screenOutline > 0.001) {
    vec2 px = 1.0 / u_resolution;
    float dC = linearDepth(uv);
    float dL = linearDepth(uv - vec2(px.x, 0.0));
    float dR = linearDepth(uv + vec2(px.x, 0.0));
    float dU = linearDepth(uv + vec2(0.0, px.y));
    float dD = linearDepth(uv - vec2(0.0, px.y));
    float edge = (abs(dL - dR) + abs(dU - dD)) / max(dC, 0.5);
    float ink = smoothstep(0.08, 0.28, edge) * u_screenOutline;
    col = mix(col, vec3(0.05, 0.04, 0.09), clamp(ink, 0.0, 1.0));
  }

  // Saturation & Noir contrast
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, u_saturation);
  if (u_noir > 0.01) {
    float mono = smoothstep(0.08, 0.92, luma);
    col = mix(col, vec3(mono), u_noir);
  }

  // CRT scanlines
  if (u_crt == 1) {
    float scan = 0.82 + 0.18 * sin(uv.y * u_resolution.y * 1.4);
    col *= scan;
  }

  // Film grain
  if (u_grain > 0.001) {
    float noise = fract(sin(dot(uv * u_resolution + u_time * 60.0, vec2(12.9898, 78.233))) * 43758.5453);
    col += (noise - 0.5) * u_grain;
  }

  // Vignette
  if (u_vignette > 0.001) {
    float d = length(v_uv - 0.5);
    float vig = smoothstep(0.32, 0.85, d);
    col *= (1.0 - vig * u_vignette);
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  return { vertexSource, brightFragmentSource, blurFragmentSource, fragmentSource };
}
