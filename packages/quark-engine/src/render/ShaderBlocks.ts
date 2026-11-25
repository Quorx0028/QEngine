import type { ShaderBlockId } from './IRenderBackend';

export const SHADER_BLOCK_IDS: readonly ShaderBlockId[] = [
  'pbrLighting',
  'celLighting',
  'rimLight',
  'fresnelGlow',
  'vertexWave',
  'dissolveNoise',
  'hologramScanline',
  'pixelDither',
  'triplanarGrid',
  'distanceFog',
  'iridescent',
  'matcapNeon',
  'glassRefract',
  'voronoiCaustics',
  'pixelWorld',
  'pulseEmissive',
  'envIBL',
  'microDetail',
  'clearcoat',
  'subsurfaceWrap',
  'terrainSplat',
  'waterSurface',
  'volumetricBeam',
  'surfaceDecal',
] as const;

export interface ComposeShaderConfig {
  blocks: ShaderBlockId[];
  customVertexSnippet?: string;
  customFragmentSnippet?: string;
}

export interface ComposedShaderSource {
  cacheKey: string;
  vertexSource: string;
  fragmentSource: string;
}

const FRAME_GLOBALS_UBO = `
layout(std140) uniform FrameGlobals {
  mat4 u_viewProj;
  mat4 u_lightViewProj;
  mat4 u_spotLightViewProj;
  vec4 u_camPosTime;
  vec4 u_lightDirInt;
  vec4 u_lightColShadow;
  vec4 u_ambientHdr;
  vec4 u_fogColorDens;
  vec4 u_skyTopSpotShad;
  vec4 u_skyHorPad;
  vec4 u_lightCounts;
  vec4 u_pointPosRad[4];
  vec4 u_pointColPad[4];
  vec4 u_spotPosRange[4];
  vec4 u_spotDirInner[4];
  vec4 u_spotColOuter[4];
  vec4 u_dryZones[4];
  vec4 u_dryCeilY;
};
#define u_cameraPos (u_camPosTime.xyz)
#define u_time (u_camPosTime.w)
#define u_lightDir (u_lightDirInt.xyz)
#define u_lightIntensity (u_lightDirInt.w)
#define u_lightColor (u_lightColShadow.xyz)
#define u_shadowsEnabled (int(u_lightColShadow.w + 0.5))
#define u_ambientColor (u_ambientHdr.xyz)
#define u_hdrOutput (int(u_ambientHdr.w + 0.5))
#define u_fogColor (u_fogColorDens.xyz)
#define u_fogDensity (u_fogColorDens.w)
#define u_skyTop (u_skyTopSpotShad.xyz)
#define u_spotShadowEnabled (int(u_skyTopSpotShad.w + 0.5))
#define u_skyHorizon (u_skyHorPad.xyz)
#define u_rainIntensity (u_skyHorPad.w)
#define u_pointLightCount (int(u_lightCounts.x + 0.5))
#define u_spotLightCount (int(u_lightCounts.y + 0.5))
#define u_wetness (u_lightCounts.z)
#define u_cloudCoverage (u_lightCounts.w)
`;

export function composeShader(config: ComposeShaderConfig): ComposedShaderSource {
  const unique = Array.from(new Set(config.blocks));
  const has = (id: ShaderBlockId) => unique.includes(id);

  const cacheKey = `${unique.slice().sort().join('|')}::${config.customVertexSnippet ?? ''}::${config.customFragmentSnippet ?? ''}`;

  const vertexWaveFn = has('vertexWave')
    ? `
vec3 applyVertexWave(vec3 pos, float t, float amp, float freq) {
  float w = sin(pos.x * freq + t * 2.6) * cos(pos.z * freq * 0.8 + t * 2.1);
  return pos + vec3(0.0, w * amp, 0.0);
}
`
    : '';

  const waterVertexFn = has('waterSurface')
    ? `
vec3 gerstnerWave(
  vec3 pos,
  vec2 dir,
  float steepness,
  float wavelength,
  float speedMul,
  float t,
  inout vec3 tangent,
  inout vec3 binormal
) {
  float k = 6.2831853 / max(wavelength, 0.25);
  float c = sqrt(9.8 / k) * speedMul;
  vec2 d = normalize(dir);
  float f = k * (dot(d, pos.xz) - c * t);
  float a = steepness / k;
  float cosF = cos(f);
  float sinF = sin(f);
  tangent += vec3(
    -d.x * d.x * (steepness * sinF),
    d.x * (steepness * cosF),
    -d.x * d.y * (steepness * sinF)
  );
  binormal += vec3(
    -d.x * d.y * (steepness * sinF),
    d.y * (steepness * cosF),
    -d.y * d.y * (steepness * sinF)
  );
  return vec3(d.x * (a * cosF), a * sinF, d.y * (a * cosF));
}
`
    : '';

  const vertexSource = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 4) in vec4 a_joints;
layout(location = 5) in vec4 a_weights;
layout(location = 6) in vec4 a_instMat0;
layout(location = 7) in vec4 a_instMat1;
layout(location = 8) in vec4 a_instMat2;
layout(location = 9) in vec4 a_instMat3;

${FRAME_GLOBALS_UBO}
uniform mat4 u_model;
uniform float u_waveAmp;
uniform float u_waveFreq;
uniform float u_waterChoppiness;
uniform vec2 u_uvScale;
uniform int u_skinned;
uniform int u_instanced;
uniform mat4 u_boneMatrices[64];

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv;
out vec4 v_shadowCoord;
out vec4 v_spotShadowCoord;
out float v_waveCrest;
out float v_waterFace;

${vertexWaveFn}
${waterVertexFn}

