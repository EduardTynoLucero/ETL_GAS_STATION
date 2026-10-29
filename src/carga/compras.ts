// Carga de un Reporte de compras ya leído: staging (stg.compra) y paso a la estrella (dw.cargar_compras).
// Son pocas líneas por archivo (una por factura y producto): van con un solo INSERT ... unnest, sin COPY.
import type { Cliente } from '../db.js';
import { decimalATexto } from '../reportes/consulta-tickets/conversion.js';
import type { Incidencia } from '../reportes/consulta-tickets/tipos.js';
import { ESCALAS_COMPRA, type CampoNumeroCompra, type Compra } from '../reportes/compras/tipos.js';

export interface ConteosCompras {
  insertadas: number;
  actualizadas: number;
  sin_cambio: number;
  no_vinieron: number;
}

export class ErrorSinTablasCompras extends Error {
  constructor() {
    super(
      'La base todavía no tiene las tablas de compras e inventario. Ejecuta sql/actualizar_compras_inventario.sql ' +
        '(o npm run instalar-bd) y vuelve a subir el archivo.',
    );
  }
}

/** ¿Ya se ejecutó sql/actualizar_compras_inventario.sql en esta base? */
export async function tablasDeComprasInstaladas(c: Cliente): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(`SELECT to_regclass('dw.fact_compra') IS NOT NULL AND to_regproc('dw.cargar_compras') IS NOT NULL AS ok`);
  return r.rows[0]!.ok;
}

/** El valor tal como entra a staging: los números redondeados a la escala de su columna */
export function numeroStaging(c: Compra, campo: CampoNumeroCompra): string | null {
  const v = c[campo];
  return v === null ? null : decimalATexto(v, ESCALAS_COMPRA[campo]);
}

const NUMEROS = Object.keys(ESCALAS_COMPRA) as CampoNumeroCompra[];

export async function copiarComprasAStaging(c: Cliente, cargaId: number, compras: Compra[]): Promise<void> {
  const textos = ['seccion', 'estacion', 'serie', 'numero', 'fecha_hora', 'proveedor_nit', 'proveedor_nombre', 'producto', 'combustible'] as const;
  await c.query(
    `INSERT INTO stg.compra (carga_id, fila_excel, turno, anulada, ${textos.join(', ')}, ${NUMEROS.join(', ')})
     SELECT $1::bigint, u.fila, u.turno, u.anulada, ${textos.map((t) => `u.${t}${t === 'fecha_hora' ? '::timestamp' : ''}`).join(', ')},
            ${NUMEROS.map((n) => `u.${n}::numeric`).join(', ')}
       FROM unnest($2::int[], $3::int[], $4::boolean[], ${textos.map((_, i) => `$${i + 5}::text[]`).join(', ')},
                   ${NUMEROS.map((_, i) => `$${i + 5 + textos.length}::text[]`).join(', ')})
            AS u(fila, turno, anulada, ${textos.join(', ')}, ${NUMEROS.join(', ')})`,
    [
      cargaId,
      compras.map((x) => x.fila),
      compras.map((x) => x.turno),
      compras.map((x) => x.anulada),
      ...textos.map((t) => compras.map((x) => x[t])),
      ...NUMEROS.map((n) => compras.map((x) => numeroStaging(x, n))),
    ],
  );
}

export async function publicarCompras(c: Cliente, cargaId: number): Promise<ConteosCompras> {
  const r = await c.query<ConteosCompras>('SELECT * FROM dw.cargar_compras($1)', [cargaId]);
  return r.rows[0]!;
}

/** Avisos que genera la base al publicar (compras ya cargadas que no vinieron) */
export async function avisosDeComprasEnLaBase(c: Cliente, cargaId: number): Promise<Incidencia[]> {
  const r = await c.query<{ severidad: Incidencia['severidad']; regla: string; columna: string | null; valor: string | null; mensaje: string }>(
    `SELECT severidad, regla, columna, valor, mensaje FROM etl.incidencia
      WHERE carga_id = $1 AND regla = 'COMPRA_NO_VINO' ORDER BY incidencia_id`,
    [cargaId],
  );
  return r.rows.map((f) => ({
    severidad: f.severidad,
    regla: f.regla,
    mensaje: f.mensaje,
    ...(f.columna !== null && { columna: f.columna }),
    ...(f.valor !== null && { valor: f.valor }),
  }));
}
