/**
 * mlx_api.js
 * Complete MLX90396 API - SCPI Tunneling Version
 */
export class MLX90396_API {
    
  static Mlx90396Command = {
      RT: 0xF0,       // Reset
      HS: 0xE0,       // Memory Store
      HR: 0xD0,       // Memory Recall
      EX: 0x80,       // Exit Mode
      RR: 0x50,       // Read Register
      WR: 0x60,       // Write Register
      SB: 0x10,       // Start Burst
      SWOC: 0x20,     // Start WOC
      SM: 0x30,       // Start Single Measurement
      RM_NO_TEMP: 0x40, // Read Measurement (No Temp)
      RM_TEMP: 0x41   // Read Measurement (With Temp)
  };

  constructor(scpiQueryFn, getSpiPrefixFn = () => ":SPI") {
      this.query = scpiQueryFn;
      this.getSpiPrefix = typeof getSpiPrefixFn === 'function' ? getSpiPrefixFn : () => getSpiPrefixFn;
  }

  // --- Core SPI & Math Utilities ---

async _send_spi(mosi_data, miso_len) {
      const prefix = this.getSpiPrefix();
      const txArray = [...mosi_data];
      for (let i = 0; i < miso_len; i++) {
          txArray.push(0x00);
      }
      const decStr = txArray.join(',');
      
      // 1. Assert CS0
      await this.query(`${prefix}:CS0 0`);

      // 2. Send SPI Transaction
      const scpiCmd = `${prefix}:WriteReaD ${decStr}`;
      const response = await this.query(scpiCmd);
      
      // 3. De-assert CS0
      await this.query(`${prefix}:CS0 1`);
      
      if (!response) return Array(miso_len).fill(0);
      
      // Extract valid hex/dec byte tokens from SCPI response
      const tokens = response.match(/0x[0-9a-fA-F]+|[0-9a-fA-F]+/g) || [];
      const rxArray = tokens.map(tok => parseInt(tok, 16));

      // Slice MISO payload after MOSI transmit bytes
      if (rxArray.length >= mosi_data.length + miso_len) {
        return rxArray.slice(mosi_data.length, mosi_data.length + miso_len);
      } else if (rxArray.length >= miso_len) {
        return rxArray.slice(-miso_len);
      }
      
      return Array(miso_len).fill(0);
  }

  _crc_2f(message) {
      let crc = 0xFF; 
      for (let i = 0; i < message.length; i++) {
          crc = crc ^ message[i];
          for (let j = 0; j < 8; j++) {
              if ((crc & 0x80) === 0) crc = (crc << 1) & 0xFF;
              else crc = ((crc << 1) ^ 0x2F) & 0xFF;
          }
      }
      return (crc ^ 0xFF) & 0xFF; 
  }

  _s16(u) {
      let val = (u << 4) & 0xFFFF;
      if (val & 0x8000) val = val - 0x10000;
      return val >> 4;
  }

  _checkMaskLimit(data_mask) {
      let count = 0;
      let temp_mask = data_mask;
      while (temp_mask) {
          temp_mask &= (temp_mask - 1);
          if (++count > 6) return true; 
      }
      return false;
  }

  // --- API Device Commands ---

