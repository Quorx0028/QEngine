export interface AnimTransition {
  from: string;
  to: string;
  when: () => boolean;
  fadeSec?: number;
}

/**
 * Lightweight animation state machine usable with both 3D skeletal clips and 2D SpriteAnimator.
 */
export class AnimStateMachine {
  private readonly states = new Set<string>();
  private readonly transitions: AnimTransition[] = [];
  private readonly onEnter: (state: string, fadeSec: number) => void;
  private activeState = '';

  constructor(onEnterState: (state: string, fadeSec: number) => void) {
    this.onEnter = onEnterState;
  }

  get currentState(): string {
    return this.activeState;
  }

  addState(name: string): this {
    this.states.add(name);
    return this;
  }

  addTransition(from: string, to: string, when: () => boolean, fadeSec = 0.15): this {
    this.transitions.push({ from, to, when, fadeSec });
    return this;
  }

  start(initialState: string): this {
    this.states.add(initialState);
    this.activeState = initialState;
    this.onEnter(initialState, 0);
    return this;
  }

  setState(nextState: string, fadeSec = 0.15): void {
    if (!this.states.has(nextState) || this.activeState === nextState) return;
    this.activeState = nextState;
    this.onEnter(nextState, fadeSec);
  }

  update(): string {
    for (const tr of this.transitions) {
      if ((tr.from === this.activeState || tr.from === '*') && tr.to !== this.activeState && tr.when()) {
        this.activeState = tr.to;
        this.onEnter(tr.to, tr.fadeSec ?? 0.15);
        break;
      }
    }
    return this.activeState;
  }
}
