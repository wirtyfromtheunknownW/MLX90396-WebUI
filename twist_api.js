/**
 * twist_api.js
 * Twist-mode signal processing for the MLX90396.
 *
 *  1px mode (units: mT)   : X0 (Bx), Y0 (By), Z0 (Bz)
 *     alpha = atan2(Z0, X0)               strength = sqrt(Z0^2 + X0^2)
 *     beta  = atan2(Z0, Y0)               strength = sqrt(Z0^2 + Y0^2)
 *
 *  2px mode (units: mT/mm): X02 (dBx/dx), Z02 (dBz/dx), Y13 (dBy/dy), Z13 (dBz/dy)
 *     alpha = atan2(Z02, X02)             strength = sqrt(Z02^2 + X02^2)
 *     beta  = atan2(Z13, Y13)             strength = sqrt(Z13^2 + Y13^2)
 */

const toDeg = (rad) => (rad * 180) / Math.PI;

export function calcTwist1px({ X0, Y0, Z0 }) {
  const alpha = Math.atan2(Z0, X0);
  const beta = Math.atan2(Z0, Y0);
  return {
    alphaRad: alpha,
    betaRad: beta,
    alphaDeg: toDeg(alpha),
    betaDeg: toDeg(beta),
    strengthAlpha: Math.hypot(Z0, X0),
    strengthBeta: Math.hypot(Z0, Y0),
    unit: 'mT',
    mode: '1px',
  };
}

export function calcTwist2px({ X02, Z02, Y13, Z13 }) {
  const alpha = Math.atan2(Z02, X02);
  const beta = Math.atan2(Z13, Y13);
  return {
    alphaRad: alpha,
    betaRad: beta,
    alphaDeg: toDeg(alpha),
    betaDeg: toDeg(beta),
    strengthAlpha: Math.hypot(Z02, X02),
    strengthBeta: Math.hypot(Z13, Y13),
    unit: 'mT/mm',
    mode: '2px',
  };
}

// --- Calibration (Desmos model, rad -> deg) ---
//   a1 = atan2( sqrt( z1^2 + (k1 * (y1 - o11 * z1))^2 ), (x1 - o12 * z1) )
//   b1 = atan2( sqrt( z1^2 + (k2 * (x1 - o21 * z1))^2 ), (y1 - o22 * z1) )
export const TWIST_CAL = {
  k1: 1, k2: 1,
  o11: 0, o12: 0,
  o21: 0, o22: 0,
};

export function applyTwistCalibration(x, y, z) {
  const { k1, k2, o11, o12, o21, o22 } = TWIST_CAL;
  const isIdentity = k1 === 1 && k2 === 1 && o11 === 0 && o12 === 0 && o21 === 0 && o22 === 0;
  if (isIdentity) {
    // Vanilla mode: identity calibration is a true no-op, so the calibrated
    // readout equals the pure atan2 (no tangential cross-axis mixing) until
    // the user actually enters calibration offsets / gains.
    const a1 = Math.atan2(z, x);
    const b1 = Math.atan2(z, y);
    return {
      alphaRad: a1,
      betaRad: b1,
      alphaDeg: toDeg(a1),
      betaDeg: toDeg(b1),
    };
  }
  const a1 = Math.atan2(
    Math.hypot(z, k1 * (y - o11 * z)),
    x - o12 * z
  );
  const b1 = Math.atan2(
    Math.hypot(z, k2 * (x - o21 * z)),
    y - o22 * z
  );
  return {
    alphaRad: a1,
    betaRad: b1,
    alphaDeg: toDeg(a1),
    betaDeg: toDeg(b1),
  };
}

// Combined pipeline: raw alpha/beta + strengths for the selected mode, then
// Desmos calibration applied and returned in degrees. 2px cross-terms use the
// perpendicular differential pair (alpha consumes Y13, beta consumes X02).
export function computeTwistSignals(mode = '1px', input = null) {
  const is2px = mode === '2px';
  const src = input || (is2px
    ? { X02: 0, Z02: 0, Y13: 0, Z13: 0 }
    : { X0: 0, Y0: 0, Z0: 0 });
  const raw = is2px ? calcTwist2px(src) : calcTwist1px(src);

  const alphaIn = is2px
    ? { x: src.X02, y: src.Y13, z: src.Z02 }
    : { x: src.X0, y: src.Y0, z: src.Z0 };
  const betaIn = is2px
    ? { x: src.X02, y: src.Y13, z: src.Z13 }
    : { x: src.X0, y: src.Y0, z: src.Z0 };

  const calA = applyTwistCalibration(alphaIn.x, alphaIn.y, alphaIn.z);
  const calB = applyTwistCalibration(betaIn.x, betaIn.y, betaIn.z);

  return {
    ...raw,
    alphaCalDeg: calA.alphaDeg,
    alphaCalRad: calA.alphaRad,
    betaCalDeg: calB.betaDeg,
    betaCalRad: calB.betaRad,
  };
}

// Derive 1px + 2px inputs from the 4 pixel readouts.
export function deriveTwistInputsFromPoints(points) {
  const p0 = points?.[0] || {};
  const p1 = points?.[1] || {};
  const p2 = points?.[2] || {};
  const p3 = points?.[3] || {};
  return {
    X0: p0.x ?? 0, Y0: p0.y ?? 0, Z0: p0.z ?? 0,
    X02: ((p2.x ?? 0) - (p0.x ?? 0)) / 2,
    Z02: ((p2.z ?? 0) - (p0.z ?? 0)) / 2,
    Y13: ((p3.y ?? 0) - (p1.y ?? 0)) / 2,
    Z13: ((p3.z ?? 0) - (p1.z ?? 0)) / 2,
  };
}

// --- Gain Configuration (MLX90396 GAINSEL register) ---
// Twisted demo gain: electrical gain scaled ~72 -> ~219.
// GAINSEL_1PX was 9 (0b001001); now 37 (0b100101).
// TODO(hw-trim): during the physical Arduino hardware validation session,
// adjust this literal to the final trimmed value and confirm bits against
// the GAINSEL register table in the MLX90396 datasheet before flashing.
export const GAINSEL = {
  '1px': 0b100101, // 37 — boosted electrical gain (~219) for the twist demo
  '2px': 0b001001, // 9  — stock 1px-style gain, kept off until trim
};

export function setGainSel(mode, value) {
  GAINSEL[mode] = value & 0x3F;
  return GAINSEL[mode];
}

export function getGainSel(mode) {
  return GAINSEL[mode] ?? 0;
}