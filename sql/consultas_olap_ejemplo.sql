-- =====================================================================
-- Consultas de ejemplo sobre el modelo OLAP (ETL_GAS_STATION)
-- Ábrelas en pgAdmin (Query Tool sobre la base gas_station_db) y ejecuta la que necesites.
-- Las fechas de los filtros (octubre 2026, turnos 765 a 787) son de ejemplo: cámbialas.
-- =====================================================================

-- 0) Historial de cargas: qué archivo entró, cuándo, cuántos tickets y si cuadró
SELECT * FROM etl.v_cargas ORDER BY carga_id DESC;

-- 0.1) Incidencias de la última carga cargada o rechazada (las repetidas no traen incidencias; errores primero)
SELECT severidad, regla, ticket_numero, fila_excel, mensaje
FROM etl.incidencia
WHERE carga_id = (SELECT max(carga_id) FROM etl.carga WHERE estado IN ('CARGADO', 'RECHAZADO'))
ORDER BY CASE severidad WHEN 'ERROR' THEN 1 WHEN 'ADVERTENCIA' THEN 2 ELSE 3 END, regla, ticket_numero;

-- 0.2) Cuadre de la última carga cargada o rechazada contra los subtotales del reporte
SELECT grupo, medida, tickets, suma_detalle, valor_reporte, tolerancia, cuadra
FROM etl.cuadre
WHERE carga_id = (SELECT max(carga_id) FROM etl.carga WHERE estado IN ('CARGADO', 'RECHAZADO'))
ORDER BY grupo, medida;

-- 0.3) Qué cambió de una carga a otra (facturas asignadas después, nombres de clientes corregidos)
SELECT c.carga_id, c.entidad, c.llave, c.campo, c.valor_anterior, c.valor_nuevo
FROM etl.cambio c
ORDER BY c.cambio_id DESC
LIMIT 200;


-- 1) ROLLUP (drill-down por tiempo): mes > semana > día, con subtotales y total general
SELECT d.anio_mes,
       d.semana_iso,
       d.fecha,
       sum(v.tickets)     AS tickets,
       sum(v.galones)     AS galones,
       sum(v.monto_total) AS monto_total,
       round(100 * sum(v.utilidad) / nullif(sum(v.monto_neto), 0), 2) AS margen_pct,
       GROUPING(d.anio_mes, d.semana_iso, d.fecha) AS nivel   -- 0 = día, 1 = semana, 3 = mes, 7 = total
FROM mart.mv_ventas_diarias v
JOIN dw.dim_fecha d ON d.fecha_key = v.fecha_key
WHERE d.anio_mes = '2026-10'
GROUP BY ROLLUP (d.anio_mes, d.semana_iso, d.fecha)
ORDER BY d.anio_mes, d.semana_iso, d.fecha NULLS LAST;

-- 2) CUBE: todas las combinaciones de producto, tipo de cliente y si tiene factura
SELECT coalesce(p.nombre, '(todos)') AS producto,
       CASE GROUPING(v.es_consumidor_final) WHEN 1 THEN '(todos)'
            ELSE CASE WHEN v.es_consumidor_final THEN 'Consumidor final' ELSE 'Cliente con código' END END AS cliente,
       CASE GROUPING(v.con_factura) WHEN 1 THEN '(todos)'
            ELSE CASE WHEN v.con_factura THEN 'Con factura' ELSE 'Sin factura' END END AS factura,
       sum(v.tickets) AS tickets,
       sum(v.monto_total) AS monto_total
FROM mart.mv_ventas_diarias v
JOIN dw.dim_producto p ON p.producto_key = v.producto_key
JOIN dw.dim_fecha d    ON d.fecha_key = v.fecha_key
WHERE d.anio_mes = '2026-10'
GROUP BY CUBE (p.nombre, v.es_consumidor_final, v.con_factura)
ORDER BY 1, 2, 3;

-- 3) GROUPING SETS: varios cortes en una sola lectura (por producto, por bomba, por franja horaria y total)
SELECT p.nombre  AS producto,
       b.numero  AS bomba,
       h.franja,
       count(*)            AS tickets,
       sum(f.cantidad_gal) AS galones,
       sum(f.monto_total)  AS monto_total
FROM dw.fact_despacho f
JOIN dw.dim_producto p ON p.producto_key = f.producto_key
JOIN dw.dim_bomba b    ON b.bomba_key = f.bomba_key
JOIN dw.dim_hora h     ON h.hora_key = f.hora_key
WHERE f.fecha_key BETWEEN 20261001 AND 20261031
GROUP BY GROUPING SETS ((p.nombre), (b.numero), (h.franja), ())
ORDER BY 1, 2, 3;

