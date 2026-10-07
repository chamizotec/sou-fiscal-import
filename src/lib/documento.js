import { createHash } from "node:crypto";
import { limpar } from "./texto.js";

function digitosVerificadores(base, pesos) {
  const soma = base.split("").reduce((total, digito, indice) => total + Number(digito) * pesos[indice], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cpfValido(digitos) {
  if (!/^\d{11}$/.test(digitos) || /^(\d)\1{10}$/.test(digitos)) return false;
  const primeiro = digitosVerificadores(digitos.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = digitosVerificadores(digitos.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return digitos.endsWith(`${primeiro}${segundo}`);
}

export function cnpjValido(digitos) {
  if (!/^\d{14}$/.test(digitos) || /^(\d)\1{13}$/.test(digitos)) return false;
  const primeiro = digitosVerificadores(digitos.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = digitosVerificadores(digitos.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return digitos.endsWith(`${primeiro}${segundo}`);
}

export function hashDocumento(digitos) {
  return createHash("sha256").update(digitos).digest("hex");
}

export function classificarDocumento(valor) {
  const texto = limpar(valor);
  if (!texto) return null;
  const bruto = texto.replace(/\D/g, "");
  if (!bruto || /^0+$/.test(bruto)) return null;

  const candidatos = [];
  if (bruto.length <= 11) candidatos.push(["CPF", bruto.padStart(11, "0")]);
  if (bruto.length <= 14) candidatos.push(["CNPJ", bruto.padStart(14, "0")]);
  if (bruto.length === 11) candidatos.unshift(["CPF", bruto]);
  if (bruto.length === 14) candidatos.unshift(["CNPJ", bruto]);

  for (const [tipo, digitos] of candidatos) {
    if (tipo === "CPF" && cpfValido(digitos)) {
      return { tipo, digitos, hash: hashDocumento(digitos), chave: `cpf:${hashDocumento(digitos)}` };
    }
    if (tipo === "CNPJ" && cnpjValido(digitos)) {
      return { tipo, digitos, hash: null, chave: `cnpj:${digitos}` };
    }
  }
  return null;
}

export function idHash(texto) {
  return createHash("sha256").update(texto).digest("hex");
}
