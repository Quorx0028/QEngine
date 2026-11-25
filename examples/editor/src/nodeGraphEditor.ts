import {
  BLUEPRINT_NODE_CATALOG,
  NODE_SPEC_BY_TYPE,
  type BlueprintGraph,
  type BlueprintNode,
  type BlueprintNodeType,
  type QuarkProjectDoc,
} from 'quark-engine';

const PARAM_LABELS: Record<string, string> = {
  entityId: 'Объект',
  triggerEntityId: 'Зона',
  targetEntityId: 'Цель',
  anchorEntityId: 'Привязка',
  onlyPlayer: 'Только игрок',
  minImpulse: 'Мин. сила',
  intervalSec: 'Интервал, с',
  durationSec: 'Время, с',
  seconds: 'Пауза, с',
  chance: 'Шанс 0..1',
  opacity: 'Прозрачн.',
  intensity: 'Сила',
  color: 'Цвет',
  glow: 'Свечение',
  preset: 'Эффект',
  count: 'Кол-во',
  sound: 'Звук',
  freq: 'Частота',
  varName: 'Переменная',
  label: 'Текст',
  name: 'Имя',
  value: 'Значение',
  op: 'Операция',
  cmp: 'Условие',
  key: 'Клавиша',
  mode: 'Режим',
  locked: 'Статика',
  dynamic: 'Физика',
  kind: 'Форма',
  title: 'Заголовок',
  subtitle: 'Подпись',
  weather: 'Погода',
};

export class NodeGraphEditor {
  private readonly root: HTMLElement;
  private readonly getDoc: () => QuarkProjectDoc;
  private readonly onMutate: (rebuildRequired?: boolean) => void;
  private activeGraphId: string | null = null;
  private pendingLink: { nodeId: string; port: string } | null = null;
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private nodeFilter = '';
  private readonly nodeEls = new Map<string, HTMLElement>();

  constructor(
    root: HTMLElement,
    getDoc: () => QuarkProjectDoc,
    onMutate: (rebuildRequired?: boolean) => void
  ) {
    this.root = root;
    this.getDoc = getDoc;
    this.onMutate = onMutate;
  }

  ensureDefaultGraph(): BlueprintGraph {
    const doc = this.getDoc();
    if (doc.blueprints.length === 0) {
      doc.blueprints.push({
        id: `bp_${Date.now()}`,
        name: 'Логика игры',
        enabled: true,
        nodes: [],
        edges: [],
      });
    }
    if (!this.activeGraphId || !doc.blueprints.some((g) => g.id === this.activeGraphId)) {
      this.activeGraphId = doc.blueprints[0].id;
    }
    return doc.blueprints.find((g) => g.id === this.activeGraphId)!;
  }

  addQuickTriggerRule(targetEntityId: string, eventType: 'onTriggerEnter' | 'onRaycastClick'): void {
    const g = this.ensureDefaultGraph();
    const y = 40 + g.nodes.length * 56;
    const n1Id = `n_${Date.now()}_a`;
    const n2Id = `n_${Date.now()}_b`;
    g.nodes.push(
      {
        id: n1Id,
        type: eventType,
        x: 60,
        y,
        params:
          eventType === 'onTriggerEnter'
            ? { triggerEntityId: targetEntityId, onlyPlayer: true }
            : { targetEntityId },
      },
      {
        id: n2Id,
        type: 'emitVfx',
        x: 340,
        y,
        params: { preset: 'confetti', entityId: targetEntityId, x: 0, y: 0.8, z: 0, count: 32 },
      }
    );
    g.edges.push({ id: `e_${Date.now()}`, fromNode: n1Id, fromPort: 'out', toNode: n2Id, toPort: 'in' });
    this.onMutate(false);
    this.render();
  }

  pulseNode(nodeId: string): void {
    const el = this.nodeEls.get(nodeId);
    if (!el) return;
    el.classList.add('pulse');
    window.setTimeout(() => el.classList.remove('pulse'), 300);
  }

  render(): void {
    const doc = this.getDoc();
    const graph = this.ensureDefaultGraph();
    this.nodeEls.clear();
    this.root.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'bp-shell';

    const bar = document.createElement('div');
    bar.className = 'bp-bar';

    const leftBar = document.createElement('div');
    leftBar.className = 'row-gap';

    const selGraph = document.createElement('select');
    selGraph.setAttribute('aria-label', 'Активный граф');
    for (const g of doc.blueprints) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      if (g.id === graph.id) opt.selected = true;
      selGraph.appendChild(opt);
    }
    selGraph.onchange = () => {
      this.activeGraphId = selGraph.value;
      this.pendingLink = null;
      this.render();
    };

