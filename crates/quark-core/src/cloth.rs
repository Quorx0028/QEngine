use glam::Vec3;

#[derive(Clone, Copy)]
struct ClothLink {
    a: usize,
    b: usize,
    rest_len: f32,
}

pub struct ClothGrid {
    pub cols: usize,
    pub rows: usize,
    pos: Vec<Vec3>,
    prev: Vec<Vec3>,
    pinned: Vec<bool>,
    links: Vec<ClothLink>,
    pub wind: Vec3,
    pub gravity: f32,
    pub vertex_buf: Vec<f32>, // [px, py, pz, nx, ny, nz, u, v] interleaved for WebGL2 VBO
    pub index_buf: Vec<u32>,
}

impl ClothGrid {
    pub fn new(
        origin: Vec3,
        right_step: Vec3,
        down_step: Vec3,
        cols: usize,
        rows: usize,
        pin_top_row: bool,
        pin_left_col: bool,
    ) -> Self {
        let cols = cols.max(2);
        let rows = rows.max(2);
        let n = cols * rows;
        let mut pos = Vec::with_capacity(n);
        let mut prev = Vec::with_capacity(n);
        let mut pinned = Vec::with_capacity(n);

        for r in 0..rows {
            for c in 0..cols {
                let p = origin + right_step * (c as f32) + down_step * (r as f32);
                pos.push(p);
                prev.push(p);
                let is_pin = (pin_top_row && r == 0) || (pin_left_col && c == 0);
                pinned.push(is_pin);
            }
        }

        let mut links = Vec::new();
        let mut add_link = |i0: usize, i1: usize| {
            let rest_len = (pos[i0] - pos[i1]).length().max(1e-4);
            links.push(ClothLink {
                a: i0,
                b: i1,
                rest_len,
            });
        };

        for r in 0..rows {
            for c in 0..cols {
                let idx = r * cols + c;
                if c + 1 < cols {
                    add_link(idx, idx + 1);
                }
                if r + 1 < rows {
                    add_link(idx, idx + cols);
                }
                if c + 1 < cols && r + 1 < rows {
                    add_link(idx, idx + cols + 1);
                    add_link(idx + 1, idx + cols);
                }
            }
        }

        let mut index_buf = Vec::with_capacity((cols - 1) * (rows - 1) * 6);
        for r in 0..(rows - 1) {
            for c in 0..(cols - 1) {
                let i00 = (r * cols + c) as u32;
                let i10 = i00 + 1;
                let i01 = i00 + cols as u32;
                let i11 = i01 + 1;
                index_buf.extend_from_slice(&[i00, i01, i10, i10, i01, i11]);
            }
        }

        let mut grid = Self {
            cols,
            rows,
            pos,
            prev,
            pinned,
            links,
            wind: Vec3::new(2.2, 0.25, 0.9),
            gravity: -9.8,
            vertex_buf: vec![0.0; n * 8],
            index_buf,
        };
        grid.rebuild_vertices();
        grid
    }

    pub fn set_pinned(&mut self, col: usize, row: usize, is_pinned: bool) {
        if col < self.cols && row < self.rows {
            self.pinned[row * self.cols + col] = is_pinned;
        }
    }

    pub fn push_sphere(&mut self, center: Vec3, radius: f32) {
        let r2 = radius * radius;
        for i in 0..self.pos.len() {
            if self.pinned[i] {
                continue;
            }
            let diff = self.pos[i] - center;
            let d2 = diff.length_squared();
            if d2 < r2 && d2 > 1e-8 {
                let d = d2.sqrt();
                self.pos[i] = center + (diff / d) * radius;
            }
        }
    }

