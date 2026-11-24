use crate::ecs::Collider3D;
use glam::{Quat, Vec2, Vec3};

#[derive(Clone, Debug)]
pub struct ConvexHullShape {
    pub vertices: Vec<Vec3>,
    pub bounding_radius: f32,
    pub volume: f32,
}

impl ConvexHullShape {
    pub fn from_points(raw: &[Vec3]) -> Self {
        let mut vertices = Vec::with_capacity(raw.len());
        for &p in raw {
            if !vertices.iter().any(|v: &Vec3| v.distance_squared(p) < 1e-6) {
                vertices.push(p);
            }
        }
        if vertices.is_empty() {
            vertices.push(Vec3::ZERO);
        }
        let mut min_v = Vec3::splat(f32::INFINITY);
        let mut max_v = Vec3::splat(f32::NEG_INFINITY);
        let mut r2 = 0.0f32;
        for &v in &vertices {
            min_v = min_v.min(v);
            max_v = max_v.max(v);
            r2 = r2.max(v.length_squared());
        }
        let ext = (max_v - min_v).max(Vec3::splat(0.05));
        // Approximate hull fill ~0.65 of bounding box when arbitrary point cloud
        let volume = (ext.x * ext.y * ext.z * 0.65).max(0.001);
        Self {
            vertices,
            bounding_radius: r2.sqrt().max(0.02),
            volume,
        }
    }

