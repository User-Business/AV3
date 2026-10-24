/**
 * Validação de CNPJ conforme a legislação brasileira vigente.
 *
 * Desde julho de 2026 a Receita Federal emite CNPJs ALFANUMÉRICOS
 * (IN RFB nº 2.229/2024): as 12 primeiras posições podem conter letras A-Z e
 * os 2 dígitos verificadores continuam numéricos. O cálculo do DV é o mesmo
 * módulo 11 de sempre, usando como valor de cada caractere o seu código ASCII
 * menos 48 ('0'..'9' => 0..9, 'A' => 17 ... 'Z' => 42). Para CNPJs só com
 * números o resultado é idêntico ao algoritmo antigo, então um único
 * validador cobre os dois formatos.
 */

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

const FORMATO = /^[0-9A-Z]{12}[0-9]{2}$/;

/** Remove máscara ("12.ABC.345/01DE-35" -> "12ABC34501DE35") e normaliza caixa. */
export function normalizarCnpj(entrada: string): string {
  return entrada.replace(/[.\-/\s]/g, '').toUpperCase();
}

function calcularDigito(base: string, pesos: number[]): number {
  let soma = 0;
  for (let i = 0; i < pesos.length; i++) {
    soma += (base.charCodeAt(i) - 48) * pesos[i]!;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** Calcula os dois dígitos verificadores para uma base de 12 caracteres. */
export function calcularDigitosVerificadores(base12: string): string {
  const base = normalizarCnpj(base12);
  if (!/^[0-9A-Z]{12}$/.test(base)) {
    throw new Error('A base do CNPJ deve ter 12 caracteres alfanuméricos');
  }
  const dv1 = calcularDigito(base, PESOS_DV1);
  const dv2 = calcularDigito(base + dv1, PESOS_DV2);
  return `${dv1}${dv2}`;
}

export function cnpjValido(entrada: string): boolean {
  const cnpj = normalizarCnpj(entrada);
  if (!FORMATO.test(cnpj)) return false;
  // Sequências repetidas (00000000000000, 11111111111111...) passam no
  // módulo 11, mas não são CNPJs válidos.
  if (/^(.)\1{13}$/.test(cnpj)) return false;
  return calcularDigitosVerificadores(cnpj.slice(0, 12)) === cnpj.slice(12);
}
