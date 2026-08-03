/** Разбор и сборка PNG для печати ассетов; тесты читают им испечённые картинки. */
export interface RawImage {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

export function decodePng(buffer: Buffer): RawImage;
export function encodePng(image: RawImage): Buffer;