void main() {
  vec3 localPos = a_position;
  vec3 localNormal = a_normal;
  v_waveCrest = 0.0;
  v_waterFace = 1.0;
  if (u_skinned == 1) {
    float wSum = a_weights.x + a_weights.y + a_weights.z + a_weights.w;
    if (wSum > 0.0001) {
      mat4 skinMat =
        a_weights.x * u_boneMatrices[clamp(int(a_joints.x + 0.5), 0, 63)] +
        a_weights.y * u_boneMatrices[clamp(int(a_joints.y + 0.5), 0, 63)] +
        a_weights.z * u_boneMatrices[clamp(int(a_joints.z + 0.5), 0, 63)] +
        a_weights.w * u_boneMatrices[clamp(int(a_joints.w + 0.5), 0, 63)];
      localPos = (skinMat * vec4(localPos, 1.0)).xyz;
      localNormal = normalize(mat3(skinMat) * localNormal);
    }
  }
  ${has('vertexWave') && !has('waterSurface') ? 'localPos = applyVertexWave(localPos, u_time, u_waveAmp, u_waveFreq);' : ''}
  ${
    has('waterSurface')
      ? `
  v_waterFace = step(0.5, a_normal.y);
  float waveWeight = (abs(a_position.y) < 0.001) ? 1.0 : smoothstep(-0.02, 0.02, a_position.y);
  vec3 gTan = vec3(1.0, 0.0, 0.0);
  vec3 gBin = vec3(0.0, 0.0, 1.0);
  float wBase = max(u_waveFreq, 0.25);
  float chop = clamp(u_waterChoppiness, 0.05, 1.2);
  float ampScale = clamp(u_waveAmp * 8.5, 0.0, 2.2);
  vec3 wDisp = vec3(0.0);
  wDisp += gerstnerWave(localPos, vec2(1.0, 0.37), 0.17 * chop * ampScale, 4.9 / wBase, 1.15, u_time, gTan, gBin);
  wDisp += gerstnerWave(localPos, vec2(-0.61, 0.79), 0.14 * chop * ampScale, 3.15 / wBase, 1.42, u_time, gTan, gBin);
  wDisp += gerstnerWave(localPos, vec2(0.39, -0.92), 0.11 * chop * ampScale, 1.92 / wBase, 1.78, u_time, gTan, gBin);
  wDisp += gerstnerWave(localPos, vec2(-0.86, -0.51), 0.08 * chop * ampScale, 1.18 / wBase, 2.15, u_time, gTan, gBin);
  localPos += wDisp * waveWeight;
  if (v_waterFace > 0.5) {
    localNormal = normalize(cross(gBin, gTan));
  }
  v_waveCrest = clamp((wDisp.y / max(u_waveAmp * 1.15, 0.015)) * 0.5 + 0.5, 0.0, 1.0);
  `
      : ''
  }
  ${config.customVertexSnippet ?? ''}
  mat4 modelMat = (u_instanced == 1) ? mat4(a_instMat0, a_instMat1, a_instMat2, a_instMat3) : u_model;
  vec4 world = modelMat * vec4(localPos, 1.0);
  v_worldPos = world.xyz;
  v_normal = normalize(transpose(inverse(mat3(modelMat))) * localNormal);
  v_uv = a_uv * u_uvScale;
  v_shadowCoord = u_lightViewProj * vec4(world.xyz + v_normal * 0.05, 1.0);
  v_spotShadowCoord = u_spotLightViewProj * vec4(world.xyz + v_normal * 0.04, 1.0);
  gl_Position = u_viewProj * world;
}
`;

  const blockSnippets: string[] = [];

  if (has('triplanarGrid')) {
    blockSnippets.push(`
vec3 evalTriplanarGrid(vec3 baseAlbedo, vec3 wp, float scale) {
  vec2 g = abs(fract(wp.xz * scale - 0.5) - 0.5) / max(fwidth(wp.xz * scale), vec2(0.001));
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float checker = mod(floor(wp.x * scale * 0.5) + floor(wp.z * scale * 0.5), 2.0);
  vec3 tint = mix(baseAlbedo * 0.88, baseAlbedo * 1.08, checker);
  return mix(tint, baseAlbedo * 1.45 + vec3(0.08), line * 0.45);
}
`);
  }

  if (has('pbrLighting')) {
    blockSnippets.push(`
vec3 evalPbrLighting(vec3 albedoLin, vec3 n, vec3 v, vec3 l, vec3 lColorLin, float lInt, vec3 ambLin, float metallic, float roughness, float cc, float ccR, float sss, float shadow) {
  vec3 direct = evalCookTorranceDirect(albedoLin, n, v, l, lColorLin * (lInt * 2.35), metallic, roughness, cc, ccR, sss) * shadow;
  float skyBlend = smoothstep(-0.55, 0.85, n.y);
  vec3 hemi = mix(ambLin * 0.42, ambLin * 1.15, skyBlend) * albedoLin * (1.0 - metallic * 0.65) * 1.35;
  return direct + hemi;
}
`);
  }

  if (has('celLighting')) {
    blockSnippets.push(`
vec3 evalCelLighting(vec3 albedo, vec3 n, vec3 v, vec3 l, vec3 lColor, float lInt, vec3 amb, vec3 shadowTint, float steps, float shadow) {
  float rawNdl = dot(n, l);
  float shadowWeight = smoothstep(-0.04, 0.16, rawNdl);
  float effShadow = mix(1.0, shadow, shadowWeight);
  float ndotl = clamp(rawNdl * 0.5 + 0.5, 0.0, 1.0) * mix(0.45, 1.0, effShadow);
  float bands = max(steps, 2.0);
  float scaled = clamp(ndotl, 0.0, 0.999) * bands;
  float bandIdx = floor(scaled);
  float bandFrac = smoothstep(0.0, 0.12, fract(scaled));
  float q = mix(bandIdx, min(bandIdx + 1.0, bands - 1.0), bandFrac * 0.25) / max(bands - 1.0, 1.0);
  vec3 coolShadow = albedo * mix(vec3(0.48), shadowTint, 0.72) * 0.88 + amb * albedo * 0.26;
  vec3 warmLit = albedo * lColor * clamp(lInt, 0.7, 1.02) * 0.94;
  vec3 diffuse = mix(coolShadow, warmLit, smoothstep(0.08, 0.92, q));
  vec3 h = normalize(l + v);
  float spec = smoothstep(0.91, 0.95, max(dot(n, h), 0.0)) * 0.22 * effShadow;
  return diffuse + lColor * spec + amb * albedo * 0.14;
}
`);
  }

  if (has('rimLight')) {
    blockSnippets.push(`
vec3 evalRimLight(vec3 n, vec3 v, vec3 rimColor, float power) {
  float rim = pow(1.0 - max(dot(n, v), 0.0), max(power, 0.5));
  return rimColor * smoothstep(0.35, 0.85, rim);
}
`);
  }

  if (has('fresnelGlow')) {
    blockSnippets.push(`
vec3 evalFresnelGlow(vec3 n, vec3 v, vec3 glowColor, float power) {
  float f = pow(1.0 - max(dot(n, v), 0.0), max(power, 0.5));
  return glowColor * f;
}
`);
  }

  if (has('iridescent')) {
    blockSnippets.push(`
