import * as THREE from "three";

// Faux earth curvature: world geometry dips away with the square of its
// ground distance from the camera focus. Purely a vertex-shader illusion —
// the sim and picking stay flat. Strength ramps up as the camera rises, so
// street-level play is exactly flat.

interface PatchedShader {
  uniforms: { uCurveCenter: { value: THREE.Vector2 }; uCurveStrength: { value: number } };
}

const patched: PatchedShader[] = [];
const center = new THREE.Vector2(0, 0);
let strength = 0;

/** Patch a material so its vertices bend with the fake planet. */
export function applyCurvature(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms["uCurveCenter"] = { value: center };
    shader.uniforms["uCurveStrength"] = { value: strength };
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `
      vec4 wPos = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        wPos = instanceMatrix * wPos;
      #endif
      wPos = modelMatrix * wPos;
      float cDist = distance(wPos.xz, uCurveCenter);
      wPos.y -= cDist * cDist * uCurveStrength;
      vec4 mvPosition = viewMatrix * wPos;
      gl_Position = projectionMatrix * mvPosition;
      `,
    );
    shader.vertexShader = "uniform vec2 uCurveCenter;\nuniform float uCurveStrength;\n" + shader.vertexShader;
    patched.push(shader as unknown as PatchedShader);
  };
}

/**
 * Per-frame update. Curvature fades in from flat (street level) to a
 * dramatic faux radius when the whole city is in view.
 */
export function updateCurvature(targetX: number, targetY: number, viewHeight: number): void {
  center.set(targetX, -targetY); // scene space: world y -> -z
  const t = Math.min(1, Math.max(0, (viewHeight - 1500) / 8000));
  const radius = 60000; // meters — much smaller than Earth, visibly round
  strength = (t * 1) / (2 * radius);
  for (const s of patched) {
    s.uniforms.uCurveCenter.value = center;
    s.uniforms.uCurveStrength.value = strength;
  }
}
