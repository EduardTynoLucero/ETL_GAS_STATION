// Carpeta vigilada: cada archivo .xlsx que aparece en "entrada" se carga y se mueve a
// "procesados" o "rechazados", con un .json al lado que dice qué pasó.
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { leerConfig } from '../config.js';
import { esErrorDeConexion, explicarErrorConexion } from '../db.js';
import { cargarArchivo, type OpcionesCarga, type ResultadoCarga } from './cargar.js';
import { resumenJson } from '../resumen.js';

const esperar = (ms: number, senal?: AbortSignal) =>
  new Promise<void>((listo) => {
    const t = setTimeout(listo, ms);
    senal?.addEventListener('abort', () => (clearTimeout(t), listo()), { once: true });
  });

export async function mover(origen: string, destino: string): Promise<void> {
  try {
    await rename(origen, destino);
  } catch (err) {
    // Otra unidad de disco o carpeta de red: copiar y borrar
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(origen, destino);
    await unlink(origen);
  }
}

export function sello(): string {
  const d = new Date();
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}_${dos(d.getHours())}${dos(d.getMinutes())}${dos(d.getSeconds())}`;
}

/**
 * Archivos .xlsx de la carpeta de entrada, del más viejo al más nuevo (se ignoran los temporales de Excel "~$...").
 * El orden importa: el último archivo cargado manda, así que una exportación vieja no debe pisar a una nueva
 */
async function pendientes(carpeta: string): Promise<string[]> {
  const nombres = (await readdir(carpeta)).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$'));
  const conFecha = await Promise.all(nombres.map(async (n) => ({ n, t: (await stat(path.join(carpeta, n))).mtimeMs })));
  return conFecha.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n)).map((x) => x.n);
}

/** Espera a que el archivo deje de crecer (que se termine de copiar). Un archivo que se queda en 0 bytes está vacío */
async function estadoDelArchivo(ruta: string): Promise<'completo' | 'copiando' | 'vacio'> {
  const a = await stat(ruta);
  await esperar(2000);
  const b = await stat(ruta);
  if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return 'copiando';
  return b.size === 0 ? 'vacio' : 'completo';
}

export async function procesarCarpeta(
  alTerminar: (r: ResultadoCarga) => void,
  opciones: OpcionesCarga = {},
): Promise<{ procesados: number; fallidos: number; rechazados: number }> {
  const { carpetas } = leerConfig();
  await Promise.all(Object.values(carpetas).map((c) => mkdir(c, { recursive: true })));
  let procesados = 0;
  let fallidos = 0;
  let rechazados = 0;
  for (const nombre of await pendientes(carpetas.entrada)) {
    const ruta = path.join(carpetas.entrada, nombre);
    const estado = await estadoDelArchivo(ruta);
    if (estado === 'copiando') continue; // se revisa en la siguiente vuelta
    if (estado === 'vacio') {
      // Una exportación cortada: no se mueve, pero cuenta como no procesado para que se note
      console.error(`${nombre}: está vacío (0 bytes); se queda en la carpeta de entrada. Bórralo y exporta el reporte otra vez.`);
      fallidos++;
      continue;
    }
    let resultado: ResultadoCarga;
    try {
      resultado = await cargarArchivo(ruta, opciones);
    } catch (err) {
      // Sin conexión a la base u otro problema que no es del archivo: se deja en entrada para reintentar
      const motivo = esErrorDeConexion(err) ? explicarErrorConexion(err) : (err as Error).message;
      console.error(`${nombre}: no se pudo procesar, se queda en la carpeta de entrada para el siguiente intento. ${motivo}`);
      fallidos++;
      continue;
    }
    const carpetaDestino = resultado.estado === 'RECHAZADO' ? carpetas.rechazados : carpetas.procesados;
    const destino = path.join(carpetaDestino, `${sello()}_${nombre}`);
    await mover(ruta, destino);
    await writeFile(`${destino}.json`, JSON.stringify(resumenJson(resultado), null, 2), 'utf8');
    alTerminar(resultado);
    procesados++;
    if (resultado.estado === 'RECHAZADO') rechazados++;
  }
  return { procesados, fallidos, rechazados };
}

export async function vigilar(
  alTerminar: (r: ResultadoCarga) => void,
  opciones: OpcionesCarga = {},
  senal?: AbortSignal,
): Promise<void> {
  const { carpetas, intervaloVigilarSeg } = leerConfig();
  console.log(`Vigilando ${carpetas.entrada} cada ${intervaloVigilarSeg} s. Ctrl+C para detener.`);
  while (!senal?.aborted) {
    try {
      await procesarCarpeta(alTerminar, opciones);
    } catch (err) {
      console.error(`Error revisando la carpeta: ${(err as Error).message}`);
    }
    await esperar(intervaloVigilarSeg * 1000, senal);
  }
  console.log('Vigilancia detenida.');
}