    #[inline]
    pub fn support_local(&self, dir: Vec3) -> Vec3 {
        let mut best = self.vertices[0];
        let mut best_dot = best.dot(dir);
        for &v in &self.vertices[1..] {
            let d = v.dot(dir);
            if d > best_dot {
                best_dot = d;
                best = v;
            }
        }
        best
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CompoundChild {
    pub local_pos: Vec3,
    pub local_rot: Quat,
    pub collider: Collider3D,
}

#[derive(Clone, Debug)]
pub struct CompoundShape {
    pub children: Vec<CompoundChild>,
    pub bounding_radius: f32,
    pub volume: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct WaterZone {
    pub id: u32,
    pub center: Vec3,
    pub half_extents: Vec3,
    pub rot: Quat,
    pub density: f32,
    pub linear_drag: f32,
    pub angular_drag: f32,
    pub flow: Vec3,
}

/// Closest point on 3D segment `[a, b]` to point `p`.
#[inline]
pub fn closest_point_on_segment(p: Vec3, a: Vec3, b: Vec3) -> (Vec3, f32) {
    let ab = b - a;
    let len_sq = ab.length_squared();
    if len_sq < 1e-10 {
        return (a, 0.0);
    }
    let t = ((p - a).dot(ab) / len_sq).clamp(0.0, 1.0);
    (a + ab * t, t)
}

/// Exact closed-form closest points between two 3D segments `[p1, q1]` and `[p2, q2]`.
/// Returns `(closest1, closest2, dist_sq)`.
pub fn closest_segment_segment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3) -> (Vec3, Vec3, f32) {
    let d1 = q1 - p1;
    let d2 = q2 - p2;
    let r = p1 - p2;
    let a = d1.dot(d1);
    let e = d2.dot(d2);
    let f = d2.dot(r);

    let (s, t) = if a <= 1e-8 && e <= 1e-8 {
        (0.0, 0.0)
    } else if a <= 1e-8 {
        (0.0, (f / e).clamp(0.0, 1.0))
    } else {
        let c = d1.dot(r);
        if e <= 1e-8 {
            ((-c / a).clamp(0.0, 1.0), 0.0)
        } else {
            let b = d1.dot(d2);
            let denom = a * e - b * b;
            let mut s = if denom.abs() > 1e-8 {
                ((b * f - c * e) / denom).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let mut t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
            (s, t)
        }
    };

    let c1 = p1 + d1 * s;
    let c2 = p2 + d2 * t;
    (c1, c2, c1.distance_squared(c2))
}

/// Exact piecewise-quadratic closest point between a local segment `[p0, p1]` and box `[-half, +half]`.
/// Returns `(seg_pt, box_pt, dist_sq, t_mid_of_equal_min_span)`.
pub fn closest_segment_local_box(p0: Vec3, p1: Vec3, half: Vec3) -> (Vec3, Vec3, f32, f32) {
    let d = p1 - p0;
    let mut knots = [0.0f32; 8];
    let mut klen = 2usize;
    knots[0] = 0.0;
    knots[1] = 1.0;

    for axis in 0..3 {
        let da = d[axis];
        if da.abs() > 1e-7 {
            for target in [-half[axis], half[axis]] {
                let t = (target - p0[axis]) / da;
                if t > 1e-5 && t < 1.0 - 1e-5 {
                    knots[klen] = t;
                    klen += 1;
                }
            }
        }
    }
    knots[..klen].sort_by(|a, b| a.total_cmp(b));

    let mut best_t = 0.0f32;
    let mut best_d2 = f32::INFINITY;
    let mut flat_lo = f32::INFINITY;
    let mut flat_hi = f32::NEG_INFINITY;

    let eval = |t: f32| -> (Vec3, Vec3, f32) {
        let s = p0 + d * t;
        let c = s.clamp(-half, half);
        (s, c, s.distance_squared(c))
    };

    for i in 0..(klen - 1) {
        let ta = knots[i];
        let tb = knots[i + 1];
        if tb - ta < 1e-7 {
            continue;
        }
        let tm = 0.5 * (ta + tb);
        let sm = p0 + d * tm;

        // Solve quadratic coefficients A * t^2 + B * t + C for active clamped faces
        let mut qa = 0.0f32;
        let mut qb = 0.0f32;
        for axis in 0..3 {
            let bound = if sm[axis] > half[axis] {
                Some(half[axis])
            } else if sm[axis] < -half[axis] {
                Some(-half[axis])
            } else {
                None
            };
            if let Some(bval) = bound {
                let diff0 = p0[axis] - bval;
                qa += d[axis] * d[axis];
                qb += 2.0 * diff0 * d[axis];
            }
        }

        if qa < 1e-9 {
            // Segment run has constant distance on [ta, tb]; check if optimal plateau
            let (_, _, d2) = eval(tm);
            if d2 < best_d2 - 1e-6 {
                best_d2 = d2;
                best_t = tm;
                flat_lo = ta;
                flat_hi = tb;
            } else if (d2 - best_d2).abs() <= 1e-6 {
                flat_lo = flat_lo.min(ta);
                flat_hi = flat_hi.max(tb);
                best_t = 0.5 * (flat_lo + flat_hi);
            }
        } else {
            let t_cand = (-qb / (2.0 * qa)).clamp(ta, tb);
            let (_, _, d2) = eval(t_cand);
            if d2 < best_d2 - 1e-6 {
                best_d2 = d2;
                best_t = t_cand;
                flat_lo = t_cand;
                flat_hi = t_cand;
            }
        }
    }

    // Check endpoints explicitly in case all sub-intervals were degenerate
    for &te in &[0.0f32, 1.0f32] {
        let (_, _, d2) = eval(te);
        if d2 < best_d2 - 1e-6 {
            best_d2 = d2;
            best_t = te;
        }
    }

    let final_t = if flat_hi > flat_lo && (eval(0.5 * (flat_lo + flat_hi)).2 - best_d2).abs() <= 2e-5 {
        0.5 * (flat_lo + flat_hi)
    } else {
        best_t
    };
    let (seg_pt, box_pt, d2) = eval(final_t);
    (seg_pt, box_pt, d2, final_t)
}

/// Exact capsule-vs-OBB contact detector returning `(world_normal, depth, box_surface_world_point, segment_t)`.
/// Unlike 3-sphere sampling, continuous segment evaluation NEVER discards deep wall contacts for minor corner normals.
#[allow(clippy::too_many_arguments)]
pub fn capsule_vs_obb(
    cap_pos: Vec3,
    cap_rot: Quat,
    radius: f32,
    half_height: f32,
    box_pos: Vec3,
    box_rot: Quat,
    half: Vec3,
) -> Option<(Vec3, f32, Vec3, f32)> {
    let inv_box = box_rot.conjugate();
    let cap_axis_world = cap_rot * Vec3::Y;
    let p0_w = cap_pos - cap_axis_world * half_height;
    let p1_w = cap_pos + cap_axis_world * half_height;
    let p0 = inv_box * (p0_w - box_pos);
    let p1 = inv_box * (p1_w - box_pos);

    let (seg_pt, box_pt, dist_sq, t_best) = closest_segment_local_box(p0, p1, half);
    if dist_sq >= radius * radius {
        return None;
    }

    if dist_sq > 1e-8 {
        let dist = dist_sq.sqrt();
        let ln = (seg_pt - box_pt) / dist;
        return Some((
            box_rot * ln,
            radius - dist,
            box_pos + box_rot * box_pt,
            t_best,
        ));
    }

    // Segment overlaps inside local box: evaluate interior exit depths along the overlapping span
    // Choose point inside box closest to p0/p1 overlap midpoint so contact lever stays physically grounded.
    let mut t_lo = 0.0f32;
    let mut t_hi = 1.0f32;
    let d = p1 - p0;
    for axis in 0..3 {
        if d[axis].abs() > 1e-7 {
            let ta = (-half[axis] - p0[axis]) / d[axis];
            let tb = (half[axis] - p0[axis]) / d[axis];
            t_lo = t_lo.max(ta.min(tb));
            t_hi = t_hi.min(ta.max(tb));
        }
    }
    let t_mid = if t_lo <= t_hi { 0.5 * (t_lo + t_hi) } else { t_best };
    let interior_pt = (p0 + d * t_mid).clamp(-half, half);

    let dx_min = (interior_pt.x + half.x).abs();
    let dx_max = (half.x - interior_pt.x).abs();
    let dy_min = (interior_pt.y + half.y).abs();
    let dy_max = (half.y - interior_pt.y).abs();
    let dz_min = (interior_pt.z + half.z).abs();
    let dz_max = (half.z - interior_pt.z).abs();

    let mut best_dist = dy_max;
    let mut best_ln = Vec3::Y;
    let mut best_face_pt = Vec3::new(interior_pt.x, half.y, interior_pt.z);
    let faces = [
        (dy_min, Vec3::NEG_Y, Vec3::new(interior_pt.x, -half.y, interior_pt.z)),
        (dx_min, Vec3::NEG_X, Vec3::new(-half.x, interior_pt.y, interior_pt.z)),
        (dx_max, Vec3::X, Vec3::new(half.x, interior_pt.y, interior_pt.z)),
        (dz_min, Vec3::NEG_Z, Vec3::new(interior_pt.x, interior_pt.y, -half.z)),
        (dz_max, Vec3::Z, Vec3::new(interior_pt.x, interior_pt.y, half.z)),
    ];
    for &(fd, fnrm, fpt) in &faces {
        if fd < best_dist {
            best_dist = fd;
            best_ln = fnrm;
            best_face_pt = fpt;
        }
    }

    Some((
        box_rot * best_ln,
        radius + best_dist,
        box_pos + box_rot * best_face_pt,
        t_mid,
    ))
}

/// Exact closest point between 3D segment `[s0, s1]` and triangle `[a, b, c]`.
/// Returns `(seg_pt, tri_pt, dist_sq, seg_t)`.
pub fn closest_segment_triangle(
    s0: Vec3,
    s1: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
) -> (Vec3, Vec3, f32, f32) {
    let mut best_s = s0;
    let mut best_tri = closest_point_on_triangle(s0, a, b, c);
    let mut best_d2 = best_s.distance_squared(best_tri);
    let mut best_t = 0.0f32;

    let mut consider = |cs: Vec3, ct: Vec3, d2: f32, t: f32| {
        if d2 < best_d2 {
            best_d2 = d2;
            best_s = cs;
            best_tri = ct;
            best_t = t;
        }
    };

    let c1 = closest_point_on_triangle(s1, a, b, c);
    consider(s1, c1, s1.distance_squared(c1), 1.0);

    // Check segment intersection with triangle plane
    let tri_n = (b - a).cross(c - a);
    let tri_n_len2 = tri_n.length_squared();
    if tri_n_len2 > 1e-10 {
        let dir = s1 - s0;
        let denom = dir.dot(tri_n);
        if denom.abs() > 1e-8 {
            let t_plane = ((a - s0).dot(tri_n) / denom).clamp(0.0, 1.0);
            let p_plane = s0 + dir * t_plane;
            let p_on_tri = closest_point_on_triangle(p_plane, a, b, c);
            consider(p_plane, p_on_tri, p_plane.distance_squared(p_on_tri), t_plane);
        }
    }

    // Check closest points between segment and the 3 triangle edges
    let seg_len_sq = (s1 - s0).length_squared().max(1e-10);
    for (ea, eb) in [(a, b), (b, c), (c, a)] {
        let (cs, ct, d2) = closest_segment_segment(s0, s1, ea, eb);
        let t = ((cs - s0).dot(s1 - s0) / seg_len_sq).clamp(0.0, 1.0);
        consider(cs, ct, d2, t);
    }

    (best_s, best_tri, best_d2, best_t)
}

#[inline]
pub fn closest_point_on_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;

    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }

    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return a + ab * v;
    }

    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return a + ac * w;
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return b + (c - b) * w;
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    a + ab * v + ac * w
}

