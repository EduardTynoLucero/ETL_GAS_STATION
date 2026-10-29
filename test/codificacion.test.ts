// Todos los archivos de texto del proyecto van en UTF-8 sin BOM: así las tildes se ven bien en el panel,
// en la consola y en PostgreSQL. Esta prueba avisa si un editor o un comando los guardó en otra codificación.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = path.resolve(import.meta.dirname, '..');
const CARPETAS = ['src', 'panel', 'sql', 'test'];
const SUELTOS = ['README.md', '.env.example', 'package.json', 'tsconfig.json', 'tsconfig.build.json', '.editorconfig'];
const EXTENSIONES = /\.(ts|js|mjs|css|html|sql|md|json)$/i;

function archivos(carpeta: string): string[] {
  return readdirSync(carpeta, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(carpeta, e.name);
    if (e.isDirectory()) return archivos(ruta);
    return EXTENSIONES.test(e.name) ? [ruta] : [];
  });
}

const todos = [...CARPETAS.flatMap((c) => archivos(path.join(RAIZ, c))), ...SUELTOS.map((s) => path.join(RAIZ, s))];
// Lo que queda de una tilde leída como Windows-1252 y guardada otra vez en UTF-8 (la "ó" se vuelve "A con tilde" + "superíndice 3")
const DANADO = new RegExp('\\u00C3[\\u0080-\\u00BF]|\\u00C2[\\u0080-\\u00BF]|\\uFFFD');

describe('codificación de los archivos', () => {
  it.each(todos.map((r) => [path.relative(RAIZ, r), r]))('%s está en UTF-8 sin BOM y sin tildes dañadas', (_nombre, ruta) => {
    const bytes = readFileSync(ruta);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'tiene BOM').toBe(false);
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(DANADO.exec(texto)?.[0] ?? null, 'tiene tildes dañadas').toBeNull();
  });
});
