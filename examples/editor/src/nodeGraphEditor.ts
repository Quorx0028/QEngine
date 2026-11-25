import {
  BLUEPRINT_NODE_CATALOG,
  NODE_SPEC_BY_TYPE,
  type BlueprintGraph,
  type BlueprintNode,
  type BlueprintNodeType,
  type QuarkProjectDoc,
} from 'quark-engine';

export class NodeGraphEditor {
  private readonly root: HTMLElement;
  private readonly getDoc: () => QuarkProjectDoc;
  private readonly onMutate: (rebuildRequired?: boolean) => void;
  private activeGraphId: string | null = null;
  private pendingLink: { nodeId: string; port: string } | null = null;
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
    const y = 40 + g.nodes.length * 55;
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
        x: 330,
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
    window.setTimeout(() => el.classList.remove('pulse'), 320);
  }

  render(): void {
    const doc = this.getDoc();
    const graph = this.ensureDefaultGraph();
    this.nodeEls.clear();
    this.root.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'bp-shell';

    // Top bar
    const bar = document.createElement('div');
    bar.className = 'bp-bar';

    const leftBar = document.createElement('div');
    leftBar.className = 'row-gap';
    const selGraph = document.createElement('select');
    for (const g of doc.blueprints) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `Граф: ${g.name}`;
      if (g.id === graph.id) opt.selected = true;
      selGraph.appendChild(opt);
    }
    selGraph.onchange = () => {
      this.activeGraphId = selGraph.value;
      this.pendingLink = null;
      this.render();
    };

    const btnNewGraph = document.createElement('button');
    btnNewGraph.textContent = '+ Новый граф';
    btnNewGraph.onclick = () => {
      const ng: BlueprintGraph = {
        id: `bp_${Date.now()}`,
        name: `Скрипт #${doc.blueprints.length + 1}`,
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
    chkEnabled.append(cb, document.createTextNode('Активен'));

    leftBar.append(selGraph, btnNewGraph, chkEnabled);

    const rightBar = document.createElement('div');
    rightBar.className = 'row-gap';

    const makeAddSelect = (cat: 'event' | 'logic' | 'action', title: string) => {
      const sel = document.createElement('select');
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = title;
      sel.appendChild(defOpt);
      for (const spec of BLUEPRINT_NODE_CATALOG) {
        if (spec.category !== cat) continue;
        const opt = document.createElement('option');
        opt.value = spec.type;
        opt.textContent = spec.label;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        if (!sel.value) return;
        const t = sel.value as BlueprintNodeType;
        const spec = NODE_SPEC_BY_TYPE.get(t)!;
        const idx = graph.nodes.length;
        graph.nodes.push({
          id: `n_${Date.now()}_${idx}`,
          type: t,
          x: 60 + ((idx * 240) % 720),
          y: 50 + Math.floor(idx / 3) * 180,
          params: { ...spec.defaultParams },
        });
        sel.value = '';
        this.onMutate(false);
        this.render();
      };
      return sel;
    };

    const hintSpan = document.createElement('span');
    hintSpan.className = 'muted';
    hintSpan.textContent = this.pendingLink
      ? 'Кликни входной порт (in/reset) для соединения...'
      : 'Выход → Вход: кликни порты для связи · Клик по проводу = удалить';

    rightBar.append(
      makeAddSelect('event', '+ Событие...'),
      makeAddSelect('logic', '+ Условие / Перем...'),
      makeAddSelect('action', '+ Действие...'),
      hintSpan
    );

    bar.append(leftBar, rightBar);
    shell.appendChild(bar);

    // Canvas stage
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'bp-canvas';
    const stage = document.createElement('div');
    stage.className = 'bp-stage';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bp-wires');
    stage.appendChild(svg);

    const drawWires = () => {
      svg.innerHTML = '';
      for (const edge of graph.edges) {
        const fromEl = stage.querySelector<HTMLElement>(`[data-out="${edge.fromNode}:${edge.fromPort}"]`);
        const toEl = stage.querySelector<HTMLElement>(`[data-in="${edge.toNode}:${edge.toPort}"]`);
        if (!fromEl || !toEl) continue;
        const sr = stage.getBoundingClientRect();
        const fr = fromEl.getBoundingClientRect();
        const tr = toEl.getBoundingClientRect();
        const x1 = fr.right - sr.left;
        const y1 = fr.top + fr.height * 0.5 - sr.top;
        const x2 = tr.left - sr.left;
        const y2 = tr.top + tr.height * 0.5 - sr.top;
        const dx = Math.max(45, Math.abs(x2 - x1) * 0.5);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'bp-wire');
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
        path.onclick = () => {
          graph.edges = graph.edges.filter((e) => e.id !== edge.id);
          this.onMutate(false);
          this.render();
        };
        svg.appendChild(path);
      }
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
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'padding:0 5px;background:rgba(0,0,0,0.35);border:none;';
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        graph.nodes = graph.nodes.filter((n) => n.id !== node.id);
        graph.edges = graph.edges.filter((e) => e.fromNode !== node.id && e.toNode !== node.id);
        this.onMutate(false);
        this.render();
      };
      head.append(titleSpan, delBtn);

      // Drag node position
      head.onpointerdown = (ev) => {
        if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
        const sx = ev.clientX;
        const sy = ev.clientY;
        const ox = node.x;
        const oy = node.y;
        const onMove = (mv: PointerEvent) => {
          node.x = Math.max(0, Math.round(ox + mv.clientX - sx));
          node.y = Math.max(0, Math.round(oy + mv.clientY - sy));
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
        b.textContent = `● ${ip}`;
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
        b.textContent = `${op} ●`;
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
      row.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.style.minWidth = '54px';
      lbl.textContent = key;

      if (key === 'entityId' || key === 'triggerEntityId' || key === 'targetEntityId' || key === 'anchorEntityId') {
        const sel = document.createElement('select');
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '(выбрать)';
        sel.appendChild(emptyOpt);
        if (key === 'entityId' && node.type === 'applyImpulse') {
          const pl = document.createElement('option');
          pl.value = '__player__';
          pl.textContent = '🎮 Игрок';
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
        inp.type = key === 'color' ? 'color' : 'text';
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
