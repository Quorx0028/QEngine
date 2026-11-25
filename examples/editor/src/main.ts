import './styles.css';
import {
  createStarterProject,
  Engine,
  OrbitControls,
  PHYSICS_MATERIAL_PRESETS,
  ProjectRunner,
  TransformGizmo,
  type EditorEntityDef,
  type EditorEntityKind,
  type GizmoMode,
  type QuarkProjectDoc,
  type RoomSide,
  type StarterTemplateId,
} from 'quark-engine';
import wasmUrl from 'quark-engine/wasm?url';
import { NodeGraphEditor } from './nodeGraphEditor';
import { ShaderEditorPanel } from './shaderEditor';
import { WorldSettingsPanel } from './worldPanel';

const STORAGE_KEY = 'quarkstudio_autosave_v1';

async function bootstrapEditor() {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const engine = await Engine.init({ canvas, wasmUrl, maxDpr: 1.5 });
  const { input } = engine;

  let doc: QuarkProjectDoc = loadInitialDoc();
  let mode: 'edit' | 'play' = 'edit';
  let runner: ProjectRunner | null = null;
  let selectedDocId: string | null =
    doc.entities.find((e) => e.id === 'crate_decor')?.id ?? doc.entities[0]?.id ?? null;

  const undoStack: string[] = [];
  const redoStack: string[] = [];
  const pushUndoSnapshot = () => {
    undoStack.push(JSON.stringify(doc));
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  };

  // UI Elements
  const statsEl = document.getElementById('vp-stats')!;
  const hintEl = document.getElementById('vp-hint')!;
  const playHudEl = document.getElementById('play-hud')!;
  const playCountersEl = document.getElementById('play-counters')!;
  const playBannerEl = document.getElementById('play-banner')!;
  const outlinerEl = document.getElementById('outliner-list')!;
  const searchEl = document.getElementById('inp-search') as HTMLInputElement;
  const inspectorEl = document.getElementById('inspector-body')!;
  const inspIdEl = document.getElementById('insp-id')!;
  const projNameEl = document.getElementById('inp-proj-name') as HTMLInputElement;
  projNameEl.value = doc.name;

  // Orbit + Gizmo (active in Edit Mode)
  const orbit = new OrbitControls({ target: [0, 1.5, 0], radius: 15, theta: 0.45, phi: 1.05 });
  orbit.attach(canvas);

  const gizmo = new TransformGizmo(engine.scene, engine.assets, orbit, {
    snapStep: 0.5,
    rotSnapDeg: 15,
    isSelectable: (eid) => runner?.eidToDoc.has(eid) ?? false,
    canDrag: (eid) => {
      const did = runner?.eidToDoc.get(eid);
      const def = doc.entities.find((x) => x.id === did);
      return !def?.physics.editorLocked;
    },
    onSelect: (eid) => {
      const did = eid !== null ? (runner?.eidToDoc.get(eid) ?? null) : null;
      selectedDocId = did;
      renderOutliner();
      renderInspector();
    },
    onChange: (eid, gMode) => {
      const did = runner?.eidToDoc.get(eid);
      const def = doc.entities.find((x) => x.id === did);
      if (!def) return;
      const xf = engine.scene.getTransform(eid);
      def.position = [round2(xf.position[0]), round2(xf.position[1]), round2(xf.position[2])];
      if (gMode === 'scale' && (def.kind === 'box' || def.kind === 'trigger')) {
        def.size = [
          Math.max(0.2, round2(xf.scale[0])),
          Math.max(0.2, round2(xf.scale[1])),
          Math.max(0.2, round2(xf.scale[2])),
        ];
        def.scale = [1, 1, 1];
      } else if (gMode === 'scale') {
        def.scale = [round2(xf.scale[0]), round2(xf.scale[1]), round2(xf.scale[2])];
      }
      renderInspector();
    },
    onDragEnd: () => {
      pushUndoSnapshot();
      autosaveDoc();
    },
  });
  gizmo.setEnabled(true);
  gizmo.attach(canvas);

  const countersMap = new Map<string, string | number | boolean>();
  let bannerTimer = 0;

  // Sub-panels in Bottom Drawer
  const nodeEditor = new NodeGraphEditor(
    document.getElementById('tab-blueprints')!,
    () => doc,
    (rebuild) => {
      pushUndoSnapshot();
      autosaveDoc();
      renderInspector();
      if (rebuild && mode === 'edit') void remountEditScene();
    }
  );
  const shaderEditor = new ShaderEditorPanel(
    document.getElementById('tab-shaders')!,
    () => doc,
    () => selectedDocId,
    (rebuild) => {
      pushUndoSnapshot();
      autosaveDoc();
      renderInspector();
      if (rebuild && mode === 'edit') void remountEditScene();
    }
  );
  const worldPanel = new WorldSettingsPanel(
    document.getElementById('tab-world')!,
    () => doc,
    (rebuild) => {
      pushUndoSnapshot();
      autosaveDoc();
      if (rebuild && mode === 'edit') void remountEditScene();
    }
  );

  function autosaveDoc() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch {
      // ignore quota errors
    }
  }

  function loadInitialDoc(): QuarkProjectDoc {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as QuarkProjectDoc;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entities)) return parsed;
      }
    } catch {
      // fallback
    }
    return createStarterProject('escapeRoom');
  }

  async function remountEditScene() {
    gizmo.resetHandles();
    runner?.dispose();
    runner = await ProjectRunner.mount(engine, doc, 'edit');
    if (selectedDocId) {
      const eid = runner.docToEid.get(selectedDocId) ?? null;
      gizmo.select(eid);
    } else {
      gizmo.select(null);
    }
    statsEl.textContent = `✏ EDIT · Entities: ${engine.scene.getEntityCount()}`;
  }

  async function enterPlayMode() {
    if (mode === 'play') return;
    mode = 'play';
    countersMap.clear();
    playCountersEl.textContent = '';
    playBannerEl.classList.remove('visible');
    gizmo.setEnabled(false);
    gizmo.detach();
    orbit.enabled = false;
    orbit.detach();

    runner?.dispose();
    runner = await ProjectRunner.mount(engine, doc, 'play', {
      onShowBanner: (title, subtitle, color) => {
        playBannerEl.style.borderColor = color || '#38bdf8';
        playBannerEl.innerHTML = `<strong style="color:${color || '#38bdf8'}">${escapeHtml(title)}</strong>${subtitle ? `<div style="font-size:12px;color:#cbd5e1;margin-top:2px;">${escapeHtml(subtitle)}</div>` : ''}`;
        playBannerEl.classList.add('visible');
        window.clearTimeout(bannerTimer);
        bannerTimer = window.setTimeout(() => playBannerEl.classList.remove('visible'), 4200);
      },
      onUpdateHudCounter: (label, value) => {
        countersMap.set(label, value);
        playCountersEl.textContent = Array.from(countersMap.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('   |   ');
      },
      onNodeExecuted: (nid) => nodeEditor.pulseNode(nid),
    });

    btnPlay.textContent = '■ STOP';
    btnPlay.classList.add('playing');
    playHudEl.classList.add('visible');
    hintEl.textContent = 'PLAY MODE: Кликни по экрану (WASD бег, Space прыжок, ЛКМ выстрел/клик, E дверь, ESC отпустить мышь)';
  }

  async function exitPlayMode() {
    if (mode === 'edit') return;
    mode = 'edit';
    if (document.pointerLockElement) document.exitPointerLock();
    playHudEl.classList.remove('visible');
    btnPlay.textContent = '▶ PLAY';
    btnPlay.classList.remove('playing');
    hintEl.textContent = 'Edit Mode: ЛКМ выбор/Gizmo · ПКМ/Drag орбита · Колесо зум · F фокус';

    await remountEditScene();
    orbit.attach(canvas);
    orbit.enabled = true;
    gizmo.attach(canvas);
    gizmo.setEnabled(true);
  }

  function renderOutliner() {
    const q = searchEl.value.trim().toLowerCase();
    outlinerEl.innerHTML = '';
    for (const ent of doc.entities) {
      if (q && !ent.name.toLowerCase().includes(q) && !ent.kind.toLowerCase().includes(q)) continue;
      const item = document.createElement('div');
      item.className = 'out-item' + (ent.id === selectedDocId ? ' selected' : '');

      const nm = document.createElement('span');
      nm.className = 'out-name';
      nm.textContent = `${kindIcon(ent.kind)} ${ent.name}`;

      const badges = document.createElement('span');
      badges.className = 'out-badges';
      if (ent.physics.isTrigger || ent.kind === 'trigger') {
        badges.innerHTML = `<span class="badge-trig">Зона</span>`;
      } else if (ent.physics.mode === 'static' || ent.physics.mode === 'kinematic') {
        badges.innerHTML = `<span class="badge-static">🔒 Статика</span>`;
      } else if (ent.physics.mode === 'dynamic') {
        badges.innerHTML = `<span class="badge-dyn">⚡ Физика</span>`;
      }
      if (ent.physics.editorLocked) {
        badges.innerHTML += `<span title="Закреплён от случайного сдвига">📌</span>`;
      }

      item.append(nm, badges);
      item.onclick = () => {
        selectedDocId = ent.id;
        const eid = runner?.docToEid.get(ent.id) ?? null;
        gizmo.select(eid);
        renderOutliner();
        renderInspector();
      };
      item.ondblclick = () => focusSelected();
      outlinerEl.appendChild(item);
    }
  }

  function renderInspector() {
    const ent = doc.entities.find((e) => e.id === selectedDocId);
    if (!ent) {
      inspIdEl.textContent = 'Не выбрано';
      inspectorEl.innerHTML = `<div class="empty-msg">Выбери объект в сцене или кликни по нему во вьюпорте</div>`;
      return;
    }
    inspIdEl.textContent = ent.kind.toUpperCase();
    inspectorEl.innerHTML = '';

    // 1. Name & Actions
    const cardBasic = document.createElement('div');
    cardBasic.className = 'card';
    cardBasic.innerHTML = `<div class="card-title">Объект</div>`;
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.value = ent.name;
    nameInp.onchange = () => {
      pushUndoSnapshot();
      ent.name = nameInp.value.trim() || ent.id;
      autosaveDoc();
      renderOutliner();
    };
    const btnDrop = document.createElement('button');
    btnDrop.textContent = '⬇ Поставить ровно на пол';
    btnDrop.onclick = () => {
      pushUndoSnapshot();
      const halfH = ent.kind === 'sphere' ? (ent.radius ?? 0.5) * ent.scale[1] : ent.kind === 'room' || ent.kind === 'stairs' || ent.kind === 'pool' ? 0 : (ent.size[1] * ent.scale[1]) * 0.5;
      const eid = runner?.docToEid.get(ent.id);
      const hit = engine.scene.raycast3D([ent.position[0], ent.position[1] + 5, ent.position[2]], [0, -1, 0], 60);
      if (hit && hit.entity !== eid) {
        ent.position[1] = round2(hit.point[1] + halfH);
      } else {
        ent.position[1] = round2(halfH);
      }
      runner?.syncEntityTransformInEdit(ent);
      gizmo.update();
      autosaveDoc();
      renderInspector();
    };
    cardBasic.append(nameInp, btnDrop);

    // 2. Transform Card
    const cardXf = document.createElement('div');
    cardXf.className = 'card';
    cardXf.innerHTML = `<div class="card-title">Трансформация</div>`;
    const makeVecRow = (title: string, vec: [number, number, number], step: number, rebuildOnEdit: boolean) => {
      const lblTitle = document.createElement('div');
      lblTitle.className = 'muted';
      lblTitle.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'vec3-grid';
      (['X', 'Y', 'Z'] as const).forEach((ax, i) => {
        const l = document.createElement('label');
        l.textContent = ax;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = String(step);
        inp.value = String(vec[i]);
        inp.onchange = () => {
          pushUndoSnapshot();
          vec[i] = Number(inp.value);
          autosaveDoc();
          if (rebuildOnEdit) void remountEditScene();
          else {
            runner?.syncEntityTransformInEdit(ent);
            gizmo.update();
          }
        };
        l.appendChild(inp);
        grid.appendChild(l);
      });
      cardXf.append(lblTitle, grid);
    };
    makeVecRow('Позиция (м)', ent.position, 0.25, ent.kind === 'room' || ent.kind === 'stairs' || ent.kind === 'pool');
    makeVecRow('Поворот (°)', ent.rotationDeg, 15, ent.kind === 'ramp');
    makeVecRow('Размеры [Ш, В, Г]', ent.size, 0.25, ent.kind === 'room' || ent.kind === 'stairs' || ent.kind === 'pool' || ent.kind === 'ramp');

    // 3. Physics & Fixation Card
    const cardPhys = document.createElement('div');
    cardPhys.className = 'card';
    cardPhys.innerHTML = `<div class="card-title">Фиксация и Физика (Чтобы не падало!)</div>`;
    const modeGrid = document.createElement('div');
    modeGrid.className = 'seg-3';

    const setPhysMode = (m: 'static' | 'dynamic' | 'trigger') => {
      pushUndoSnapshot();
      if (m === 'trigger') {
        ent.physics.mode = 'static';
        ent.physics.isTrigger = true;
      } else {
        ent.physics.isTrigger = false;
        ent.physics.mode = m;
        if (m === 'dynamic' && ent.physics.mass <= 0) ent.physics.mass = 1.5;
      }
      autosaveDoc();
      renderOutliner();
      renderInspector();
      void remountEditScene();
    };

    const mkModeBtn = (label: string, active: boolean, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (active) b.classList.add('active');
      b.onclick = fn;
      return b;
    };
    modeGrid.append(
      mkModeBtn('🔒 Статика', !ent.physics.isTrigger && ent.physics.mode !== 'dynamic', () => setPhysMode('static')),
      mkModeBtn('⚡ Падает', !ent.physics.isTrigger && ent.physics.mode === 'dynamic', () => setPhysMode('dynamic')),
      mkModeBtn('👻 Триггер', Boolean(ent.physics.isTrigger) || ent.kind === 'trigger', () => setPhysMode('trigger'))
    );

    const chkPin = document.createElement('label');
    chkPin.className = 'tb-chk';
    const cbPin = document.createElement('input');
    cbPin.type = 'checkbox';
    cbPin.checked = Boolean(ent.physics.editorLocked);
    cbPin.onchange = () => {
      pushUndoSnapshot();
      ent.physics.editorLocked = cbPin.checked;
      autosaveDoc();
      renderOutliner();
    };
    chkPin.append(cbPin, document.createTextNode('📌 Не двигать мышью в редакторе (Pin)'));

    const presetRow = document.createElement('select');
    const pOpt0 = document.createElement('option');
    pOpt0.value = '';
    pOpt0.textContent = 'Быстрый пресет физики...';
    presetRow.appendChild(pOpt0);
    for (const k of Object.keys(PHYSICS_MATERIAL_PRESETS) as Array<keyof typeof PHYSICS_MATERIAL_PRESETS>) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `Материал физики: ${k}`;
      presetRow.appendChild(o);
    }
    presetRow.onchange = () => {
      const pr = PHYSICS_MATERIAL_PRESETS[presetRow.value as keyof typeof PHYSICS_MATERIAL_PRESETS];
      if (!pr) return;
      pushUndoSnapshot();
      ent.physics.friction = pr.friction ?? 0.7;
      ent.physics.restitution = pr.restitution ?? 0.1;
      if (pr.density) ent.physics.mass = Math.max(0.5, Number((pr.density * 1.2).toFixed(1)));
      autosaveDoc();
      renderInspector();
    };

    const weldRow = document.createElement('select');
    const w0 = document.createElement('option');
    w0.value = '';
    w0.textContent = '🔗 Сварить (Weld) с объектом...';
    weldRow.appendChild(w0);
    for (const other of doc.entities) {
      if (other.id === ent.id) continue;
      const o = document.createElement('option');
      o.value = other.id;
      o.textContent = `Связать с: ${other.name}`;
      weldRow.appendChild(o);
    }
    weldRow.onchange = () => {
      if (!weldRow.value) return;
      pushUndoSnapshot();
      doc.welds.push({ id: `w_${Date.now()}`, entityA: ent.id, entityB: weldRow.value });
      weldRow.value = '';
      autosaveDoc();
      renderInspector();
    };

    cardPhys.append(modeGrid, chkPin, presetRow, weldRow);

    // 4. Material Card
    const cardMat = document.createElement('div');
    cardMat.className = 'card';
    cardMat.innerHTML = `<div class="card-title">Материал и Шейдер</div>`;
    const selMat = document.createElement('select');
    for (const m of doc.materials) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      if (m.id === ent.materialId) o.selected = true;
      selMat.appendChild(o);
    }
    selMat.onchange = () => {
      pushUndoSnapshot();
      ent.materialId = selMat.value;
      autosaveDoc();
      void remountEditScene();
    };
    const btnOpenShader = document.createElement('button');
    btnOpenShader.textContent = '🎨 Редактировать шейдер / текстуру';
    btnOpenShader.onclick = () => {
      activateTab('shaders');
      shaderEditor.selectMaterial(ent.materialId);
    };
    cardMat.append(selMat, btnOpenShader);

    // 5. Room or Light specific card
    if (ent.kind === 'room') {
      const rc = (ent.roomConfig = ent.roomConfig ?? { doors: ['south'], roof: true, floor: true });
      const cardRoom = document.createElement('div');
      cardRoom.className = 'card';
      cardRoom.innerHTML = `<div class="card-title">Настройки комнаты</div>`;
      const rowChecks = document.createElement('div');
      rowChecks.className = 'row-gap';
      const mkChk = (lbl: string, val: boolean, fn: (v: boolean) => void) => {
        const l = document.createElement('label');
        l.className = 'tb-chk';
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = val;
        c.onchange = () => {
          pushUndoSnapshot();
          fn(c.checked);
          autosaveDoc();
          void remountEditScene();
        };
        l.append(c, document.createTextNode(lbl));
        return l;
      };
      rowChecks.append(
        mkChk('Крыша', rc.roof !== false, (v) => (rc.roof = v)),
        mkChk('Пол', rc.floor !== false, (v) => (rc.floor = v)),
        mkChk('Дверь Юг', (rc.doors ?? []).includes('south'), (v) => {
          const s = new Set<RoomSide>(rc.doors ?? []);
          if (v) s.add('south');
          else s.delete('south');
          rc.doors = Array.from(s);
        }),
        mkChk('Дверь Север', (rc.doors ?? []).includes('north'), (v) => {
          const s = new Set<RoomSide>(rc.doors ?? []);
          if (v) s.add('north');
          else s.delete('north');
          rc.doors = Array.from(s);
        })
      );
      cardRoom.appendChild(rowChecks);
      inspectorEl.append(cardBasic, cardXf, cardPhys, cardMat, cardRoom);
    } else if (ent.kind === 'pointLight' || ent.kind === 'spotLight') {
      const lc = (ent.lightConfig = ent.lightConfig ?? { color: '#ffcf70', intensity: 8, range: 14, enabled: true });
      const cardLight = document.createElement('div');
      cardLight.className = 'card';
      cardLight.innerHTML = `<div class="card-title">Источник света</div>`;
      const lCol = document.createElement('input');
      lCol.type = 'color';
      lCol.value = lc.color;
      lCol.onchange = () => {
        pushUndoSnapshot();
        lc.color = lCol.value;
        autosaveDoc();
        void remountEditScene();
      };
      const lInt = document.createElement('input');
      lInt.type = 'number';
      lInt.value = String(lc.intensity);
      lInt.onchange = () => {
        pushUndoSnapshot();
        lc.intensity = Number(lInt.value);
        autosaveDoc();
        void remountEditScene();
      };
      cardLight.append(lCol, lInt);
      inspectorEl.append(cardBasic, cardXf, cardLight);
    } else {
      inspectorEl.append(cardBasic, cardXf, cardPhys, cardMat);
    }

    // 6. Quick Logic Card
    const cardLogic = document.createElement('div');
    cardLogic.className = 'card';
    cardLogic.innerHTML = `<div class="card-title">Ноды / События (Blueprint)</div>`;
    const btnAddTrigger = document.createElement('button');
    btnAddTrigger.textContent = '+ Событие входа/клика → VFX';
    btnAddTrigger.onclick = () => {
      activateTab('blueprints');
      nodeEditor.addQuickTriggerRule(ent.id, ent.kind === 'trigger' || ent.physics.isTrigger ? 'onTriggerEnter' : 'onRaycastClick');
    };
    cardLogic.appendChild(btnAddTrigger);
    inspectorEl.appendChild(cardLogic);
  }

  function focusSelected() {
    const ent = doc.entities.find((e) => e.id === selectedDocId);
    if (!ent) return;
    orbit.setView(ent.position, Math.max(5, Math.max(...ent.size) * 1.4));
  }

  function spawnEditorEntity(rawKind: string) {
    if (!rawKind) return;
    pushUndoSnapshot();
    const t = orbit.getState().target;
    const snap = (v: number) => Math.round(v * 2) / 2;
    const isDynamicCrate = rawKind === 'crate' || rawKind === 'sphere';
    const kind: EditorEntityKind = rawKind === 'crate' ? 'box' : (rawKind as EditorEntityKind);
    const yPos =
      kind === 'room' || kind === 'stairs' || kind === 'pool'
        ? 0
        : kind === 'sphere'
          ? 0.5
          : 0.75;
    const id = `ent_${Date.now()}`;
    const def: EditorEntityDef = {
      id,
      name: `${kindLabel(rawKind)} #${doc.entities.length + 1}`,
      kind,
      position: [snap(t[0]), yPos, snap(t[2])],
      rotationDeg: [0, 0, 0],
      scale: [1, 1, 1],
      size:
        kind === 'room'
          ? [8, 3.6, 8]
          : kind === 'pool'
            ? [6, 1.8, 6]
            : kind === 'stairs'
              ? [2.4, 3.2, 5]
              : kind === 'ramp'
                ? [3, 1.8, 5]
                : kind === 'trigger'
                  ? [2.4, 2.2, 2.4]
                  : [1.4, 1.4, 1.4],
      radius: 0.5,
      height: 2.0,
      materialId:
        kind === 'trigger'
          ? 'mat_trigger'
          : isDynamicCrate
            ? 'mat_wood'
            : kind === 'pointLight' || kind === 'spotLight'
              ? 'mat_neon'
              : 'mat_wall',
      physics: {
        mode: isDynamicCrate ? 'dynamic' : 'static',
        mass: isDynamicCrate ? 1.5 : 0,
        friction: 0.78,
        restitution: 0.1,
        isTrigger: kind === 'trigger',
      },
      roomConfig: kind === 'room' ? { doors: ['south'], roof: true, floor: true, lightColor: '#ffcf70', godRay: true } : undefined,
      lightConfig: kind === 'pointLight' || kind === 'spotLight' ? { color: '#ffcf70', intensity: 10, range: 16, enabled: true } : undefined,
    };
    doc.entities.push(def);
    selectedDocId = id;
    autosaveDoc();
    renderOutliner();
    renderInspector();
    void remountEditScene();
  }

  // Toolbar bindings
  projNameEl.onchange = () => {
    doc.name = projNameEl.value.trim() || 'Моя игра';
    autosaveDoc();
  };

  const selTemplate = document.getElementById('sel-template') as HTMLSelectElement;
  selTemplate.onchange = async () => {
    if (mode === 'play') await exitPlayMode();
    pushUndoSnapshot();
    doc = createStarterProject(selTemplate.value as StarterTemplateId);
    projNameEl.value = doc.name;
    selectedDocId = doc.entities[0]?.id ?? null;
    autosaveDoc();
    renderOutliner();
    renderInspector();
    nodeEditor.render();
    shaderEditor.render();
    worldPanel.render();
    await remountEditScene();
  };

  const selAddKind = document.getElementById('sel-add-kind') as HTMLSelectElement;
  selAddKind.onchange = () => {
    spawnEditorEntity(selAddKind.value);
    selAddKind.value = '';
  };

  const setTool = (m: GizmoMode) => {
    gizmo.setMode(m);
    document.getElementById('btn-tool-translate')!.classList.toggle('active', m === 'translate');
    document.getElementById('btn-tool-rotate')!.classList.toggle('active', m === 'rotate');
    document.getElementById('btn-tool-scale')!.classList.toggle('active', m === 'scale');
  };
  document.getElementById('btn-tool-translate')!.onclick = () => setTool('translate');
  document.getElementById('btn-tool-rotate')!.onclick = () => setTool('rotate');
  document.getElementById('btn-tool-scale')!.onclick = () => setTool('scale');

  const chkSnap = document.getElementById('chk-snap') as HTMLInputElement;
  chkSnap.onchange = () => gizmo.setSnap(chkSnap.checked ? 0.5 : 0, chkSnap.checked ? 15 : 0);

  const performUndoRedo = async (dir: 'undo' | 'redo') => {
    const src = dir === 'undo' ? undoStack : redoStack;
    const dst = dir === 'undo' ? redoStack : undoStack;
    const snap = src.pop();
    if (!snap) return;
    dst.push(JSON.stringify(doc));
    doc = JSON.parse(snap) as QuarkProjectDoc;
    projNameEl.value = doc.name;
    autosaveDoc();
    renderOutliner();
    renderInspector();
    nodeEditor.render();
    shaderEditor.render();
    worldPanel.render();
    await remountEditScene();
  };
  document.getElementById('btn-undo')!.onclick = () => void performUndoRedo('undo');
  document.getElementById('btn-redo')!.onclick = () => void performUndoRedo('redo');

  document.getElementById('btn-focus')!.onclick = focusSelected;
  document.getElementById('btn-dup')!.onclick = () => {
    const ent = doc.entities.find((e) => e.id === selectedDocId);
    if (!ent) return;
    pushUndoSnapshot();
    const clone: EditorEntityDef = JSON.parse(JSON.stringify(ent));
    clone.id = `ent_${Date.now()}`;
    clone.name = `${ent.name} (копия)`;
    clone.position[0] += 1.5;
    doc.entities.push(clone);
    selectedDocId = clone.id;
    autosaveDoc();
    renderOutliner();
    renderInspector();
    void remountEditScene();
  };
  document.getElementById('btn-del')!.onclick = () => {
    if (!selectedDocId) return;
    pushUndoSnapshot();
    doc.entities = doc.entities.filter((e) => e.id !== selectedDocId);
    doc.welds = doc.welds.filter((w) => w.entityA !== selectedDocId && w.entityB !== selectedDocId);
    selectedDocId = doc.entities[0]?.id ?? null;
    autosaveDoc();
    renderOutliner();
    renderInspector();
    void remountEditScene();
  };
  searchEl.oninput = renderOutliner;

  // GLB Import
  const inpGlb = document.getElementById('inp-glb') as HTMLInputElement;
  inpGlb.onchange = async () => {
    const file = inpGlb.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    pushUndoSnapshot();
    const id = `glb_${Date.now()}`;
    doc.entities.push({
      id,
      name: file.name.replace(/\.glb$/i, ''),
      kind: 'glb',
      position: [0, 0.5, 0],
      rotationDeg: [0, 0, 0],
      scale: [1, 1, 1],
      size: [1.5, 1.5, 1.5],
      materialId: doc.materials[0]?.id ?? 'mat_wall',
      physics: { mode: 'static', mass: 0, friction: 0.75, restitution: 0.1 },
      glbDataBase64: b64,
    });
    selectedDocId = id;
    inpGlb.value = '';
    autosaveDoc();
    renderOutliner();
    renderInspector();
    await remountEditScene();
  };

  // Play / Stop + Export / Import
  const btnPlay = document.getElementById('btn-play')!;
  btnPlay.onclick = () => (mode === 'edit' ? void enterPlayMode() : void exitPlayMode());
  document.getElementById('btn-stop-play')!.onclick = () => void exitPlayMode();

  document.getElementById('btn-save')!.onclick = () => {
    autosaveDoc();
    statsEl.textContent = `✓ Проект "${doc.name}" сохранён в браузере`;
  };
  document.getElementById('btn-export')!.onclick = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.name.replace(/[^\wа-яА-Я-]+/g, '_') || 'my_game'}.quark.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const inpImport = document.getElementById('inp-import') as HTMLInputElement;
  inpImport.onchange = async () => {
    const file = inpImport.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as QuarkProjectDoc;
      if (parsed.version === 1) {
        if (mode === 'play') await exitPlayMode();
        pushUndoSnapshot();
        doc = parsed;
        projNameEl.value = doc.name;
        selectedDocId = doc.entities[0]?.id ?? null;
        autosaveDoc();
        renderOutliner();
        renderInspector();
        nodeEditor.render();
        shaderEditor.render();
        worldPanel.render();
        await remountEditScene();
      }
    } finally {
      inpImport.value = '';
    }
  };

  // Bottom drawer tabs
  const drawerEl = document.getElementById('bottom-drawer')!;
  const tabBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  const tabBodies = ['blueprints', 'shaders', 'world'] as const;
  function activateTab(tab: (typeof tabBodies)[number]) {
    drawerEl.classList.remove('collapsed');
    tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    for (const tb of tabBodies) {
      document.getElementById(`tab-${tb}`)!.classList.toggle('active', tb === tab);
    }
  }
  tabBtns.forEach((b) => {
    b.onclick = () => activateTab((b.dataset.tab as (typeof tabBodies)[number]) || 'blueprints');
  });
  document.getElementById('btn-toggle-drawer')!.onclick = () => drawerEl.classList.toggle('collapsed');

  canvas.addEventListener('click', () => {
    if (mode === 'play') {
      if (!input.isPointerLocked()) input.requestPointerLock();
      else runner?.handlePlayClick();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.code === 'Escape' && mode === 'play') {
      void exitPlayMode();
      return;
    }
    if (mode === 'edit') {
      if (e.code === 'KeyW') setTool('translate');
      else if (e.code === 'KeyE') setTool('rotate');
      else if (e.code === 'KeyR') setTool('scale');
      else if (e.code === 'KeyF') focusSelected();
      else if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault();
        void performUndoRedo('undo');
      } else if ((e.metaKey || e.ctrlKey) && e.code === 'KeyY') {
        e.preventDefault();
        void performUndoRedo('redo');
      }
    }
  });

  // Initial mount & render loop
  input.attach(canvas);
  await remountEditScene();
  renderOutliner();
  renderInspector();
  nodeEditor.render();
  shaderEditor.render();
  worldPanel.render();

  engine.onFixedUpdate((fdt) => runner?.fixedUpdate(fdt));
  let statAcc = 0;
  engine.onUpdate((dt) => {
    if (mode === 'edit') {
      orbit.update(dt, engine.scene.camera);
      gizmo.update();
    }
    runner?.update(dt);
    statAcc += dt;
    if (statAcc >= 0.25) {
      statAcc = 0;
      const st = engine.getStats();
      statsEl.textContent = `${mode === 'play' ? '▶ PLAY' : '✏ EDIT'} · FPS: ${st.fps} · Draws: ${st.drawCalls} · Entities: ${st.entities}`;
    }
  });
  engine.start();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function kindIcon(k: string): string {
  return k === 'room'
    ? '🏠'
    : k === 'trigger'
      ? '🎯'
      : k === 'pointLight' || k === 'spotLight'
        ? '💡'
        : k === 'pool'
          ? '🌊'
          : k === 'stairs' || k === 'ramp'
            ? '🪜'
            : k === 'sphere'
              ? '⚪'
              : '📦';
}

function kindLabel(raw: string): string {
  const map: Record<string, string> = {
    box: 'Блок',
    crate: 'Ящик',
    room: 'Комната',
    stairs: 'Лестница',
    ramp: 'Рампа',
    sphere: 'Сфера',
    cylinder: 'Цилиндр',
    pool: 'Бассейн',
    trigger: 'Триггер',
    breakable: 'Стекло',
    pointLight: 'Лампа',
    spotLight: 'Прожектор',
  };
  return map[raw] ?? raw;
}

void bootstrapEditor();
