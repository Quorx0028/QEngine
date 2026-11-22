import {
  Engine,
  POST_PROCESS_PRESET_NAMES,
  SHADER_PRESET_NAMES,
  type PostProcessPresetName,
  type ShaderPresetName,
  type Vec3Tuple,
} from 'quark-engine';
import wasmUrl from 'quark-engine/wasm?url';
import { GizmoOverlay, type GizmoAxis, type GizmoMode } from './GizmoOverlay';
import { SceneRuntimeBuilder } from './RuntimeRunner';
import {
  addKeyframe,
  createDefaultObject,
  createDefaultSceneDocument,
  parseSceneDocument,
  removeKeyframeAt,
  RUNTIME_STORAGE_KEY,
  serializeSceneDocument,
  uint8ToBase64,
  type EditorColliderKind,
  type EditorObject,
  type EditorSceneDocument,
} from './SceneDocument';

function rgbaToHex(c: [number, number, number, number]): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
  return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
}

function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b, alpha];
}

function computeCameraRay(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  camPos: Vec3Tuple,
  camTarget: Vec3Tuple,
  fovDeg: number
): Vec3Tuple {
  const nx = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
  const ny = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
  const aspect = rect.width / Math.max(1, rect.height);
  const tanHalf = Math.tan(((fovDeg * Math.PI) / 180) * 0.5);

  const fx = camTarget[0] - camPos[0];
  const fy = camTarget[1] - camPos[1];
  const fz = camTarget[2] - camPos[2];
  const fLen = Math.hypot(fx, fy, fz) || 1;
  const f: Vec3Tuple = [fx / fLen, fy / fLen, fz / fLen];

  let rx = -f[2];
  let rz = f[0];
  const rLen = Math.hypot(rx, rz) || 1;
  rx /= rLen;
  rz /= rLen;
  const r: Vec3Tuple = [rx, 0, rz];

  const u: Vec3Tuple = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];

  const dx = f[0] + r[0] * nx * aspect * tanHalf + u[0] * ny * tanHalf;
  const dy = f[1] + r[1] * nx * aspect * tanHalf + u[1] * ny * tanHalf;
  const dz = f[2] + r[2] * nx * aspect * tanHalf + u[2] * ny * tanHalf;
  const len = Math.hypot(dx, dy, dz) || 1;
  return [dx / len, dy / len, dz / len];
}

