import type { Vec3Tuple } from '../math/Mat4';
import type { CollisionEvent, EntityId, Scene, TriggerEvent } from '../Scene';

export interface BehaviorContext {
  readonly entity: EntityId;
  readonly scene: Scene;
}

export interface EntityBehavior {
  readonly type?: string;
  onStart?(ctx: BehaviorContext): void;
  onUpdate?(ctx: BehaviorContext, dt: number): void;
  onFixedUpdate?(ctx: BehaviorContext, fixedDt: number): void;
  onTriggerEnter?(ctx: BehaviorContext, other: EntityId): void;
  onTriggerExit?(ctx: BehaviorContext, other: EntityId): void;
  onCollisionEnter?(ctx: BehaviorContext, other: EntityId, normal: Vec3Tuple): void;
  onDestroy?(ctx: BehaviorContext): void;
}

interface AttachedBehavior {
  entity: EntityId;
  behavior: EntityBehavior;
  started: boolean;
}

/**
 * Defines a reusable, typed, customizable EntityBehavior factory in a few lines.
 */
export function defineBehavior<TState extends Record<string, unknown>>(
  type: string,
  template: () => Partial<EntityBehavior> & TState
): (overrides?: Partial<TState>) => EntityBehavior & TState {
  return (overrides = {}) => {
    const instance = template();
    Object.assign(instance, overrides);
    return Object.assign(instance, { type }) as EntityBehavior & TState;
  };
}

/**
 * Registry for creating behaviors dynamically by string type (useful for editors/levels).
 */
export class BehaviorRegistry {
  private readonly factories = new Map<string, (params?: Record<string, unknown>) => EntityBehavior>();

  register(type: string, factory: (params?: Record<string, unknown>) => EntityBehavior): void {
    this.factories.set(type, factory);
  }

  create(type: string, params?: Record<string, unknown>): EntityBehavior | null {
    const f = this.factories.get(type);
    return f ? f(params) : null;
  }

  listTypes(): string[] {
    return Array.from(this.factories.keys());
  }
}

/**
 * Lightweight per-entity lifecycle & event manager bound to a Scene.
 */
export class BehaviorManager {
  private readonly scene: Scene;
  private readonly byEntity = new Map<EntityId, AttachedBehavior[]>();
  private readonly pendingRemove: Array<{ entity: EntityId; behavior: EntityBehavior }> = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  add<T extends EntityBehavior>(entity: EntityId, behavior: T): T {
    if (!this.scene.isAlive(entity)) {
      throw new Error(`Cannot attach behavior to dead entity ${entity}`);
    }
    let list = this.byEntity.get(entity);
    if (!list) {
      list = [];
      this.byEntity.set(entity, list);
    }
    list.push({ entity, behavior, started: false });
    return behavior;
  }

  get<T extends EntityBehavior>(
    entity: EntityId,
    typeOrCtor: string | (abstract new (...args: never[]) => T)
  ): T | undefined {
    const list = this.byEntity.get(entity);
    if (!list) return undefined;
    for (const item of list) {
      if (typeof typeOrCtor === 'string') {
        if (item.behavior.type === typeOrCtor) return item.behavior as T;
      } else if (item.behavior instanceof typeOrCtor) {
        return item.behavior;
      }
    }
    return undefined;
  }

  remove(entity: EntityId, behavior: EntityBehavior): boolean {
    const list = this.byEntity.get(entity);
    if (!list) return false;
    const idx = list.findIndex((x) => x.behavior === behavior);
    if (idx < 0) return false;
    const [removed] = list.splice(idx, 1);
    removed.behavior.onDestroy?.({ entity, scene: this.scene });
    if (list.length === 0) this.byEntity.delete(entity);
    return true;
  }

  destroyEntity(entity: EntityId): void {
    const list = this.byEntity.get(entity);
    if (!list) return;
    this.byEntity.delete(entity);
    for (const item of list) {
      item.behavior.onDestroy?.({ entity, scene: this.scene });
    }
  }

  clear(): void {
    for (const [entity, list] of this.byEntity.entries()) {
      for (const item of list) {
        item.behavior.onDestroy?.({ entity, scene: this.scene });
      }
    }
    this.byEntity.clear();
  }

  private ensureStarted(item: AttachedBehavior): void {
    if (!item.started) {
      item.started = true;
      item.behavior.onStart?.({ entity: item.entity, scene: this.scene });
    }
  }

  stepFixed(fixedDt: number): void {
    for (const [entity, list] of this.byEntity.entries()) {
      if (!this.scene.isAlive(entity)) continue;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        this.ensureStarted(item);
        item.behavior.onFixedUpdate?.({ entity, scene: this.scene }, fixedDt);
      }
    }
    this.flushRemovals();
  }

  stepUpdate(dt: number): void {
    for (const [entity, list] of this.byEntity.entries()) {
      if (!this.scene.isAlive(entity)) continue;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        this.ensureStarted(item);
        item.behavior.onUpdate?.({ entity, scene: this.scene }, dt);
      }
    }
    this.flushRemovals();
  }

  dispatchCollision(ev: CollisionEvent): void {
    this.byEntity.get(ev.entityA)?.forEach((it) => {
      it.behavior.onCollisionEnter?.({ entity: ev.entityA, scene: this.scene }, ev.entityB, ev.normal);
    });
    this.byEntity.get(ev.entityB)?.forEach((it) => {
      it.behavior.onCollisionEnter?.(
        { entity: ev.entityB, scene: this.scene },
        ev.entityA,
        [-ev.normal[0], -ev.normal[1], -ev.normal[2]]
      );
    });
  }

  dispatchTriggerEnter(ev: TriggerEvent): void {
    this.byEntity.get(ev.entityA)?.forEach((it) => {
      it.behavior.onTriggerEnter?.({ entity: ev.entityA, scene: this.scene }, ev.entityB);
    });
    this.byEntity.get(ev.entityB)?.forEach((it) => {
      it.behavior.onTriggerEnter?.({ entity: ev.entityB, scene: this.scene }, ev.entityA);
    });
  }

  dispatchTriggerExit(ev: TriggerEvent): void {
    this.byEntity.get(ev.entityA)?.forEach((it) => {
      it.behavior.onTriggerExit?.({ entity: ev.entityA, scene: this.scene }, ev.entityB);
    });
    this.byEntity.get(ev.entityB)?.forEach((it) => {
      it.behavior.onTriggerExit?.({ entity: ev.entityB, scene: this.scene }, ev.entityA);
    });
  }

  private flushRemovals(): void {
    while (this.pendingRemove.length > 0) {
      const r = this.pendingRemove.pop()!;
      this.remove(r.entity, r.behavior);
    }
  }
}
