/**
 * Ассеты приходят в бандл ссылками: Vite подменяет импорт на URL файла, а не
 * вклеивает его в код. Так лес грузится отдельно и параллельно сцене.
 *
 * Модель машины — исключение: она импортируется обычным JSON и едет вместе с
 * кодом сцены. Без леса заезд состоится, без машины — нет.
 */
declare module "*.json?url" {
  const url: string;
  export default url;
}

declare module "*.png" {
  const url: string;
  export default url;
}

declare module "*.jpg" {
  const url: string;
  export default url;
}
