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
        bloomIntensity: 0.28,
        bloomThreshold: 0.78,
        screenOutline: 0,
        ssao: 0.65,
        pixelSize: 1,
        crt: false,
        chromaticAberration: 0,
        vignette: 0.22,
        filmGrain: 0,
        waveStrength: 0,
        saturation: 1.08,
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
uniform int u_hdrInput;
out vec4 fragColor;
void main() {
  vec3 c = texture(u_sceneTex, v_uv).rgb;
  float peak = max(c.r, max(c.g, c.b));
  float thresh = (u_hdrInput == 1) ? max(u_bloomThreshold * 1.15, 0.55) : u_bloomThreshold;
  float knee = thresh * 0.45 + 0.001;
  float soft = clamp(peak - thresh + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee);
  float contrib = max(soft, peak - thresh) / max(peak, 0.0001);
  fragColor = vec4(c * max(contrib, 0.0), 1.0);
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
uniform int u_hdrInput;
uniform float u_underwater;

out vec4 fragColor;

float ignNoise(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

float linearDepth(vec2 uv) {
  float d = texture(u_depthTex, uv).r;
  float z = d * 2.0 - 1.0;
  float near = 0.1;
  float far = 250.0;
  return (2.0 * near * far) / max(far + near - z * (far - near), 0.0001);
}

vec3 viewPosFromUv(vec2 uv, float d, float aspect) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * aspect * 0.62 * d, ndc.y * 0.62 * d, d);
}

float fxaaLuma(vec3 c) {
  vec3 mapped = c / (vec3(1.0) + c);
  return dot(mapped, vec3(0.299, 0.587, 0.114));
}