/// Applies internal-edge normal smoothing: if contact point `pt` lies on an edge marked as flat/concave
/// interior (`internal_edge_mask` bits 0=AB, 1=BC, 2=CA), projects normal smoothly toward `tri_n`.
pub fn smooth_internal_triangle_normal(
    raw_n: Vec3,
    tri: [Vec3; 3],
    pt: Vec3,
    internal_edge_mask: u8,
) -> Vec3 {
    if internal_edge_mask == 0 {
        return raw_n;
    }
    let tri_n = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
    if tri_n.length_squared() < 0.5 {
        return raw_n;
    }
    let edges = [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])];
    for (k, &(ea, eb)) in edges.iter().enumerate() {
        if (internal_edge_mask & (1 << k)) == 0 {
            continue;
        }
        let (ep, _) = closest_point_on_segment(pt, ea, eb);
        if ep.distance_squared(pt) < 1e-4 {
            // Only snap toward face normal if contact lies on positive side of triangle plane
            if raw_n.dot(tri_n) > 0.05 {
                return tri_n;
            }
        }
    }
    raw_n
}

// =========================================================================
// Generic Support Mapping + GJK / EPA for Cylinder, ConvexHull & Mixed Pairs
// =========================================================================

pub enum SupportShape<'a> {
    Obb { pos: Vec3, rot: Quat, half: Vec3 },
    Sphere { pos: Vec3, radius: f32 },
    Capsule { pos: Vec3, rot: Quat, radius: f32, half_height: f32 },
    Cylinder { pos: Vec3, rot: Quat, radius: f32, half_height: f32 },
    ConvexHull { pos: Vec3, rot: Quat, hull: &'a ConvexHullShape },
    Triangle { verts: [Vec3; 3] },
}

