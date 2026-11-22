use glam::Vec3;

#[derive(Clone, Debug)]
pub struct TerrainHeightmap {
    pub origin_x: f32,
    pub origin_z: f32,
    pub cell_size: f32,
    pub width: usize,
    pub height: usize,
    pub heights: Vec<f32>,
}

impl TerrainHeightmap {
    pub fn new(
        origin_x: f32,
        origin_z: f32,
        cell_size: f32,
        width: usize,
        height: usize,
        heights: Vec<f32>,
    ) -> Option<Self> {
        if width < 2 || height < 2 || heights.len() < width * height {
            return None;
        }
        Some(Self {
            origin_x,
            origin_z,
            cell_size: cell_size.max(0.05),
            width,
            height,
            heights,
        })
    }

    #[inline]
    fn h_at_grid(&self, gx: usize, gz: usize) -> f32 {
        self.heights[gz * self.width + gx]
    }

    /// O(1) exact triangle-interpolated height and normal at world (x, z).
    pub fn sample_height_and_normal(&self, x: f32, z: f32) -> Option<(f32, Vec3)> {
        let fx = (x - self.origin_x) / self.cell_size;
        let fz = (z - self.origin_z) / self.cell_size;
        if fx < 0.0 || fz < 0.0 || fx > (self.width - 1) as f32 || fz > (self.height - 1) as f32 {
            return None;
        }
        let cx = (fx.floor() as usize).min(self.width - 2);
        let cz = (fz.floor() as usize).min(self.height - 2);
        let u = fx - cx as f32;
        let v = fz - cz as f32;

        let h00 = self.h_at_grid(cx, cz);
        let h10 = self.h_at_grid(cx + 1, cz);
        let h01 = self.h_at_grid(cx, cz + 1);
        let h11 = self.h_at_grid(cx + 1, cz + 1);

        let cs = self.cell_size;
        if u + v <= 1.0 {
            let h = h00 + (h10 - h00) * u + (h01 - h00) * v;
            let e1 = Vec3::new(0.0, h01 - h00, cs);
            let e2 = Vec3::new(cs, h10 - h00, 0.0);
            let n = e1.cross(e2).normalize_or_zero();
            Some((h, if n.y < 0.0 { -n } else { n }))
        } else {
            let h = h11 + (h01 - h11) * (1.0 - u) + (h10 - h11) * (1.0 - v);
            let e1 = Vec3::new(0.0, h10 - h11, -cs);
            let e2 = Vec3::new(-cs, h01 - h11, 0.0);
            let n = e1.cross(e2).normalize_or_zero();
            Some((h, if n.y < 0.0 { -n } else { n }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_terrain_heightmap_o1_sample_and_normal() {
        // 3x3 sloped plane rising +1 per unit along +X
        let heights = vec![
            0.0, 2.0, 4.0,
            0.0, 2.0, 4.0,
            0.0, 2.0, 4.0,
        ];
        let hm = TerrainHeightmap::new(0.0, 0.0, 2.0, 3, 3, heights).unwrap();
        let (h, n) = hm.sample_height_and_normal(2.0, 1.5).unwrap();
        assert!((h - 2.0).abs() < 1e-4, "expected height 2.0, got {h}");
        assert!(n.y > 0.65 && n.x < -0.5, "expected tilted up-left normal, got {n:?}");
        assert!(hm.sample_height_and_normal(-1.0, 1.0).is_none());
    }
}
