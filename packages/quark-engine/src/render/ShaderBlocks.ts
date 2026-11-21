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

  const vertexSource = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform float u_time;
uniform float u_waveAmp;
uniform float u_waveFreq;

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv;

${vertexWaveFn}

void main() {
  vec3 localPos = a_position;
  ${has('vertexWave') ? 'localPos = applyVertexWave(localPos, u_time, u_waveAmp, u_waveFreq);' : ''}
  ${config.customVertexSnippet ?? ''}
  vec4 world = u_model * vec4(localPos, 1.0);
  v_worldPos = world.xyz;
  v_normal = normalize(transpose(inverse(mat3(u_model))) * a_normal);
  v_uv = a_uv;
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
vec3 evalPbrLighting(vec3 albedo, vec3 n, vec3 v, vec3 l, vec3 lColor, float lInt, vec3 amb, float metallic, float roughness) {
  vec3 h = normalize(l + v);
  float ndotl = max(dot(n, l), 0.0);
  float ndotv = max(dot(n, v), 0.001);
  float ndoth = max(dot(n, h), 0.0);
  float r = clamp(roughness, 0.06, 1.0);
  float a2 = r * r * r * r;
  float denom = (ndoth * ndoth * (a2 - 1.0) + 1.0);
  float d = a2 / (3.14159265 * denom * denom + 0.0001);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 f = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  vec3 spec = (d * f) / max(4.0 * ndotv * ndotl + 0.05, 0.05);
  vec3 kd = (vec3(1.0) - f) * (1.0 - metallic);
  vec3 direct = (kd * albedo / 3.14159265 + spec) * lColor * lInt * ndotl;
  vec3 hemi = mix(amb * 0.6, amb * 1.2, n.y * 0.5 + 0.5) * albedo;
  return direct + hemi;
}
`);
  }

  if (has('celLighting')) {
    blockSnippets.push(`
vec3 evalCelLighting(vec3 albedo, vec3 n, vec3 v, vec3 l, vec3 lColor, float lInt, vec3 amb, vec3 shadowTint, float steps) {
  float ndotl = dot(n, l) * 0.5 + 0.5;
  float q = floor(clamp(ndotl, 0.0, 0.999) * max(steps, 2.0)) / max(steps - 1.0, 1.0);
  float lit = smoothstep(0.0, 0.08, q);
  vec3 diffuse = mix(albedo * shadowTint, albedo * lColor * lInt, q) * mix(0.65, 1.0, lit);
  vec3 h = normalize(l + v);
  float spec = step(0.92, max(dot(n, h), 0.0)) * 0.28;
  return diffuse + amb * albedo * 0.55 + vec3(spec);
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

  if (has('dissolveNoise')) {
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

  if (has('hologramScanline')) {
    blockSnippets.push(`
float evalHologramScanline(vec3 wp, float t) {
  float scan = 0.65 + 0.35 * sin(wp.y * 28.0 - t * 9.0);
  float pulse = 0.9 + 0.1 * sin(t * 23.0);
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

  const lightingBody = has('celLighting')
    ? `color = evalCelLighting(albedo, n, v, l, u_lightColor, u_lightIntensity, u_ambientColor, u_shadowTint, u_celSteps);`
    : has('pbrLighting')
      ? `color = evalPbrLighting(albedo, n, v, l, u_lightColor, u_lightIntensity, u_ambientColor, u_metallic, u_roughness);`
      : `color = albedo * (max(dot(n, l), 0.0) * u_lightColor * u_lightIntensity + u_ambientColor);`;

  const fragmentSource = `#version 300 es
precision highp float;

in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv;

uniform vec3 u_cameraPos;
uniform float u_time;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform float u_lightIntensity;
uniform vec3 u_ambientColor;
uniform vec3 u_fogColor;
uniform float u_fogDensity;

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
uniform int u_hasTexture;
uniform sampler2D u_tex;

out vec4 fragColor;

${blockSnippets.join('\n')}

void main() {
  vec4 texSample = u_hasTexture == 1 ? texture(u_tex, v_uv) : vec4(1.0);
  vec3 albedo = u_baseColor.rgb * texSample.rgb;
  float alpha = u_baseColor.a * texSample.a;

  ${has('triplanarGrid') ? 'albedo = evalTriplanarGrid(albedo, v_worldPos, u_gridScale);' : ''}

  vec3 n = normalize(v_normal);
  vec3 v = normalize(u_cameraPos - v_worldPos);
  vec3 l = normalize(u_lightDir);

  vec3 color;
  ${lightingBody}

  ${has('rimLight') ? 'color += evalRimLight(n, v, u_rimColor, u_rimPower);' : ''}
  ${has('fresnelGlow') ? 'color += evalFresnelGlow(n, v, u_glowColor, u_fresnelPower);' : ''}

  ${
    has('dissolveNoise')
      ? `
  float nVal = valueNoise3(v_worldPos * 2.5);
  if (nVal < u_dissolve) discard;
  float edge = 1.0 - smoothstep(u_dissolve, u_dissolve + 0.09, nVal);
  color = mix(color, u_edgeColor * 2.2, edge);
  `
      : ''
  }

  ${
    has('hologramScanline')
      ? `
  float scan = evalHologramScanline(v_worldPos, u_time);
  color *= scan;
  alpha *= (0.45 + 0.45 * scan);
  `
      : ''
  }

  ${config.customFragmentSnippet ?? ''}

  // ACES Filmic tone map + gamma
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));

  ${has('pixelDither') ? 'color = applyPixelDither(color, gl_FragCoord.xy, u_ditherStrength);' : ''}
  ${has('distanceFog') ? 'color = applyDistanceFog(color, length(u_cameraPos - v_worldPos), u_fogColor, u_fogDensity);' : ''}

  fragColor = vec4(color, alpha);
}
`;

  return { cacheKey, vertexSource, fragmentSource };
}