impl<'a> SupportShape<'a> {
    #[inline]
    pub fn support(&self, dir: Vec3) -> Vec3 {
        let d = if dir.length_squared() > 1e-12 { dir } else { Vec3::Y };
        match *self {
            SupportShape::Obb { pos, rot, half } => {
                let ld = rot.conjugate() * d;
                let ls = Vec3::new(
                    if ld.x >= 0.0 { half.x } else { -half.x },
                    if ld.y >= 0.0 { half.y } else { -half.y },
                    if ld.z >= 0.0 { half.z } else { -half.z },
                );
                pos + rot * ls
            }
            SupportShape::Sphere { pos, radius } => pos + d.normalize() * radius,
            SupportShape::Capsule { pos, rot, radius, half_height } => {
                let axis = rot * Vec3::Y;
                let end = if d.dot(axis) >= 0.0 { pos + axis * half_height } else { pos - axis * half_height };
                end + d.normalize() * radius
            }
            SupportShape::Cylinder { pos, rot, radius, half_height } => {
                let ld = rot.conjugate() * d;
                let ly = if ld.y >= 0.0 { half_height } else { -half_height };
                let radial_sq = ld.x * ld.x + ld.z * ld.z;
                let (lx, lz) = if radial_sq > 1e-10 {
                    let s = radius / radial_sq.sqrt();
                    (ld.x * s, ld.z * s)
                } else {
                    (0.0, 0.0)
                };
                pos + rot * Vec3::new(lx, ly, lz)
            }
            SupportShape::ConvexHull { pos, rot, hull } => {
                let ld = rot.conjugate() * d;
                pos + rot * hull.support_local(ld)
            }
            SupportShape::Triangle { verts } => {
                let d0 = verts[0].dot(d);
                let d1 = verts[1].dot(d);
                let d2 = verts[2].dot(d);
                if d0 >= d1 && d0 >= d2 {
                    verts[0]
                } else if d1 >= d2 {
                    verts[1]
                } else {
                    verts[2]
                }
            }
        }
    }

    #[inline]
    pub fn center(&self) -> Vec3 {
        match *self {
            SupportShape::Obb { pos, .. }
            | SupportShape::Sphere { pos, .. }
            | SupportShape::Capsule { pos, .. }
            | SupportShape::Cylinder { pos, .. }
            | SupportShape::ConvexHull { pos, .. } => pos,
            SupportShape::Triangle { verts } => (verts[0] + verts[1] + verts[2]) / 3.0,
        }
    }
}

#[derive(Clone, Copy)]
struct SupPt {
    p: Vec3,
    a: Vec3,
    b: Vec3,
}

#[inline]
fn minkowski_support(sa: &SupportShape<'_>, sb: &SupportShape<'_>, dir: Vec3) -> SupPt {
    let a = sa.support(dir);
    let b = sb.support(-dir);
    SupPt { p: a - b, a, b }
}