vec3 evalIridescent(vec3 n, vec3 v, vec3 wp, float t) {
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float phase = (1.0 - ndv) * 4.8 + wp.y * 0.35 + t * 0.8;
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (phase + vec3(0.0, 0.33, 0.67)));
  return rainbow * mix(0.25, 0.95, 1.0 - ndv);
}
`);
  }

  if (has('matcapNeon')) {
    blockSnippets.push(`
vec3 evalMatcapNeon(vec3 n, vec3 v, vec3 wp, vec3 glowColor, float t) {
  float edge = pow(1.0 - max(dot(n, v), 0.0), 1.6);
  vec3 grid = abs(fract(wp * 1.25 - 0.5) - 0.5) / max(fwidth(wp * 1.25), vec3(0.002));
  float wire = 1.0 - min(min(grid.x, grid.y), min(grid.z, 1.0));
  float pulse = 0.75 + 0.25 * sin(t * 3.2 + wp.y * 2.0);
  return glowColor * (edge * 1.1 + wire * 0.95) * pulse;
}
`);
  }

  if (has('glassRefract')) {
    blockSnippets.push(`
vec3 evalGlassRefract(vec3 n, vec3 v, vec3 l, vec3 glowColor) {
  float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 refl = reflect(-v, n);
  float skyRefl = smoothstep(-0.2, 0.8, refl.y);
  vec3 h = normalize(l + v);
  float spark = pow(max(dot(n, h), 0.0), 96.0) * 1.8;
  return mix(glowColor * 0.3, vec3(0.85, 0.95, 1.0), skyRefl) * (0.35 + fresnel * 0.9) + vec3(spark);
}
`);
  }

  if (has('voronoiCaustics')) {
    blockSnippets.push(`
float evalVoronoiCaustics(vec3 wp, float t) {
  vec2 p = wp.xz * 1.3 + wp.y * 0.45;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float minD = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 h = fract(sin(vec2(dot(i + g, vec2(127.1, 311.7)), dot(i + g, vec2(269.5, 183.3)))) * 43758.5453);
      vec2 o = 0.5 + 0.45 * sin(t * 1.8 + 6.2831 * h);
      float d = length(g + o - f);
      minD = min(minD, d);
    }
  }
  return pow(clamp(1.0 - minD, 0.0, 1.0), 3.0);
}
`);
  }

  if (has('pixelWorld')) {
    blockSnippets.push(`
vec3 evalPixelWorld(vec3 wp, vec3 col) {
  vec3 q = floor(wp * 4.0) / 4.0;
  float band = fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  return col * (0.86 + 0.24 * band);
}
`);
  }

  if (has('pulseEmissive')) {
    blockSnippets.push(`
vec3 evalPulseEmissive(vec3 wp, vec3 glowColor, float t) {
  float p = 0.5 + 0.5 * sin(t * 4.0 + wp.y * 3.0);
  return glowColor * (0.2 + p * 0.75);
}
`);
  }

  if (has('terrainSplat')) {
    blockSnippets.push(`
vec3 evalTerrainSplat(vec3 baseAlbedo, vec3 wp, vec3 n) {
  float slope = clamp(1.0 - n.y, 0.0, 1.0);
  float rockMask = smoothstep(0.16, 0.42, slope);
  float dirtMask = smoothstep(3.5, 0.2, wp.y) * (1.0 - rockMask) * 0.45;
  vec3 grass = vec3(0.24, 0.44, 0.19) * baseAlbedo * 1.15;
  vec3 dirt = vec3(0.38, 0.29, 0.20) * baseAlbedo * 1.1;
  vec3 rock = vec3(0.42, 0.43, 0.46);
  vec3 ground = mix(grass, dirt, dirtMask);
  return mix(ground, rock, rockMask);
}
`);
  }

  if (has('dissolveNoise') || has('microDetail') || has('waterSurface') || has('volumetricBeam') || has('surfaceDecal')) {
    blockSnippets.push(`
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1,0,0));
  float n010 = hash31(i + vec3(0,1,0));
  float n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1));
  float n101 = hash31(i + vec3(1,0,1));
  float n011 = hash31(i + vec3(0,1,1));
  float n111 = hash31(i + vec3(1,1,1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}
`);
  }

  if (has('microDetail')) {
    blockSnippets.push(`
void applyMicroDetail(vec3 wp, vec3 camPos, float bumpScale, inout vec3 n, inout float roughness) {
  float dist = length(camPos - wp);
  float fade = smoothstep(16.0, 2.0, dist);
  if (fade <= 0.01) return;
  float macro = valueNoise3(wp * 1.35) * 0.65 + valueNoise3(wp * 3.8) * 0.35;
  float e = 0.04;
  float hC = valueNoise3(wp * 4.8);
  float hx = valueNoise3((wp + vec3(e, 0.0, 0.0)) * 4.8) - hC;
  float hz = valueNoise3((wp + vec3(0.0, 0.0, e)) * 4.8) - hC;
  float bStr = max(bumpScale, 0.0) * fade * smoothstep(0.12, 0.85, roughness);
  n = normalize(n + vec3(-hx, 0.0, -hz) * (bStr / e));
  roughness = clamp(roughness + (macro - 0.5) * 0.07 * fade, 0.045, 0.96);
}
`);
  }

  if (has('envIBL')) {
    blockSnippets.push(`
vec3 evalEnvIBL(vec3 albedoLin, vec3 n, vec3 v, vec3 l, vec3 lColorLin, vec3 skyTopLin, vec3 skyHorizLin, float metallic, float roughness, float cc, float ccR) {
  vec3 r = reflect(-v, n);
  float ndotv = max(dot(n, v), 0.001);
  float skyT = smoothstep(0.0, 0.72, r.y);
  vec3 groundCol = mix(skyHorizLin * 0.22, vec3(0.04, 0.042, 0.048), 0.75);
  vec3 horizonCol = mix(skyHorizLin, vec3(0.62, 0.68, 0.76), 0.15);
  vec3 zenithCol = skyTopLin;
  vec3 envUp = mix(horizonCol, zenithCol, skyT);
  float groundT = smoothstep(0.06, -0.38, r.y);
  vec3 envCol = mix(envUp, groundCol, groundT);
  float specExp = mix(240.0, 6.0, roughness * roughness);
  float sunSpec = pow(max(dot(r, l), 0.0), specExp) * (1.0 - roughness * 0.82) * 1.15;
  envCol += lColorLin * sunSpec;

  vec3 f0 = mix(vec3(0.04), albedoLin, metallic);
  vec3 fresnel = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - ndotv, 5.0);
  // Roughness-attenuated specular reflection (no chalky wash on diffuse surfaces)
  vec3 envSpec = envCol * fresnel * mix(0.95, 0.12, roughness * roughness);
  vec3 irr = mix(groundCol * 0.55, skyHorizLin * 0.42, n.y * 0.5 + 0.5) * albedoLin * (1.0 - metallic) * 0.34;
  vec3 outIbl = irr + envSpec;
  if (cc > 0.001) {
    float fCc = 0.04 + 0.96 * pow(1.0 - ndotv, 5.0);
    float ccSun = pow(max(dot(r, l), 0.0), mix(360.0, 14.0, ccR * ccR)) * (1.0 - ccR * 0.7);
    vec3 ccEnv = mix(envUp, groundCol, groundT) + lColorLin * ccSun;
    outIbl += ccEnv * fCc * cc * mix(0.9, 0.15, ccR);
  }
  return outIbl;
}
`);
  }

  if (has('hologramScanline')) {
    blockSnippets.push(`