function rayHitAabb(
  origin: Vec3Tuple,
  dir: Vec3Tuple,
  center: Vec3Tuple,
  halfExtents: Vec3Tuple
): number | null {
  let tmin = 0.05;
  let tmax = 1000;
  for (let i = 0; i < 3; i++) {
    const minB = center[i] - Math.max(0.2, halfExtents[i]);
    const maxB = center[i] + Math.max(0.2, halfExtents[i]);
    if (Math.abs(dir[i]) < 1e-6) {
      if (origin[i] < minB || origin[i] > maxB) return null;
    } else {
      let t1 = (minB - origin[i]) / dir[i];
      let t2 = (maxB - origin[i]) / dir[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const playerOnly = params.get('mode') === 'player';

  const appShell = document.getElementById('app')!;
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
  const gizmoCanvas = document.getElementById('gizmo-canvas') as HTMLCanvasElement;
  const gizmo = new GizmoOverlay(gizmoCanvas);

  const engine = await Engine.init({ canvas: glCanvas, wasmUrl });
  const runner = new SceneRuntimeBuilder(engine);

  let doc: EditorSceneDocument;
  const savedJson = localStorage.getItem(RUNTIME_STORAGE_KEY);
  if (savedJson) {
    try {
      doc = parseSceneDocument(savedJson);
    } catch {
      doc = createDefaultSceneDocument();
    }
  } else {
    doc = createDefaultSceneDocument();
  }

  let selectedId: string | null = doc.objects[1]?.id ?? doc.objects[0]?.id ?? null;
  let playMode = playerOnly;
  let gizmoMode: GizmoMode = 'move';
  let animPlaying = false;
  let animTime = 0;

  // Camera state
  let camPos: Vec3Tuple = [6, 5.5, 13];
  let camYaw = 0.35;
  let camPitch = -0.28;
  let playYaw = 0;
  let playPitch = -0.1;
  let wasGrounded = true;

  // Persist helper
  const saveToLocal = () => {
    try {
      localStorage.setItem(RUNTIME_STORAGE_KEY, serializeSceneDocument(doc));
    } catch {
      // Ignore quota overflow for large GLBs
    }
  };

  if (playerOnly) {
    appShell.classList.add('player-only');
    (document.getElementById('player-hud') as HTMLElement).style.display = 'block';
    document.getElementById('btn-back-editor')!.onclick = () => {
      window.location.href = window.location.pathname;
    };
  }

  // DOM refs
  const inpSceneName = document.getElementById('inp-scene-name') as HTMLInputElement;
  const hierList = document.getElementById('hierarchy-list')!;
  const inspectorBody = document.getElementById('inspector-body')!;
  const envPp = document.getElementById('env-pp') as HTMLSelectElement;
  const envShadows = document.getElementById('env-shadows') as HTMLInputElement;
  const envFog = document.getElementById('env-fog') as HTMLInputElement;
  const envSun = document.getElementById('env-sun') as HTMLInputElement;
  const rngAnim = document.getElementById('rng-anim-time') as HTMLInputElement;
  const lblAnimTime = document.getElementById('lbl-anim-time')!;
  const inpAnimDur = document.getElementById('inp-anim-dur') as HTMLInputElement;
  const chkAnimLoop = document.getElementById('chk-anim-loop') as HTMLInputElement;
  const kfMarkers = document.getElementById('kf-markers')!;
  const viewportHud = document.getElementById('viewport-hud')!;

  POST_PROCESS_PRESET_NAMES.forEach((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    envPp.appendChild(o);
  });

  function selectedObject(): EditorObject | undefined {
    return doc.objects.find((o) => o.id === selectedId);
  }

  function syncEnvUi(): void {
    inpSceneName.value = doc.name;
    envPp.value = doc.environment.postProcess;
    envShadows.checked = doc.environment.shadowsEnabled;
    envFog.value = String(doc.environment.fogDensity);
    envSun.value = String(doc.environment.lightIntensity);
    inpAnimDur.value = String(doc.timelineDuration);
    chkAnimLoop.checked = doc.timelineLoop;
    rngAnim.max = String(doc.timelineDuration);
  }

  function renderHierarchy(): void {
    hierList.innerHTML = '';
    for (const obj of doc.objects) {
      const row = document.createElement('div');
      row.className = `hier-item${obj.id === selectedId ? ' selected' : ''}`;
      const tag = obj.lightKind !== 'none' ? obj.lightKind.toUpperCase() : obj.meshKind.toUpperCase();
      row.innerHTML = `<span>${obj.name}</span><span class="hier-tag">${tag}</span>`;
      row.onclick = () => {
        selectedId = obj.id;
        renderHierarchy();
        renderInspector();
        renderKeyframeMarkers();
      };
      hierList.appendChild(row);
    }
  }

  function renderKeyframeMarkers(): void {
    kfMarkers.innerHTML = '';
    const obj = selectedObject();
    if (!obj) return;
    const dur = Math.max(0.1, doc.timelineDuration);
    for (const kf of obj.keyframes) {
      const dot = document.createElement('div');
      dot.className = 'kf-dot';
      dot.style.left = `${Math.min(100, (kf.time / dur) * 100)}%`;
      dot.title = `${kf.time.toFixed(2)}s`;
      dot.onclick = () => {
        animTime = kf.time;
        rngAnim.value = String(animTime);
        lblAnimTime.textContent = `${animTime.toFixed(2)}s`;
        runner.applyTimelineAt(doc, animTime);
      };
      kfMarkers.appendChild(dot);
    }
  }

  function bindVec3Inputs(
    container: HTMLElement,
    label: string,
    vec: Vec3Tuple,
    step: number,
    onChange: () => void
  ): void {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const row = document.createElement('div');
    row.className = 'vec3-row';
    (['X', 'Y', 'Z'] as const).forEach((axis, idx) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = String(step);
      inp.title = `${label} ${axis}`;
      inp.value = String(Number(vec[idx].toFixed(2)));
      inp.oninput = () => {
        const v = Number(inp.value);
        if (Number.isFinite(v)) {
          vec[idx] = v;
          onChange();
        }
      };
      row.appendChild(inp);
    });
    wrap.appendChild(row);
    container.appendChild(wrap);
  }

  async function renderInspector(): Promise<void> {
    inspectorBody.innerHTML = '';
    const obj = selectedObject();
    if (!obj) {
      inspectorBody.innerHTML = '<div style="padding:10px;opacity:0.6;">Select an object</div>';
      return;
    }

    const secInfo = document.createElement('div');
    secInfo.className = 'inspector-section';
    secInfo.innerHTML = `<h4>Transform</h4>`;
    const nameLbl = document.createElement('label');
    nameLbl.textContent = 'Name';
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.value = obj.name;
    nameInp.oninput = () => {
      obj.name = nameInp.value;
      renderHierarchy();
      saveToLocal();
    };
    nameLbl.appendChild(nameInp);
    secInfo.appendChild(nameLbl);

    const onXformEdit = () => {
      runner.syncSingleObject(doc, obj);
      saveToLocal();
    };
    bindVec3Inputs(secInfo, 'Position', obj.position, 0.1, onXformEdit);
    bindVec3Inputs(secInfo, 'Rotation (deg)', obj.rotationDeg, 1, onXformEdit);
    bindVec3Inputs(secInfo, 'Scale', obj.scale, 0.1, onXformEdit);
    inspectorBody.appendChild(secInfo);

    if (obj.meshKind !== 'lightMarker') {
      const secMat = document.createElement('div');
      secMat.className = 'inspector-section';
      secMat.innerHTML = `<h4>Material & Shader</h4>`;

      const presetSel = document.createElement('select');
      SHADER_PRESET_NAMES.forEach((p) => {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        presetSel.appendChild(o);
      });
      presetSel.value = obj.material.preset;
      presetSel.onchange = () => {
        obj.material.preset = presetSel.value as ShaderPresetName;
        runner.syncSingleObject(doc, obj);
        saveToLocal();
      };
      const presetLbl = document.createElement('label');
      presetLbl.textContent = 'Shader Preset';
      presetLbl.appendChild(presetSel);
      secMat.appendChild(presetLbl);

      const colInp = document.createElement('input');
      colInp.type = 'color';
      colInp.value = rgbaToHex(obj.material.baseColor);
      colInp.oninput = () => {
        obj.material.baseColor = hexToRgba(colInp.value, obj.material.baseColor[3]);
        runner.syncSingleObject(doc, obj);
        saveToLocal();
      };
      const colLbl = document.createElement('label');
      colLbl.className = 'inline';
      colLbl.append('Base Color', colInp);
      secMat.appendChild(colLbl);

      const roughInp = document.createElement('input');
      roughInp.type = 'range';
      roughInp.min = '0.05';
      roughInp.max = '1';
      roughInp.step = '0.02';
      roughInp.value = String(obj.material.roughness);
      roughInp.oninput = () => {
        obj.material.roughness = Number(roughInp.value);
        runner.syncSingleObject(doc, obj);
        saveToLocal();
      };
      const roughLbl = document.createElement('label');
      roughLbl.textContent = 'Roughness';
      roughLbl.appendChild(roughInp);
      secMat.appendChild(roughLbl);

      const metInp = document.createElement('input');
      metInp.type = 'range';
      metInp.min = '0';
      metInp.max = '1';
      metInp.step = '0.02';
      metInp.value = String(obj.material.metallic);
      metInp.oninput = () => {
        obj.material.metallic = Number(metInp.value);
        runner.syncSingleObject(doc, obj);
        saveToLocal();
      };
      const metLbl = document.createElement('label');
      metLbl.textContent = 'Metallic';
      metLbl.appendChild(metInp);
      secMat.appendChild(metLbl);

      const outInp = document.createElement('input');
      outInp.type = 'range';
      outInp.min = '0';
      outInp.max = '0.08';
      outInp.step = '0.005';
      outInp.value = String(obj.material.outlineWidth);
      outInp.oninput = () => {
        obj.material.outlineWidth = Number(outInp.value);
        runner.syncSingleObject(doc, obj);
        saveToLocal();
      };
      const outLbl = document.createElement('label');
      outLbl.textContent = 'Outline Width';
      outLbl.appendChild(outInp);
      secMat.appendChild(outLbl);

      inspectorBody.appendChild(secMat);
    }

    if (obj.lightKind !== 'none') {
      const secL = document.createElement('div');
      secL.className = 'inspector-section';
      secL.innerHTML = `<h4>${obj.lightKind === 'spot' ? 'SpotLight' : 'PointLight'}</h4>`;

      const lCol = document.createElement('input');
      lCol.type = 'color';
      lCol.value = rgbaToHex([obj.light.color[0], obj.light.color[1], obj.light.color[2], 1]);
      lCol.oninput = () => {
        const c = hexToRgba(lCol.value);
        obj.light.color = [c[0], c[1], c[2]];
        runner.syncLights(doc);
        saveToLocal();
      };
      const lColLbl = document.createElement('label');
      lColLbl.className = 'inline';
      lColLbl.append('Light Color', lCol);
      secL.appendChild(lColLbl);

      const lInt = document.createElement('input');
      lInt.type = 'number';
      lInt.step = '0.2';
      lInt.value = String(obj.light.intensity);
      lInt.oninput = () => {
        obj.light.intensity = Number(lInt.value) || 0;
        runner.syncLights(doc);
        saveToLocal();
      };
      const lIntLbl = document.createElement('label');
      lIntLbl.textContent = 'Intensity';
      lIntLbl.appendChild(lInt);
      secL.appendChild(lIntLbl);

      const lRng = document.createElement('input');
      lRng.type = 'number';
      lRng.step = '1';
      lRng.value = String(obj.light.range);
      lRng.oninput = () => {
        obj.light.range = Number(lRng.value) || 1;
        runner.syncLights(doc);
        saveToLocal();
      };
      const lRngLbl = document.createElement('label');
      lRngLbl.textContent = 'Range';
      lRngLbl.appendChild(lRng);
      secL.appendChild(lRngLbl);
      inspectorBody.appendChild(secL);
    }

    if (obj.meshKind === 'glb') {
      const secGlb = document.createElement('div');
      secGlb.className = 'inspector-section';
      secGlb.innerHTML = `<h4>Skeletal GLB Animation</h4>`;
      const { clipNames } = await runner.resolveGlb(obj);
      if (clipNames.length > 0) {
        const clipSel = document.createElement('select');
        clipNames.forEach((cn) => {
          const o = document.createElement('option');
          o.value = cn;
          o.textContent = cn;
          clipSel.appendChild(o);
        });
        clipSel.value = obj.activeClip ?? clipNames[0];
        clipSel.onchange = () => {
          obj.activeClip = clipSel.value;
          const binding = runner.bindings.get(obj.id);
          if (binding && binding.meshHandle.skeletonId !== null) {
            engine.scene.playAnimation(
              binding.entity,
              binding.meshHandle.skeletonId,
              binding.meshHandle.clips[clipSel.value],
              { speed: obj.animSpeed ?? 1, loop: obj.animLoop ?? true }
            );
          }
          saveToLocal();
        };
        const clipLbl = document.createElement('label');
        clipLbl.textContent = 'Clip';
        clipLbl.appendChild(clipSel);
        secGlb.appendChild(clipLbl);
      } else {
        secGlb.innerHTML += '<div style="opacity:0.65;">No skeletal clips in GLB</div>';
      }
      inspectorBody.appendChild(secGlb);
    }

    const secPhys = document.createElement('div');
    secPhys.className = 'inspector-section';
    secPhys.innerHTML = `<h4>Physics (Active in Play)</h4>`;
    const physEnable = document.createElement('input');
    physEnable.type = 'checkbox';
    physEnable.checked = obj.physics.enabled;
    physEnable.onchange = () => {
      obj.physics.enabled = physEnable.checked;
      saveToLocal();
    };
    const pEnLbl = document.createElement('label');
    pEnLbl.className = 'inline';
    pEnLbl.append(physEnable, 'Enable Collider');
    secPhys.appendChild(pEnLbl);

    const dynChk = document.createElement('input');
    dynChk.type = 'checkbox';
    dynChk.checked = obj.physics.dynamic;
    dynChk.onchange = () => {
      obj.physics.dynamic = dynChk.checked;
      saveToLocal();
    };
    const dynLbl = document.createElement('label');
    dynLbl.className = 'inline';
    dynLbl.append(dynChk, 'Dynamic RigidBody');
    secPhys.appendChild(dynLbl);

    const ctrlChk = document.createElement('input');
    ctrlChk.type = 'checkbox';
    ctrlChk.checked = obj.physics.isCharacterController;
    ctrlChk.onchange = () => {
      obj.physics.isCharacterController = ctrlChk.checked;
      if (ctrlChk.checked) {
        obj.physics.dynamic = true;
        obj.physics.lockRotation = true;
      }
      saveToLocal();
    };
    const ctrlLbl = document.createElement('label');
    ctrlLbl.className = 'inline';
    ctrlLbl.append(ctrlChk, 'Playable Character (WASD)');
    secPhys.appendChild(ctrlLbl);

    const colSel = document.createElement('select');
    (['none', 'aabb', 'sphere', 'capsule'] as EditorColliderKind[]).forEach((ck) => {
      const o = document.createElement('option');
      o.value = ck;
      o.textContent = ck;
      colSel.appendChild(o);
    });
    colSel.value = obj.physics.colliderKind;
    colSel.onchange = () => {
      obj.physics.colliderKind = colSel.value as EditorColliderKind;
      saveToLocal();
    };
    const colKindLbl = document.createElement('label');
    colKindLbl.textContent = 'Collider Shape';
    colKindLbl.appendChild(colSel);
    secPhys.appendChild(colKindLbl);

    const physNumInputs: Record<string, HTMLInputElement> = {};
    const addPhysNum = (
      key: string,
      title: string,
      val: number,
      min: number,
      max: number,
      step: number,
      onChange: (n: number) => void
    ) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.value = String(val);
      inp.oninput = () => {
        const parsed = Number(inp.value);
        if (Number.isFinite(parsed)) {
          onChange(Math.max(min, Math.min(max, parsed)));
          saveToLocal();
        }
      };
      physNumInputs[key] = inp;
      const lbl = document.createElement('label');
      lbl.textContent = title;
      lbl.appendChild(inp);
      secPhys.appendChild(lbl);
    };

    addPhysNum('mass', 'Mass (kg)', obj.physics.mass, 0.05, 500, 0.1, (n) => {
      obj.physics.mass = n;
    });
    addPhysNum('friction', 'Friction', obj.physics.friction, 0, 2, 0.05, (n) => {
      obj.physics.friction = n;
    });
    addPhysNum('restitution', 'Restitution (Bounce)', obj.physics.restitution, 0, 1, 0.05, (n) => {
      obj.physics.restitution = n;
    });
    addPhysNum('gravityScale', 'Gravity Scale', obj.physics.gravityScale, -3, 5, 0.1, (n) => {
      obj.physics.gravityScale = n;
    });
    addPhysNum('linearDamping', 'Linear Damping', obj.physics.linearDamping ?? 0.12, 0, 5, 0.05, (n) => {
      obj.physics.linearDamping = n;
    });
    addPhysNum('angularDamping', 'Angular Damping', obj.physics.angularDamping ?? 0.35, 0, 5, 0.05, (n) => {
      obj.physics.angularDamping = n;
    });

    const lockChk = document.createElement('input');
    lockChk.type = 'checkbox';
    lockChk.checked = obj.physics.lockRotation;
    lockChk.onchange = () => {
      obj.physics.lockRotation = lockChk.checked;
      saveToLocal();
    };
    const lockLbl = document.createElement('label');
    lockLbl.className = 'inline';
    lockLbl.append(lockChk, 'Lock Rotation');
    secPhys.appendChild(lockLbl);

    const trigChk = document.createElement('input');
    trigChk.type = 'checkbox';
    trigChk.checked = obj.physics.isTrigger;
    trigChk.onchange = () => {
      obj.physics.isTrigger = trigChk.checked;
      saveToLocal();
    };
    const trigLbl = document.createElement('label');
    trigLbl.className = 'inline';
    trigLbl.append(trigChk, 'Is Trigger Volume');
    secPhys.appendChild(trigLbl);

    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;';
    const physPresets: Array<{ label: string; mass: number; friction: number; restitution: number; linearDamping: number }> = [
      { label: 'Wood 1kg', mass: 1, friction: 0.78, restitution: 0.12, linearDamping: 0.12 },
      { label: 'Steel 20kg', mass: 20, friction: 0.65, restitution: 0.08, linearDamping: 0.08 },
      { label: 'Ice', mass: 1, friction: 0.02, restitution: 0.05, linearDamping: 0.02 },
      { label: 'Rubber', mass: 1.5, friction: 0.9, restitution: 0.85, linearDamping: 0.05 },
    ];
    for (const pr of physPresets) {
      const btn = document.createElement('button');
      btn.textContent = pr.label;
      btn.style.fontSize = '11px';
      btn.onclick = () => {
        obj.physics.mass = pr.mass;
        obj.physics.friction = pr.friction;
        obj.physics.restitution = pr.restitution;
        obj.physics.linearDamping = pr.linearDamping;
        physNumInputs.mass.value = String(pr.mass);
        physNumInputs.friction.value = String(pr.friction);
        physNumInputs.restitution.value = String(pr.restitution);
        physNumInputs.linearDamping.value = String(pr.linearDamping);
        saveToLocal();
      };
      presetRow.appendChild(btn);
    }
    secPhys.appendChild(presetRow);

    inspectorBody.appendChild(secPhys);
  }

  // Toolbar bindings
  const setGizmo = (m: GizmoMode) => {
    gizmoMode = m;
    document.getElementById('btn-gizmo-move')!.classList.toggle('active', m === 'move');
    document.getElementById('btn-gizmo-rotate')!.classList.toggle('active', m === 'rotate');
    document.getElementById('btn-gizmo-scale')!.classList.toggle('active', m === 'scale');
  };
  document.getElementById('btn-gizmo-move')!.onclick = () => setGizmo('move');
  document.getElementById('btn-gizmo-rotate')!.onclick = () => setGizmo('rotate');
  document.getElementById('btn-gizmo-scale')!.onclick = () => setGizmo('scale');

  async function addEditorObject(obj: EditorObject) {
    doc.objects.push(obj);
    selectedId = obj.id;
    saveToLocal();
    await runner.rebuild(doc, playMode);
    renderHierarchy();
    renderInspector();
    renderKeyframeMarkers();
  }

  document.getElementById('btn-add-box')!.onclick = () =>
    addEditorObject(createDefaultObject('Cube', 'box', { physics: { ...createDefaultObject('', 'box').physics, dynamic: true } }));
  document.getElementById('btn-add-sphere')!.onclick = () =>
    addEditorObject(createDefaultObject('Sphere', 'sphere', { physics: { ...createDefaultObject('', 'sphere').physics, dynamic: true, colliderKind: 'sphere' } }));
  document.getElementById('btn-add-ramp')!.onclick = () =>
    addEditorObject(createDefaultObject('Ramp', 'ramp', { scale: [3, 1.5, 4] }));
  document.getElementById('btn-add-point')!.onclick = () =>
    addEditorObject(createDefaultObject('PointLight', 'lightMarker', { position: [0, 3, 0], scale: [0.35, 0.35, 0.35], lightKind: 'point' }));
  document.getElementById('btn-add-spot')!.onclick = () =>
    addEditorObject(createDefaultObject('SpotLight', 'lightMarker', { position: [0, 4, 3], rotationDeg: [-25, 0, 0], scale: [0.35, 0.35, 0.35], lightKind: 'spot' }));

  const importGlbBytes = async (fileName: string, bytes: Uint8Array) => {
    const obj = createDefaultObject(fileName.replace(/\.glb$/i, ''), 'glb', {
      position: [0, 1, 0],
      glbName: fileName,
      glbBase64: uint8ToBase64(bytes),
    });
    await addEditorObject(obj);
  };

  const fileGlb = document.getElementById('file-glb') as HTMLInputElement;
  document.getElementById('btn-import-glb')!.onclick = () => fileGlb.click();
  fileGlb.onchange = async () => {
    const f = fileGlb.files?.[0];
    if (f) await importGlbBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    fileGlb.value = '';
  };

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && f.name.toLowerCase().endsWith('.glb')) {
      await importGlbBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    }
  });

  document.getElementById('btn-dup-obj')!.onclick = () => {
    const obj = selectedObject();
    if (!obj) return;
    const clone = parseSceneDocument(serializeSceneDocument({ ...doc, objects: [obj] })).objects[0];
    clone.id = `obj_${Date.now().toString(36)}_copy`;
    clone.name = `${obj.name} Copy`;
    clone.position = [obj.position[0] + 1, obj.position[1], obj.position[2]];
    addEditorObject(clone);
  };

  document.getElementById('btn-del-obj')!.onclick = async () => {
    if (!selectedId || doc.objects.length <= 1) return;
    doc.objects = doc.objects.filter((o) => o.id !== selectedId);
    selectedId = doc.objects[0]?.id ?? null;
    saveToLocal();
    await runner.rebuild(doc, playMode);
    renderHierarchy();
    renderInspector();
    renderKeyframeMarkers();
  };

  inpSceneName.oninput = () => {
    doc.name = inpSceneName.value;
    saveToLocal();
  };
  envPp.onchange = () => {
    doc.environment.postProcess = envPp.value as PostProcessPresetName;
    runner.applyEnvironment(doc);
    saveToLocal();
  };
  envShadows.onchange = () => {
    doc.environment.shadowsEnabled = envShadows.checked;
    runner.applyEnvironment(doc);
    saveToLocal();
  };
  envFog.oninput = () => {
    doc.environment.fogDensity = Number(envFog.value);
    runner.applyEnvironment(doc);
    saveToLocal();
  };
  envSun.oninput = () => {
    doc.environment.lightIntensity = Number(envSun.value);
    runner.applyEnvironment(doc);
    saveToLocal();
  };

  // Play / Stop mode
  const btnPlay = document.getElementById('btn-play-test')!;
  const btnStop = document.getElementById('btn-stop-test')!;
  btnPlay.onclick = async () => {
    playMode = true;
    animPlaying = true;
    animTime = 0;
    btnPlay.classList.add('active');
    await runner.rebuild(doc, true);
    if (runner.playerEntity) {
      const p = engine.scene.getPosition(runner.playerEntity);
      playYaw = 0;
      playPitch = -0.1;
      engine.scene.camera.position = [p[0], p[1] + 0.6, p[2]];
    }
  };
  btnStop.onclick = async () => {
    playMode = false;
    animPlaying = false;
    if (document.pointerLockElement) document.exitPointerLock();
    btnPlay.classList.remove('active');
    await runner.rebuild(doc, false);
  };

  // Timeline controls
  const btnAnimPlay = document.getElementById('btn-anim-play')!;
  btnAnimPlay.onclick = () => {
    animPlaying = !animPlaying;
    btnAnimPlay.classList.toggle('active', animPlaying);
  };
  document.getElementById('btn-add-kf')!.onclick = () => {
    const obj = selectedObject();
    if (!obj) return;
    addKeyframe(obj, animTime, obj.position, obj.rotationDeg, obj.scale);
    renderKeyframeMarkers();
    saveToLocal();
  };
  document.getElementById('btn-del-kf')!.onclick = () => {
    const obj = selectedObject();
    if (!obj) return;
    if (removeKeyframeAt(obj, animTime)) {
      renderKeyframeMarkers();
      saveToLocal();
    }
  };
  rngAnim.oninput = () => {
    animTime = Number(rngAnim.value);
    lblAnimTime.textContent = `${animTime.toFixed(2)}s`;
    runner.applyTimelineAt(doc, animTime);
  };
  inpAnimDur.oninput = () => {
    doc.timelineDuration = Math.max(0.5, Number(inpAnimDur.value) || 4);
    rngAnim.max = String(doc.timelineDuration);
    renderKeyframeMarkers();
    saveToLocal();
  };
  chkAnimLoop.onchange = () => {
    doc.timelineLoop = chkAnimLoop.checked;
    saveToLocal();
  };

  // Save / Load JSON / Launch in Browser
  document.getElementById('btn-save-json')!.onclick = () => {
    const blob = new Blob([serializeSceneDocument(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'scene'}.quark.json`;
    a.click();
  };
  const fileJson = document.getElementById('file-json') as HTMLInputElement;
  document.getElementById('btn-load-json')!.onclick = () => fileJson.click();
  fileJson.onchange = async () => {
    const f = fileJson.files?.[0];
    if (!f) return;
    doc = parseSceneDocument(await f.text());
    selectedId = doc.objects[0]?.id ?? null;
    saveToLocal();
    syncEnvUi();
    await runner.rebuild(doc, playMode);
    renderHierarchy();
    renderInspector();
    renderKeyframeMarkers();
    fileJson.value = '';
  };

  document.getElementById('btn-launch-browser')!.onclick = () => {
    saveToLocal();
    const url = new URL(window.location.href);
    url.searchParams.set('mode', 'player');
    window.open(url.toString(), '_blank');
  };

  // Viewport interaction (Pick + Axis Gizmo Drag + RMB Look + Wheel Zoom)
  let draggingAxis: GizmoAxis | null = null;
  let draggingCamera = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  glCanvas.addEventListener('mousedown', (e) => {
    if (playMode) {
      if (!engine.input.isPointerLocked()) engine.input.requestPointerLock();
      return;
    }
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    if (e.button === 2 || e.button === 1 || e.altKey) {
      draggingCamera = true;
      return;
    }
    if (e.button === 0) {
      const rect = glCanvas.getBoundingClientRect();
      const aspect = glCanvas.clientWidth / Math.max(1, glCanvas.clientHeight);
      const { viewProj } = engine.scene.computeCameraMatrices(aspect);
      const sel = selectedObject();
      if (sel) {
        const mx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * gizmoCanvas.width;
        const my = ((e.clientY - rect.top) / Math.max(1, rect.height)) * gizmoCanvas.height;
        const hitAxis = gizmo.pickAxis(mx, my, sel.position, engine.scene.camera.position, viewProj);
        if (hitAxis) {
          draggingAxis = hitAxis;
          return;
        }
      }

      // Ray-pick object by bounding box
      const rayDir = computeCameraRay(
        e.clientX,
        e.clientY,
        rect,
        engine.scene.camera.position,
        engine.scene.camera.target,
        engine.scene.camera.fovDeg
      );
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const obj of doc.objects) {
        const hx = Math.max(0.3, obj.scale[0] * 0.5);
        const hy = obj.meshKind === 'plane' ? 0.15 : Math.max(0.3, obj.scale[1] * 0.5);
        const hz = Math.max(0.3, obj.scale[2] * 0.5);
        const d = rayHitAabb(engine.scene.camera.position, rayDir, obj.position, [hx, hy, hz]);
        if (d !== null && d < bestDist) {
          bestDist = d;
          bestId = obj.id;
        }
      }
      if (bestId) {
        selectedId = bestId;
        renderHierarchy();
        renderInspector();
        renderKeyframeMarkers();
      }
    }
  });

  window.addEventListener('mousemove', (e) => {
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    if (draggingCamera && !playMode) {
      camYaw -= dx * 0.005;
      camPitch = Math.max(-1.4, Math.min(1.4, camPitch - dy * 0.005));
      return;
    }

    if (draggingAxis && !playMode) {
      const sel = selectedObject();
      if (!sel) return;
      const aspect = glCanvas.clientWidth / Math.max(1, glCanvas.clientHeight);
      const { viewProj } = engine.scene.computeCameraMatrices(aspect);
      const [sx, sy, worldPerPx] = gizmo.axisScreenDir(
        draggingAxis,
        sel.position,
        engine.scene.camera.position,
        viewProj
      );
      const scaleX = gizmoCanvas.width / Math.max(1, glCanvas.clientWidth);
      const scaleY = gizmoCanvas.height / Math.max(1, glCanvas.clientHeight);
      const projDelta = dx * scaleX * sx + dy * scaleY * sy;
      const axIdx = draggingAxis === 'x' ? 0 : draggingAxis === 'y' ? 1 : 2;

      if (gizmoMode === 'move') {
        sel.position[axIdx] = Number((sel.position[axIdx] + projDelta * worldPerPx * 1.15).toFixed(3));
      } else if (gizmoMode === 'scale') {
        sel.scale[axIdx] = Math.max(0.1, Number((sel.scale[axIdx] + projDelta * 0.015).toFixed(3)));
      } else {
        sel.rotationDeg[axIdx] = Number((sel.rotationDeg[axIdx] + (dx - dy) * 0.6).toFixed(1));
      }
      runner.syncSingleObject(doc, sel);
      renderInspector();
      saveToLocal();
    }
  });

  window.addEventListener('mouseup', () => {
    draggingAxis = null;
    draggingCamera = false;
  });

  glCanvas.addEventListener(
    'wheel',
    (e) => {
      if (playMode) return;
      e.preventDefault();
      const fx = -Math.sin(camYaw) * Math.cos(camPitch);
      const fy = Math.sin(camPitch);
      const fz = -Math.cos(camYaw) * Math.cos(camPitch);
      const step = -e.deltaY * 0.015;
      camPos = [camPos[0] + fx * step, camPos[1] + fy * step, camPos[2] + fz * step];
    },
    { passive: false }
  );

  // Physics fixed update for Play mode / Standalone Player
  engine.onFixedUpdate(() => {
    if (!playMode || !runner.playerEntity) return;
    const fx = -Math.sin(playYaw);
    const fz = -Math.cos(playYaw);
    const rx = Math.cos(playYaw);
    const rz = -Math.sin(playYaw);
    let mf = 0;
    let mr = 0;
    if (engine.input.isKeyDown('KeyW') || engine.input.isKeyDown('ArrowUp')) mf += 1;
    if (engine.input.isKeyDown('KeyS') || engine.input.isKeyDown('ArrowDown')) mf -= 1;
    if (engine.input.isKeyDown('KeyD') || engine.input.isKeyDown('ArrowRight')) mr += 1;
    if (engine.input.isKeyDown('KeyA') || engine.input.isKeyDown('ArrowLeft')) mr -= 1;
    const len = Math.hypot(mf, mr) || 1;
    const spd = engine.input.isKeyDown('ShiftLeft') ? 10 : 6.2;
    const vx = mf || mr ? ((fx * mf + rx * mr) / len) * spd : 0;
    const vz = mf || mr ? ((fz * mf + rz * mr) / len) * spd : 0;

    const [, vy] = engine.scene.getVelocity(runner.playerEntity);
    const grounded = engine.scene.isGrounded(runner.playerEntity);
    const jump = engine.input.isKeyDown('Space') && grounded && wasGrounded ? 9.0 : vy;
    wasGrounded = grounded;
    engine.scene.setVelocity(runner.playerEntity, vx, jump, vz);
  });

  engine.onUpdate((dt) => {
    if (!playMode) {
      if (engine.input.wasKeyPressed('KeyW') && !draggingCamera) setGizmo('move');
      if (engine.input.wasKeyPressed('KeyE') && !draggingCamera) setGizmo('rotate');
      if (engine.input.wasKeyPressed('KeyR') && !draggingCamera) setGizmo('scale');
      if (engine.input.wasKeyPressed('KeyK')) document.getElementById('btn-add-kf')!.click();

      if (draggingCamera) {
        const spd = (engine.input.isKeyDown('ShiftLeft') ? 16 : 8) * dt;
        const fx = -Math.sin(camYaw) * Math.cos(camPitch);
        const fy = Math.sin(camPitch);
        const fz = -Math.cos(camYaw) * Math.cos(camPitch);
        const rx = Math.cos(camYaw);
        const rz = -Math.sin(camYaw);
        if (engine.input.isKeyDown('KeyW')) camPos = [camPos[0] + fx * spd, camPos[1] + fy * spd, camPos[2] + fz * spd];
        if (engine.input.isKeyDown('KeyS')) camPos = [camPos[0] - fx * spd, camPos[1] - fy * spd, camPos[2] - fz * spd];
        if (engine.input.isKeyDown('KeyD')) camPos = [camPos[0] + rx * spd, camPos[1], camPos[2] + rz * spd];
        if (engine.input.isKeyDown('KeyA')) camPos = [camPos[0] - rx * spd, camPos[1], camPos[2] - rz * spd];
      }

      const lookX = -Math.sin(camYaw) * Math.cos(camPitch);
      const lookY = Math.sin(camPitch);
      const lookZ = -Math.cos(camYaw) * Math.cos(camPitch);
      engine.scene.camera.position = camPos;
      engine.scene.camera.target = [camPos[0] + lookX, camPos[1] + lookY, camPos[2] + lookZ];
    } else {
      const [mdx, mdy] = engine.input.consumeMouseDelta();
      playYaw -= mdx * 0.0024;
      playPitch = Math.max(-1.2, Math.min(1.1, playPitch - mdy * 0.0022));
      if (runner.playerEntity) {
        const [px, py, pz] = engine.scene.getPosition(runner.playerEntity);
        const eyeY = py + 0.65;
        const lx = -Math.sin(playYaw) * Math.cos(playPitch);
        const ly = Math.sin(playPitch);
        const lz = -Math.cos(playYaw) * Math.cos(playPitch);
        engine.scene.camera.position = [px, eyeY, pz];
        engine.scene.camera.target = [px + lx, eyeY + ly, pz + lz];
      } else {
        const lx = -Math.sin(camYaw) * Math.cos(camPitch);
        const ly = Math.sin(camPitch);
        const lz = -Math.cos(camYaw) * Math.cos(camPitch);
        engine.scene.camera.position = camPos;
        engine.scene.camera.target = [camPos[0] + lx, camPos[1] + ly, camPos[2] + lz];
      }
    }

    if (animPlaying || playMode) {
      animTime += dt;
      if (doc.timelineLoop) {
        animTime %= Math.max(0.1, doc.timelineDuration);
      } else if (animTime > doc.timelineDuration) {
        animTime = doc.timelineDuration;
        if (!playMode) animPlaying = false;
      }
      rngAnim.value = String(animTime);
      lblAnimTime.textContent = `${animTime.toFixed(2)}s`;
      runner.applyTimelineAt(doc, animTime);
    }

    if (!playerOnly) {
      gizmo.resize(glCanvas.width, glCanvas.height);
      const aspect = glCanvas.height > 0 ? glCanvas.width / glCanvas.height : 16 / 9;
      const { viewProj } = engine.scene.computeCameraMatrices(aspect);
      const sel = !playMode ? selectedObject() : undefined;
      gizmo.draw(
        sel ? sel.position : null,
        engine.scene.camera.position,
        viewProj,
        gizmoMode,
        draggingAxis,
        sel?.name
      );

      const st = engine.getStats();
      viewportHud.textContent =
        `${playMode ? 'PLAY MODE' : 'EDIT MODE'} · FPS ${st.fps} · Entities ${st.entities} · Draws ${st.drawCalls} · ` +
        (playMode ? 'Click canvas to control Player (WASD+Space), Stop to edit' : 'Click object · Drag X/Y/Z axis · Right-drag look + WASD');
    }
  });

  syncEnvUi();
  await runner.rebuild(doc, playMode);
  renderHierarchy();
  renderInspector();
  renderKeyframeMarkers();
  engine.start();
}

bootstrap().catch((err) => {
  console.error(err);
});
