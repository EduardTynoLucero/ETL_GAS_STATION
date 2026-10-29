import { describe, expect, it } from 'vitest';
import { esErrorDeConexion, explicarErrorConexion } from '../src/db.js';

describe('esErrorDeConexion', () => {
  it('reconoce los errores de red y de autenticación', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', '28P01', '3D000', '42P01']) {
      expect(esErrorDeConexion({ code })).toBe(true);
    }
  });

  it('reconoce el tiempo agotado de pg, que no trae código', () => {
    expect(esErrorDeConexion(new Error('timeout expired'))).toBe(true);
    expect(esErrorDeConexion(new Error('Connection terminated due to connection timeout'))).toBe(true);
  });

  it('reconoce la espera agotada del pool y la conexión perdida a media consulta', () => {
    const espera = new Error('timeout exceeded when trying to connect');
    expect(esErrorDeConexion(espera)).toBe(true);
    expect(explicarErrorConexion(espera)).toMatch(/ocupado/);
    expect(explicarErrorConexion({ code: 'ETIMEDOUT', syscall: 'read' })).toMatch(/Se perdió la conexión/);
  });

  it('reconoce la contraseña vacía', () => {
    expect(esErrorDeConexion(new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string'))).toBe(true);
  });

  it('reconoce el servidor reiniciando, la conexión cortada, SSL y el bloqueo en la PC', () => {
    expect(esErrorDeConexion({ code: '57P03', message: 'the database system is starting up' })).toBe(true);
    expect(esErrorDeConexion(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(esErrorDeConexion(new Error('The server does not support SSL connections'))).toBe(true);
    expect(esErrorDeConexion({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' })).toBe(true);
    expect(esErrorDeConexion({ code: 'EACCES', syscall: 'connect', message: 'connect EACCES' })).toBe(true);
    expect(esErrorDeConexion({ code: '57P01', message: 'terminating connection due to administrator command' })).toBe(true);
    expect(esErrorDeConexion({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', message: 'unable to get local issuer certificate' })).toBe(true);
    expect(esErrorDeConexion(new Error('Client has encountered a connection error and is not queryable'))).toBe(true);
  });

  it('no confunde errores de archivos ni de SQL con errores de conexión', () => {
    expect(esErrorDeConexion({ code: 'EACCES', path: 'C:\\datos\\a.xlsx' })).toBe(false);
    expect(esErrorDeConexion({ code: 'ETIMEDOUT', path: '\\\\servidor\\carpeta\\a.xlsx' })).toBe(false);
    expect(esErrorDeConexion({ code: '42703', message: 'column "x" does not exist' })).toBe(false);
    expect(esErrorDeConexion(new Error('otra cosa'))).toBe(false);
    expect(esErrorDeConexion(undefined)).toBe(false);
  });
});

describe('explicarErrorConexion', () => {
  it('da un mensaje en español para el tiempo agotado', () => {
    expect(explicarErrorConexion(new Error('timeout expired'))).toMatch(/no responde \(se agotó el tiempo de espera\)/);
  });

  it('pide revisar PGDATABASE cuando la base no existe, sin sugerir crear otra', () => {
    const m = explicarErrorConexion({ code: '3D000' });
    expect(m).toMatch(/PGDATABASE/);
    expect(m).not.toMatch(/instalar-bd/);
  });

  it('explica en español el servidor reiniciando y la falta de SSL', () => {
    expect(explicarErrorConexion({ code: '57P03' })).toMatch(/se está iniciando o reiniciando/);
    expect(explicarErrorConexion({ code: '57P01' })).toMatch(/se reinició o se detuvo/);
    expect(explicarErrorConexion(new Error('The server does not support SSL connections'))).toMatch(/PGSSL=false/);
  });

  it('deja pasar el mensaje original de otros errores', () => {
    expect(explicarErrorConexion({ code: '42703', message: 'column "x" does not exist' })).toBe('column "x" does not exist');
  });
});