    const btnNewGraph = document.createElement('button');
    btnNewGraph.textContent = '+ Граф';
    btnNewGraph.onclick = () => {
      const ng: BlueprintGraph = {
        id: `bp_${Date.now()}`,
        name: `Скрипт ${doc.blueprints.length + 1}`,
        enabled: true,
        nodes: [],
        edges: [],
      };
      doc.blueprints.push(ng);
      this.activeGraphId = ng.id;
      this.onMutate(false);
      this.render();
    };

    const chkEnabled = document.createElement('label');
    chkEnabled.className = 'tb-chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = graph.enabled;
    cb.onchange = () => {
      graph.enabled = cb.checked;
      this.onMutate(false);
    };
    chkEnabled.append(cb, document.createTextNode('Вкл'));

    leftBar.append(selGraph, btnNewGraph, chkEnabled);

    const rightBar = document.createElement('div');
    rightBar.className = 'row-gap';

    const searchInp = document.createElement('input');
    searchInp.type = 'text';
    searchInp.className = 'search';
    searchInp.placeholder = 'Найти ноду';
    searchInp.value = this.nodeFilter;
    searchInp.setAttribute('aria-label', 'Поиск ноды для добавления');

    const selQuickAdd = document.createElement('select');
    selQuickAdd.setAttribute('aria-label', 'Добавить ноду');
    const populateQuickAdd = () => {
      selQuickAdd.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = this.nodeFilter ? '+ Выбрать найденную...' : '+ Добавить ноду';
      selQuickAdd.appendChild(def);
      const q = this.nodeFilter.trim().toLowerCase();
      for (const spec of BLUEPRINT_NODE_CATALOG) {
        if (q && !spec.label.toLowerCase().includes(q) && !spec.type.toLowerCase().includes(q)) continue;
        const opt = document.createElement('option');
        opt.value = spec.type;
        const cat = spec.category === 'event' ? 'Событие' : spec.category === 'logic' ? 'Логика' : 'Действие';
        opt.textContent = `${cat}: ${spec.label}`;
        selQuickAdd.appendChild(opt);
      }
    };
    populateQuickAdd();
    searchInp.oninput = () => {
      this.nodeFilter = searchInp.value;
      populateQuickAdd();
    };
    selQuickAdd.onchange = () => {
      if (!selQuickAdd.value) return;
      const t = selQuickAdd.value as BlueprintNodeType;
      const spec = NODE_SPEC_BY_TYPE.get(t)!;
      const idx = graph.nodes.length;
      graph.nodes.push({
        id: `n_${Date.now()}_${idx}`,
        type: t,
        x: Math.round((80 - this.panX) / this.zoom + ((idx * 240) % 720)),
        y: Math.round((40 - this.panY) / this.zoom + Math.floor(idx / 3) * 180),
        params: { ...spec.defaultParams },
      });
      selQuickAdd.value = '';
      this.onMutate(false);
      this.render();
    };

    const btnResetView = document.createElement('button');
    btnResetView.textContent = `${Math.round(this.zoom * 100)}%`;
    btnResetView.title = 'Сбросить масштаб и центр';
    btnResetView.onclick = () => {
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;
      applyStageTransform();
      btnResetView.textContent = '100%';
    };

    rightBar.append(searchInp, selQuickAdd, btnResetView);
    bar.append(leftBar, rightBar);
    shell.appendChild(bar);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'bp-canvas';
    const stage = document.createElement('div');
    stage.className = 'bp-stage';

    const applyStageTransform = () => {
      stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
      canvasWrap.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
    };
    applyStageTransform();

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bp-wires');
    stage.appendChild(svg);

    const previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    previewPath.setAttribute('class', 'bp-wire-preview');
    previewPath.style.display = 'none';
    svg.appendChild(previewPath);