vec3 sampleSceneFxaa(vec2 uv, vec2 px) {
  vec3 cM = texture(u_sceneTex, uv).rgb;
  vec3 cNW = texture(u_sceneTex, uv + vec2(-px.x,  px.y)).rgb;
  vec3 cNE = texture(u_sceneTex, uv + vec2( px.x,  px.y)).rgb;
  vec3 cSW = texture(u_sceneTex, uv + vec2(-px.x, -px.y)).rgb;
  vec3 cSE = texture(u_sceneTex, uv + vec2( px.x, -px.y)).rgb;
  float lM = fxaaLuma(cM);
  float lNW = fxaaLuma(cNW);
  float lNE = fxaaLuma(cNE);
  float lSW = fxaaLuma(cSW);
  float lSE = fxaaLuma(cSE);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float contrast = lMax - lMin;
  if (contrast < max(0.0312, lMax * 0.125)) return cM;

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
    ((lNW + lSW) - (lNE + lSE))
  );
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpMin, vec2(-4.0), vec2(4.0)) * px;

  vec3 rgbA = 0.5 * (
    texture(u_sceneTex, clamp(uv + dir * (1.0 / 3.0 - 0.5), 0.001, 0.999)).rgb +
    texture(u_sceneTex, clamp(uv + dir * (2.0 / 3.0 - 0.5), 0.001, 0.999)).rgb
  );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(u_sceneTex, clamp(uv + dir * -0.5, 0.001, 0.999)).rgb +
    texture(u_sceneTex, clamp(uv + dir *  0.5, 0.001, 0.999)).rgb
  );
  float lB = fxaaLuma(rgbB);
  return (lB < lMin || lB > lMax) ? rgbA : rgbB;
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
  float activeWave = max(u_wave, u_underwater * 0.0055);
  if (activeWave > 0.0001) {
    uv.x += sin(uv.y * 22.0 + u_time * 3.2) * activeWave;
    uv.y += cos(uv.x * 18.0 + u_time * 2.6) * activeWave * 0.7;
  }

  // Retro pixelation snap across entire screen
  if (u_pixelSize > 1.01) {
    vec2 grid = max(u_resolution / u_pixelSize, vec2(16.0));
    uv = floor(uv * grid) / grid;
  }

  // Chromatic aberration or FXAA-smoothed scene fetch
  vec3 col;
  vec2 px = 1.0 / max(u_resolution, vec2(1.0));
  if (u_chromatic > 0.0001) {
    vec2 dir = (uv - 0.5) * u_chromatic * 2.0;
    col.r = texture(u_sceneTex, clamp(uv + dir, 0.0, 1.0)).r;
    col.g = texture(u_sceneTex, uv).g;
    col.b = texture(u_sceneTex, clamp(uv - dir, 0.0, 1.0)).b;
  } else if (u_pixelSize <= 1.01 && u_crt == 0) {
    col = sampleSceneFxaa(uv, px);
  } else {
    col = texture(u_sceneTex, uv).rgb;
  }

  // Contact-aware SSAO in Linear HDR (rotated 6-tap Poisson kernel + slope bias prevents flat-plane striping)
  if (u_ssao > 0.001) {
    float dC = linearDepth(uv);
    if (dC < 36.0) {
      float aspect = u_resolution.x / max(u_resolution.y, 1.0);
      vec2 px = 1.0 / u_resolution;
      vec2 nStep = px * 2.0;
      float dR = linearDepth(uv + vec2(nStep.x, 0.0));
      float dU = linearDepth(uv + vec2(0.0, nStep.y));
      vec3 pC = viewPosFromUv(uv, dC, aspect);
      vec3 pR = viewPosFromUv(uv + vec2(nStep.x, 0.0), dR, aspect);
      vec3 pU = viewPosFromUv(uv + vec2(0.0, nStep.y), dU, aspect);
      vec3 surfN = normalize(cross(pU - pC, pR - pC));

      float radPx = clamp(22.0 / max(dC, 1.0), 4.0, 14.0);
      float ang = ignNoise(gl_FragCoord.xy) * 6.2831853;
      float ca = cos(ang);
      float sa = sin(ang);
      mat2 rot = mat2(ca, -sa, sa, ca);

      vec2 taps[6];
      taps[0] = vec2( 0.89,  0.22); taps[1] = vec2(-0.74,  0.58);
      taps[2] = vec2(-0.31, -0.91); taps[3] = vec2( 0.56, -0.78);
      taps[4] = vec2( 0.34,  0.42); taps[5] = vec2(-0.46, -0.18);

      float occ = 0.0;
      for (int i = 0; i < 6; i++) {
        vec2 sUv = clamp(uv + (rot * taps[i]) * px * radPx, 0.002, 0.998);
        float dS = linearDepth(sUv);
        vec3 pS = viewPosFromUv(sUv, dS, aspect);
        vec3 vDiff = pS - pC;
        float dist = length(vDiff);
        if (dist > 0.02 && dist < 1.6) {
          float nDot = dot(surfN, vDiff / dist);
          float planeDist = dC - dS;
          float range = smoothstep(1.5, 0.08, dist);
          occ += smoothstep(0.04, 0.24, planeDist) * smoothstep(0.18, 0.55, abs(nDot)) * range;
        }
      }
      float distFade = smoothstep(36.0, 18.0, dC);
      float ao = 1.0 - (occ / 6.0) * u_ssao * 0.85 * distFade;
      col *= clamp(ao, 0.40, 1.0);
    }
  }

  // Optical Bloom glow in Linear HDR
  if (u_bloomIntensity > 0.001) {
    vec3 bloom = texture(u_bloomTex, uv).rgb * u_bloomIntensity;
    if (u_hdrInput == 1) {
      col += bloom;
    } else {
      col = col + bloom * (1.0 - col * 0.45);
    }
  }

  // Screen-space depth Sobel outline
  if (u_screenOutline > 0.001) {
    vec2 px = 1.0 / u_resolution;
    float dC = linearDepth(uv);
    float dL = linearDepth(uv - vec2(px.x, 0.0));
    float dR = linearDepth(uv + vec2(px.x, 0.0));
    float dU = linearDepth(uv + vec2(0.0, px.y));
    float dD = linearDepth(uv - vec2(0.0, px.y));
    float edge = (abs(dL - dR) + abs(dU - dD)) / max(dC, 0.5);
    float ink = smoothstep(0.08, 0.28, edge) * u_screenOutline;
    vec3 inkCol = (u_hdrInput == 1) ? vec3(0.006, 0.005, 0.015) : vec3(0.05, 0.04, 0.09);
    col = mix(col, inkCol, clamp(ink, 0.0, 1.0));
  }

  // Automatic volumetric underwater tint, depth absorption & caustic rays
  if (u_underwater > 0.001) {
    float uwD = linearDepth(uv);
    float uwFog = 1.0 - exp(-uwD * 0.14);
    float ray = 0.5 + 0.5 * sin(uv.x * 16.0 + uv.y * 5.0 + u_time * 2.4) * cos(uv.x * 9.0 - u_time * 1.7);
    vec3 uwColor = (u_hdrInput == 1) ? vec3(0.015, 0.16, 0.28) : vec3(0.05, 0.36, 0.52);
    col = mix(col, uwColor, clamp(uwFog * 0.72 * u_underwater, 0.0, 0.82));
    col += uwColor * (pow(ray, 3.0) * 0.25 * (1.0 - uv.y * 0.6) * u_underwater);
  }

  // Final Filmic ACES Tone Mapping + sRGB Gamma when fed Linear HDR buffer
  if (u_hdrInput == 1) {
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
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

  // Sub-LSB IGN dither eliminates any 8-bit display quantization banding
  col = clamp(col + (ignNoise(gl_FragCoord.xy) - 0.5) / 255.0, 0.0, 1.0);
  fragColor = vec4(col, 1.0);
}
`;

  return { vertexSource, brightFragmentSource, blurFragmentSource, fragmentSource };
}
