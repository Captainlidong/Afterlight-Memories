/**
 * 感知哈希 pHash（设计文档 §12.3 近似重复检测）。
 * 32×32 灰度 → 2D DCT-II → 取左上 8×8 低频 → 中位数阈值 → 64bit（16 hex）。
 * 文件完全重复用 sha256；近似重复用 pHash hamming ≤ 10。
 */

const N = 32;
const LOW = 8;

// 预计算余弦表 cos((2x+1)·u·π / 2N)，供可分离 DCT 复用。
const COS: number[][] = (() => {
  const table: number[][] = [];
  for (let x = 0; x < N; x++) {
    table[x] = [];
    for (let u = 0; u < N; u++) {
      table[x][u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }
  return table;
})();

/** 输入必须是 32×32 单通道灰度（1024 字节）。返回 16 个 hex 字符。 */
export function phashFromGray32(gray: Uint8Array): string {
  if (gray.length !== N * N) {
    throw new Error(`phash 需要 ${N * N} 字节灰度，收到 ${gray.length}`);
  }
  // 可分离 2D DCT：先对每行做 1D DCT，再对每列做 1D DCT。
  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let acc = 0;
      for (let x = 0; x < N; x++) {
        acc += gray[y * N + x] * COS[x][u];
      }
      rows[y * N + u] = acc;
    }
  }
  const dct = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let acc = 0;
      for (let y = 0; y < N; y++) {
        acc += rows[y * N + u] * COS[y][v];
      }
      dct[v * N + u] = acc;
    }
  }
  // 取左上 8×8 低频（含 DC）。中位数排除 DC[0]，避免整体亮度偏移主导。
  const block: number[] = [];
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      block.push(dct[v * N + u]);
    }
  }
  const ac = block.slice(1).sort((a, b) => a - b);
  const mid = ac.length >> 1;
  const median =
    ac.length % 2 === 1 ? ac[mid] : (ac[mid - 1] + ac[mid]) / 2;

  // 64bit：每 4bit 拼一个 hex 字符。
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) {
      nibble = (nibble << 1) | (block[i + b] > median ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

const HEX_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** 两个等长 hex 哈希的 hamming 距离（不同 bit 数）。 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += HEX_BITS[x] ?? 0;
  }
  return dist;
}

/** 近似重复阈值（§12.3）。 */
export const PHASH_DUPLICATE_THRESHOLD = 10;