-- 4) Pivote hora x día de la semana (mapa de calor de galones)
SELECT h.hora,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 1) AS lunes,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 2) AS martes,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 3) AS miercoles,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 4) AS jueves,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 5) AS viernes,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 6) AS sabado,
       sum(f.cantidad_gal) FILTER (WHERE d.dia_semana = 7) AS domingo
FROM dw.fact_despacho f
JOIN dw.dim_fecha d ON d.fecha_key = f.fecha_key
JOIN dw.dim_hora h  ON h.hora_key = f.hora_key
WHERE d.anio_mes = '2026-10'
GROUP BY h.hora
ORDER BY h.hora;

-- 5) Turno contra día calendario: el mismo período se puede ver por cualquiera de los dos
SELECT t.numero AS turno, t.fecha_operativa, t.primer_ticket_en, t.ultimo_ticket_en, t.cruza_medianoche,
       sum(v.tickets) AS tickets, sum(v.monto_total) AS monto_total, sum(v.monto_sin_factura) AS monto_sin_factura
FROM mart.mv_ventas_turno v
JOIN dw.dim_turno t ON t.turno_key = v.turno_key
GROUP BY t.numero, t.fecha_operativa, t.primer_ticket_en, t.ultimo_ticket_en, t.cruza_medianoche
ORDER BY t.numero;

-- 6) Jerarquía contribuyente > cliente: ventas sin factura por NIT y por código (ROLLUP)
SELECT coalesce(c.nit, '(total)')   AS nit,
       coalesce(c.codigo, '(todos los códigos)') AS codigo,
       CASE WHEN GROUPING(c.nit) = 1 THEN '(todos)' ELSE max(c.nombre) END AS nombre,
       count(*)                     AS tickets,
       sum(f.monto_total)           AS monto_sin_factura
FROM dw.fact_despacho f
JOIN dw.dim_cliente c ON c.cliente_key = f.cliente_key
WHERE f.factura_numero IS NULL AND NOT c.es_consumidor_final
  AND f.fecha_key BETWEEN 20261001 AND 20261031
GROUP BY ROLLUP (c.nit, c.codigo)
ORDER BY sum(f.monto_total) DESC;

-- 7) Descuento por pricebook: quién lo recibe y cuánto, por día
SELECT d.fecha, c.nombre AS cliente, pb.nombre_origen AS pricebook,
       count(*) AS tickets, sum(f.cantidad_gal) AS galones, sum(f.descuento_pricebook) AS descuento_q
FROM dw.fact_despacho f
JOIN dw.dim_fecha d      ON d.fecha_key = f.fecha_key
JOIN dw.dim_cliente c    ON c.cliente_key = f.cliente_key
JOIN dw.dim_pricebook pb ON pb.pricebook_key = f.pricebook_key
WHERE pb.tipo <> 'LISTA' AND d.anio_mes = '2026-10'
GROUP BY ROLLUP ((d.fecha, c.nombre, pb.nombre_origen))
ORDER BY d.fecha NULLS LAST, descuento_q DESC;

-- 8) Cuadre contra el reporte: lo mismo que imprime BISS al final de cada sección (por turnos 765 a 787)
SELECT coalesce(p.nombre, 'TOTAL GENERAL') AS seccion,
       count(*)              AS tickets,
       sum(f.cantidad_gal)   AS cantidad,
       sum(f.iva)            AS iva,
       sum(f.idp)            AS idp,
       sum(f.descuento_redondeo) AS descto,
       sum(f.monto_total)    AS total,
       sum(f.monto_neto)     AS total_neto,
       sum(f.costo_total)    AS costo,
       sum(f.utilidad)       AS utilidad
FROM dw.fact_despacho f
JOIN dw.dim_producto p ON p.producto_key = f.producto_key
JOIN dw.dim_turno t    ON t.turno_key = f.turno_key
WHERE t.numero BETWEEN 765 AND 787
GROUP BY ROLLUP (p.nombre)
ORDER BY p.nombre NULLS LAST;

-- 9) Cruce entre procesos (cuando se cargue el reporte de facturación como otro hecho):
--    tickets sin factura y facturas sin ticket, unidos por la dimensión degenerada serie + número
-- SELECT ...
-- FROM dw.fact_despacho t
-- FULL JOIN dw.fact_factura_linea l
--        ON l.estacion_key = t.estacion_key AND l.factura_serie = t.factura_serie AND l.factura_numero = t.factura_numero
-- WHERE t.ticket_numero IS NULL OR l.factura_numero IS NULL;