float evalHologramScanline(vec3 wp, float t) {
  float scan = 0.7 + 0.3 * sin((wp.y * 18.0 + wp.x * 4.0 + wp.z * 4.0) - t * 8.0);
  float pulse = 0.92 + 0.08 * sin(t * 16.0);
  return scan * pulse;
}
`);
  }

  if (has('pixelDither')) {
    blockSnippets.push(`
vec3 applyPixelDither(vec3 col, vec2 fragCoord, float strength) {
  int x = int(mod(fragCoord.x, 4.0));
  int y = int(mod(fragCoord.y, 4.0));
  int idx = y * 4 + x;
  float bayer = (float(idx) / 16.0) - 0.5;
  vec3 dithered = clamp(col + bayer * strength * 0.16, 0.0, 1.0);
  float levels = mix(32.0, 6.0, clamp(strength, 0.0, 1.0));
  return floor(dithered * levels + 0.5) / levels;
}
`);
  }

  if (has('distanceFog')) {
    blockSnippets.push(`
vec3 applyDistanceFog(vec3 col, float dist, vec3 fogColor, float density) {
  float f = 1.0 - exp(-dist * dist * density * density);
  return mix(col, fogColor, clamp(f, 0.0, 1.0));
}
`);
  }

  if (has('waterSurface')) {
    blockSnippets.push(`
void evalWaterSurface(
  vec3 shallowLin,
  vec3 deepLin,
  vec3 glowLin,
  vec3 wp,
  vec2 uv,
  float waveCrest,
  float waterFace,
  inout vec3 n,
  vec3 v,
  vec3 l,
  vec3 lColLin,
  float lInt,
  vec3 skyTopLin,
  vec3 skyHorizLin,
  float style,
  float foamAmt,
  float choppiness,
  float clarity,
  float fresnelPow,
  float shadow,
  out vec3 outColor,
  out float outAlpha
) {
  // Side & bottom volumetric tank walls (coupled seamlessly to wave perimeter)
  if (waterFace < 0.5) {
    float wallY = clamp(uv.y, 0.0, 1.0);
    float causticBand = valueNoise3(vec3(wp.xz * 2.2 + vec2(u_time * 0.35, -u_time * 0.25), wp.y * 1.8 - u_time * 0.5));
    vec3 volCol = mix(deepLin * 0.9, shallowLin * 0.85, wallY);
    volCol += glowLin * (smoothstep(0.55, 0.92, causticBand) * 0.24 * wallY);
    float sideFresnel = pow(1.0 - max(dot(n, v), 0.05), 3.0);
    volCol = mix(volCol, skyHorizLin * 0.65, sideFresnel * 0.38 * (1.0 - style * 0.5));
    outColor = volCol;
    outAlpha = clamp(mix(0.84, 0.42, clamp(clarity, 0.0, 1.0)) + sideFresnel * 0.15, 0.32, 0.92);
    return;
  }

  // Fast analytical capillary ripples (replaces 10x expensive 3D valueNoise calls per water pixel!)
  float n1 = puddleNoise2(wp.xz * 2.4 + vec2(u_time * 0.45, u_time * 0.28));
  float n2 = puddleNoise2(wp.xz * 5.8 - vec2(u_time * 0.62, -u_time * 0.48));
  vec2 rw1 = wp.xz * 5.6 + vec2(u_time * 2.2, u_time * 1.4);
  vec2 rw2 = wp.xz * 9.2 - vec2(u_time * 2.8, -u_time * 1.9);
  vec2 rw3 = wp.xz * 14.5 + vec2(-u_time * 3.1, u_time * 2.4);
  float gx = cos(rw1.x + 0.5 * sin(rw1.y)) * 0.55 + cos(rw2.x * 0.8 - rw2.y * 0.6) * 0.35 + cos(rw3.x * 0.7 + rw3.y * 0.7) * 0.22;
  float gz = sin(rw1.y + 0.5 * cos(rw1.x)) * 0.55 - cos(rw2.y * 0.8 + rw2.x * 0.6) * 0.35 + sin(rw3.y * 0.7 - rw3.x * 0.7) * 0.22;
  float rippleStrength = mix(1.0, 0.28, style) * (0.28 + choppiness * 0.72);
  n = normalize(n + vec3(-gx, 0.0, -gz) * (0.26 * rippleStrength));
  float rainRingGlow = 0.0;
  if (u_rainIntensity > 0.01) {
    vec2 rGrad = vec2(0.0);
    evalRainRipples(wp.xz * 0.85, u_time, u_rainIntensity, rGrad, rainRingGlow);
    n = normalize(n + vec3(rGrad.x, 0.0, rGrad.y) * 0.65);
  }

  float ndotv = max(dot(n, v), 0.02);
  float fresnelReal = clamp(0.02 + 0.98 * pow(1.0 - ndotv, max(fresnelPow, 2.0)), 0.0, 1.0);
  float fresnelToon = smoothstep(0.46, 0.54, 1.0 - ndotv);
  float fresnel = mix(fresnelReal, fresnelToon, style);

  vec3 r = reflect(-v, n);
  float skyMix = smoothstep(-0.02, 0.65, r.y);
  vec3 reflCol = mix(skyHorizLin, skyTopLin, skyMix);
  float sunSpecReal = pow(max(dot(r, l), 0.0), mix(240.0, 520.0, clamp(choppiness, 0.0, 1.0))) * 3.2 * shadow;
  float sunSpecToon = smoothstep(0.955, 0.972, max(dot(r, l), 0.0)) * 1.45 * shadow;
  vec3 specCol = lColLin * max(lInt, 0.45) * mix(sunSpecReal, sunSpecToon, style);

  // Depth absorption & anime stepped water bands
  float edgeDist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float shallowEdge = 1.0 - smoothstep(0.01, 0.14, edgeDist);
  float depthMix = mix(clamp(1.0 - waveCrest * 0.55 - shallowEdge * 0.4, 0.0, 1.0), smoothstep(0.32, 0.68, 1.0 - waveCrest), style);
  vec3 waterBody = mix(shallowLin, deepLin, depthMix);
  waterBody *= (0.42 + 0.58 * clamp(dot(n, l) * 0.5 + 0.5, 0.0, 1.0) * mix(0.65, 1.0, shadow));
  waterBody += glowLin * (0.09 * waveCrest + 0.03 * n1) * (1.0 - style * 0.5);

  vec3 realMix = mix(waterBody, reflCol, fresnel * 0.88) + specCol + lColLin * (rainRingGlow * 0.42);
  vec3 animeBand = mix(shallowLin * 1.12, deepLin * 1.15, smoothstep(0.38, 0.46, fresnel * 0.6 + (1.0 - waveCrest) * 0.5));
  vec3 animeMix = mix(animeBand, reflCol * 0.9 + glowLin * 0.25, fresnel * 0.45) + specCol + vec3(0.85, 0.95, 1.0) * (rainRingGlow * 0.55);
  vec3 litWater = mix(realMix, animeMix, style);

  // Crisp realistic peak foam & anime Ghibli shoreline foam (zero muddy clouds on calm water!)
  float frothNoise = n1 * 0.55 + n2 * 0.45;
  float crestMaskReal = smoothstep(0.84, 0.99, waveCrest + (frothNoise - 0.5) * 0.16);
  float crestMaskToon = smoothstep(0.70, 0.75, waveCrest + (frothNoise - 0.5) * 0.24);
  float shoreWaveReal = 1.0 - smoothstep(0.0, 0.032 + 0.012 * sin(u_time * 3.1 + frothNoise * 6.0), edgeDist);
  float shoreWaveToon = 1.0 - smoothstep(0.0, 0.085 + 0.025 * sin(u_time * 3.1 + frothNoise * 6.0), edgeDist);
  float shoreFoamReal = shoreWaveReal * smoothstep(0.45, 0.78, frothNoise);
  float shoreFoamToon = smoothstep(0.45, 0.52, shoreWaveToon * frothNoise * 1.45);
  float foam = clamp((mix(crestMaskReal, crestMaskToon, style) + mix(shoreFoamReal, shoreFoamToon, style)) * foamAmt, 0.0, 1.0);
  vec3 foamCol = mix(vec3(0.90, 0.96, 1.0), vec3(0.98, 0.99, 1.0), style) * (0.68 + 0.32 * max(dot(n, l), 0.25));

  outColor = mix(litWater, foamCol, foam);
  float baseAlpha = mix(0.88, 0.34, clamp(clarity, 0.0, 1.0));
  outAlpha = clamp(mix(baseAlpha, 0.96, fresnel * 0.65 + foam * 0.85), 0.24, 0.98);
}
`);
  }

  const lightingBody = has('volumetricBeam')
    ? `
  float ndotvBeam = abs(dot(n, v));
  float edgeFade = pow(clamp(ndotvBeam, 0.0, 1.0), 1.65);
  float vFade = smoothstep(0.0, 0.25, v_uv.y) * smoothstep(1.0, 0.08, v_uv.y);
  float swirl = valueNoise3(vec3(v_worldPos * 1.45 + vec3(0.0, u_time * 0.28, 0.0)));
  color = srgbToLin(u_glowColor) * (0.65 + 0.55 * swirl);
  alpha = clamp(u_baseColor.a * edgeFade * vFade * (0.7 + 0.45 * swirl), 0.0, 1.0);