/// Runs GJK intersection + EPA penetration solver returning `(normal_pushing_a_away_from_b, depth, contact_world_pt)`.
pub fn gjk_epa(sa: &SupportShape<'_>, sb: &SupportShape<'_>) -> Option<(Vec3, f32, Vec3)> {
    let mut dir = sa.center() - sb.center();
    if dir.length_squared() < 1e-8 {
        dir = Vec3::Y;
    }

    let mut simp = [SupPt {
        p: Vec3::ZERO,
        a: Vec3::ZERO,
        b: Vec3::ZERO,
    }; 4];
    simp[0] = minkowski_support(sa, sb, dir);
    let mut n = 1usize;
    dir = -simp[0].p;
    if dir.length_squared() < 1e-10 {
        dir = Vec3::Y;
    }

    let mut hit = false;
    for _ in 0..32 {
        let p = minkowski_support(sa, sb, dir);
        if p.p.dot(dir) < 0.0 {
            return None;
        }
        simp[n] = p;
        n += 1;
        if handle_simplex(&mut simp, &mut n, &mut dir) {
            hit = true;
            break;
        }
        if dir.length_squared() < 1e-12 {
            hit = true;
            break;
        }
    }
    if !hit || n < 4 {
        return None;
    }

    epa_solve(sa, sb, &simp)
}

fn handle_simplex(s: &mut [SupPt; 4], n: &mut usize, dir: &mut Vec3) -> bool {
    match *n {
        2 => {
            let b = s[0].p;
            let a = s[1].p;
            let ab = b - a;
            let ao = -a;
            if ab.dot(ao) > 0.0 {
                *dir = ab.cross(ao).cross(ab);
                if dir.length_squared() < 1e-10 {
                    *dir = Vec3::X.cross(ab);
                    if dir.length_squared() < 1e-10 {
                        *dir = Vec3::Y.cross(ab);
                    }
                }
            } else {
                s[0] = s[1];
                *n = 1;
                *dir = ao;
            }
            false
        }
        3 => {
            let c = s[0].p;
            let b = s[1].p;
            let a = s[2].p;
            let ab = b - a;
            let ac = c - a;
            let ao = -a;
            let abc = ab.cross(ac);
            if abc.cross(ac).dot(ao) > 0.0 {
                if ac.dot(ao) > 0.0 {
                    s[1] = s[2];
                    *n = 2;
                    *dir = ac.cross(ao).cross(ac);
                } else {
                    s[0] = s[1];
                    s[1] = s[2];
                    *n = 2;
                    return handle_simplex(s, n, dir);
                }
            } else if ab.cross(abc).dot(ao) > 0.0 {
                s[0] = s[1];
                s[1] = s[2];
                *n = 2;
                return handle_simplex(s, n, dir);
            } else if abc.dot(ao) > 0.0 {
                *dir = abc;
            } else {
                s.swap(0, 1);
                *dir = -abc;
            }
            false
        }
        4 => {
            let d = s[0].p;
            let c = s[1].p;
            let b = s[2].p;
            let a = s[3].p;
            let ab = b - a;
            let ac = c - a;
            let ad = d - a;
            let ao = -a;

            let mut abc = ab.cross(ac);
            if abc.dot(ad) > 0.0 {
                abc = -abc;
            }
            let mut acd = ac.cross(ad);
            if acd.dot(ab) > 0.0 {
                acd = -acd;
            }
            let mut adb = ad.cross(ab);
            if adb.dot(ac) > 0.0 {
                adb = -adb;
            }

            if abc.dot(ao) > 0.0 {
                s[0] = s[1];
                s[1] = s[2];
                s[2] = s[3];
                *n = 3;
                *dir = abc;
                return false;
            }
            if acd.dot(ao) > 0.0 {
                s[2] = s[3];
                *n = 3;
                *dir = acd;
                return false;
            }
            if adb.dot(ao) > 0.0 {
                s[1] = s[2];
                s[2] = s[3];
                *n = 3;
                *dir = adb;
                return false;
            }
            true
        }
        _ => false,
    }
}