    pub fn step(&mut self, dt: f32, time_sec: f32) {
        let h = dt.clamp(0.0, 0.033);
        if h <= 1e-6 {
            return;
        }
        let h2 = h * h;
        let damp = 0.985;

        for r in 0..self.rows {
            for c in 0..self.cols {
                let i = r * self.cols + c;
                if self.pinned[i] {
                    continue;
                }
                let p = self.pos[i];
                let vel = (p - self.prev[i]) * damp;
                self.prev[i] = p;
                let gust = 0.65 + 0.55 * (time_sec * 2.4 + c as f32 * 0.45 + r as f32 * 0.3).sin();
                let flutter = Vec3::new(0.0, 0.0, (time_sec * 5.2 + c as f32 * 0.8).cos() * 0.9);
                let acc = Vec3::new(0.0, self.gravity, 0.0) + self.wind * gust + flutter;
                self.pos[i] = p + vel + acc * h2;
                if self.pos[i].y < 0.04 {
                    self.pos[i].y = 0.04;
                }
            }
        }

        for _ in 0..5 {
            for link in &self.links {
                let pa = self.pos[link.a];
                let pb = self.pos[link.b];
                let delta = pb - pa;
                let d = delta.length();
                if d <= 1e-6 {
                    continue;
                }
                let corr = delta * ((d - link.rest_len) / d);
                let pin_a = self.pinned[link.a];
                let pin_b = self.pinned[link.b];
                if !pin_a && !pin_b {
                    self.pos[link.a] += corr * 0.5;
                    self.pos[link.b] -= corr * 0.5;
                } else if !pin_a {
                    self.pos[link.a] += corr;
                } else if !pin_b {
                    self.pos[link.b] -= corr;
                }
            }
        }

        self.rebuild_vertices();
    }

    fn rebuild_vertices(&mut self) {
        let cols = self.cols;
        let rows = self.rows;
        for r in 0..rows {
            for c in 0..cols {
                let i = r * cols + c;
                let p = self.pos[i];
                let left = if c > 0 { self.pos[i - 1] } else { p };
                let right = if c + 1 < cols { self.pos[i + 1] } else { p };
                let up = if r > 0 { self.pos[i - cols] } else { p };
                let down = if r + 1 < rows { self.pos[i + cols] } else { p };
                let dx = right - left;
                let dy = down - up;
                let mut n = dy.cross(dx);
                if n.length_squared() < 1e-8 {
                    n = Vec3::Z;
                } else {
                    n = n.normalize();
                }
                let off = i * 8;
                self.vertex_buf[off] = p.x;
                self.vertex_buf[off + 1] = p.y;
                self.vertex_buf[off + 2] = p.z;
                self.vertex_buf[off + 3] = n.x;
                self.vertex_buf[off + 4] = n.y;
                self.vertex_buf[off + 5] = n.z;
                self.vertex_buf[off + 6] = c as f32 / (cols - 1) as f32;
                self.vertex_buf[off + 7] = r as f32 / (rows - 1) as f32;
            }
        }
    }
}

pub struct ClothWorld {
    pub grids: Vec<ClothGrid>,
    pub elapsed: f32,
}

impl ClothWorld {
    pub fn new() -> Self {
        Self {
            grids: Vec::new(),
            elapsed: 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.grids.clear();
        self.elapsed = 0.0;
    }

    pub fn add_grid(&mut self, grid: ClothGrid) -> u32 {
        let id = self.grids.len() as u32;
        self.grids.push(grid);
        id
    }

    pub fn step(&mut self, dt: f32) {
        self.elapsed += dt.clamp(0.0, 0.05);
        for g in &mut self.grids {
            g.step(dt, self.elapsed);
        }
    }
}

impl Default for ClothWorld {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cloth_grid_pinned_and_wind_simulation() {
        let mut cw = ClothWorld::new();
        let id = cw.add_grid(ClothGrid::new(
            Vec3::new(0.0, 3.0, 0.0),
            Vec3::new(0.25, 0.0, 0.0),
            Vec3::new(0.0, -0.25, 0.0),
            6,
            5,
            true,
            false,
        ));
        let top_before = cw.grids[id as usize].vertex_buf[1];
        let bot_off = (6 * 5 - 1) * 8;
        let init_x = 5.0f32 * 0.25;
        let init_y = 3.0 - 4.0f32 * 0.25;
        for _ in 0..30 {
            cw.step(1.0 / 60.0);
        }
        let grid = &mut cw.grids[id as usize];
        assert!((grid.vertex_buf[1] - top_before).abs() < 1e-5);
        assert!(grid.vertex_buf[bot_off].is_finite());
        let moved = (grid.vertex_buf[bot_off] - init_x).abs()
            + (grid.vertex_buf[bot_off + 1] - init_y).abs()
            + grid.vertex_buf[bot_off + 2].abs();
        assert!(moved > 0.02);

        grid.push_sphere(Vec3::new(0.6, 2.5, 0.0), 0.75);
        assert!(grid.vertex_buf[bot_off + 1].is_finite());
    }
}
