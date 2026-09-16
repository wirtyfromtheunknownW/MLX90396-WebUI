export class Arduino_API {
  constructor() {
    this.latestSample = {
      posX_mm: 0,
      posY_mm: 0,
      angleDeg: 0,
      rawX: 0,
      rawY: 0,
      rawZ: 0,
      points: [],
      error: true,
    };
  }

  parseLine(rawLine) {
    const line = String(rawLine ?? '').trim();
    if (!line) {
      return null;
    }

    // New frame: x0|y0|z0|x1|y1|z1|x2|y2|z2|x3|y3|z3|X_mm|Y_mm|angle
    // Legacy fallback: posX,posY,angle,rawX,rawY,rawZ
    const sep = line.includes('|') ? '|' : ',';
    const values = line
      .split(sep)
      .map((segment) => Number(String(segment).trim()));

    if (values.some((value) => Number.isNaN(value))) {
      return null;
    }

    if (values.length === 15) {
      const [x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, posX, posY, angle] = values;
      const sample = {
        posX_mm: posX,
        posY_mm: posY,
        angleDeg: angle,
        rawX: (x0 + x1 + x2 + x3) / 4,
        rawY: (y0 + y1 + y2 + y3) / 4,
        rawZ: (z0 + z1 + z2 + z3) / 4,
        points: [
          { x: x0, y: y0, z: z0 },
          { x: x1, y: y1, z: z1 },
          { x: x2, y: y2, z: z2 },
          { x: x3, y: y3, z: z3 },
        ],
        error: false,
      };
      this.latestSample = sample;
      return sample;
    }

    if (values.length === 6) {
      const [posX, posY, angle, rawX, rawY, rawZ] = values;
      const sample = {
        posX_mm: posX,
        posY_mm: posY,
        angleDeg: angle,
        rawX,
        rawY,
        rawZ,
        points: [],
        error: false,
      };
      this.latestSample = sample;
      return sample;
    }

    return null;
  }

  processLine(rawLine) {
    const sample = this.parseLine(rawLine);
    if (sample) {
      this.latestSample = sample;
    }
    return this.getSample();
  }

  getSample() {
    return {
      ...this.latestSample,
      error: this.latestSample?.error === true,
    };
  }
}

export default Arduino_API;