fn epa_solve(sa: &SupportShape<'_>, sb: &SupportShape<'_>, init: &[SupPt; 4]) -> Option<(Vec3, f32, Vec3)> {
    const MAX_VERTS: usize = 64;
    const MAX_FACES: usize = 128;
    let mut verts = [SupPt {
        p: Vec3::ZERO,
        a: Vec3::ZERO,
        b: Vec3::ZERO,
    }; MAX_VERTS];
    verts[..4].copy_from_slice(init);
    let mut v_count = 4usize;

    #[derive(Clone, Copy)]
    struct Face {
        i: [usize; 3],
        n: Vec3,
        d: f32,
        alive: bool,
    }

    let make_face = |v: &[SupPt], i0: usize, i1: usize, i2: usize, interior: Vec3| -> Option<Face> {
        let a = v[i0].p;
        let b = v[i1].p;
        let c = v[i2].p;
        let mut n = (b - a).cross(c - a);
        let l2 = n.length_squared();
        if l2 < 1e-12 {
            return None;
        }
        n /= l2.sqrt();
        if n.dot(a - interior) < 0.0 {
            n = -n;
            let d = n.dot(a);
            return Some(Face {
                i: [i0, i2, i1],
                n,
                d,
                alive: true,
            });
        }
        let d = n.dot(a);
        Some(Face {
            i: [i0, i1, i2],
            n,
            d,
            alive: true,
        })
    };

    let interior = 0.25 * (verts[0].p + verts[1].p + verts[2].p + verts[3].p);
    let mut faces = [Face {
        i: [0; 3],
        n: Vec3::Y,
        d: 0.0,
        alive: false,
    }; MAX_FACES];
    let mut f_count = 0usize;
    for &(i0, i1, i2) in &[(0, 1, 2), (0, 2, 3), (0, 3, 1), (1, 3, 2)] {
        if let Some(f) = make_face(&verts, i0, i1, i2, interior) {
            faces[f_count] = f;
            f_count += 1;
        }
    }
    if f_count == 0 {
        return None;
    }

    let mut best_f = 0usize;
    for _ in 0..24 {
        let mut min_d = f32::INFINITY;
        let mut found = false;
        for idx in 0..f_count {
            if faces[idx].alive && faces[idx].d < min_d {
                min_d = faces[idx].d;
                best_f = idx;
                found = true;
            }
        }
        if !found {
            break;
        }
        let fnrm = faces[best_f].n;
        let new_pt = minkowski_support(sa, sb, fnrm);
        let new_d = fnrm.dot(new_pt.p);
        if (new_d - min_d) < 0.001 || v_count >= MAX_VERTS {
            break;
        }

        let new_idx = v_count;
        verts[new_idx] = new_pt;
        v_count += 1;

        let mut edges = [(0usize, 0usize); 96];
        let mut e_count = 0usize;
        for f in &mut faces[..f_count] {
            if f.alive && f.n.dot(new_pt.p - verts[f.i[0]].p) > 1e-6 {
                f.alive = false;
                let fe = [(f.i[0], f.i[1]), (f.i[1], f.i[2]), (f.i[2], f.i[0])];
                for &(ea, eb) in &fe {
                    if let Some(pos) = edges[..e_count].iter().position(|&(x, y)| x == eb && y == ea) {
                        e_count -= 1;
                        edges[pos] = edges[e_count];
                    } else if e_count < edges.len() {
                        edges[e_count] = (ea, eb);
                        e_count += 1;
                    }
                }
            }
        }

        for &(ea, eb) in &edges[..e_count] {
            if f_count < MAX_FACES {
                if let Some(nf) = make_face(&verts, ea, eb, new_idx, interior) {
                    faces[f_count] = nf;
                    f_count += 1;
                }
            }
        }
    }

    let f = faces[best_f];
    if !f.alive && f_count == 0 {
        return None;
    }
    let p_close = f.n * f.d;
    let a = verts[f.i[0]].p;
    let b = verts[f.i[1]].p;
    let c = verts[f.i[2]].p;
    let (u, v, w) = barycentric(p_close, a, b, c);
    let pt_a = verts[f.i[0]].a * u + verts[f.i[1]].a * v + verts[f.i[2]].a * w;
    let pt_b = verts[f.i[0]].b * u + verts[f.i[1]].b * v + verts[f.i[2]].b * w;
    let depth = f.d.max(1e-5);
    // f.n points from origin outward along penetration vector of A relative to B (so A is pushed by -f.n)
    Some((-f.n, depth, 0.5 * (pt_a + pt_b)))
}

#[inline]
fn barycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> (f32, f32, f32) {
    let v0 = b - a;
    let v1 = c - a;
    let v2 = p - a;
    let d00 = v0.dot(v0);
    let d01 = v0.dot(v1);
    let d11 = v1.dot(v1);
    let d20 = v2.dot(v0);
    let d21 = v2.dot(v1);
    let denom = d00 * d11 - d01 * d01;
    if denom.abs() < 1e-10 {
        return (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0);
    }
    let v = ((d11 * d20 - d01 * d21) / denom).clamp(0.0, 1.0);
    let w = ((d00 * d21 - d01 * d20) / denom).clamp(0.0, 1.0);
    let u = (1.0 - v - w).max(0.0);
    let sum = (u + v + w).max(1e-6);
    (u / sum, v / sum, w / sum)
}