`
    : has('surfaceDecal')
      ? `
  vec2 dUv = v_uv * 2.0 - 1.0;
  float r = length(dUv);
  if (r > 0.98) discard;
  float nCrack = valueNoise3(vec3(dUv * 5.2, u_dissolve * 10.0));
  float ring = smoothstep(0.68, 0.78, r) * (1.0 - smoothstep(0.84, 0.96, r));
  float core = 1.0 - smoothstep(0.18, 0.85, r + (nCrack - 0.5) * 0.35);
  float crackLine = 1.0 - smoothstep(0.0, 0.14, abs(sin(atan(dUv.y, dUv.x) * 6.0 + nCrack * 4.5)));
  vec3 scorchCol = albedoLin * (0.45 + 0.55 * shadowFactor);
  vec3 emberCol = srgbToLin(u_glowColor) * (ring * 1.45 + crackLine * (1.0 - r) * 0.75);
  color = mix(scorchCol, emberCol, clamp(ring + crackLine * 0.4, 0.0, 1.0));
  alpha = clamp((core * 0.85 + ring * 0.9) * u_baseColor.a, 0.0, 1.0);
`
      : has('waterSurface')
    ? `vec3 _wCol = vec3(0.0); float _wAlpha = alpha; evalWaterSurface(albedoLin, srgbToLin(u_edgeColor), srgbToLin(u_glowColor), v_worldPos, v_uv, v_waveCrest, v_waterFace, n, v, l, lColLin, u_lightIntensity, skyTopLin, skyHorizLin, clamp(u_waterStyle, 0.0, 1.0), max(u_waterFoam, 0.0), clamp(u_waterChoppiness, 0.0, 1.2), clamp(u_waterClarity, 0.0, 1.0), u_fresnelPower, shadowFactor, _wCol, _wAlpha); color = _wCol; alpha = _wAlpha;`
    : has('celLighting')
    ? `color = evalCelLighting(albedoLin, n, v, l, lColLin * 1.45, u_lightIntensity, ambLin * 1.45, shadowTintLin, u_celSteps, shadowFactor);`
    : has('pbrLighting')
      ? `color = evalPbrLighting(albedoLin, n, v, l, lColLin, u_lightIntensity, ambLin, matMetallic, matRoughness, matClearcoat, matClearcoatRoughness, matSubsurface, shadowFactor);`
      : `color = albedoLin * (max(dot(n, l), 0.0) * lColLin * u_lightIntensity * 1.8 * shadowFactor + ambLin * 1.4);`;

  const fragmentSource = `#version 300 es
precision highp float;

in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv;
in vec4 v_shadowCoord;
in vec4 v_spotShadowCoord;
in float v_waveCrest;
in float v_waterFace;

${FRAME_GLOBALS_UBO}
uniform sampler2D u_shadowMap;
uniform sampler2D u_spotShadowMap;

