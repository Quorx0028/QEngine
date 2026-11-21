export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
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
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.dragging = false;
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

  consumeMouseDelta(): [number, number] {
    const out: [number, number] = [this.deltaX, this.deltaY];
    this.deltaX = 0;
    this.deltaY = 0;
    return out;
  }

  endFrame(): void {
    this.pressed.clear();
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
