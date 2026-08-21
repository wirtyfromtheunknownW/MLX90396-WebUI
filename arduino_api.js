export class Arduino_API {
  constructor() {
    this.latestSample = {
      posX_mm: 0,
      posY_mm: 0,
      angleDeg: 0,
      rawX: 0,
      rawY: 0,
      rawZ: 0,
      error: true,
    };
  }

  parseLine(rawLine) {
    const line = String(rawLine ?? '').trim();
    if (!line) {
      return null;
    }

    const values = line
      .split(',')
      .map((segment) => Number(String(segment).trim()));

    if (values.length < 6 || values.some((value) => Number.isNaN(value))) {
      return null;
    }

    const [posX, posY, angle, rawX, rawY, rawZ] = values;
    const sample = {
      posX_mm: posX,
      posY_mm: posY,
      angleDeg: angle,
      rawX,
      rawY,
      rawZ,
      error: false,
    };

    this.latestSample = sample;
    return sample;
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
