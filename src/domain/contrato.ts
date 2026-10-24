import { ErroRegraNegocio, ErroValidacao } from './erros.js';

/**
 * Datas de contrato são datas de calendário (coluna DATE), sem hora. "Hoje"
 * precisa ser calculado no fuso do negócio: às 22h de 31/12 em Brasília já é
 * 01/01 em UTC, e um contrato vencendo em 31/12 seria dado como vencido.
 */
export const FUSO_NEGOCIO = 'America/Sao_Paulo';

/** 'YYYY-MM-DD' da data informada no fuso do negócio. */
export function dataCalendario(data = new Date(), fuso = FUSO_NEGOCIO): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(data);
}

/** Converte 'YYYY-MM-DD' em Date à meia-noite UTC (formato que o Prisma grava em DATE). */
export function paraDataSemHora(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new ErroValidacao(`Data inválida: ${iso}`);
  const data = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== iso) {
    throw new ErroValidacao(`Data inválida: ${iso}`);
  }
  return data;
}

export function isoDeDataSemHora(data: Date): string {
  return data.toISOString().slice(0, 10);
}

export interface DadosContrato {
  dataAssinatura: string; // YYYY-MM-DD
  dataVencimento: string; // YYYY-MM-DD
  clausulas: string[];
  valorMensal: string; // decimal em string para não perder precisão
  renovacaoAutomatica: boolean;
}

export class Contrato {
  private constructor(private readonly dados: DadosContrato) {}

  static criar(dados: DadosContrato): Contrato {
    const contrato = new Contrato({
      ...dados,
      clausulas: dados.clausulas.map((c) => c.trim()).filter(Boolean),
    });
    contrato.validar();
    return contrato;
  }

  static restaurar(dados: DadosContrato): Contrato {
    return new Contrato({ ...dados });
  }

  private validar(): void {
    paraDataSemHora(this.dados.dataAssinatura);
    paraDataSemHora(this.dados.dataVencimento);
    if (this.dados.dataVencimento <= this.dados.dataAssinatura) {
      throw new ErroValidacao('dataVencimento deve ser posterior a dataAssinatura');
    }
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(this.dados.valorMensal)) {
      throw new ErroValidacao('valorMensal deve ser um decimal não negativo com até 2 casas');
    }
    if (this.dados.clausulas.length === 0) {
      throw new ErroValidacao('O contrato deve ter ao menos uma cláusula');
    }
  }

  get valores(): Readonly<DadosContrato> {
    return this.dados;
  }

  estaVigente(hoje = dataCalendario()): boolean {
    return this.dados.dataAssinatura <= hoje && hoje <= this.dados.dataVencimento;
  }

  renovar(novoVencimento: string): void {
    paraDataSemHora(novoVencimento);
    if (novoVencimento <= this.dados.dataVencimento) {
      throw new ErroRegraNegocio(
        `O novo vencimento (${novoVencimento}) deve ser posterior ao atual (${this.dados.dataVencimento})`,
      );
    }
    this.dados.dataVencimento = novoVencimento;
  }
}