uniform vec4 u_baseColor;
uniform vec3 u_shadowTint;
uniform vec3 u_rimColor;
uniform vec3 u_glowColor;
uniform vec3 u_edgeColor;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_celSteps;
uniform float u_rimPower;
uniform float u_fresnelPower;
uniform float u_dissolve;
uniform float u_ditherStrength;
uniform float u_gridScale;
uniform float u_clearcoat;
uniform float u_clearcoatRoughness;
uniform float u_subsurface;
uniform float u_bumpScale;
uniform float u_waterStyle;
uniform float u_waterFoam;
uniform float u_waterChoppiness;
uniform float u_waterClarity;
uniform int u_hasTexture;
uniform sampler2D u_tex;
uniform int u_hasNormalMap;
uniform sampler2D u_normalMap;
uniform int u_hasMetallicRoughnessMap;
uniform sampler2D u_metallicRoughnessMap;
uniform int u_hasEmissiveMap;
uniform sampler2D u_emissiveMap;
uniform vec3 u_emissiveColor;

out vec4 fragColor;

float ignNoise(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

vec2 hash22R(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float puddleNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float evalPuddleFbm(vec2 p) {
  return puddleNoise2(p) * 0.65 + puddleNoise2(p * 2.15 + 3.7) * 0.35;
}

void evalRainRipples(vec2 wpXZ, float t, float intensity, out vec2 grad, out float ringGlow) {
  grad = vec2(0.0);
  ringGlow = 0.0;
  float k = clamp(intensity, 0.0, 1.5);
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 1.05 : 1.75;
    float speed = layer == 0 ? 1.55 : 2.15;
    vec2 uv = wpXZ * scale + vec2(float(layer) * 11.3, float(layer) * 7.1);
    vec2 cell = floor(uv);
    vec2 local = fract(uv);
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 cId = cell + vec2(float(ox), float(oy));
        vec2 rnd = hash22R(cId);
        float phase = fract(t * speed + rnd.x * 6.283 + rnd.y * 1.7);
        vec2 center = vec2(float(ox), float(oy)) + 0.15 + rnd * 0.7;
        vec2 delta = local - center;
        float dist = length(delta);
        float rad = phase * 0.62;
        float diff = dist - rad;
        float env = exp(-diff * diff * 180.0) * (1.0 - phase) * smoothstep(0.02, 0.1, dist);
        float wave = sin(diff * 46.0);
        vec2 dir = dist > 0.001 ? delta / dist : vec2(0.0);
        grad += dir * (wave * env * k * 0.72);
        ringGlow += env * clamp(wave * 0.5 + 0.5, 0.0, 1.0) * k * 0.18;
      }
    }
  }
}

vec3 srgbToLin(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(2.2));
}

vec3 linToSrgb(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
}

vec3 acesToneMap(vec3 c) {
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
}

// Heitz Height-Correlated Smith-GGX Visibility = G / (4 * NdotV * NdotL)
float vSmithGGXCorrelated(float ndotv, float ndotl, float a2) {
  float ggxv = ndotl * sqrt(ndotv * ndotv * (1.0 - a2) + a2);
  float ggxl = ndotv * sqrt(ndotl * ndotl * (1.0 - a2) + a2);
  return 0.5 / max(ggxv + ggxl, 0.0001);
}

vec3 evalCookTorranceDirect(
  vec3 albedoLin,
  vec3 n,
  vec3 v,
  vec3 l,
  vec3 lRadiance,
  float metallic,
  float roughness,
  float cc,
  float ccR,
  float sss
) {
  float rawNdl = dot(n, l);
  float ndotl = max(rawNdl, 0.0);
  float ndotv = max(dot(n, v), 0.001);
  vec3 h = normalize(l + v);
  float ndoth = max(dot(n, h), 0.0);
  float hdotv = max(dot(h, v), 0.0);

  vec3 outCol = vec3(0.0);
  if (ndotl > 0.0) {
    float r = clamp(roughness, 0.045, 1.0);
    float a = r * r;
    float a2 = a * a;
    float dDen = ndoth * ndoth * (a2 - 1.0) + 1.0;
    float d = a2 / (3.14159265 * dDen * dDen + 0.0001);
    float vis = vSmithGGXCorrelated(ndotv, ndotl, a2);
    vec3 f0 = mix(vec3(0.04), albedoLin, metallic);
    vec3 f = f0 + (1.0 - f0) * pow(1.0 - hdotv, 5.0);
    // Multi-scattering energy compensation for rough metals
    vec3 spec = (d * vis) * f * (1.0 + f0 * (r * 0.45));
    vec3 kd = (vec3(1.0) - f) * (1.0 - metallic);
    outCol += (kd * albedoLin / 3.14159265 + spec) * lRadiance * ndotl;

    if (cc > 0.001) {
      float rc = clamp(ccR, 0.04, 1.0);
      float ac = rc * rc;
      float ac2 = ac * ac;
      float dDenC = ndoth * ndoth * (ac2 - 1.0) + 1.0;
      float dc = ac2 / (3.14159265 * dDenC * dDenC + 0.0001);
      float visc = vSmithGGXCorrelated(ndotv, ndotl, ac2);
      float fc = 0.04 + 0.96 * pow(1.0 - hdotv, 5.0);
      outCol += vec3(dc * visc * fc * cc) * lRadiance * ndotl;
    }
  }

  if (sss > 0.001) {
    float wrap = clamp((rawNdl + 0.45) / 1.45, 0.0, 1.0);
    float scatter = pow(max(dot(v, -l + n * 0.35), 0.0), 3.0);
    outCol += albedoLin * (wrap * 0.35 + scatter * 0.65) * lRadiance * sss * 0.55;
  }
  return outCol;
}

float evalShadowMap(sampler2D smap, vec4 sc, vec3 n, vec3 l) {
  vec3 proj = sc.xyz / max(sc.w, 0.0001) * 0.5 + 0.5;
  if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0 || proj.z < 0.0) {
    return 1.0;
  }
  float bias = max(0.0020 * (1.0 - max(dot(n, l), 0.0)), 0.0004);
  vec2 ts = 1.0 / vec2(textureSize(smap, 0));
  float z = proj.z - bias;
  float ang = ignNoise(gl_FragCoord.xy) * 6.2831853;
  vec2 radius = ts * 2.35;

  // 6-tap Vogel Disk PCF (golden angle spiral avoids grid patterns while cutting shadow ALU by 40%)
  float sum = 0.0;
  for (int i = 0; i < 6; i++) {
    float r = sqrt((float(i) + 0.5) / 6.0);
    float theta = float(i) * 2.39996323 + ang;
    vec2 offset = vec2(cos(theta), sin(theta)) * r * radius;
    sum += (z <= texture(smap, proj.xy + offset).r) ? 1.0 : 0.0;
  }
  return sum * 0.1666667;
}