  async rt() {
      const mosi = [MLX90396_API.Mlx90396Command.RT, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]); 
  }

  async hs() {
      const mosi = [MLX90396_API.Mlx90396Command.HS, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]); 
  }

  async hr() {
      const mosi = [MLX90396_API.Mlx90396Command.HR, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]); 
  }

  async ex(mode) {
      const mosi = [MLX90396_API.Mlx90396Command.EX | (0x0F & mode), 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]); 
  }

  async rr(reg) {
      const mosi = [MLX90396_API.Mlx90396Command.RR, reg, 0];
      mosi[2] = this._crc_2f(mosi.slice(0, 2));
      const miso = await this._send_spi(mosi, 4);
      
      const error = (this._crc_2f(miso.slice(0, 3)) !== miso[3]);
      const data = (miso[1] << 8) | miso[2];
      
      return { error, status: miso[0], data }; 
  }

  async wr(reg, data) {
      const mosi = [
          MLX90396_API.Mlx90396Command.WR,
          reg,
          (data >> 8) & 0xFF,
          data & 0xFF,
          0
      ];
      mosi[4] = this._crc_2f(mosi.slice(0, 4));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]);
  }

  async sb(data_mask) {
      if (this._checkMaskLimit(data_mask)) return true;
      const mosi = [
          MLX90396_API.Mlx90396Command.SB | ((data_mask >> 16) & 0x0F),
          (data_mask >> 8) & 0xFF,
          data_mask & 0xFF,
          0 
      ];
      mosi[3] = this._crc_2f(mosi.slice(0, 3));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]);
  }

  async swoc(data_mask) {
      if (this._checkMaskLimit(data_mask)) return true;
      const mosi = [
          MLX90396_API.Mlx90396Command.SWOC | ((data_mask >> 16) & 0x0F),
          (data_mask >> 8) & 0xFF,
          data_mask & 0xFF,
          0 
      ];
      mosi[3] = this._crc_2f(mosi.slice(0, 3));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]);
  }

  async sm(data_mask) {
      if (this._checkMaskLimit(data_mask)) return true;
      const mosi = [
          MLX90396_API.Mlx90396Command.SM | ((data_mask >> 16) & 0x0F),
          (data_mask >> 8) & 0xFF,
          data_mask & 0xFF,
          0 
      ];
      mosi[3] = this._crc_2f(mosi.slice(0, 3));
      const miso = await this._send_spi(mosi, 2);
      return (this._crc_2f(miso.slice(0, 1)) !== miso[1]);
  }

  async rm_joystick_xyz(temp, data_mask) {
      if (this._checkMaskLimit(data_mask)) return { error: true };
      const mosi = [temp ? MLX90396_API.Mlx90396Command.RM_TEMP : MLX90396_API.Mlx90396Command.RM_NO_TEMP, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      
      let miso, error, x0, y0, z0;

      if (temp) {
          miso = await this._send_spi(mosi, 10);
          x0 = this._s16((miso[3] << 8) | miso[4]);
          y0 = this._s16((miso[5] << 8) | miso[6]);
          z0 = this._s16((miso[7] << 8) | miso[8]);
          error = (this._crc_2f(miso.slice(0, 9)) !== miso[9]);
      } else {
          miso = await this._send_spi(mosi, 8);
          x0 = this._s16((miso[1] << 8) | miso[2]);
          y0 = this._s16((miso[3] << 8) | miso[4]);
          z0 = this._s16((miso[5] << 8) | miso[6]);
          error = (this._crc_2f(miso.slice(0, 7)) !== miso[7]);
      }

      return { error, x0, y0, z0 };
  }

  async rm_sfi_joystick(temp, data_mask) {
      if (this._checkMaskLimit(data_mask)) return { error: true };
      const mosi = [temp ? MLX90396_API.Mlx90396Command.RM_TEMP : MLX90396_API.Mlx90396Command.RM_NO_TEMP, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      
      let miso, error, x02, z02, y13, z13;

      if (temp) {
          miso = await this._send_spi(mosi, 12);
          x02 = this._s16((miso[3] << 8) | miso[4]);
          z02 = this._s16((miso[5] << 8) | miso[6]);
          y13 = this._s16((miso[7] << 8) | miso[8]);
          z13 = this._s16((miso[9] << 8) | miso[10]);
          error = (this._crc_2f(miso.slice(0, 11)) !== miso[11]);
      } else {
          miso = await this._send_spi(mosi, 10);
          x02 = this._s16((miso[1] << 8) | miso[2]);
          z02 = this._s16((miso[3] << 8) | miso[4]);
          y13 = this._s16((miso[5] << 8) | miso[6]);
          z13 = this._s16((miso[7] << 8) | miso[8]);
          error = (this._crc_2f(miso.slice(0, 9)) !== miso[9]);
      }

      return { error, x02, z02, y13, z13 };
  }
}