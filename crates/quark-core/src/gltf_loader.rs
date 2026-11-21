use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct VertexPbr {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct GlbSubmesh {
    pub index_offset: u32,
    pub index_count: u32,
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
}

#[derive(Clone, Debug)]
pub struct ParsedGlb {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub submeshes: Vec<GlbSubmesh>,
    pub submesh_floats: Vec<f32>,
    pub bounds_min: [f32; 3],
    pub bounds_max: [f32; 3],
}

#[derive(Debug)]
pub enum GltfParseError {
    InvalidContainer(String),
    MissingBinaryBuffer,
    NoGeometry,
}

pub fn parse_glb(bytes: &[u8]) -> Result<ParsedGlb, GltfParseError> {
    if bytes.len() < 12 {
        return Err(GltfParseError::InvalidContainer("file too short".into()));
    }
    let gltf = gltf::Gltf::from_slice(bytes)
        .map_err(|e| GltfParseError::InvalidContainer(e.to_string()))?;

    let blob = gltf.blob.as_deref().ok_or(GltfParseError::MissingBinaryBuffer)?;

    let mut vertices: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut submeshes: Vec<GlbSubmesh> = Vec::new();
    let mut submesh_floats: Vec<f32> = Vec::new();
    let mut bmin = Vec3::splat(f32::INFINITY);
    let mut bmax = Vec3::splat(f32::NEG_INFINITY);

    let mut visited_scene_nodes = false;
    if let Some(scene) = gltf.default_scene().or_else(|| gltf.scenes().next()) {
        visited_scene_nodes = true;
        for node in scene.nodes() {
            visit_node(
                &node,
                Mat4::IDENTITY,
                blob,
                &mut vertices,
                &mut indices,
                &mut submeshes,
                &mut bmin,
                &mut bmax,
            );
        }
    }

    if !visited_scene_nodes || submeshes.is_empty() {
        for mesh in gltf.meshes() {
            append_mesh(
                &mesh,
                Mat4::IDENTITY,
                blob,
                &mut vertices,
                &mut indices,
                &mut submeshes,
                &mut bmin,
                &mut bmax,
            );
        }
    }

    if submeshes.is_empty() || vertices.is_empty() {
        return Err(GltfParseError::NoGeometry);
    }

    for sm in &submeshes {
        submesh_floats.extend_from_slice(&[
            sm.index_offset as f32,
            sm.index_count as f32,
            sm.base_color[0],
            sm.base_color[1],
            sm.base_color[2],
            sm.base_color[3],
            sm.metallic,
            sm.roughness,
        ]);
    }

    Ok(ParsedGlb {
        vertices,
        indices,
        submeshes,
        submesh_floats,
        bounds_min: bmin.to_array(),
        bounds_max: bmax.to_array(),
    })
}

fn visit_node(
    node: &gltf::Node,
    parent_mat: Mat4,
    blob: &[u8],
    vertices: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    submeshes: &mut Vec<GlbSubmesh>,
    bmin: &mut Vec3,
    bmax: &mut Vec3,
) {
    let local = Mat4::from_cols_array_2d(&node.transform().matrix());
    let world = parent_mat * local;
    if let Some(mesh) = node.mesh() {
        append_mesh(&mesh, world, blob, vertices, indices, submeshes, bmin, bmax);
    }
    for child in node.children() {
        visit_node(&child, world, blob, vertices, indices, submeshes, bmin, bmax);
    }
}

fn append_mesh(
    mesh: &gltf::Mesh,
    world_mat: Mat4,
    blob: &[u8],
    vertices: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    submeshes: &mut Vec<GlbSubmesh>,
    bmin: &mut Vec3,
    bmax: &mut Vec3,
) {
    let normal_mat = world_mat.inverse().transpose();
    for primitive in mesh.primitives() {
        let reader = primitive.reader(|buffer| match buffer.source() {
            gltf::buffer::Source::Bin => Some(blob),
            gltf::buffer::Source::Uri(_) => None,
        });
        let Some(pos_iter) = reader.read_positions() else {
            continue;
        };
        let positions: Vec<[f32; 3]> = pos_iter.collect();
        if positions.is_empty() {
            continue;
        }
        let normals: Vec<[f32; 3]> = reader
            .read_normals()
            .map(|it| it.collect())
            .unwrap_or_default();
        let uvs: Vec<[f32; 2]> = reader
            .read_tex_coords(0)
            .map(|tc| tc.into_f32().collect())
            .unwrap_or_default();

        let local_indices: Vec<u32> = match reader.read_indices() {
            Some(ind) => ind.into_u32().collect(),
            None => (0..positions.len() as u32).collect(),
        };
        if local_indices.is_empty() {
            continue;
        }

        let base_vertex = (vertices.len() / 8) as u32;
        let index_offset = indices.len() as u32;
        let index_count = local_indices.len() as u32;

        let mut world_positions = Vec::with_capacity(positions.len());
        for p in &positions {
            let wp = world_mat.transform_point3(Vec3::from_array(*p));
            *bmin = bmin.min(wp);
            *bmax = bmax.max(wp);
            world_positions.push(wp);
        }

        // Compute flat normals fallback when asset lacks normals.
        let mut fallback_normals = vec![Vec3::ZERO; positions.len()];
        if normals.len() != positions.len() {
            for tri in local_indices.chunks_exact(3) {
                let (i0, i1, i2) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
                if i0 < world_positions.len()
                    && i1 < world_positions.len()
                    && i2 < world_positions.len()
                {
                    let e1 = world_positions[i1] - world_positions[i0];
                    let e2 = world_positions[i2] - world_positions[i0];
                    let n = e1.cross(e2);
                    fallback_normals[i0] += n;
                    fallback_normals[i1] += n;
                    fallback_normals[i2] += n;
                }
            }
        }

        for i in 0..positions.len() {
            let wp = world_positions[i];
            let wn = if normals.len() == positions.len() {
                normal_mat
                    .transform_vector3(Vec3::from_array(normals[i]))
                    .normalize_or_zero()
            } else {
                let n = fallback_normals[i].normalize_or_zero();
                if n.length_squared() > 0.0 {
                    n
                } else {
                    Vec3::Y
                }
            };
            let uv = uvs.get(i).copied().unwrap_or([0.0, 0.0]);
            let vtx = VertexPbr {
                pos: wp.to_array(),
                normal: wn.to_array(),
                uv,
            };
            vertices.extend_from_slice(bytemuck::cast_slice(&[vtx]));
        }

        for idx in local_indices {
            indices.push(base_vertex + idx);
        }

        let pbr = primitive.material().pbr_metallic_roughness();
        submeshes.push(GlbSubmesh {
            index_offset,
            index_count,
            base_color: pbr.base_color_factor(),
            metallic: pbr.metallic_factor(),
            roughness: pbr.roughness_factor(),
        });
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub(crate) fn make_minimal_triangle_glb() -> Vec<u8> {
        let mut bin = Vec::new();
        let verts: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        for v in verts {
            bin.extend_from_slice(&v.to_le_bytes());
        }
        let indices: [u16; 3] = [0, 1, 2];
        for i in indices {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        while bin.len() % 4 != 0 {
            bin.push(0);
        }

        let json = format!(
            concat!(
                r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"#,
                r#""bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},{{"buffer":0,"byteOffset":36,"byteLength":6}}],"#,
                r#""accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},"#,
                r#"{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"#,
                r#""meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1}}]}}]}}"#
            ),
            bin.len()
        );
        let mut json_bytes = json.into_bytes();
        while json_bytes.len() % 4 != 0 {
            json_bytes.push(b' ');
        }

        let total_len = 12 + 8 + json_bytes.len() + 8 + bin.len();
        let mut glb = Vec::with_capacity(total_len);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total_len as u32).to_le_bytes());

        glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4E4F534Au32.to_le_bytes());
        glb.extend_from_slice(&json_bytes);

        glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x004E4942u32.to_le_bytes());
        glb.extend_from_slice(&bin);
        glb
    }

    #[test]
    fn test_parse_minimal_valid_glb() {
        let glb = make_minimal_triangle_glb();
        let parsed = parse_glb(&glb).expect("valid minimal GLB should parse");
        assert_eq!(parsed.vertices.len(), 3 * 8);
        assert_eq!(parsed.indices, vec![0, 1, 2]);
        assert_eq!(parsed.submeshes.len(), 1);
        assert!((parsed.vertices[5] - 1.0).abs() < 1e-4);
        assert!((parsed.bounds_max[0] - 1.0).abs() < 1e-4);
        assert!((parsed.bounds_max[1] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn test_parse_malformed_glb_returns_error() {
        assert!(parse_glb(b"not-a-glb").is_err());
        assert!(parse_glb(&[]).is_err());
    }
}