float evalShadow(vec4 sc, vec3 n, vec3 l) {
  if (u_shadowsEnabled == 0) return 1.0;
  return evalShadowMap(u_shadowMap, sc, n, l);
}

vec3 perturbNormal(vec3 n, vec3 wp, vec2 uv, vec3 mapN) {
  vec3 dp1 = dFdx(wp);
  vec3 dp2 = dFdy(wp);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n);
  vec3 dp1perp = cross(n, dp1);
  vec3 t = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 b = dp2perp * duv1.y + dp1perp * duv2.y;
  float maxLen = max(dot(t, t), dot(b, b));
  if (maxLen < 1e-12) return n;
  float invMax = inversesqrt(maxLen);
  mat3 tbn = mat3(t * invMax, b * invMax, n);
  return normalize(tbn * mapN);
}

vec3 evalPointLights(vec3 albedoLin, vec3 wp, vec3 n, vec3 v, float metallic, float roughness, float cc, float ccR, float sss, float cel) {
  vec3 acc = vec3(0.0);
  int count = u_pointLightCount;
  for (int i = 0; i < 4; i++) {
    if (i >= count) break;
    vec3 toL = u_pointPosRad[i].xyz - wp;
    float d = length(toL);
    float r = max(u_pointPosRad[i].w, 0.1);
    if (d >= r) continue;
    vec3 ld = toL / max(d, 0.001);
    float dNorm = d / r;
    float win = clamp(1.0 - dNorm * dNorm, 0.0, 1.0);
    float att = (win * win) / (1.0 + d * d * 0.45);
    vec3 lColLin = srgbToLin(u_pointColPad[i].rgb) * (att * 3.1);
    if (cel > 0.5) {
      float ndl = floor(max(dot(n, ld), 0.0) * 2.99) / 2.0;
      vec3 h = normalize(ld + v);
      float sp = smoothstep(0.91, 0.95, max(dot(n, h), 0.0)) * 0.25;
      acc += (albedoLin * ndl + vec3(sp)) * lColLin * 0.45;
    } else {
      acc += evalCookTorranceDirect(albedoLin, n, v, ld, lColLin, metallic, roughness, cc, ccR, sss);
    }
  }
  return acc;
}

vec3 evalSpotLights(vec3 albedoLin, vec3 wp, vec3 n, vec3 v, float metallic, float roughness, float cc, float ccR, float sss, float cel, vec4 spotSc) {
  vec3 acc = vec3(0.0);
  int count = u_spotLightCount;
  for (int i = 0; i < 4; i++) {
    if (i >= count) break;
    vec3 toL = u_spotPosRange[i].xyz - wp;
    float d = length(toL);
    float r = max(u_spotPosRange[i].w, 0.1);
    if (d >= r) continue;
    vec3 ld = toL / max(d, 0.001);
    float theta = dot(-ld, normalize(u_spotDirInner[i].xyz));
    float outerC = u_spotColOuter[i].w;
    float innerC = u_spotDirInner[i].w;
    float cone = clamp((theta - outerC) / max(innerC - outerC, 0.001), 0.0, 1.0);
    if (cone <= 0.001) continue;
    float dNorm = d / r;
    float win = clamp(1.0 - dNorm * dNorm, 0.0, 1.0);
    float att = ((win * win) / (1.0 + d * d * 0.18)) * cone;
    float spotShad = (i == 0 && u_spotShadowEnabled == 1) ? evalShadowMap(u_spotShadowMap, spotSc, n, ld) : 1.0;
    vec3 lColLin = srgbToLin(u_spotColOuter[i].rgb) * (att * spotShad * 2.8);
    if (cel > 0.5) {
      float ndl = floor(max(dot(n, ld), 0.0) * 2.99) / 2.0;
      acc += albedoLin * ndl * lColLin * 0.45;
    } else {
      acc += evalCookTorranceDirect(albedoLin, n, v, ld, lColLin, metallic, roughness, cc, ccR, sss);
    }
  }
  return acc;
}

${blockSnippets.join('\n')}

