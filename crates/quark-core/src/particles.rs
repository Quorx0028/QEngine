use glam::Vec3;

pub const MAX_GPU_PARTICLES: usize = 8192;
pub const PACKED_PARTICLE_STRIDE: usize = 12; // [px, py, pz, size, r, g, b, a, vx, vy, vz, stretch]

#[derive(Clone, Copy)]
pub struct GpuParticle {
    pub pos: Vec3,
    pub vel: Vec3,
    pub age: f32,
    pub max_age: f32,
    pub size_start: f32,
    pub size_end: f32,
    pub col_start: [f32; 4],
    pub col_end: [f32; 4],
    pub gravity: f32,
    pub drag: f32,
    pub bounce: f32,
    pub floor_y: f32,
    pub additive: bool,
    pub stretch: f32,
}

pub struct ParticleSystem {
    particles: Vec<GpuParticle>,
    pub packed_alpha: Vec<f32>,
    pub packed_additive: Vec<f32>,
}

impl ParticleSystem {
    pub fn new() -> Self {
        Self {
            particles: Vec::with_capacity(512),
            packed_alpha: Vec::new(),
            packed_additive: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.particles.clear();
        self.packed_alpha.clear();
        self.packed_additive.clear();
    }

    pub fn active_count(&self) -> usize {
        self.particles.len()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &mut self,
        pos: Vec3,
        vel: Vec3,
        size_start: f32,
        size_end: f32,
        col_start: [f32; 4],
        col_end: [f32; 4],
        max_age: f32,
        gravity: f32,
        drag: f32,
        bounce: f32,
        floor_y: f32,
        additive: bool,
        stretch: f32,
    ) {
        if self.particles.len() >= MAX_GPU_PARTICLES {
            let oldest_idx = 0;
            self.particles.swap_remove(oldest_idx);
        }
        self.particles.push(GpuParticle {
            pos,
            vel,
            age: 0.0,
            max_age: max_age.max(0.02),
            size_start,
            size_end,
            col_start,
            col_end,
            gravity,
            drag: drag.max(0.0),
            bounce: bounce.clamp(0.0, 0.95),
            floor_y,
            additive,
            stretch: stretch.max(0.0),
        });
    }

    pub fn step_and_pack(&mut self, dt: f32) {
        let clamped_dt = dt.clamp(0.0, 0.05);
        let mut i = 0usize;
        while i < self.particles.len() {
            let p = &mut self.particles[i];
            p.age += clamped_dt;
            if p.age >= p.max_age {
                self.particles.swap_remove(i);
                continue;
            }

            p.vel.y += p.gravity * clamped_dt;
            let damp = (1.0 - p.drag * clamped_dt).clamp(0.0, 1.0);
            p.vel *= damp;
            p.pos += p.vel * clamped_dt;

            if p.bounce > 0.01 && p.pos.y < p.floor_y && p.vel.y < 0.0 {
                p.pos.y = p.floor_y;
                p.vel.y = -p.vel.y * p.bounce;
                p.vel.x *= 0.84;
                p.vel.z *= 0.84;
            }
            i += 1;
        }

        self.packed_alpha.clear();
        self.packed_additive.clear();
        for p in &self.particles {
            let t = (p.age / p.max_age).clamp(0.0, 1.0);
            let size = p.size_start + (p.size_end - p.size_start) * t;
            let r = p.col_start[0] + (p.col_end[0] - p.col_start[0]) * t;
            let g = p.col_start[1] + (p.col_end[1] - p.col_start[1]) * t;
            let b = p.col_start[2] + (p.col_end[2] - p.col_start[2]) * t;
            let a = p.col_start[3] + (p.col_end[3] - p.col_start[3]) * t;
            let dst = if p.additive {
                &mut self.packed_additive
            } else {
                &mut self.packed_alpha
            };
            dst.extend_from_slice(&[
                p.pos.x,
                p.pos.y,
                p.pos.z,
                size,
                r,
                g,
                b,
                a,
                p.vel.x,
                p.vel.y,
                p.vel.z,
                p.stretch,
            ]);
        }
    }
}

impl Default for ParticleSystem {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_particle_spawn_bounce_pack_and_expire() {
        let mut sys = ParticleSystem::new();
        // Spawn one additive bouncing spark and one alpha smoke particle
        sys.spawn(
            Vec3::new(0.0, 0.2, 0.0),
            Vec3::new(2.0, -5.0, 0.0),
            0.2,
            0.05,
            [1.0, 0.8, 0.3, 1.0],
            [1.0, 0.2, 0.0, 0.0],
            0.5,
            -9.8,
            0.1,
            0.65,
            0.0,
            true,
            0.25,
        );
        sys.spawn(
            Vec3::new(1.0, 1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            0.4,
            0.9,
            [0.7, 0.7, 0.7, 0.6],
            [0.8, 0.8, 0.8, 0.0],
            0.2,
            0.5,
            0.5,
            0.0,
            0.0,
            false,
            0.0,
        );

        for _ in 0..5 {
            sys.step_and_pack(0.02);
        }
        assert_eq!(sys.active_count(), 2);
        assert_eq!(sys.packed_additive.len(), PACKED_PARTICLE_STRIDE);
        assert_eq!(sys.packed_alpha.len(), PACKED_PARTICLE_STRIDE);
        // Spark must bounce above y = 0.0
        assert!(sys.packed_additive[1] >= 0.0);

        // Advance past smoke lifetime (0.2s)
        for _ in 0..8 {
            sys.step_and_pack(0.02);
        }
        assert_eq!(sys.active_count(), 1);
        assert_eq!(sys.packed_alpha.len(), 0);
    }
}
