// Cómo se le muestra al usuario el resultado de una lectura o de una carga
import type { ResultadoCarga } from './carga/cargar.js';
import type { ResultadoCompras } from './reportes/compras/tipos.js';
import type { Incidencia, ResultadoLectura } from './reportes/consulta-tickets/tipos.js';

export const miles = (n: number | string) => {
  const [entero, dec] = String(n).split('.');
  return entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? `.${dec}` : '');
};

const fechaCorta = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)} ${f.slice(11, 16)}` : '?');

const MAX_EJEMPLOS = 3;

function resumenIncidencias(incidencias: Incidencia[]): string[] {
  const lineas: string[] = [];
  const conteo = { ERROR: 0, ADVERTENCIA: 0, INFO: 0 };
  for (const i of incidencias) conteo[i.severidad]++;
  const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
  lineas.push(
    `  Incidencias: ${plural(conteo.ERROR, 'error', 'errores')}, ${plural(conteo.ADVERTENCIA, 'advertencia', 'advertencias')}, ` +
      plural(conteo.INFO, 'informativa', 'informativas'),
  );
  const porRegla = new Map<string, Incidencia[]>();
  for (const i of incidencias) {
    const clave = `${i.severidad} ${i.regla}`;
    porRegla.set(clave, [...(porRegla.get(clave) ?? []), i]);
  }
  const orden = { ERROR: 0, ADVERTENCIA: 1, INFO: 2 };
  const grupos = [...porRegla.entries()].sort(
    ([, a], [, b]) => orden[a[0]!.severidad] - orden[b[0]!.severidad] || b.length - a.length,
  );
  for (const [clave, lista] of grupos) {
    lineas.push(`    ${clave} (${lista.length})`);
    for (const i of lista.slice(0, MAX_EJEMPLOS)) lineas.push(`      - ${i.mensaje}`);
    if (lista.length > MAX_EJEMPLOS) lineas.push(`      ... y ${lista.length - MAX_EJEMPLOS} más (ver etl.incidencia)`);
  }
  return lineas;
}

export function textoLectura(l: ResultadoLectura): string[] {
  const r = l.resumen;
  const lineas = [
    `  Hoja "${l.hoja}", encabezado en la fila ${l.filaEncabezado}, ${l.columnas.length} columnas` +
      (l.traeEstacion ? '' : ' (sin columna Estación)'),
    `  Tickets leídos: ${miles(l.tickets.length)} de ${r.estaciones.join(', ') || '?'}, turnos ${r.turnoMin ?? '?'} a ${r.turnoMax ?? '?'}, ` +
      `del ${fechaCorta(r.fechaMin)} al ${fechaCorta(r.fechaMax)}`,
    `  Total Q${miles(r.total)} · ${miles(r.cantidad)} galones`,
  ];
  if (l.cuadre.length) {
    const malos = l.cuadre.filter((f) => !f.cuadra).length;
    const grupos = new Set(l.cuadre.map((f) => f.grupo)).size;
    lineas.push(
      malos === 0
        ? `  Cuadre contra el reporte: ${grupos} grupos, ${l.cuadre.length} comparaciones, todo cuadra`
        : `  Cuadre contra el reporte: ${malos} de ${l.cuadre.length} comparaciones NO cuadran`,
    );
  }
  lineas.push(...resumenIncidencias(l.incidencias));
  return lineas;
}

export function textoCompras(l: ResultadoCompras): string[] {
  const r = l.resumen;
  const lineas = [
    `  Reporte de compras: hoja "${l.hoja}", encabezado en la fila ${l.filaEncabezado}, ${l.columnas.length} columnas`,
    `  Líneas leídas: ${miles(l.compras.length)} de ${r.proveedores.join(', ') || '?'}, del ${fechaCorta(r.fechaMin)} al ${fechaCorta(r.fechaMax)}`,
    `  Total Q${miles(r.total)} · ${miles(r.galones)} galones de combustible`,
  ];
  if (l.cuadre.length) {
    const malos = l.cuadre.filter((f) => !f.cuadra).length;
    lineas.push(
      malos === 0
        ? `  Cuadre contra el reporte: ${new Set(l.cuadre.map((f) => f.grupo)).size} grupos, ${l.cuadre.length} comparaciones, todo cuadra`
        : `  Cuadre contra el reporte: ${malos} de ${l.cuadre.length} comparaciones NO cuadran`,
    );
  }
  lineas.push(...resumenIncidencias(l.incidencias));
  return lineas;
}

export function textoCarga(r: ResultadoCarga): string {
  const lineas = [`${r.archivo}: ${r.estado}${r.cargaId ? ` (carga ${r.cargaId})` : ''} en ${r.segundos} s`];
  lineas.push(`  ${r.mensaje}`);
  if (r.lectura) lineas.push(...textoLectura(r.lectura));
  if (r.compras) lineas.push(...textoCompras(r.compras));
  if (r.avisoMart) lineas.push(`  AVISO: ${r.avisoMart}`);
  return lineas.join('\n');
}

/** Versión para guardar junto al archivo procesado o imprimir con --json */
export function resumenJson(r: ResultadoCarga) {
  const l = r.lectura;
  const k = r.compras;
  return {
    archivo: r.archivo,
    tipo: r.tipo,
    estado: r.estado,
    carga_id: r.cargaId,
    mensaje: r.mensaje,
    segundos: r.segundos,
    conteos: r.conteos ?? r.conteosCompras ?? null,
    aviso: r.avisoMart ?? null,
    compras: k
      ? {
          lineas: k.compras.length,
          ...k.resumen,
          cuadra: k.cuadre.every((f) => f.cuadra),
          cuadre: k.cuadre.map((f) => ({ grupo: f.grupo, medida: f.medida, suma: f.sumaDetalle.toFixed(), reporte: f.valorReporte.toFixed(), cuadra: f.cuadra })),
          incidencias: k.incidencias,
        }
      : null,
    lectura: l
      ? {
          tickets: l.tickets.length,
          ...l.resumen,
          cuadra: l.cuadre.every((f) => f.cuadra),
          cuadre: l.cuadre.map((f) => ({
            grupo: f.grupo,
            medida: f.medida,
            suma: f.sumaDetalle.toFixed(),
            reporte: f.valorReporte.toFixed(),
            cuadra: f.cuadra,
          })),
          incidencias: l.incidencias,
        }
      : null,
  };
}
