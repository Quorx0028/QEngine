export interface ActionBinding {
  keys?: string[];
  mouseButtons?: number[];
  gamepadButtons?: number[];
}

export interface AxisBinding {
  posKeys?: string[];
  negKeys?: string[];
  gamepadAxis?: number;
  deadzone?: number;
  invert?: boolean;
}

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly mouseDown = new Set<number>();
  private readonly mousePressed = new Set<number>();
  private readonly actions = new Map<string, ActionBinding>();
  private readonly axes = new Map<string, AxisBinding>();

  private deltaX = 0;
  private deltaY = 0;
  private target: HTMLElement | null = null;
  private pointerLocked = false;
  private dragging = false;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    const code = e.code;
    if (!this.down.has(code)) {
      this.pressed.add(code);
    }
    this.down.add(code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.dragging = true;
    if (!this.mouseDown.has(e.button)) {
      this.mousePressed.add(e.button);
    }
    this.mouseDown.add(e.button);
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.dragging = false;
    this.mouseDown.delete(e.button);
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (this.pointerLocked || this.dragging) {
      this.deltaX += e.movementX;
      this.deltaY += e.movementY;
    }
  };

  private readonly onPointerLockChange = () => {
    if (typeof document !== 'undefined') {
      this.pointerLocked = document.pointerLockElement === this.target;
    }
  };

  private readonly onBlur = () => {
    this.down.clear();
    this.pressed.clear();
    this.mouseDown.clear();
    this.mousePressed.clear();
    this.dragging = false;
  };

  attach(element?: HTMLElement): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.target = element ?? null;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    if (this.target) {
      this.target.addEventListener('mousedown', this.onMouseDown);
      window.addEventListener('mouseup', this.onMouseUp);
      window.addEventListener('mousemove', this.onMouseMove);
    }
  }

  requestPointerLock(): void {
    if (this.target && typeof this.target.requestPointerLock === 'function') {
      this.target.requestPointerLock();
    }
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  isKeyDown(code: string): boolean {
    return this.down.has(code);
  }

  wasKeyPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  isMouseButtonDown(button: number): boolean {
    return this.mouseDown.has(button);
  }

  wasMouseButtonPressed(button: number): boolean {
    return this.mousePressed.has(button);
  }

  bindAction(name: string, binding: ActionBinding): void {
    this.actions.set(name, binding);
  }

  bindAxis(name: string, binding: AxisBinding): void {
    this.axes.set(name, binding);
  }

  private firstGamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]?.connected) return pads[i];
    }
    return null;
  }

  isActionDown(name: string): boolean {
    const b = this.actions.get(name);
    if (!b) return false;
    if (b.keys?.some((k) => this.down.has(k))) return true;
    if (b.mouseButtons?.some((m) => this.mouseDown.has(m))) return true;
    if (b.gamepadButtons && b.gamepadButtons.length > 0) {
      const gp = this.firstGamepad();
      if (gp && b.gamepadButtons.some((idx) => gp.buttons[idx]?.pressed)) return true;
    }
    return false;
  }

  wasActionPressed(name: string): boolean {
    const b = this.actions.get(name);
    if (!b) return false;
    if (b.keys?.some((k) => this.pressed.has(k))) return true;
    if (b.mouseButtons?.some((m) => this.mousePressed.has(m))) return true;
    return false;
  }

  getAxis(name: string): number {
    const b = this.axes.get(name);
    if (!b) return 0;
    let val = 0;
    if (b.posKeys?.some((k) => this.down.has(k))) val += 1;
    if (b.negKeys?.some((k) => this.down.has(k))) val -= 1;
    if (b.gamepadAxis !== undefined && Math.abs(val) < 0.01) {
      const gp = this.firstGamepad();
      const raw = gp?.axes[b.gamepadAxis] ?? 0;
      const dz = b.deadzone ?? 0.15;
      if (Math.abs(raw) > dz) {
        val = b.invert ? -raw : raw;
      }
    }
    return Math.max(-1, Math.min(1, val));
  }

  consumeMouseDelta(): [number, number] {
    const out: [number, number] = [this.deltaX, this.deltaY];
    this.deltaX = 0;
    this.deltaY = 0;
    return out;
  }

  endFrame(): void {
    this.pressed.clear();
    this.mousePressed.clear();
    this.deltaX = 0;
    this.deltaY = 0;
  }

  dispose(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    if (this.target) {
      this.target.removeEventListener('mousedown', this.onMouseDown);
      this.target = null;
    }
  }
}