void main() {
  vec4 texSample = u_hasTexture == 1 ? texture(u_tex, v_uv) : vec4(1.0);
  vec3 albedo = u_baseColor.rgb * texSample.rgb;
  float alpha = u_baseColor.a * texSample.a;

  ${has('triplanarGrid') ? 'albedo = evalTriplanarGrid(albedo, v_worldPos, u_gridScale);' : ''}
  ${has('pixelWorld') ? 'albedo = evalPixelWorld(v_worldPos, albedo);' : ''}

  vec3 n = normalize(v_normal);
  if (u_hasNormalMap == 1) {
    vec3 mapN = texture(u_normalMap, v_uv).xyz * 2.0 - 1.0;
    n = perturbNormal(n, v_worldPos, v_uv, mapN);
  }
  ${has('terrainSplat') ? 'albedo = evalTerrainSplat(albedo, v_worldPos, n);' : ''}

  vec3 albedoLin = srgbToLin(albedo);
  vec3 lColLin = srgbToLin(u_lightColor);
  vec3 ambLin = srgbToLin(u_ambientColor);
  vec3 shadowTintLin = srgbToLin(u_shadowTint);
  vec3 skyTopLin = srgbToLin(u_skyTop);
  vec3 skyHorizLin = srgbToLin(u_skyHorizon);
  vec3 fogColLin = srgbToLin(u_fogColor);

  vec3 v = normalize(u_cameraPos - v_worldPos);
  vec3 l = normalize(u_lightDir);
  float matMetallic = u_metallic;
  float matRoughness = u_roughness;
  if (u_hasMetallicRoughnessMap == 1) {
    vec3 mr = texture(u_metallicRoughnessMap, v_uv).rgb;
    matRoughness *= mr.g;
    matMetallic *= mr.b;
  }
  ${has('microDetail') ? 'applyMicroDetail(v_worldPos, u_cameraPos, u_bumpScale, n, matRoughness);' : ''}
  float matClearcoat = ${has('clearcoat') ? 'u_clearcoat' : '0.0'};
  float matClearcoatRoughness = u_clearcoatRoughness;
  float matSubsurface = ${has('subsurfaceWrap') ? 'u_subsurface' : '0.0'};

  // Weather wetness: dark wet sheen, glossy FBM puddles & subtle normal-driven raindrop ripples on flat upward surfaces (skipping submerged caustic floors)
  float puddleRingGlow = 0.0;
  ${
    !has('waterSurface') && !has('volumetricBeam') && !has('surfaceDecal') && !has('voronoiCaustics')
      ? `
  if (u_wetness > 0.01 && n.y > 0.94) {
    float dryMask = 1.0;
    for (int dz = 0; dz < 4; dz++) {
      vec4 zBox = u_dryZones[dz];
      if (v_worldPos.y < u_dryCeilY[dz] && v_worldPos.x > zBox.x && v_worldPos.x < zBox.y && v_worldPos.z > zBox.z && v_worldPos.z < zBox.w) {
        dryMask = 0.0;
      }
    }
    float slopeMask = smoothstep(0.94, 0.99, n.y) * dryMask;
    if (slopeMask > 0.01) {
      float pf = evalPuddleFbm(v_worldPos.xz * 0.24);
      float puddle = smoothstep(0.56 - u_wetness * 0.24, 0.72 - u_wetness * 0.14, pf) * u_wetness * slopeMask;
      albedoLin *= mix(1.0, 0.52, u_wetness * 0.45 * slopeMask + puddle * 0.42);
      matRoughness = mix(matRoughness, 0.03, puddle * 0.94);
      matClearcoat = max(matClearcoat, puddle * 0.96);
      matClearcoatRoughness = mix(matClearcoatRoughness, 0.03, puddle);
      if (u_rainIntensity > 0.01 && puddle > 0.05) {
        vec2 pGrad = vec2(0.0);
        evalRainRipples(v_worldPos.xz * 0.95, u_time, u_rainIntensity, pGrad, puddleRingGlow);
        n = normalize(n + vec3(pGrad.x, 0.0, pGrad.y) * (puddle * 0.95));
        puddleRingGlow *= puddle;
      }
    }
  }
  `
      : ''
  }

  float shadowFactor = ${has('volumetricBeam') || has('surfaceDecal') ? '1.0' : 'evalShadow(v_shadowCoord, n, l)'};

  vec3 color;
  ${lightingBody}
  ${
    has('volumetricBeam') || has('surfaceDecal') || has('waterSurface')
      ? ''
      : `
  ${has('envIBL') ? 'color += evalEnvIBL(albedoLin, n, v, l, lColLin * max(u_lightIntensity, 0.25), skyTopLin, skyHorizLin, matMetallic, matRoughness, matClearcoat, matClearcoatRoughness);' : ''}
  color += evalPointLights(albedoLin, v_worldPos, n, v, matMetallic, matRoughness, matClearcoat, matClearcoatRoughness, matSubsurface, ${has('celLighting') ? '1.0' : '0.0'});
  color += evalSpotLights(albedoLin, v_worldPos, n, v, matMetallic, matRoughness, matClearcoat, matClearcoatRoughness, matSubsurface, ${has('celLighting') ? '1.0' : '0.0'}, v_spotShadowCoord);
  color += mix(skyHorizLin, vec3(0.85, 0.94, 1.0), 0.5) * (puddleRingGlow * 0.28);
  `
  }
  color += srgbToLin(u_emissiveColor) + (u_hasEmissiveMap == 1 ? srgbToLin(texture(u_emissiveMap, v_uv).rgb) : vec3(0.0));

  ${has('rimLight') ? 'color += srgbToLin(evalRimLight(n, v, u_rimColor, u_rimPower)) * 0.55;' : ''}
  ${has('fresnelGlow') ? 'color += srgbToLin(evalFresnelGlow(n, v, u_glowColor, u_fresnelPower));' : ''}
  ${has('iridescent') ? 'color += srgbToLin(evalIridescent(n, v, v_worldPos, u_time)) * 0.75;' : ''}
  ${has('matcapNeon') ? 'color += srgbToLin(evalMatcapNeon(n, v, v_worldPos, u_glowColor, u_time)) * 1.25;' : ''}
  ${has('glassRefract') ? 'color = mix(color, srgbToLin(evalGlassRefract(n, v, l, u_glowColor)), 0.72); alpha *= 0.58;' : ''}
  ${has('voronoiCaustics') ? `color += srgbToLin(u_glowColor) * evalVoronoiCaustics(v_worldPos, u_time) * ${has('waterSurface') ? '0.28' : '0.95'};` : ''}
  ${has('pulseEmissive') ? 'color += srgbToLin(evalPulseEmissive(v_worldPos, u_edgeColor, u_time)) * 1.35;' : ''}

  ${
    has('dissolveNoise')
      ? `
  float nVal = valueNoise3(v_worldPos * 2.5);
  if (nVal < u_dissolve) discard;
  float edge = 1.0 - smoothstep(u_dissolve, u_dissolve + 0.09, nVal);
  color = mix(color, srgbToLin(u_edgeColor) * 3.2, edge);
  `
      : ''
  }

  ${
    has('hologramScanline')
      ? `
  float scan = evalHologramScanline(v_worldPos, u_time);
  color = color * 0.25 + albedoLin * (1.28 * scan) + srgbToLin(u_glowColor) * (0.14 * scan);
  alpha *= (0.58 + 0.42 * scan);
  `
      : ''
  }

  ${config.customFragmentSnippet ?? ''}

  ${
    has('distanceFog')
      ? `
  float camDist = length(u_cameraPos - v_worldPos);
  float sunScatter = pow(max(dot(-v, l), 0.0), 6.0);
  vec3 scatterFog = mix(fogColLin, lColLin * max(u_lightIntensity, 0.25) * 0.65 + fogColLin, sunScatter * 0.32);
  color = applyDistanceFog(color, camDist, scatterFog, u_fogDensity);
  `
      : ''
  }

  if (u_hdrOutput == 1) {
    ${has('pixelDither') ? 'color = srgbToLin(applyPixelDither(linToSrgb(acesToneMap(color)), gl_FragCoord.xy, u_ditherStrength));' : ''}
    fragColor = vec4(color, alpha);
  } else {
    color = linToSrgb(acesToneMap(color));
    ${has('pixelDither') ? 'color = applyPixelDither(color, gl_FragCoord.xy, u_ditherStrength);' : ''}
    color = clamp(color + (ignNoise(gl_FragCoord.xy) - 0.5) / 255.0, 0.0, 1.0);
    fragColor = vec4(color, alpha);
  }
}
`;

  return { cacheKey, vertexSource, fragmentSource };
}