    const portCenter = (el: HTMLElement) => {
      const sr = stage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        x: (r.left + r.width * 0.5 - sr.left) / this.zoom,
        y: (r.top + r.height * 0.5 - sr.top) / this.zoom,
      };
    };

    const drawWires = () => {
      while (svg.firstChild && svg.firstChild !== previewPath) svg.removeChild(svg.firstChild);
      for (const edge of graph.edges) {
        const fromEl = stage.querySelector<HTMLElement>(`[data-out="${edge.fromNode}:${edge.fromPort}"]`);
        const toEl = stage.querySelector<HTMLElement>(`[data-in="${edge.toNode}:${edge.toPort}"]`);
        if (!fromEl || !toEl) continue;
        const p1 = portCenter(fromEl);
        const p2 = portCenter(toEl);
        const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const isAlt = edge.fromPort === 'false' || edge.fromPort === 'b';
        path.setAttribute('class', isAlt ? 'bp-wire alt' : 'bp-wire');
        path.setAttribute('d', `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`);
        path.onclick = () => {
          graph.edges = graph.edges.filter((e) => e.id !== edge.id);
          this.onMutate(false);
          this.render();
        };
        svg.insertBefore(path, previewPath);
      }
    };

    // Pan empty stage & zoom wheel
    canvasWrap.onpointerdown = (ev) => {
      if (ev.target !== canvasWrap && ev.target !== stage) return;
      canvasWrap.classList.add('panning');
      const sx = ev.clientX;
      const sy = ev.clientY;
      const ox = this.panX;
      const oy = this.panY;
      const onMove = (mv: PointerEvent) => {
        this.panX = Math.round(ox + mv.clientX - sx);
        this.panY = Math.round(oy + mv.clientY - sy);
        applyStageTransform();
      };
      const onUp = () => {
        canvasWrap.classList.remove('panning');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    canvasWrap.onwheel = (ev) => {
      ev.preventDefault();
      const next = Math.max(0.55, Math.min(1.4, this.zoom * (ev.deltaY > 0 ? 0.92 : 1.08)));
      this.zoom = Number(next.toFixed(2));
      btnResetView.textContent = `${Math.round(this.zoom * 100)}%`;
      applyStageTransform();
    };

    for (const node of graph.nodes) {
      const spec = NODE_SPEC_BY_TYPE.get(node.type);
      if (!spec) continue;
      const card = document.createElement('div');
      card.className = 'bp-node';
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;
      this.nodeEls.set(node.id, card);

      const head = document.createElement('div');
      head.className = `bp-node-head bp-cat-${spec.category}`;
      const titleSpan = document.createElement('span');
      titleSpan.textContent = spec.label;

      const actions = document.createElement('div');
      actions.className = 'bp-node-actions';

      const dupBtn = document.createElement('button');
      dupBtn.textContent = '+';
      dupBtn.title = 'Копировать ноду';
      dupBtn.onclick = (ev) => {
        ev.stopPropagation();
        graph.nodes.push({
          id: `n_${Date.now()}`,
          type: node.type,
          x: node.x + 28,
          y: node.y + 28,
          params: { ...node.params },
        });
        this.onMutate(false);
        this.render();
      };

      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.title = 'Удалить ноду';
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        graph.nodes = graph.nodes.filter((n) => n.id !== node.id);
        graph.edges = graph.edges.filter((e) => e.fromNode !== node.id && e.toNode !== node.id);
        this.onMutate(false);
        this.render();
      };
      actions.append(dupBtn, delBtn);
      head.append(titleSpan, actions);

      head.onpointerdown = (ev) => {
        if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
        const sx = ev.clientX;
        const sy = ev.clientY;
        const ox = node.x;
        const oy = node.y;
        const onMove = (mv: PointerEvent) => {
          node.x = Math.max(0, Math.round(ox + (mv.clientX - sx) / this.zoom));
          node.y = Math.max(0, Math.round(oy + (mv.clientY - sy) / this.zoom));
          card.style.left = `${node.x}px`;
          card.style.top = `${node.y}px`;
          drawWires();
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          this.onMutate(false);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };

      const body = this.buildNodeParamsBody(doc, node);

      const ports = document.createElement('div');
      ports.className = 'bp-ports';
      const inCol = document.createElement('div');
      inCol.className = 'bp-port-col';
      for (const ip of spec.inputs) {
        const b = document.createElement('button');
        b.className = 'port-btn';
        b.dataset.in = `${node.id}:${ip}`;
        const dot = document.createElement('span');
        dot.className = 'port-dot';
        b.append(dot, document.createTextNode(ip));
        b.onclick = () => {
          if (this.pendingLink && this.pendingLink.nodeId !== node.id) {
            graph.edges.push({
              id: `e_${Date.now()}`,
              fromNode: this.pendingLink.nodeId,
              fromPort: this.pendingLink.port,
              toNode: node.id,
              toPort: ip,
            });
            this.pendingLink = null;
            this.onMutate(false);
            this.render();
          }
        };
        inCol.appendChild(b);
      }

      const outCol = document.createElement('div');
      outCol.className = 'bp-port-col';
      outCol.style.alignItems = 'flex-end';
      for (const op of spec.outputs) {
        const b = document.createElement('button');
        b.className = 'port-btn';
        if (this.pendingLink?.nodeId === node.id && this.pendingLink.port === op) {
          b.classList.add('armed');
        }
        b.dataset.out = `${node.id}:${op}`;
        const dot = document.createElement('span');
        dot.className = op === 'false' || op === 'b' ? 'port-dot alt' : 'port-dot';
        b.append(document.createTextNode(op), dot);

        // Support BOTH drag-to-connect Bezier preview AND click-to-link
        b.onpointerdown = (ev) => {
          ev.stopPropagation();
          const start = portCenter(b);
          let dragged = false;
          const onMove = (mv: PointerEvent) => {
            const sr = stage.getBoundingClientRect();
            const mx = (mv.clientX - sr.left) / this.zoom;
            const my = (mv.clientY - sr.top) / this.zoom;
            if (Math.hypot(mx - start.x, my - start.y) > 8) dragged = true;
            if (!dragged) return;
            const dx = Math.max(36, Math.abs(mx - start.x) * 0.5);
            previewPath.style.display = 'block';
            previewPath.setAttribute('d', `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${mx - dx} ${my}, ${mx} ${my}`);
          };
          const onUp = (up: PointerEvent) => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            previewPath.style.display = 'none';
            if (dragged) {
              const target = document.elementFromPoint(up.clientX, up.clientY)?.closest<HTMLElement>('[data-in]');
              const specStr = target?.dataset.in;
              if (specStr) {
                const [toNode, toPort] = specStr.split(':');
                if (toNode && toPort && toNode !== node.id) {
                  graph.edges.push({
                    id: `e_${Date.now()}`,
                    fromNode: node.id,
                    fromPort: op,
                    toNode,
                    toPort,
                  });
                  this.pendingLink = null;
                  this.onMutate(false);
                  this.render();
                  return;
                }
              }
            }
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        };

        b.onclick = () => {
          this.pendingLink =
            this.pendingLink?.nodeId === node.id && this.pendingLink.port === op
              ? null
              : { nodeId: node.id, port: op };
          this.render();
        };
        outCol.appendChild(b);
      }
      ports.append(inCol, outCol);

      card.append(head, body, ports);
      stage.appendChild(card);
    }

    canvasWrap.appendChild(stage);
    shell.appendChild(canvasWrap);
    this.root.appendChild(shell);
    requestAnimationFrame(drawWires);
  }

  private buildNodeParamsBody(doc: QuarkProjectDoc, node: BlueprintNode): HTMLElement {
    const body = document.createElement('div');
    body.className = 'bp-node-body';

    for (const [key, val] of Object.entries(node.params)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.style.minWidth = '64px';
      lbl.textContent = PARAM_LABELS[key] ?? key;

      if (key === 'entityId' || key === 'triggerEntityId' || key === 'targetEntityId' || key === 'anchorEntityId') {
        const sel = document.createElement('select');
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = 'Не выбран';
        sel.appendChild(emptyOpt);
        if (key === 'entityId' && node.type === 'applyImpulse') {
          const pl = document.createElement('option');
          pl.value = '__player__';
          pl.textContent = 'Игрок';
          if (val === '__player__') pl.selected = true;
          sel.appendChild(pl);
        }
        for (const ent of doc.entities) {
          const opt = document.createElement('option');
          opt.value = ent.id;
          opt.textContent = ent.name;
          if (val === ent.id) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.onchange = () => {
          node.params[key] = sel.value;
          this.onMutate(false);
        };
        row.append(lbl, sel);
      } else if (typeof val === 'boolean') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = val;
        cb.style.width = 'auto';
        cb.onchange = () => {
          node.params[key] = cb.checked;
          this.onMutate(false);
        };
        row.append(lbl, cb);
      } else if (typeof val === 'number') {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '0.1';
        inp.value = String(val);
        inp.onchange = () => {
          node.params[key] = Number(inp.value);
          this.onMutate(false);
        };
        row.append(lbl, inp);
      } else {
        const inp = document.createElement('input');
        inp.type = key === 'color' || key === 'glow' ? 'color' : 'text';
        inp.value = String(val);
        inp.onchange = () => {
          node.params[key] = inp.value;
          this.onMutate(false);
        };
        row.append(lbl, inp);
      }
      body.appendChild(row);
    }
    return body;
  }
}
