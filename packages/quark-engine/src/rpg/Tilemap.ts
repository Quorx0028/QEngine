import type { EntityId, Scene } from '../Scene';

export interface TiledProperty {
  name: string;
  value: unknown;
}

export interface TiledObject {
  name: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  properties?: TiledProperty[];
}

export interface TiledLayer {
  name: string;
  type: 'tilelayer' | 'objectgroup';
  width?: number;
  height?: number;
  data?: number[];
  objects?: TiledObject[];
  visible?: boolean;
  properties?: TiledProperty[];
}

export interface TiledJsonMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
}

export interface TilemapLoadOptions {
  origin?: [number, number];
  tileWorldSize?: number;
  textureId?: number;
  tilesetCols?: number;
  tilesetRows?: number;
  layerStart?: number;
  solidLayerNames?: string[];
}

export interface WorldTiledObject extends TiledObject {
  worldX: number;
  worldY: number;
}

function isLayerSolid(layer: TiledLayer, solidNames: string[]): boolean {
  if (solidNames.includes(layer.name.toLowerCase())) return true;
  if (layer.name.toLowerCase().includes('wall') || layer.name.toLowerCase().includes('col')) {
    return true;
  }
  return Boolean(layer.properties?.some((p) => p.name === 'solid' && Boolean(p.value)));
}

/**
 * Loads a Tiled JSON map, spawns layered Sprite2D tile entities, and builds TileGrid2D physics colliders.
 */
export class Tilemap {
  readonly width: number;
  readonly height: number;
  readonly tileWorldSize: number;
  readonly origin: [number, number];
  readonly tileEntities: EntityId[] = [];
  readonly objects: WorldTiledObject[] = [];

  private constructor(
    width: number,
    height: number,
    tileWorldSize: number,
    origin: [number, number]
  ) {
    this.width = width;
    this.height = height;
    this.tileWorldSize = tileWorldSize;
    this.origin = origin;
  }

  static fromTiledJson(
    scene: Scene,
    map: TiledJsonMap,
    opts: TilemapLoadOptions = {}
  ): Tilemap {
    const origin = opts.origin ?? [0, 0];
    const ts = opts.tileWorldSize ?? 1.0;
    const cols = Math.max(1, opts.tilesetCols ?? 8);
    const rows = Math.max(1, opts.tilesetRows ?? 8);
    const solidNames = (opts.solidLayerNames ?? ['walls', 'collision', 'solid']).map((s) =>
      s.toLowerCase()
    );
    const tm = new Tilemap(map.width, map.height, ts, origin);

    let layerOrder = opts.layerStart ?? -10;
    for (const layer of map.layers) {
      if (layer.visible === false) continue;

      if (layer.type === 'tilelayer' && layer.data) {
        const w = layer.width ?? map.width;
        const h = layer.height ?? map.height;
        const solid = isLayerSolid(layer, solidNames);
        const solidGrid = solid ? new Uint8Array(w * h) : null;

        for (let row = 0; row < h; row++) {
          const ey = h - 1 - row;
          for (let col = 0; col < w; col++) {
            const rawGid = layer.data[row * w + col] ?? 0;
            const gid = rawGid & 0x1fffffff; // Strip Tiled flip bits
            if (gid <= 0) continue;

            if (solidGrid) {
              solidGrid[ey * w + col] = 1;
            }

            const tileIdx = gid - 1;
            const tx = tileIdx % cols;
            const ty = Math.floor(tileIdx / cols) % rows;
            const cw = 1 / cols;
            const ch = 1 / rows;

            const e = scene.createEntity();
            scene.setTransform(e, {
              position: [origin[0] + (col + 0.5) * ts, origin[1] + (ey + 0.5) * ts, 0],
              immediate: true,
            });
            scene.setSprite2D(e, {
              size: [ts, ts],
              uvMin: [tx * cw, ty * ch],
              uvMax: [(tx + 1) * cw, (ty + 1) * ch],
              textureId: opts.textureId,
              layer: layerOrder,
            });
            tm.tileEntities.push(e);
          }
        }

        if (solidGrid) {
          scene.addTileGrid2D(origin, ts, w, h, solidGrid);
        }
        layerOrder++;
      } else if (layer.type === 'objectgroup' && layer.objects) {
        const pxPerTileX = Math.max(1, map.tilewidth);
        const pxPerTileY = Math.max(1, map.tileheight);
        for (const obj of layer.objects) {
          const worldX = origin[0] + (obj.x / pxPerTileX) * ts;
          const worldY = origin[1] + (map.height - obj.y / pxPerTileY) * ts;
          tm.objects.push({ ...obj, worldX, worldY });
        }
      }
    }

    return tm;
  }

  getObjectByName(name: string): WorldTiledObject | undefined {
    return this.objects.find((o) => o.name === name);
  }

  getObjectsByType(type: string): WorldTiledObject[] {
    return this.objects.filter((o) => o.type === type);
  }
}
