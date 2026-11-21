import type { MaterialDesc, MaterialUniforms, ShaderBlockId } from './IRenderBackend';
import { defaultMaterialUniforms } from './ShaderPresets';

export class ShaderGraph {
  private readonly blocks: ShaderBlockId[] = [];
  private uniforms: MaterialUniforms = defaultMaterialUniforms();
  private transparent = false;
  private doubleSided = false;
  private outlineWidth = 0;
  private outlineColor: [number, number, number] = [0.06, 0.05, 0.1];
  private customVertexSnippet?: string;
  private customFragmentSnippet?: string;

  add(block: ShaderBlockId): this {
    if (!this.blocks.includes(block)) {
      this.blocks.push(block);
    }
    return this;
  }

  remove(block: ShaderBlockId): this {
    const idx = this.blocks.indexOf(block);
    if (idx >= 0) this.blocks.splice(idx, 1);
    return this;
  }

  setUniforms(patch: Partial<MaterialUniforms>): this {
    this.uniforms = { ...this.uniforms, ...patch };
    return this;
  }

  setTransparent(enabled: boolean): this {
    this.transparent = enabled;
    return this;
  }

  setDoubleSided(enabled: boolean): this {
    this.doubleSided = enabled;
    return this;
  }

  setOutline(width: number, color: [number, number, number] = [0.06, 0.05, 0.1]): this {
    this.outlineWidth = width;
    this.outlineColor = color;
    return this;
  }

  withCustomVertex(glslBodySnippet: string): this {
    this.customVertexSnippet = glslBodySnippet;
    return this;
  }

  withCustomFragment(glslBodySnippet: string): this {
    this.customFragmentSnippet = glslBodySnippet;
    return this;
  }

  compile(): MaterialDesc {
    return {
      blocks: [...this.blocks],
      uniforms: { ...this.uniforms },
      transparent: this.transparent,
      doubleSided: this.doubleSided,
      outlineWidth: this.outlineWidth > 0 ? this.outlineWidth : undefined,
      outlineColor: this.outlineWidth > 0 ? [...this.outlineColor] : undefined,
      customVertexSnippet: this.customVertexSnippet,
      customFragmentSnippet: this.customFragmentSnippet,
    };
  }
}