/// Ray vs rotated cylinder (finite capped cylinder along local Y).
pub fn ray_cylinder(
    origin: Vec3,
    dir: Vec3,
    pos: Vec3,
    rot: Quat,
    radius: f32,
    half_height: f32,
) -> Option<(f32, Vec3)> {
    let inv = rot.conjugate();
    let lo = inv * (origin - pos);
    let ld = inv * dir;

    let mut best_t = f32::INFINITY;
    let mut best_ln = Vec3::Y;

    // 1. Infinite cylinder wall XZ
    let a = ld.x * ld.x + ld.z * ld.z;
    if a > 1e-8 {
        let b = lo.x * ld.x + lo.z * ld.z;
        let c = lo.x * lo.x + lo.z * lo.z - radius * radius;
        let disc = b * b - a * c;
        if disc >= 0.0 {
            let t = (-b - disc.sqrt()) / a;
            if t >= 0.0 {
                let y = lo.y + ld.y * t;
                if y.abs() <= half_height {
                    best_t = t;
                    let hx = lo.x + ld.x * t;
                    let hz = lo.z + ld.z * t;
                    best_ln = Vec3::new(hx, 0.0, hz).normalize_or_zero();
                }
            }
        }
    }

    // 2. Top and bottom caps
    if ld.y.abs() > 1e-8 {
        for &(cap_y, cap_n) in &[(half_height, Vec3::Y), (-half_height, Vec3::NEG_Y)] {
            let t = (cap_y - lo.y) / ld.y;
            if t >= 0.0 && t < best_t {
                let hx = lo.x + ld.x * t;
                let hz = lo.z + ld.z * t;
                if hx * hx + hz * hz <= radius * radius {
                    best_t = t;
                    best_ln = cap_n;
                }
            }
        }
    }

    if best_t.is_finite() {
        Some((best_t, rot * best_ln))
    } else {
        None
    }
}

/// Ray vs rotated capsule (vertical axis in local space).
pub fn ray_capsule(
    origin: Vec3,
    dir: Vec3,
    pos: Vec3,
    rot: Quat,
    radius: f32,
    half_height: f32,
) -> Option<(f32, Vec3)> {
    let mut best = ray_cylinder(origin, dir, pos, rot, radius, half_height);
    let axis = rot * Vec3::Y;
    for cap_c in [pos + axis * half_height, pos - axis * half_height] {
        let oc = origin - cap_c;
        let b = oc.dot(dir);
        let c = oc.dot(oc) - radius * radius;
        let disc = b * b - c;
        if disc >= 0.0 {
            let t = -b - disc.sqrt();
            if t >= 0.0 && best.map_or(true, |(bt, _)| t < bt) {
                let n = ((origin + dir * t) - cap_c).normalize_or_zero();
                best = Some((t, n));
            }
        }
    }
    best
}

