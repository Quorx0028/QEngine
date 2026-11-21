import type { MaterialDesc, MaterialUniforms } from './IRenderBackend';

export type ShaderPresetName =
  | 'pbr'
  | 'animeToon'
  | 'hologram'
  | 'dissolve'
  | 'retroDither'
  | 'waveSurface'
  | 'iridescent'
  | 'cyberNeon'
  | 'crystalGlass'
  | 'waterCaustics'
  | 'ps1Retro'
  | 'magmaPulse'
  | 'ultraRealism';

export const SHADER_PRESET_NAMES: readonly ShaderPresetName[] = [
  'pbr',
  'animeToon',
  'hologram',
  'dissolve',
  'retroDither',
  'waveSurface',
  'iridescent',
  'cyberNeon',
  'crystalGlass',
  'waterCaustics',
  'ps1Retro',
  'magmaPulse',
  'ultraRealism',
] as const;

export function defaultMaterialUniforms(overrides: Partial<MaterialUniforms> = {}): MaterialUniforms {
  return {
    baseColor: [0.82, 0.85, 0.92, 1.0],
    shadowTint: [0.42, 0.44, 0.62],
    rimColor: [0.95, 0.9, 1.0],
    glowColor: [0.25, 0.85, 1.0],
    edgeColor: [1.0, 0.45, 0.1],
    metallic: 0.1,
    roughness: 0.45,
    celSteps: 3,
    rimPower: 3.0,
    fresnelPower: 2.2,
    waveAmp: 0.18,
    waveFreq: 2.2,
    dissolve: 0.32,
    ditherStrength: 0.75,
    gridScale: 0.5,
    ...overrides,
  };
}

export type MaterialPresetOverrides = Partial<Omit<MaterialDesc, 'uniforms'>> & {
  uniforms?: Partial<MaterialUniforms>;
};

export function createPresetMaterial(
  preset: ShaderPresetName,
  overrides: MaterialPresetOverrides = {}
): MaterialDesc {
  const base = getPresetBase(preset);
  return {
    ...base,
    ...overrides,
    blocks: overrides.blocks ?? base.blocks,
    uniforms: {
      ...base.uniforms,
      ...(overrides.uniforms ?? {}),
    },
  };
}

function getPresetBase(preset: ShaderPresetName): MaterialDesc {
  switch (preset) {
    case 'pbr':
      return {
        blocks: ['pbrLighting', 'distanceFog'],
        uniforms: defaultMaterialUniforms({ metallic: 0.25, roughness: 0.35 }),
      };
    case 'animeToon':
      return {
        blocks: ['celLighting', 'rimLight', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.96, 0.72, 0.78, 1.0],
          shadowTint: [0.45, 0.36, 0.62],
          rimColor: [1.0, 0.92, 0.98],
          celSteps: 3,
          rimPower: 2.6,
        }),
        outlineWidth: 0.03,
        outlineColor: [0.08, 0.06, 0.12],
      };
    case 'hologram':
      return {
        blocks: ['fresnelGlow', 'hologramScanline', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.15, 0.75, 0.95, 0.75],
          glowColor: [0.3, 0.95, 1.0],
          fresnelPower: 1.8,
        }),
        transparent: true,
        doubleSided: true,
      };
    case 'dissolve':
      return {
        blocks: ['pbrLighting', 'dissolveNoise', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.75, 0.35, 0.85, 1.0],
          edgeColor: [1.0, 0.5, 0.15],
          dissolve: 0.28,
        }),
        doubleSided: true,
      };
    case 'retroDither':
      return {
        blocks: ['celLighting', 'pixelDither', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.65, 0.82, 0.72, 1.0],
          celSteps: 4,
          ditherStrength: 0.85,
        }),
      };
    case 'waveSurface':
      return {
        blocks: ['pbrLighting', 'vertexWave', 'fresnelGlow', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.16, 0.52, 0.86, 0.92],
          glowColor: [0.4, 0.85, 1.0],
          roughness: 0.18,
          waveAmp: 0.18,
          waveFreq: 2.4,
        }),
      };
    case 'iridescent':
      return {
        blocks: ['pbrLighting', 'iridescent', 'rimLight', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.22, 0.24, 0.32, 1.0],
          metallic: 0.65,
          roughness: 0.22,
          rimColor: [0.9, 0.95, 1.0],
        }),
      };
    case 'cyberNeon':
      return {
        blocks: ['pbrLighting', 'matcapNeon', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.08, 0.1, 0.18, 1.0],
          glowColor: [0.15, 0.95, 0.9],
          roughness: 0.25,
        }),
      };
    case 'crystalGlass':
      return {
        blocks: ['pbrLighting', 'glassRefract', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.55, 0.85, 1.0, 0.8],
          glowColor: [0.65, 0.92, 1.0],
          roughness: 0.08,
        }),
        transparent: true,
      };
    case 'waterCaustics':
      return {
        blocks: ['pbrLighting', 'voronoiCaustics', 'vertexWave', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.1, 0.45, 0.72, 1.0],
          glowColor: [0.35, 0.95, 1.0],
          waveAmp: 0.08,
          waveFreq: 2.0,
        }),
      };
    case 'ps1Retro':
      return {
        blocks: ['celLighting', 'pixelWorld', 'pixelDither', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.76, 0.72, 0.65, 1.0],
          celSteps: 4,
          ditherStrength: 0.95,
        }),
      };
    case 'magmaPulse':
      return {
        blocks: ['pbrLighting', 'pulseEmissive', 'dissolveNoise', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.18, 0.09, 0.08, 1.0],
          edgeColor: [1.0, 0.35, 0.06],
          dissolve: 0.12,
        }),
      };
    case 'ultraRealism':
      return {
        blocks: ['pbrLighting', 'envIBL', 'microDetail', 'distanceFog'],
        uniforms: defaultMaterialUniforms({
          baseColor: [0.74, 0.76, 0.79, 1.0],
          metallic: 0.18,
          roughness: 0.26,
        }),
      };
  }
}
