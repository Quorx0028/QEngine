import {
  createPresetMaterial,
  makeMaterialFromPreset,
  SHADER_BLOCK_IDS,
  SHADER_PRESET_NAMES,
  type EditorMaterialDef,
  type ProceduralTextureKind,
  type QuarkProjectDoc,
  type ShaderBlockId,
  type ShaderPresetName,
} from 'quark-engine';

const TEX_KINDS: Array<{ id: ProceduralTextureKind; label: string }> = [
  { id: 'none', label: 'Без текстуры' },
  { id: 'grid', label: 'Сетка (Grid)' },
  { id: 'checker', label: 'Шахматка' },
  { id: 'brick', label: 'Кирпич' },
  { id: 'wood', label: 'Дерево' },
  { id: 'stone', label: 'Камень' },
  { id: 'metal', label: 'Металл' },
  { id: 'custom', label: 'Свой PNG/JPG' },
];

function rgbaToHex(c: [number, number, number, number] | [number, number, number]): string {
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${ch(c[0])}${ch(c[1])}${ch(c[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2) || 'ff', 16) / 255;
  const g = parseInt(clean.slice(2, 4) || 'ff', 16) / 255;
  const b = parseInt(clean.slice(4, 6) || 'ff', 16) / 255;
  return [r, g, b];
}

export class ShaderEditorPanel {
  private readonly root: HTMLElement;
  private readonly getDoc: () => QuarkProjectDoc;
  private readonly getSelectedEntityId: () => string | null;
  private readonly onMutate: (rebuild: boolean) => void;
  private activeMatId: string | null = null;

  constructor(
    root: HTMLElement,
    getDoc: () => QuarkProjectDoc,
    getSelectedEntityId: () => string | null,
    onMutate: (rebuild: boolean) => void
  ) {
    this.root = root;
    this.getDoc = getDoc;
    this.getSelectedEntityId = getSelectedEntityId;
    this.onMutate = onMutate;
  }

  selectMaterial(matId: string): void {
    this.activeMatId = matId;
    this.render();
  }

  render(): void {
    const doc = this.getDoc();
    if (!this.activeMatId || !doc.materials.some((m) => m.id === this.activeMatId)) {
      this.activeMatId = doc.materials[0]?.id ?? null;
    }
    const mat: EditorMaterialDef | undefined = doc.materials.find((m) => m.id === this.activeMatId);
    this.root.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'shader-shell';

    // Col 1: Material List
    const col1 = document.createElement('div');
    col1.className = 'card';
    col1.innerHTML = `<div class="card-title">Материалы проекта</div>`;
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;overflow-y:auto;flex:1;';
    for (const m of doc.materials) {
      const btn = document.createElement('button');
      btn.textContent = m.name;
      if (m.id === mat?.id) btn.classList.add('active');
      btn.style.textAlign = 'left';
      btn.onclick = () => {
        this.activeMatId = m.id;
        this.render();
      };
      list.appendChild(btn);
    }
    const btnAddMat = document.createElement('button');
    btnAddMat.textContent = '+ Новый материал';
    btnAddMat.onclick = () => {
      const nm = makeMaterialFromPreset(
        `mat_${Date.now()}`,
        `Материал #${doc.materials.length + 1}`,
        'pbr',
        { baseColor: [0.3, 0.7, 1.0, 1] },
        'none'
      );
      doc.materials.push(nm);
      this.activeMatId = nm.id;
      this.onMutate(true);
      this.render();
    };
    col1.append(list, btnAddMat);
    shell.appendChild(col1);

    if (!mat) {
      this.root.appendChild(shell);
      return;
    }

    // Col 2: Texture, Preset, Colors & Params
    const col2 = document.createElement('div');
    col2.className = 'card';
    col2.innerHTML = `<div class="card-title">Текстура и Базовый Шейдер</div>`;

    const selPreset = document.createElement('select');
    for (const p of SHADER_PRESET_NAMES) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = `Пресет: ${p}`;
      if (mat.preset === p) o.selected = true;
      selPreset.appendChild(o);
    }
    selPreset.onchange = () => {
      const fresh = createPresetMaterial(selPreset.value as ShaderPresetName);
      mat.preset = selPreset.value as ShaderPresetName;
      mat.blocks = [...fresh.blocks];
      mat.uniforms = { ...fresh.uniforms };
      mat.transparent = fresh.transparent;
      mat.doubleSided = fresh.doubleSided;
      mat.outlineWidth = fresh.outlineWidth;
      this.onMutate(true);
      this.render();
    };

    const selTex = document.createElement('select');
    for (const tk of TEX_KINDS) {
      const o = document.createElement('option');
      o.value = tk.id;
      o.textContent = `Текстура: ${tk.label}`;
      if (mat.textureKind === tk.id) o.selected = true;
      selTex.appendChild(o);
    }
    selTex.onchange = () => {
      mat.textureKind = selTex.value as ProceduralTextureKind;
      this.onMutate(true);
    };

    const uploadLbl = document.createElement('label');
    uploadLbl.className = 'btn-like';
    uploadLbl.textContent = '🖼 Загрузить PNG/JPG текстуру';
    const uploadInp = document.createElement('input');
    uploadInp.type = 'file';
    uploadInp.accept = 'image/*';
    uploadInp.hidden = true;
    uploadInp.onchange = () => {
      const f = uploadInp.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          mat.textureKind = 'custom';
          mat.customImageDataUrl = reader.result;
          this.onMutate(true);
          this.render();
        }
      };
      reader.readAsDataURL(f);
    };
    uploadLbl.appendChild(uploadInp);

    const colorRow = document.createElement('div');
    colorRow.className = 'row-gap';
    const colBase = document.createElement('input');
    colBase.type = 'color';
    colBase.value = rgbaToHex(mat.uniforms.baseColor);
    colBase.onchange = () => {
      const [r, g, b] = hexToRgb(colBase.value);
      mat.uniforms.baseColor = [r, g, b, mat.uniforms.baseColor[3]];
      this.onMutate(true);
    };
    const colGlow = document.createElement('input');
    colGlow.type = 'color';
    colGlow.value = rgbaToHex(mat.uniforms.glowColor);
    colGlow.onchange = () => {
      mat.uniforms.glowColor = hexToRgb(colGlow.value);
      this.onMutate(true);
    };
    colorRow.append(document.createTextNode('Цвет:'), colBase, document.createTextNode('Свечение:'), colGlow);

    const makeRange = (label: string, min: number, max: number, step: number, val: number, set: (v: number) => void) => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:11px;';
      const sp = document.createElement('span');
      sp.textContent = `${label}: ${val.toFixed(2)}`;
      const rng = document.createElement('input');
      rng.type = 'range';
      rng.min = String(min);
      rng.max = String(max);
      rng.step = String(step);
      rng.value = String(val);
      rng.oninput = () => {
        const nv = Number(rng.value);
        sp.textContent = `${label}: ${nv.toFixed(2)}`;
        set(nv);
      };
      rng.onchange = () => this.onMutate(true);
      wrap.append(sp, rng);
      return wrap;
    };

    const btnApply = document.createElement('button');
    btnApply.className = 'active';
    btnApply.textContent = '✓ Применить к выбранному объекту';
    btnApply.onclick = () => {
      const selId = this.getSelectedEntityId();
      const ent = doc.entities.find((e) => e.id === selId);
      if (ent) {
        ent.materialId = mat.id;
        this.onMutate(true);
      }
    };

    col2.append(
      selPreset,
      selTex,
      uploadLbl,
      colorRow,
      makeRange('Металл', 0, 1, 0.05, mat.uniforms.metallic, (v) => (mat.uniforms.metallic = v)),
      makeRange('Шероховатость', 0.05, 1, 0.05, mat.uniforms.roughness, (v) => (mat.uniforms.roughness = v)),
      makeRange('Волны (Vertex)', 0, 0.4, 0.02, mat.uniforms.waveAmp, (v) => (mat.uniforms.waveAmp = v)),
      makeRange('Растворение', 0, 1, 0.05, mat.uniforms.dissolve, (v) => (mat.uniforms.dissolve = v)),
      btnApply
    );
    shell.appendChild(col2);

    // Col 3: Shader Graph Blocks + Custom GLSL
    const col3 = document.createElement('div');
    col3.className = 'card';
    col3.innerHTML = `<div class="card-title">Шейдерные ноды / блоки (ShaderGraph)</div>`;
    const grid = document.createElement('div');
    grid.className = 'blocks-wrap';
    for (const blk of SHADER_BLOCK_IDS) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = mat.blocks.includes(blk as ShaderBlockId);
      cb.onchange = () => {
        if (cb.checked && !mat.blocks.includes(blk)) mat.blocks.push(blk);
        else if (!cb.checked) mat.blocks = mat.blocks.filter((b) => b !== blk);
        this.onMutate(true);
      };
      lbl.append(cb, document.createTextNode(blk));
      grid.appendChild(lbl);
    }

    const glslArea = document.createElement('textarea');
    glslArea.placeholder = '// Свой GLSL фрагмент (необязательно), например: base.rgb *= vec3(1.1, 0.9, 1.2);';
    glslArea.rows = 3;
    glslArea.style.cssText = 'width:100%;font-family:monospace;font-size:11px;padding:5px;border-radius:6px;border:1px solid #334155;color:#cbd5e1;';
    glslArea.value = mat.customFragmentSnippet ?? '';
    glslArea.onchange = () => {
      mat.customFragmentSnippet = glslArea.value.trim() || undefined;
      this.onMutate(true);
    };

    col3.append(grid, glslArea);
    shell.appendChild(col3);

    this.root.appendChild(shell);
  }
}