/// Rotated 2D contact test supporting Aabb2D (OBB2D via Z rotation), Circle2D, and Capsule2D.
pub fn intersect_2d_rotated(
    a: crate::ecs::Collider2D,
    pa: Vec2,
    ang_a: f32,
    b: crate::ecs::Collider2D,
    pb: Vec2,
    ang_b: f32,
) -> Option<(Vec2, f32)> {
    use crate::ecs::Collider2D;
    let rot2 = |v: Vec2, ang: f32| -> Vec2 {
        let (s, c) = ang.sin_cos();
        Vec2::new(v.x * c - v.y * s, v.x * s + v.y * c)
    };
    match (a, b) {
        (Collider2D::Circle2D { radius: r1 }, Collider2D::Circle2D { radius: r2 }) => {
            let diff = pa - pb;
            let dist_sq = diff.length_squared();
            let r_sum = r1 + r2;
            if dist_sq >= r_sum * r_sum {
                return None;
            }
            let dist = dist_sq.sqrt();
            if dist < 1e-6 {
                return Some((Vec2::Y, r_sum));
            }
            Some((diff / dist, r_sum - dist))
        }
        (Collider2D::Circle2D { radius }, Collider2D::Aabb2D { half_extents }) => {
            let local_p = rot2(pa - pb, -ang_b);
            let closest = local_p.clamp(-half_extents, half_extents);
            let diff = local_p - closest;
            let d2 = diff.length_squared();
            if d2 >= radius * radius {
                return None;
            }
            if d2 > 1e-8 {
                let d = d2.sqrt();
                return Some((rot2(diff / d, ang_b), radius - d));
            }
            let dx = (half_extents.x - local_p.x.abs()).max(0.0);
            let dy = (half_extents.y - local_p.y.abs()).max(0.0);
            let ln = if dy <= dx {
                Vec2::new(0.0, if local_p.y >= 0.0 { 1.0 } else { -1.0 })
            } else {
                Vec2::new(if local_p.x >= 0.0 { 1.0 } else { -1.0 }, 0.0)
            };
            Some((rot2(ln, ang_b), radius + dx.min(dy)))
        }
        (Collider2D::Aabb2D { .. }, Collider2D::Circle2D { .. }) => {
            intersect_2d_rotated(b, pb, ang_b, a, pa, ang_a).map(|(n, d)| (-n, d))
        }
        (Collider2D::Capsule2D { radius, half_height }, Collider2D::Circle2D { radius: r2 }) => {
            let axis = rot2(Vec2::Y, ang_a);
            let p0 = pa - axis * half_height;
            let p1 = pa + axis * half_height;
            let ab = p1 - p0;
            let t = if ab.length_squared() > 1e-8 {
                ((pb - p0).dot(ab) / ab.length_squared()).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let closest = p0 + ab * t;
            intersect_2d_rotated(
                Collider2D::Circle2D { radius },
                closest,
                0.0,
                Collider2D::Circle2D { radius: r2 },
                pb,
                0.0,
            )
        }
        (Collider2D::Capsule2D { radius, half_height }, Collider2D::Aabb2D { half_extents }) => {
            let axis = rot2(Vec2::Y, ang_a);
            let mut best: Option<(Vec2, f32)> = None;
            for frac in [-1.0f32, -0.5, 0.0, 0.5, 1.0] {
                let sample = pa + axis * (half_height * frac);
                if let Some((n, d)) = intersect_2d_rotated(
                    Collider2D::Circle2D { radius },
                    sample,
                    0.0,
                    Collider2D::Aabb2D { half_extents },
                    pb,
                    ang_b,
                ) {
                    if best.map_or(true, |(_, bd)| d > bd) {
                        best = Some((n, d));
                    }
                }
            }
            best
        }
        (Collider2D::Capsule2D { radius: r1, half_height: h1 }, Collider2D::Capsule2D { radius: r2, half_height: h2 }) => {
            let a_ax = rot2(Vec2::Y, ang_a);
            let b_ax = rot2(Vec2::Y, ang_b);
            let p0 = Vec3::new(pa.x - a_ax.x * h1, pa.y - a_ax.y * h1, 0.0);
            let p1 = Vec3::new(pa.x + a_ax.x * h1, pa.y + a_ax.y * h1, 0.0);
            let q0 = Vec3::new(pb.x - b_ax.x * h2, pb.y - b_ax.y * h2, 0.0);
            let q1 = Vec3::new(pb.x + b_ax.x * h2, pb.y + b_ax.y * h2, 0.0);
            let (c1, c2, _) = closest_segment_segment(p0, p1, q0, q1);
            intersect_2d_rotated(
                Collider2D::Circle2D { radius: r1 },
                Vec2::new(c1.x, c1.y),
                0.0,
                Collider2D::Circle2D { radius: r2 },
                Vec2::new(c2.x, c2.y),
                0.0,
            )
        }
        (Collider2D::Circle2D { .. }, Collider2D::Capsule2D { .. })
        | (Collider2D::Aabb2D { .. }, Collider2D::Capsule2D { .. }) => {
            intersect_2d_rotated(b, pb, ang_b, a, pa, ang_a).map(|(n, d)| (-n, d))
        }
        (Collider2D::Aabb2D { half_extents: ha }, Collider2D::Aabb2D { half_extents: hb }) => {
            // 2D SAT across 4 axes (OBB2D vs OBB2D)
            let ax = [rot2(Vec2::X, ang_a), rot2(Vec2::Y, ang_a)];
            let bx = [rot2(Vec2::X, ang_b), rot2(Vec2::Y, ang_b)];
            let diff = pa - pb;
            let mut min_pen = f32::INFINITY;
            let mut best_axis = Vec2::Y;
            for axis in [ax[0], ax[1], bx[0], bx[1]] {
                let ra = ha.x * axis.dot(ax[0]).abs() + ha.y * axis.dot(ax[1]).abs();
                let rb = hb.x * axis.dot(bx[0]).abs() + hb.y * axis.dot(bx[1]).abs();
                let dist = diff.dot(axis).abs();
                let pen = ra + rb - dist;
                if pen <= 0.0 {
                    return None;
                }
                if pen < min_pen {
                    min_pen = pen;
                    best_axis = if diff.dot(axis) >= 0.0 { axis } else { -axis };
                }
            }
            Some((best_axis, min_pen))
        }
    }
}
