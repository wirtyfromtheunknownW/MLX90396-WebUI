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

  async _send_spi(mosi_data, miso_len) {
      const prefix = this.getSpiPrefix();
      const txArray = [...mosi_data];
      for (let i = 0; i < miso_len; i++) {
          txArray.push(0x00);
      }
      const decStr = txArray.join(',');
      
      await this.query(`${prefix}:CS0 0`);
      await new Promise(r => setTimeout(r, 2));

      const scpiCmd = `${prefix}:WriteReaD ${decStr}`;
      let response = await this.query(scpiCmd);
      
      await new Promise(r => setTimeout(r, 2));
      await this.query(`${prefix}:CS0 1`);
      
      if (!response) return Array(miso_len).fill(0);
      
      response = response.replace(scpiCmd, '').trim();
      const tokens = response.match(/0x[0-9a-fA-F]+|[0-9a-fA-F]+/g) || [];
      const rxArray = tokens.map(tok => parseInt(tok, 16));

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

  _verify_crc(message, expected_crc) {
      let crcFF = 0xFF; 
      for (let i = 0; i < message.length; i++) {
          crcFF ^= message[i];
          for (let j = 0; j < 8; j++) {
              crcFF = (crcFF & 0x80) ? ((crcFF << 1) ^ 0x2F) & 0xFF : (crcFF << 1) & 0xFF;
          }
      }
      if (((crcFF ^ 0xFF) & 0xFF) === expected_crc) return true;

      let crc00 = 0x00; 
      for (let i = 0; i < message.length; i++) {
          crc00 ^= message[i];
          for (let j = 0; j < 8; j++) {
              crc00 = (crc00 & 0x80) ? ((crc00 << 1) ^ 0x2F) & 0xFF : (crc00 << 1) & 0xFF;
          }
      }
      if (((crc00 ^ 0x00) & 0xFF) === expected_crc) return true;

      return false; 
  }

  _s16(u) {
      let val = (u << 4) & 0xFFFF;
      if (val & 0x8000) val = val - 0x10000;
      return val >> 4;
  }

  _checkMaskLimit(data_mask) {
      let count = 0;
      let temp_mask = data_mask & 0xFFFFFC; 
      while (temp_mask) {
          temp_mask &= (temp_mask - 1);
          if (++count > 6) return true; 
      }
      return false;
  }

  async rt() {
      const mosi = [MLX90396_API.Mlx90396Command.RT, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async hs() {
      const mosi = [MLX90396_API.Mlx90396Command.HS, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async hr() {
      const mosi = [MLX90396_API.Mlx90396Command.HR, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async ex(mode) {
      const mosi = [MLX90396_API.Mlx90396Command.EX | (0x0F & mode), 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      const miso = await this._send_spi(mosi, 2);
      return !this._verify_crc(miso.slice(0, 1), miso[1]); 
  }

  async rr(reg) {
      const mosi = [MLX90396_API.Mlx90396Command.RR, reg, 0];
      mosi[2] = this._crc_2f(mosi.slice(0, 2));
      const miso = await this._send_spi(mosi, 4);
      
      const error = !this._verify_crc(miso.slice(0, 3), miso[3]);
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
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
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
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
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
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
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
      return !this._verify_crc(miso.slice(0, 1), miso[1]);
  }

  // Universal dynamic read
  async rm(temp, data_mask) {
      if (this._checkMaskLimit(data_mask)) return { error: true, msg: "Limit Exceeded (Max 6 axes)" };
      
      const mosi = [temp ? MLX90396_API.Mlx90396Command.RM_TEMP : MLX90396_API.Mlx90396Command.RM_NO_TEMP, 0];
      mosi[1] = this._crc_2f(mosi.slice(0, 1));
      
      const keys = [
          'x0', 'y0', 'z0', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'x3', 'y3', 'z3',
          'x02', 'y02', 'z02', 'x13', 'y13', 'z13', 'vdd'
      ];
      
      let activeKeys = [];
      for (let i = 0; i < 19; i++) {
          const bitPos = 19 - i;
          if ((data_mask & (1 << bitPos)) !== 0) {
              activeKeys.push(keys[i]);
          }
      }
      
      const miso_len = 1 + (temp ? 2 : 0) + (activeKeys.length * 2) + 1;
      const miso = await this._send_spi(mosi, miso_len);
      
      let result = { raw: miso };
      let offset = 1; 
      
      if (temp) {
          result.t = this._s16((miso[offset] << 8) | miso[offset + 1]);
          offset += 2;
      }
      
      for (let key of activeKeys) {
          result[key] = this._s16((miso[offset] << 8) | miso[offset + 1]);
          offset += 2;
      }
      
      result.error = !this._verify_crc(miso.slice(0, offset), miso[offset]);
      result.status = miso[0];
      
      return result;
  }

  // Alias wrapper for legacy calls
  async rm_joystick_xyz(temp, data_mask) {
      return this.rm(temp, data_mask);
  }
}