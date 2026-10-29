// Incidencias de una vista previa agrupadas por severidad y regla (la usan tickets y compras)
import type { Incidencia, Severidad } from '../reportes/consulta-tickets/tipos.js';

const MAX_EJEMPLOS = 5;
/** Las incidencias que no se ven en la tabla de la vista previa (huecos de numeración, por ejemplo) se mandan todas, hasta este tope */
const MAX_SIN_FILA = 500;

/**
 * Incidencias agrupadas por severidad y regla, con algunos ejemplos. enTabla dice si una incidencia se puede
 * ver en la tabla de la vista previa: si ninguna de su regla se ve, van todas (hasta MAX_SIN_FILA)
 */
export function agruparIncidencias(incidencias: Incidencia[], enTabla: (i: Incidencia) => boolean) {
  const orden: Record<Severidad, number> = { ERROR: 0, ADVERTENCIA: 1, INFO: 2 };
  const grupos = new Map<string, Incidencia[]>();
  for (const i of incidencias) {
    const k = `${i.severidad}|${i.regla}`;
    const lista = grupos.get(k);
    if (lista) lista.push(i);
    else grupos.set(k, [i]);
  }
  return [...grupos.values()]
    .sort((a, b) => orden[a[0]!.severidad] - orden[b[0]!.severidad] || b.length - a.length)
    .map((lista) => {
      // Si ninguna se ve en la tabla, la lista es el único lugar donde aparecen: van todas
      const sinFila = !lista.some(enTabla);
      return {
        severidad: lista[0]!.severidad,
        regla: lista[0]!.regla,
        cantidad: lista.length,
        sinFila,
        ejemplos: lista.slice(0, sinFila ? MAX_SIN_FILA : MAX_EJEMPLOS).map((i) => ({ mensaje: i.mensaje, fila: i.fila ?? null, ticket: i.ticket ?? null })),
      };
    });
}

export function contarIncidencias(incidencias: Incidencia[]): Record<Severidad, number> {
  const conteo = { ERROR: 0, ADVERTENCIA: 0, INFO: 0 };
  for (const i of incidencias) conteo[i.severidad]++;
  return conteo;
}
