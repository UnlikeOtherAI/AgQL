import type { RuntimeOwnedVector } from '@agql/contracts';

import type { VectorByteOrder } from './types.ts';

export function pgvectorParameter(
  vector: RuntimeOwnedVector,
  byteOrder: VectorByteOrder,
): string | undefined {
  if (vector.encoding !== 'float32') return undefined;
  const bytesPerFloat = 4;
  if (vector.bytes.byteLength !== vector.dimension * bytesPerFloat) return undefined;
  const view = new DataView(vector.bytes.buffer, vector.bytes.byteOffset, vector.bytes.byteLength);
  const littleEndian = byteOrder === 'littleEndian';
  const components: string[] = [];
  for (let index = 0; index < vector.dimension; index += 1) {
    const value = view.getFloat32(index * bytesPerFloat, littleEndian);
    if (!Number.isFinite(value)) return undefined;
    components.push(Object.is(value, -0) ? '0' : String(value));
  }
  return `[${components.join(',')}]`;
}
