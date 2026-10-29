// Paso de staging a la estrella (dw.cargar_tickets) y refresco de la capa mart
import type { Cliente } from '../db.js';
import type { Incidencia } from '../reportes/consulta-tickets/tipos.js';

export interface ConteosCarga {
  insertadas: number;
  actualizadas: number;
  sin_cambio: number;
  movidas: number;
  no_vinieron: number;
}

export async function publicarEnDw(c: Cliente, cargaId: number): Promise<ConteosCarga> {
  const r = await c.query<ConteosCarga>('SELECT * FROM dw.cargar_tickets($1)', [cargaId]);
  return r.rows[0]!;
}

/** Avisos que genera la base al publicar (tickets que no vinieron, facturas que desaparecen) */
export async function avisosDeLaBase(c: Cliente, cargaId: number): Promise<Incidencia[]> {
  const r = await c.query<{ severidad: Incidencia['severidad']; regla: string; ticket_numero: number | null; columna: string | null; valor: string | null; mensaje: string }>(
    `SELECT severidad, regla, ticket_numero, columna, valor, mensaje FROM etl.incidencia
      WHERE carga_id = $1 AND regla IN ('TICKET_NO_VINO', 'FACTURA_QUITADA') ORDER BY incidencia_id`,
    [cargaId],
  );
  return r.rows.map((f) => ({
    severidad: f.severidad,
    regla: f.regla,
    mensaje: f.mensaje,
    ...(f.ticket_numero !== null && { ticket: f.ticket_numero }),
    ...(f.columna !== null && { columna: f.columna }),
    ...(f.valor !== null && { valor: f.valor }),
  }));
}

export async function refrescarMart(c: Cliente): Promise<void> {
  await c.query('CALL mart.refrescar()');
}

/** Borra de staging los tickets de cargas viejas; el modelo y la bitácora no se tocan */
export async function limpiarStaging(c: Cliente, dias: number): Promise<number> {
  const r = await c.query(
    `DELETE FROM stg.ticket_despacho s USING etl.carga k
      WHERE s.carga_id = k.carga_id AND k.iniciado_en < now() - make_interval(days => $1)`,
    [dias],
  );
  return r.rowCount ?? 0;
}
